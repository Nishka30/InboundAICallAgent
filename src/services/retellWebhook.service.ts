import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { verifyRetellSignature } from '../integrations/retell/webhookVerify.js';

/**
 * Placeholder inbound Retell webhook processing.
 *
 * SCOPE FOR THIS STEP: verify the signature, parse the envelope, and acknowledge
 * — NO inbound call lifecycle, caller identification, intent detection, or CRM
 * integration is implemented yet. Those land in later steps.
 *
 * Security posture mirrors CallScheduler and FAILS CLOSED:
 *   - no API key configured            -> `misconfigured` (handler returns 503)
 *   - missing / invalid signature      -> `unauthorized`  (handler returns 401)
 *   - unparseable body                 -> `bad_request`   (handler returns 400)
 *   - verified, recognised or not      -> `acknowledged`  (handler returns 204)
 *
 * Verification runs over the EXACT raw bytes Retell sent, so the route must use a
 * raw body parser mounted before any JSON parser.
 */

export type RetellWebhookResult =
  | { status: 'misconfigured' }
  | { status: 'unauthorized' }
  | { status: 'bad_request' }
  | { status: 'acknowledged'; event: string | null };

export interface RetellWebhookInput {
  rawBody: string;
  signature?: string | undefined;
  apiKey?: string | undefined;
  /** Injected for tests. */
  now?: number;
}

/** Minimal envelope shape we read for logging. Full typing lands with the lifecycle. */
interface RetellEnvelope {
  event?: unknown;
  call?: { call_id?: unknown; call_type?: unknown } | undefined;
}

export function processRetellWebhook(input: RetellWebhookInput): RetellWebhookResult {
  const apiKey = input.apiKey ?? env.RETELL_API_KEY;

  // Fail closed: verification is required but no secret is configured.
  if (!apiKey) {
    logger.error('Retell webhook received but RETELL_API_KEY is not configured');
    return { status: 'misconfigured' };
  }

  if (!input.signature) {
    return { status: 'unauthorized' };
  }

  const verified = verifyRetellSignature(input.rawBody, apiKey, input.signature, {
    timeoutMs: env.RETELL_WEBHOOK_REPLAY_WINDOW_MS,
    ...(input.now === undefined ? {} : { now: input.now }),
  });

  if (!verified) {
    return { status: 'unauthorized' };
  }

  let envelope: RetellEnvelope;
  try {
    envelope = JSON.parse(input.rawBody) as RetellEnvelope;
  } catch {
    return { status: 'bad_request' };
  }

  const event = typeof envelope.event === 'string' ? envelope.event : null;

  // Placeholder: acknowledge the verified event without acting on it. A later
  // step dispatches inbound call lifecycle events (e.g. call_inbound,
  // call_started, call_ended, call_analyzed) to the call pipeline.
  logger.info(
    { event, callType: envelope.call?.call_type ?? null },
    'retell webhook received (placeholder, not processed)',
  );

  return { status: 'acknowledged', event };
}
