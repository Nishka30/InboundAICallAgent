import { logger } from '../lib/logger.js';
import { LifecycleEvent } from '../domain/call.js';
import { GuidedBoostClient } from '../integrations/guidedBoost/client.js';
import type { SubmitInboundCallInput } from '../integrations/guidedBoost/client.js';
import type { CallRepository } from '../repositories/callRepository.js';

/**
 * Sends the call-level record to Guided Boost (`POST /api/caller/inbound/calls`,
 * API 4) at the end of every inbound call, so the CRM's Inbound Calls page has a
 * row even when no lead/inquiry/issue was created.
 *
 * Called from the `call_analyzed` handler, inside the per-event idempotency guard,
 * so it fires at most once per call (a redelivered lifecycle event is a no-op). The
 * CRM endpoint is also keyed by `call_id`, so a duplicate is a safe upsert. It never
 * throws: a delivery failure is recorded in the lifecycle/errors and the durable
 * Neon record remains the source of truth for diagnostics.
 */

export interface SendCallRecordDeps {
  client?: GuidedBoostClient;
  /** Brand override; defaults to the brand resolved from the dialed number. */
  brand?: string;
}

export async function sendCallRecord(
  retellCallId: string,
  repo: CallRepository,
  deps: SendCallRecordDeps = {},
): Promise<{ sent: boolean }> {
  const record = await repo.getByRetellCallId(retellCallId);
  if (!record) return { sent: false };

  let client: GuidedBoostClient | null;
  try {
    client = deps.client ?? new GuidedBoostClient();
  } catch {
    client = null;
  }

  if (!client) {
    await repo.recordError(retellCallId, 'call record: Guided Boost not configured');
    await repo.recordLifecycle(retellCallId, LifecycleEvent.CRM_UPDATE_FAILED, {
      reason: 'call_record',
      detail: 'unconfigured',
    });
    return { sent: false };
  }

  const input: SubmitInboundCallInput = {
    // The persisted call-record brand is the source of truth; an explicit dep wins.
    brand: deps.brand ?? record.brand,
    callId: record.retellCallId,
    outcome: record.outcome,
  };
  if (record.summary) input.summary = record.summary;
  if (record.transcript) input.transcript = record.transcript;
  if (record.recordingUrl) input.recordingUrl = record.recordingUrl;
  if (record.startedAt) input.startedAt = record.startedAt;
  if (record.endedAt) input.endedAt = record.endedAt;

  try {
    const result = await client.submitInboundCall(input);
    await repo.recordLifecycle(retellCallId, LifecycleEvent.CRM_UPDATED, {
      target: 'call_record',
      created: result.created === true,
    });
    logger.info({ retellCallId }, 'call record sent to CRM');
    return { sent: true };
  } catch (error) {
    await repo.recordError(retellCallId, 'call record delivery failed');
    await repo.recordLifecycle(retellCallId, LifecycleEvent.CRM_UPDATE_FAILED, {
      reason: 'call_record',
    });
    logger.error(
      { retellCallId, err: error instanceof Error ? error.name : 'unknown' },
      'call record delivery failed; retained locally in Neon for retry',
    );
    return { sent: false };
  }
}
