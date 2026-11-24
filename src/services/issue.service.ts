import { logger } from '../lib/logger.js';
import { LifecycleEvent, type CallRecord } from '../domain/call.js';
import { GuidedBoostClient } from '../integrations/guidedBoost/client.js';
import type {
  IssueKind,
  IssueUrgency,
  SubmitInboundIssueInput,
} from '../integrations/guidedBoost/client.js';
import type { CallRepository } from '../repositories/callRepository.js';

/**
 * Logs an existing guest's issue to Guided Boost (`POST /api/caller/inbound/issues`,
 * "AN ISSUE ON AN EXISTING GUEST", API 3). Guided Boost writes the issue to the
 * guest's lead, emails the assigned agent (admins too when urgent, or when there is
 * no agent), and creates a lead if the caller had none — so the issue is never lost.
 *
 * This is the SINGLE issue/escalation path (it replaces the old CRM-note escalation
 * service). It never throws: on any failure the issue is preserved locally, a CRM
 * failure is recorded for retry, and the call completes normally.
 */

export interface SubmitIssueParams {
  issue: string;
  kind: IssueKind;
  urgency: IssueUrgency;
}

export interface SubmitIssueResult {
  outcome: 'sent' | 'failed';
  leadId?: string;
  alertSent?: boolean;
  leadCreated?: boolean;
}

export interface SubmitIssueDeps {
  client?: GuidedBoostClient;
  /** Brand override; defaults to the configured GUIDED_BOOST_BRAND. */
  brand?: string;
}

/** Builds the Guided Boost issue request from the call record. Non-empty only. */
export function buildIssueInput(
  record: CallRecord,
  params: SubmitIssueParams,
  brand: string,
): SubmitInboundIssueInput {
  const input: SubmitInboundIssueInput = {
    brand,
    issue: params.issue,
    kind: params.kind,
    urgency: params.urgency,
    phone: record.callerNumber ?? null,
    leadId: record.leadId ?? null,
    callId: record.retellCallId,
  };
  if (record.collectedInfo.email) input.email = record.collectedInfo.email;
  if (record.summary) input.summary = record.summary;
  if (record.transcript) input.transcript = record.transcript;
  return input;
}

export async function submitIssue(
  retellCallId: string,
  repo: CallRepository,
  params: SubmitIssueParams,
  deps: SubmitIssueDeps = {},
): Promise<SubmitIssueResult> {
  const record = await repo.getByRetellCallId(retellCallId);
  if (!record) return { outcome: 'failed' };
  const urgent = params.urgency === 'urgent';

  let client: GuidedBoostClient | null;
  try {
    client = deps.client ?? new GuidedBoostClient();
  } catch {
    client = null;
  }

  if (!client) {
    await repo.recordLifecycle(retellCallId, LifecycleEvent.EXISTING_LEAD_ISSUE, {
      kind: params.kind,
      urgent,
      delivery: 'local_only',
    });
    await repo.recordError(retellCallId, 'issue submit: Guided Boost not configured');
    return { outcome: 'failed' };
  }

  // The persisted call-record brand is the source of truth; an explicit dep wins.
  const input = buildIssueInput(record, params, deps.brand ?? record.brand);

  try {
    const result = await client.submitInboundIssue(input);
    if (result.ok !== true) {
      return await recordFailure(repo, retellCallId, params, urgent);
    }

    const patch: Parameters<CallRepository['update']>[1] = {};
    if (result.lead_id && !record.leadId) {
      patch.leadId = result.lead_id;
      patch.leadResolved = true;
      patch.leadCreated = result.lead_created === true;
    }
    if (result.owner?.name && !record.ownerName) patch.ownerName = result.owner.name;
    if (result.owner?.email && !record.ownerEmail) patch.ownerEmail = result.owner.email;
    if (Object.keys(patch).length > 0) await repo.update(retellCallId, patch);

    const alertSent = result.alert_sent === true;
    const leadCreated = result.lead_created === true;
    const adminCopied = Array.isArray(result.alerted?.cc) && result.alerted.cc.length > 0;

    await repo.recordLifecycle(retellCallId, LifecycleEvent.EXISTING_LEAD_ISSUE, {
      kind: params.kind,
      urgent,
      delivery: 'sent',
      alertSent,
      leadCreated,
      ...(result.lead_id ? { leadId: result.lead_id } : {}),
    });
    if (urgent) {
      await repo.recordLifecycle(retellCallId, LifecycleEvent.URGENT_ESCALATION, {
        alertSent,
        adminCopied,
        via: 'guided_boost',
      });
    }

    return {
      outcome: 'sent',
      ...(result.lead_id ? { leadId: result.lead_id } : {}),
      alertSent,
      leadCreated,
    };
  } catch (error) {
    logger.error(
      { retellCallId, err: error instanceof Error ? error.name : 'unknown' },
      'issue submit failed; retained locally for retry',
    );
    return recordFailure(repo, retellCallId, params, urgent);
  }
}

/** Preserves the issue locally and marks the CRM operation failed (for retry). */
async function recordFailure(
  repo: CallRepository,
  retellCallId: string,
  params: SubmitIssueParams,
  urgent: boolean,
): Promise<SubmitIssueResult> {
  await repo.recordError(retellCallId, 'issue submit failed');
  await repo.recordLifecycle(retellCallId, LifecycleEvent.EXISTING_LEAD_ISSUE, {
    kind: params.kind,
    urgent,
    delivery: 'local_only',
  });
  await repo.recordLifecycle(retellCallId, LifecycleEvent.CRM_UPDATE_FAILED, {
    reason: 'issue_submit',
  });
  return { outcome: 'failed' };
}
