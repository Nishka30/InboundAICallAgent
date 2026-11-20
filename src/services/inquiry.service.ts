import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { BookingStatus, InquiryStatus, LifecycleEvent, type CallRecord } from '../domain/call.js';
import { GuidedBoostClient } from '../integrations/guidedBoost/client.js';
import type {
  ConsultationStatus,
  SubmitInboundInquiryInput,
} from '../integrations/guidedBoost/client.js';
import type { CallRepository } from '../repositories/callRepository.js';

/**
 * Captures an inbound inquiry and submits it to the Guided Boost new-inquiry API
 * (`POST /api/caller/inbound/inquiries`, "A NEW INQUIRY", API 2) so the team can
 * follow up. It is the business path for a new caller who does NOT want a
 * consultant, a caller whose booking could not be completed, and an existing
 * guest's new question — a VALID outcome, not a failure.
 *
 * Behaviour:
 *   - Builds the request from the local call record (only real values; never empty
 *     strings) and sends it. `created: true` or `created: false` are BOTH success
 *     (the API dedups identical/recent inquiries within 30 minutes), so retries are
 *     safe and we do not add a second deduplication mechanism.
 *   - On success → stores the returned lead/person ids + owner on the call record,
 *     marks the inquiry SENT, and emits LEAD_CAPTURED.
 *   - On failure → retains the inquiry locally (inquiryStatus FAILED), records a
 *     CRM failure for retry, and never throws — the call completes normally.
 */

export type SubmitInquiryOutcome = 'sent' | 'captured' | 'failed';

export interface SubmitInquiryResult {
  outcome: SubmitInquiryOutcome;
  leadId?: string;
}

export interface SubmitInquiryDeps {
  client?: GuidedBoostClient;
  /** Brand override; defaults to the configured GUIDED_BOOST_BRAND. */
  brand?: string;
}

/** Derives the consultation_status for the inquiry from the call record state. */
function deriveConsultationStatus(record: CallRecord): ConsultationStatus {
  if (record.bookingStatus === BookingStatus.CONFIRMED) return 'booked';
  if (record.bookingStatus === BookingStatus.FAILED) return 'booking_failed';
  if (record.consultationRequested) return 'requested';
  return 'not_requested';
}

/** Extracts a traveler count from free-text (e.g. "2 adults" → 2). */
function parseTravelers(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const match = value.match(/\d+/);
  if (!match) return undefined;
  const n = Number(match[0]);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** Builds the Guided Boost inquiry request from the call record. Non-empty only. */
export function buildInquiryInput(record: CallRecord, brand: string): SubmitInboundInquiryInput {
  const info = record.collectedInfo;

  const preferences = [info.interests, info.travelStyle].filter(Boolean).join('; ');
  const travelers = parseTravelers(info.travelers);

  const noteParts: string[] = [];
  if (info.inquiry) noteParts.push(info.inquiry);
  if (record.bookingStatus === BookingStatus.FAILED && record.bookingFailureReason) {
    noteParts.push(`Consultation booking could not be completed: ${record.bookingFailureReason}`);
  }
  if (record.requestedExistingConsultant) {
    noteParts.push('Caller asked to speak with their existing consultant.');
  }
  const notes = noteParts.join('\n');

  const input: SubmitInboundInquiryInput = {
    brand,
    phone: record.callerNumber ?? null,
    email: info.email ?? null,
    consultationStatus: deriveConsultationStatus(record),
    callId: record.retellCallId,
  };
  if (info.name) input.name = info.name;
  if (info.destination) input.destination = info.destination;
  if (info.travelDates) input.travelDates = info.travelDates;
  if (travelers !== undefined) input.travelers = travelers;
  if (info.budget) input.budget = info.budget;
  if (preferences.length > 0) input.preferences = preferences;
  if (notes.length > 0) input.notes = notes;
  if (info.timezone) input.timeZone = info.timezone;
  if (record.summary) input.summary = record.summary;
  if (record.transcript) input.transcript = record.transcript;
  if (record.recordingUrl) input.recordingUrl = record.recordingUrl;
  if (record.startedAt) input.startedAt = record.startedAt;
  if (record.endedAt) input.endedAt = record.endedAt;
  return input;
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
    // Guided Boost not configured: keep the inquiry locally for follow-up.
    await repo.update(retellCallId, { inquiryStatus: InquiryStatus.CAPTURED });
    await repo.recordLifecycle(retellCallId, LifecycleEvent.LEAD_CAPTURED, {
      delivery: 'local_only',
    });
    return { outcome: 'captured' };
  }

  const input = buildInquiryInput(record, deps.brand ?? env.GUIDED_BOOST_BRAND);

  try {
    const result = await client.submitInboundInquiry(input);

    // `created: false` is a SUCCESSFUL idempotent outcome (an existing recent lead
    // was updated) — never treated as an error, and no second local lead is created.
    const patch: Parameters<CallRepository['update']>[1] = { inquiryStatus: InquiryStatus.SENT };
    if (result.lead_id && !record.leadId) {
      patch.leadId = result.lead_id;
      patch.leadCreated = result.created === true;
    }
    if (result.person_key && !record.personKey) patch.personKey = result.person_key;
    if (result.owner?.name && !record.ownerName) patch.ownerName = result.owner.name;
    if (result.owner?.email && !record.ownerEmail) patch.ownerEmail = result.owner.email;
    await repo.update(retellCallId, patch);

    await repo.recordLifecycle(retellCallId, LifecycleEvent.LEAD_CAPTURED, {
      delivery: 'sent',
      created: result.created === true,
      ...(result.lead_id ? { leadId: result.lead_id } : {}),
      ...(result.person_id ? { personId: result.person_id } : {}),
      ...(typeof result.known_person === 'boolean' ? { knownPerson: result.known_person } : {}),
    });

    return { outcome: 'sent', ...(result.lead_id ? { leadId: result.lead_id } : {}) };
  } catch (error) {
    // Preserve locally; mark for CRM retry. The call still completes normally.
    await repo.recordError(retellCallId, 'inquiry submit failed');
    await repo.update(retellCallId, { inquiryStatus: InquiryStatus.FAILED });
    await repo.recordLifecycle(retellCallId, LifecycleEvent.CRM_UPDATE_FAILED, {
      reason: 'inquiry_submit',
    });
    logger.error(
      { retellCallId, err: error instanceof Error ? error.name : 'unknown' },
      'inquiry submit failed; retained locally for retry',
    );
    return { outcome: 'failed' };
  }
}
