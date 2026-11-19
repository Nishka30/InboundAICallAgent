import { logger } from '../lib/logger.js';
import { InquiryStatus, LifecycleEvent, type CallRecord } from '../domain/call.js';
import { GuidedBoostClient } from '../integrations/guidedBoost/client.js';
import { GuidedBoostError } from '../integrations/guidedBoost/errors.js';
import type { CallRepository } from '../repositories/callRepository.js';

/**
 * Captures an inbound inquiry and submits it to the NEW-lead API so the team can
 * follow up. This is the business path for a new caller who does NOT want a
 * consultant, or whose booking could not be completed — it is a VALID outcome, not
 * a failure.
 *
 * Behaviour:
 *   - Always records the inquiry on the local call record first (so it is never lost).
 *   - If the new-lead API is configured + enabled, POSTs it; on success → SENT.
 *   - If the API is not yet configured (David's endpoint pending) → CAPTURED
 *     (retained locally; it will also land in the end-of-call CRM note where a lead
 *     exists). Never throws.
 *
 * The request body uses a documented snake_case mapping; the exact field names are
 * to be confirmed against David's contract, which is why the PATH and enablement are
 * configuration-driven (see `GUIDED_BOOST_NEW_LEAD_*`).
 */

export type SubmitInquiryOutcome = 'sent' | 'captured' | 'failed';

export interface SubmitInquiryResult {
  outcome: SubmitInquiryOutcome;
  leadId?: string;
}

export interface SubmitInquiryDeps {
  client?: GuidedBoostClient;
}

/** Builds the new-lead request body from the call record. Non-empty fields only. */
export function buildInquiryPayload(record: CallRecord): Record<string, unknown> {
  const info = record.collectedInfo;
  const body: Record<string, unknown> = {
    source: 'inbound-call',
    retell_call_id: record.retellCallId,
    is_lead: true,
    consultation_requested: record.consultationRequested,
  };
  if (record.callerNumber) body['phone'] = record.callerNumber;
  if (info.name) body['name'] = info.name;
  if (info.email) body['email'] = info.email;
  if (info.destination) body['destination'] = info.destination;
  if (info.travelDates) body['travel_dates'] = info.travelDates;
  if (info.travelers) body['travelers'] = info.travelers;
  if (info.budget) body['budget'] = info.budget;
  if (info.interests) body['interests'] = info.interests;
  if (info.travelStyle) body['travel_style'] = info.travelStyle;
  if (info.inquiry) body['inquiry'] = info.inquiry;
  if (record.bookingFailureReason) body['booking_failed_reason'] = record.bookingFailureReason;
  if (record.requestedExistingConsultant) body['requested_existing_consultant'] = true;
  return body;
}

export async function submitInquiry(
  retellCallId: string,
  repo: CallRepository,
  deps: SubmitInquiryDeps = {},
): Promise<SubmitInquiryResult> {
  const record = await repo.getByRetellCallId(retellCallId);
  if (!record) return { outcome: 'failed' };

  let client: GuidedBoostClient | null;
  try {
    client = deps.client ?? new GuidedBoostClient();
  } catch {
    client = null;
  }

  if (!client) {
    await repo.update(retellCallId, { inquiryStatus: InquiryStatus.CAPTURED });
    await repo.recordLifecycle(retellCallId, LifecycleEvent.LEAD_CAPTURED, { delivery: 'local_only' });
    return { outcome: 'captured' };
  }

  const payload = buildInquiryPayload(record);

  try {
    const created = await client.createLeadFromInboundInquiry(payload);
    const patch: Parameters<CallRepository['update']>[1] = { inquiryStatus: InquiryStatus.SENT };
    if (created.leadId) {
      patch.leadId = created.leadId;
      patch.leadCreated = true;
    }
    await repo.update(retellCallId, patch);
    await repo.recordLifecycle(retellCallId, LifecycleEvent.LEAD_CAPTURED, {
      delivery: 'sent',
      ...(created.leadId ? { leadId: created.leadId } : {}),
    });
    return { outcome: 'sent', ...(created.leadId ? { leadId: created.leadId } : {}) };
  } catch (error) {
    if (error instanceof GuidedBoostError && error.kind === 'unsupported') {
      // New-lead API not configured yet: keep the inquiry locally for follow-up.
      await repo.update(retellCallId, { inquiryStatus: InquiryStatus.CAPTURED });
      await repo.recordLifecycle(retellCallId, LifecycleEvent.LEAD_CAPTURED, { delivery: 'pending_api' });
      return { outcome: 'captured' };
    }
    await repo.recordError(retellCallId, 'inquiry submit failed');
    await repo.update(retellCallId, { inquiryStatus: InquiryStatus.FAILED });
    await repo.recordLifecycle(retellCallId, LifecycleEvent.CRM_UPDATE_FAILED, {
      reason: 'inquiry_submit',
    });
    logger.error(
      { retellCallId, err: error instanceof Error ? error.name : 'unknown' },
      'inquiry submit failed; retained locally',
    );
    return { outcome: 'failed' };
  }
}
