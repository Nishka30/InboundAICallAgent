import { env, type Env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { maskPhone } from '../lib/phone.js';
import { verifyRetellSignature } from '../integrations/retell/webhookVerify.js';
import {
  inboundHookSchema,
  isLifecycleEvent,
  lifecycleEventSchema,
  readEventName,
  type RetellCallObject,
} from '../integrations/retell/webhookSchemas.js';
import { mapRetellOutcome, readSentiment } from '../integrations/retell/outcomeMap.js';
import {
  BookingStatus,
  CallOutcome,
  CallStatus,
  LifecycleEvent,
  type CallRecord,
} from '../domain/call.js';
import { callRepository, type CallRepository } from '../repositories/callRepository.js';
import { identifyCaller } from './callerIdentification.service.js';
import { finalizeCrmUpdate } from './crmUpdate.service.js';
import type { GuidedBoostClient } from '../integrations/guidedBoost/client.js';

/**
 * Inbound Retell webhook processing.
 *
 * Verifies the signature (fail closed), parses the payload, and dispatches:
 *   - `call_inbound`   → answer synchronously with dynamic variables for the agent
 *                        (best-effort caller greeting; never blocks on Guided Boost).
 *   - `call_started`   → open the call record (lifecycle INBOUND_RECEIVED/CALL_STARTED).
 *   - `call_ended`     → mark ended, capture duration/disconnection.
 *   - `call_analyzed`  → capture transcript/summary/sentiment, finalize the CRM update.
 *
 * Idempotent: each lifecycle event is applied at most once per call id, and status
 * only ever moves forward, so a retried/duplicate delivery is a safe no-op.
 */

export interface InboundWebhookInput {
  rawBody: string;
  signature: string | undefined;
  apiKey?: string | undefined;
  now?: number;
  repo?: CallRepository;
  config?: Env;
  /** Injected for tests; otherwise the CRM finalize step builds its own client. */
  crmClient?: GuidedBoostClient;
}

export interface InboundHookResponse {
  call_inbound: {
    dynamic_variables?: Record<string, string>;
    metadata?: Record<string, string>;
  };
}

export type InboundWebhookResult =
  | { status: 'misconfigured' }
  | { status: 'unauthorized' }
  | { status: 'bad_request' }
  | { status: 'inbound_ack'; response: InboundHookResponse }
  | { status: 'ignored'; event: string }
  | { status: 'processed'; event: string; retellCallId: string; changed: boolean };

export async function processInboundWebhook(
  input: InboundWebhookInput,
): Promise<InboundWebhookResult> {
  const apiKey = input.apiKey ?? env.RETELL_API_KEY;
  const repo = input.repo ?? callRepository;
  const config = input.config ?? env;

  // Fail closed: verification is required.
  if (!apiKey) {
    logger.error('inbound webhook received but RETELL_API_KEY is not configured');
    return { status: 'misconfigured' };
  }
  if (!input.signature) {
    return { status: 'unauthorized' };
  }

  const verified = verifyRetellSignature(input.rawBody, apiKey, input.signature, {
    timeoutMs: config.RETELL_WEBHOOK_REPLAY_WINDOW_MS,
    ...(input.now === undefined ? {} : { now: input.now }),
  });
  if (!verified) {
    return { status: 'unauthorized' };
  }

  let json: unknown;
  try {
    json = JSON.parse(input.rawBody);
  } catch {
    return { status: 'bad_request' };
  }

  const eventName = readEventName(json);
  if (eventName === null) {
    return { status: 'bad_request' };
  }

  if (eventName === 'call_inbound') {
    return handleInboundHook(json, config);
  }

  if (!isLifecycleEvent(eventName)) {
    logger.debug({ event: eventName }, 'ignoring unsupported inbound webhook event');
    return { status: 'ignored', event: eventName };
  }

  const parsed = lifecycleEventSchema.safeParse(json);
  if (!parsed.success) {
    return { status: 'bad_request' };
  }

  return handleLifecycleEvent(parsed.data.event, parsed.data.call, repo, input.crmClient);
}

// --- call_inbound -----------------------------------------------------------

async function handleInboundHook(json: unknown, config: Env): Promise<InboundWebhookResult> {
  const parsed = inboundHookSchema.safeParse(json);
  if (!parsed.success) {
    return { status: 'bad_request' };
  }

  const fromNumber = parsed.data.call_inbound.from_number ?? null;
  const toNumber = parsed.data.call_inbound.to_number ?? null;

  const dynamicVariables: Record<string, string> = {
    agent_name: config.RETELL_AGENT_NAME ?? 'Travel Inbound Agent',
    caller_known: 'no',
  };

  // Best-effort greeting context. Bounded and fully guarded: any failure just
  // leaves the caller as unknown — the hook must return fast and never fail.
  try {
    const identity = await identifyCaller(fromNumber);
    if (identity.personKey ?? identity.leadId) {
      dynamicVariables['caller_known'] = 'yes';
      if (identity.personKey) dynamicVariables['person_key'] = identity.personKey;
      if (identity.leadId) dynamicVariables['lead_id'] = identity.leadId;
      if (identity.name) dynamicVariables['customer_name'] = identity.name;
      if (identity.salesAgentName) dynamicVariables['existing_owner'] = identity.salesAgentName;
    }
  } catch (error) {
    logger.warn(
      { err: error instanceof Error ? error.name : 'unknown' },
      'inbound hook: identification failed; proceeding as unknown caller',
    );
  }

  logger.info(
    {
      caller: maskPhone(fromNumber),
      to: maskPhone(toNumber),
      known: dynamicVariables['caller_known'],
    },
    'inbound hook answered',
  );

  const metadata: Record<string, string> = {};
  if (toNumber) metadata['inbound_number'] = toNumber;

  return {
    status: 'inbound_ack',
    response: {
      call_inbound: {
        dynamic_variables: dynamicVariables,
        ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
      },
    },
  };
}

// --- lifecycle events -------------------------------------------------------

async function handleLifecycleEvent(
  event: string,
  call: RetellCallObject,
  repo: CallRepository,
  crmClient: GuidedBoostClient | undefined,
): Promise<InboundWebhookResult> {
  const retellCallId = call.call_id;

  // Ensure a record exists (idempotent create).
  await repo.createOrGetInbound({
    retellCallId,
    agentId: call.agent_id ?? undefined,
    direction: call.direction ?? 'inbound',
    inboundNumber: call.to_number ?? undefined,
    callerNumber: call.from_number ?? undefined,
  });

  // Idempotency: apply each event type at most once per call.
  const first = await repo.markEventProcessed(retellCallId, event);
  if (!first) {
    logger.debug({ event, retellCallId }, 'duplicate inbound webhook event ignored');
    return { status: 'processed', event, retellCallId, changed: false };
  }

  if (event === 'call_started') {
    await repo.recordLifecycle(retellCallId, LifecycleEvent.INBOUND_RECEIVED, {
      inboundNumber: call.to_number ?? null,
    });
    await repo.advanceStatus(retellCallId, CallStatus.IN_PROGRESS);
    const patch: Parameters<CallRepository['update']>[1] = {};
    if (call.start_timestamp) patch.startedAt = new Date(call.start_timestamp).toISOString();
    await repo.update(retellCallId, patch);
    await repo.recordLifecycle(retellCallId, LifecycleEvent.CALL_STARTED, {
      agentId: call.agent_id ?? null,
    });
    logger.info({ event, retellCallId }, 'inbound call started');
    return { status: 'processed', event, retellCallId, changed: true };
  }

  if (event === 'call_ended') {
    await repo.advanceStatus(retellCallId, CallStatus.ENDED);
    const patch: Parameters<CallRepository['update']>[1] = {};
    if (call.end_timestamp) patch.endedAt = new Date(call.end_timestamp).toISOString();
    if (typeof call.duration_ms === 'number') patch.durationMs = call.duration_ms;
    if (call.disconnection_reason) patch.disconnectionReason = call.disconnection_reason;
    await repo.update(retellCallId, patch);
    await repo.recordLifecycle(retellCallId, LifecycleEvent.CALL_ENDED, {
      disconnectionReason: call.disconnection_reason ?? null,
    });
    logger.info({ event, retellCallId }, 'inbound call ended');
    return { status: 'processed', event, retellCallId, changed: true };
  }

  // call_analyzed: capture artifacts and finalize the CRM update.
  await repo.advanceStatus(retellCallId, CallStatus.ANALYZED);
  const patch: Parameters<CallRepository['update']>[1] = {};
  if (typeof call.transcript === 'string' && call.transcript.length > 0) {
    patch.transcript = call.transcript;
  }
  const summary = call.call_analysis?.call_summary;
  if (typeof summary === 'string' && summary.length > 0) patch.summary = summary;
  const sentiment = readSentiment(call);
  if (sentiment) patch.sentiment = sentiment;
  if (typeof call.recording_url === 'string' && call.recording_url.length > 0) {
    patch.recordingUrl = call.recording_url;
  }
  if (call.end_timestamp) patch.endedAt = new Date(call.end_timestamp).toISOString();

  // Refine the outcome, but never downgrade a confirmed booking.
  const record = await repo.getByRetellCallId(retellCallId);
  patch.outcome = refineOutcome(record, call);

  await repo.update(retellCallId, patch);
  await repo.recordLifecycle(retellCallId, LifecycleEvent.CALL_ANALYZED, {
    sentiment: sentiment ?? null,
    hasTranscript: Boolean(patch.transcript),
  });

  await finalizeCrmUpdate(retellCallId, repo, crmClient ? { client: crmClient } : {});

  logger.info({ event, retellCallId }, 'inbound call analyzed and CRM finalized');
  return { status: 'processed', event, retellCallId, changed: true };
}

function refineOutcome(
  record: CallRecord | undefined,
  call: RetellCallObject,
): CallRecord['outcome'] {
  if (record?.bookingStatus === BookingStatus.CONFIRMED) return CallOutcome.BOOKED;
  const mapped = mapRetellOutcome(call);
  if (mapped !== CallOutcome.UNKNOWN) return mapped;
  // A completed conversation with no booking: information was provided.
  if (call.call_analysis?.call_successful === true) return CallOutcome.INFORMATION_PROVIDED;
  return record?.outcome ?? CallOutcome.UNKNOWN;
}
