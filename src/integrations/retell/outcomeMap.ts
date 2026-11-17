import { CallOutcome, type CallOutcomeName } from '../../domain/call.js';
import type { RetellCallObject } from './webhookSchemas.js';

/**
 * Maps a Retell call object to an inbound business outcome, CONSERVATIVELY.
 *
 * Telephony-evident outcomes (voicemail) are mapped. Everything a model could
 * only *infer* — interested / not interested, whether information was enough —
 * defaults to UNKNOWN so a call is only ever under-classified for human review,
 * never mislabelled. Booking success is set by the booking tool itself (the
 * authoritative `booked === true`), never guessed from analysis here.
 */
export function mapRetellOutcome(call: RetellCallObject): CallOutcomeName {
  if (call.call_analysis?.in_voicemail === true) {
    return CallOutcome.VOICEMAIL;
  }

  const reason = (call.disconnection_reason ?? '').toLowerCase();
  if (reason.includes('voicemail')) return CallOutcome.VOICEMAIL;
  if (reason.includes('dial_failed') || reason.includes('error')) return CallOutcome.FAILED;

  // A completed conversation with no booking is left UNKNOWN here; the lifecycle /
  // CRM step refines it to INFORMATION_PROVIDED / NO_BOOKING using what the tools
  // actually recorded (a booking, a callback request), not a guess.
  return CallOutcome.UNKNOWN;
}

/** Extracts the sentiment label when present, else undefined. */
export function readSentiment(call: RetellCallObject): string | undefined {
  const sentiment = call.call_analysis?.user_sentiment;
  return typeof sentiment === 'string' && sentiment.length > 0 ? sentiment : undefined;
}
