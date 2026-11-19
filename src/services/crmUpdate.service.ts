import { logger } from '../lib/logger.js';
import { LifecycleEvent, type CallRecord } from '../domain/call.js';
import { GuidedBoostClient } from '../integrations/guidedBoost/client.js';
import type { CallRepository } from '../repositories/callRepository.js';

/**
 * Finalizes the Guided Boost CRM update for a completed inbound call: a single
 * call note carrying the summary, outcome, booking result and transcript.
 *
 * Idempotent (guarded by `crmUpdatedAt`) and NON-FATAL: a Guided Boost failure is
 * recorded on the call record and surfaced as a `CRM_UPDATE_FAILED` lifecycle
 * event, but never throws — the completed call record is already safe locally, and
 * failing the webhook would only trigger provider retries that could duplicate the
 * note. (A durable CRM-note retry queue is a documented follow-up.)
 *
 * The booking itself is already recorded in Guided Boost by the booking tool (the
 * appointment + its note); this is the conversation summary/transcript note.
 */

/** Generous bound for the transcript portion of the note; full transcript is kept locally. */
const TRANSCRIPT_NOTE_LIMIT = 15_000;

export interface CrmUpdateDeps {
  client?: GuidedBoostClient;
}

export async function finalizeCrmUpdate(
  retellCallId: string,
  repo: CallRepository,
  deps: CrmUpdateDeps = {},
): Promise<void> {
  const record = await repo.getByRetellCallId(retellCallId);
  if (!record) return;

  // Already delivered — idempotent no-op.
  if (record.crmUpdatedAt) return;

  if (!record.leadId) {
    // Nothing to attach the note to. Record it so it is visible, and mark done so
    // we do not retry forever against a call that never became a lead.
    await repo.recordLifecycle(retellCallId, LifecycleEvent.CRM_UPDATE_FAILED, { reason: 'no_lead' });
    await repo.update(retellCallId, { crmUpdatedAt: new Date().toISOString() });
    logger.warn({ retellCallId }, 'crm update skipped: call has no associated lead');
    return;
  }

  let client: GuidedBoostClient;
  try {
    client = deps.client ?? new GuidedBoostClient();
  } catch (error) {
    await repo.recordError(retellCallId, 'crm update: Guided Boost not configured');
    await repo.recordLifecycle(retellCallId, LifecycleEvent.CRM_UPDATE_FAILED, {
      reason: 'unconfigured',
    });
    logger.error(
      { retellCallId, err: error instanceof Error ? error.name : 'unknown' },
      'crm update: client construction failed',
    );
    return;
  }

  const note = buildCallNote(record);

  try {
    await client.addCallNote(record.leadId, note);
    await repo.update(retellCallId, { crmUpdatedAt: new Date().toISOString() });
    await repo.recordLifecycle(retellCallId, LifecycleEvent.CRM_UPDATED, {
      leadId: record.leadId,
      outcome: record.outcome,
      booking: record.bookingStatus,
    });
    logger.info({ retellCallId, leadId: record.leadId }, 'crm updated with inbound call note');
  } catch (error) {
    await repo.recordError(retellCallId, 'crm update: note delivery failed');
    await repo.recordLifecycle(retellCallId, LifecycleEvent.CRM_UPDATE_FAILED, { reason: 'delivery' });
    logger.error(
      { retellCallId, leadId: record.leadId, err: error instanceof Error ? error.name : 'unknown' },
      'crm update: call note delivery failed; recorded for follow-up',
    );
  }
}

/** Builds the inbound call note. Summary/outcome first; transcript appended. */
export function buildCallNote(record: CallRecord): string {
  const lines: string[] = ['Inbound call (AI agent)'];
  lines.push(`Outcome: ${record.outcome}`);
  if (record.bookingStatus !== 'NONE') lines.push(`Booking: ${record.bookingStatus}`);
  if (record.appointmentId) lines.push(`Appointment: ${record.appointmentId}`);
  if (record.durationMs) lines.push(`Duration: ${Math.round(record.durationMs / 1000)}s`);
  lines.push(`Retell call id: ${record.retellCallId}`);
  if (record.sentiment) lines.push(`Sentiment: ${record.sentiment}`);
  if (record.summary) lines.push('', 'Summary:', record.summary);

  const info = record.collectedInfo;
  const collected = Object.entries(info)
    .filter(([, value]) => typeof value === 'string' && value.length > 0)
    .map(([key, value]) => `- ${key}: ${String(value)}`);
  if (collected.length > 0) lines.push('', 'Collected:', ...collected);

  if (record.transcript) {
    const transcript =
      record.transcript.length > TRANSCRIPT_NOTE_LIMIT
        ? `${record.transcript.slice(0, TRANSCRIPT_NOTE_LIMIT)}\n…[transcript truncated for note; full transcript retained in the inbound service]`
        : record.transcript;
    lines.push('', 'Transcript:', transcript);
  }

  return lines.join('\n');
}
