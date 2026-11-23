import { requireGuidedBoostConfig } from '../config/env.js';
import { logger } from '../lib/logger.js';
import {
  formatSlotLocal,
  localDateKey,
  localDayLabel,
  localTimeLabel,
  normalizeTimezone,
  timezoneLabel,
} from '../lib/timezone.js';
import { isMeetingType, type MeetingType } from '../domain/call.js';
import { GuidedBoostClient } from '../integrations/guidedBoost/client.js';
import { GuidedBoostError } from '../integrations/guidedBoost/errors.js';
import type { TeamSlot } from '../integrations/guidedBoost/schemas.js';

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
/** How many distinct DATES to offer first, and how many TIMES within a chosen date. */
const DATE_LIMIT = 3;
const TIME_LIMIT = 4;

/** One offered DATE (step 1: "which day works?"). */
export interface OfferedDate {
  date: string; // YYYY-MM-DD in the customer's zone
  label: string; // e.g. "Monday, Nov 24"
  times_available: number;
}

/** One offered TIME within a chosen date (step 2: "which time?"). */
export interface OfferedTime {
  /** The exact UTC instant to pass to book_consultation — never computed locally. */
  starts_at: string;
  local: string; // e.g. "Mon, Nov 24, 10:00 AM"
  time: string; // e.g. "10:00 AM"
}

export type GetSlotsResult =
  | {
      available: true;
      mode: 'dates';
      timezone: string;
      timezone_label: string;
      dates: OfferedDate[];
    }
  | {
      available: true;
      mode: 'times';
      timezone: string;
      timezone_label: string;
      date: string;
      day_label: string;
      slots: OfferedTime[];
    }
  | { available: false; needs_timezone?: true; needs_date?: true; reason: string };

export interface GetSlotsInput {
  leadId: string;
  timezone: string;
  /** When set, return the TIMES for this local date; otherwise offer available DATES. */
  date?: string | undefined;
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

/**
 * Looks up availability in the customer's timezone and returns it in a DATE-first
 * shape. Never throws.
 *
 * It always fetches the CRM's full upcoming window (`GET team-slots?tz=…`, with NO
 * `from`/`to`, so the CRM returns its ~14 days), then:
 *   - with NO `date`: offers the next few available DATES ("which day works?");
 *   - with a `date`: offers the TIMES on that local date ("which time?").
 * Each offered time carries the exact CRM `starts_at`, so booking never invents a time.
 */
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

  // Full upcoming window — tz only, no from/to (the CRM returns ~14 days).
  let slots: TeamSlot[];
  try {
    ({ slots } = await interactiveClient(deps).getTeamSlots(input.leadId, tz));
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
      reason: 'No consultant is currently available. Take the customer’s details for follow-up.',
    };
  }

  // Group the window by the customer's local date, in chronological order.
  const byDate = new Map<string, TeamSlot[]>();
  for (const slot of slots) {
    const key = localDateKey(slot.starts_at, tz);
    if (!key) continue;
    const bucket = byDate.get(key);
    if (bucket) bucket.push(slot);
    else byDate.set(key, [slot]);
  }
  const dateKeys = [...byDate.keys()].sort();

  // Step 2 — TIMES for the chosen date.
  if (input.date !== undefined) {
    const requested = input.date.trim();
    const daySlots = (byDate.get(requested) ?? [])
      .slice()
      .sort((a, b) => a.starts_at.localeCompare(b.starts_at));
    if (daySlots.length === 0) {
      return {
        available: false,
        needs_date: true,
        reason: `I don’t have any times on ${requested}. Would another day work?`,
      };
    }
    const first = daySlots[0] as TeamSlot;
    const times: OfferedTime[] = daySlots.slice(0, TIME_LIMIT).map((s) => ({
      starts_at: s.starts_at,
      local: formatSlotLocal(s.starts_at, tz) ?? s.starts_at,
      time: localTimeLabel(s.starts_at, tz) ?? s.starts_at,
    }));
    return {
      available: true,
      mode: 'times',
      timezone: tz,
      timezone_label: timezoneLabel(tz),
      date: requested,
      day_label: localDayLabel(first.starts_at, tz) ?? requested,
      slots: times,
    };
  }

  // Step 1 — offer the next few available DATES.
  const dates: OfferedDate[] = dateKeys.slice(0, DATE_LIMIT).map((key) => {
    const daySlots = byDate.get(key) as TeamSlot[];
    const first = daySlots[0] as TeamSlot;
    return {
      date: key,
      label: localDayLabel(first.starts_at, tz) ?? key,
      times_available: daySlots.length,
    };
  });
  return { available: true, mode: 'dates', timezone: tz, timezone_label: timezoneLabel(tz), dates };
}

/**
 * Books the consultation. Re-validates the chosen slot against FRESH availability,
 * so a stale slot is never booked, and reports success ONLY when Guided Boost
 * returns an appointment.
 */
export async function bookConsultation(
  input: BookInput,
  deps: BookingDeps = {},
): Promise<BookResult> {
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
