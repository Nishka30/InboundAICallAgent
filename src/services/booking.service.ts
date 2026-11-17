import { requireGuidedBoostConfig } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { formatSlotLocal, normalizeTimezone, timezoneLabel, zonedDateRangeUtc } from '../lib/timezone.js';
import { isMeetingType, type MeetingType } from '../domain/call.js';
import { GuidedBoostClient } from '../integrations/guidedBoost/client.js';
import { GuidedBoostError } from '../integrations/guidedBoost/errors.js';

/**
 * Inbound booking flow — reuses the SAME validated Guided Boost calendar contract
 * as the outbound system (`team-slots` + `appointments/team`), so there is only one
 * booking implementation. Meeting types are restricted to phone/whatsapp/video and
 * a booking is only ever reported successful when Guided Boost actually returns an
 * appointment (`booked === true` semantics).
 *
 * The slot lookup is INTERACTIVE (the caller is on the line), so it uses a short
 * timeout and NO retries: a slow upstream degrades to a spoken fallback rather than
 * a ~40s silence. The booking WRITE stays single-shot.
 */

const INTERACTIVE_TIMEOUT_MS = 8_000;
const SLOT_LIMIT = 3;

export interface OfferedSlot {
  starts_at: string;
  local: string;
}

export type GetSlotsResult =
  | { available: true; timezone: string; timezone_label: string; slots: OfferedSlot[] }
  | { available: false; needs_timezone?: true; needs_date?: true; reason: string };

export interface GetSlotsInput {
  leadId: string;
  timezone: string;
  date?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
}

export interface BookInput {
  leadId: string;
  confirmed: boolean;
  startsAt: string;
  meetingType: MeetingType;
  timezone?: string | undefined;
  /** A timezone already captured earlier in the call, used when the arg is absent. */
  fallbackTimezone?: string | undefined;
  note: string;
}

export type BookResult =
  | {
      booked: true;
      appointment_id: string;
      consultant?: string;
      starts_at_local?: string;
      meeting_type: MeetingType;
    }
  | { booked: false; reason: string; needs_timezone?: true };

export interface BookingDeps {
  /** Injected for tests; otherwise an interactive (short-timeout) client is built. */
  client?: GuidedBoostClient;
}

function interactiveClient(deps: BookingDeps): GuidedBoostClient {
  if (deps.client) return deps.client;
  const config = requireGuidedBoostConfig();
  return new GuidedBoostClient({
    config: { ...config, timeoutMs: INTERACTIVE_TIMEOUT_MS, maxRetries: 0 },
  });
}

/** Looks up availability in the customer's timezone. Never throws. */
export async function getAvailableSlots(
  input: GetSlotsInput,
  deps: BookingDeps = {},
): Promise<GetSlotsResult> {
  const tz = normalizeTimezone(input.timezone);
  if (tz === null) {
    return {
      available: false,
      needs_timezone: true,
      reason:
        'I need the customer’s timezone in a standard form (for example “Asia/Kolkata”). Please confirm their city or country.',
    };
  }

  // A single date is interpreted in the customer's zone; an explicit range is
  // forwarded as-is; otherwise Guided Boost's default window is used.
  let range: { from?: string; to?: string } = {};
  if (input.date !== undefined) {
    const computed = zonedDateRangeUtc(input.date, tz);
    if (computed === null) {
      return {
        available: false,
        needs_date: true,
        reason: 'I didn’t catch a valid date. Which day works (for example 2026-11-20)?',
      };
    }
    range = computed;
  } else {
    if (input.from !== undefined && !Number.isNaN(Date.parse(input.from))) range.from = input.from;
    if (input.to !== undefined && !Number.isNaN(Date.parse(input.to))) range.to = input.to;
  }

  let slots;
  try {
    ({ slots } = await interactiveClient(deps).getTeamSlots(input.leadId, tz, range));
  } catch (error) {
    logger.error(
      { leadId: input.leadId, err: errName(error) },
      'booking: slots lookup failed; returning spoken fallback',
    );
    return {
      available: false,
      reason:
        'I could not look up available times just now. Take the customer’s details and let them know a consultant will follow up.',
    };
  }

  if (slots.length === 0) {
    return {
      available: false,
      reason: input.date
        ? 'No consultant is available that day. Ask the customer for another day.'
        : 'No consultant is currently available. Take the customer’s details for follow-up.',
    };
  }

  const offered: OfferedSlot[] = slots.slice(0, SLOT_LIMIT).map((s) => ({
    starts_at: s.starts_at,
    local: formatSlotLocal(s.starts_at, tz) ?? s.starts_at,
  }));

  return { available: true, timezone: tz, timezone_label: timezoneLabel(tz), slots: offered };
}

/**
 * Books the consultation. Re-validates the chosen slot against FRESH availability,
 * so a stale slot is never booked, and reports success ONLY when Guided Boost
 * returns an appointment.
 */
export async function bookConsultation(input: BookInput, deps: BookingDeps = {}): Promise<BookResult> {
  if (input.confirmed !== true) {
    return {
      booked: false,
      reason: 'Please confirm the destination and time with the customer before booking.',
    };
  }

  if (!isMeetingType(input.meetingType)) {
    return { booked: false, reason: 'That consultation type is not supported.' };
  }

  const tz = normalizeTimezone(input.timezone) ?? normalizeTimezone(input.fallbackTimezone);
  if (tz === null) {
    return {
      booked: false,
      needs_timezone: true,
      reason:
        'I need the customer’s timezone in a standard form (for example “Asia/Kolkata”) before I can book.',
    };
  }

  const client = interactiveClient(deps);

  // Re-read fresh availability and confirm the chosen slot is still offered.
  let slots;
  try {
    ({ slots } = await client.getTeamSlots(input.leadId, tz));
  } catch (error) {
    logger.error(
      { leadId: input.leadId, err: errName(error) },
      'booking: availability re-check failed; not booking',
    );
    return {
      booked: false,
      reason:
        'I could not check availability just now. Take the customer’s details and let them know a consultant will follow up.',
    };
  }

  const stillOffered = slots.some((s) => s.starts_at === input.startsAt);
  if (!stillOffered) {
    return {
      booked: false,
      reason: 'That time is no longer available. Offer the customer another time and try again.',
    };
  }

  let result;
  try {
    result = await client.bookTeamAppointment({
      leadId: input.leadId,
      startsAt: input.startsAt,
      meetingType: input.meetingType,
      customerTz: tz,
      notes: input.note,
    });
  } catch (error) {
    // Uncertain / failed upstream: never claim success, never auto-rebook.
    const uncertain = error instanceof GuidedBoostError && error.retryable;
    logger.error(
      { leadId: input.leadId, uncertain, err: errName(error) },
      'booking: appointment write failed',
    );
    return {
      booked: false,
      reason: uncertain
        ? 'The booking is still being confirmed. Tell the customer it will be finalised and they will get a confirmation shortly; do not try to book again.'
        : 'I could not complete the booking just now. Take the customer’s details for follow-up.',
    };
  }

  if (!result.appointmentId) {
    return {
      booked: false,
      reason: 'The booking was not confirmed. Offer the customer a follow-up instead.',
    };
  }

  const local = formatSlotLocal(input.startsAt, tz);
  return {
    booked: true,
    appointment_id: result.appointmentId,
    meeting_type: input.meetingType,
    ...(result.agentName ? { consultant: result.agentName } : {}),
    ...(local ? { starts_at_local: local } : {}),
  };
}

function errName(error: unknown): string {
  return error instanceof Error ? error.name : 'unknown';
}
