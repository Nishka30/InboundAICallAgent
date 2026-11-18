import { z } from 'zod';

/**
 * Defensive schemas for the Retell webhook payloads the INBOUND service receives.
 *
 * Two distinct payload families arrive on the webhook endpoint:
 *
 *  1. `call_inbound` — the inbound-call hook Retell fires when a PSTN call reaches
 *     the configured number, BEFORE the call object exists. It carries the caller
 *     and destination numbers; we answer it synchronously with the dynamic
 *     variables / agent the agent should use. There is no `call_id` yet.
 *
 *  2. The voice lifecycle events `call_started`, `call_ended`, `call_analyzed` —
 *     envelope `{ event, call }` with `call.call_id`, matching the shape verified
 *     in CallScheduler against Retell SDK v6.2.6 and the official webhook docs.
 *
 * Only fields we actually use are typed; everything else is preserved by
 * `.passthrough()` rather than invented.
 */

/** Voice lifecycle events this service acts on. */
export const SUPPORTED_LIFECYCLE_EVENTS = ['call_started', 'call_ended', 'call_analyzed'] as const;
export type SupportedLifecycleEvent = (typeof SUPPORTED_LIFECYCLE_EVENTS)[number];

export function isLifecycleEvent(event: string): event is SupportedLifecycleEvent {
  return (SUPPORTED_LIFECYCLE_EVENTS as readonly string[]).includes(event);
}

const callAnalysisSchema = z
  .object({
    call_successful: z.boolean().nullish(),
    call_summary: z.string().nullish(),
    in_voicemail: z.boolean().nullish(),
    user_sentiment: z.string().nullish(),
    custom_analysis_data: z.record(z.unknown()).nullish(),
  })
  .passthrough();

const callObjectSchema = z
  .object({
    call_id: z.string().min(1),
    call_type: z.string().nullish(),
    call_status: z.string().nullish(),
    direction: z.string().nullish(),
    agent_id: z.string().nullish(),
    agent_version: z.number().int().nullish(),
    from_number: z.string().nullish(),
    to_number: z.string().nullish(),
    disconnection_reason: z.string().nullish(),
    start_timestamp: z.number().int().nonnegative().nullish(),
    end_timestamp: z.number().int().nonnegative().nullish(),
    duration_ms: z.number().int().nonnegative().nullish(),
    call_analysis: callAnalysisSchema.nullish(),
    transcript: z.string().nullish(),
    transcript_object: z.array(z.unknown()).nullish(),
    transcript_with_tool_calls: z.array(z.unknown()).nullish(),
    recording_url: z.string().nullish(),
    public_log_url: z.string().nullish(),
    metadata: z.record(z.unknown()).nullish(),
    retell_llm_dynamic_variables: z.record(z.unknown()).nullish(),
  })
  .passthrough();

export type RetellCallObject = z.infer<typeof callObjectSchema>;

/** Lifecycle envelope: `{ event, call }`. `call_id` is the idempotency key. */
export const lifecycleEventSchema = z
  .object({
    event: z.string().min(1),
    call: callObjectSchema,
  })
  .passthrough();

export type LifecycleWebhookEvent = z.infer<typeof lifecycleEventSchema>;

/**
 * `call_inbound` hook envelope. The nested object carries the numbers and an
 * optional agent id; there is no call object yet. Kept permissive.
 */
export const inboundHookSchema = z
  .object({
    event: z.literal('call_inbound'),
    call_inbound: z
      .object({
        agent_id: z.string().nullish(),
        from_number: z.string().nullish(),
        to_number: z.string().nullish(),
      })
      .passthrough(),
  })
  .passthrough();

export type InboundHookEvent = z.infer<typeof inboundHookSchema>;

/** Reads just the `event` discriminator from an already-parsed JSON value. */
export function readEventName(json: unknown): string | null {
  if (json && typeof json === 'object' && 'event' in json) {
    const value: unknown = json.event;
    return typeof value === 'string' ? value : null;
  }
  return null;
}
