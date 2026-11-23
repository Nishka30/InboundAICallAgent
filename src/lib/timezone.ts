/**
 * Minimal, dependency-free timezone helpers for the inbound booking flow.
 *
 * The Guided Boost calendar endpoints expect an IANA timezone id (e.g.
 * `Asia/Kolkata`) and UTC instants. The agent, however, speaks to a human and may
 * report a timezone loosely ("India time", "GMT+5:30"). These helpers:
 *   - normalize a loose value to a valid IANA id (or null → the agent must ask);
 *   - convert a customer-local calendar date to the correct UTC day window,
 *     DST-safe, so "slots on 2026-11-20" means that day in the customer's zone;
 *   - format a UTC slot back into the customer's local wall-clock for the agent to
 *     read out — so the customer never hears a raw UTC time.
 *
 * Ported in spirit from CallScheduler's `lib/timezone.ts`, trimmed to what the
 * inbound booking tools actually need.
 */

/** A tiny alias map for the loose forms most likely to arrive from speech. */
const TZ_ALIASES: Record<string, string> = {
  utc: 'UTC',
  gmt: 'UTC',
  ist: 'Asia/Kolkata',
  'india standard time': 'Asia/Kolkata',
  'gmt+5:30': 'Asia/Kolkata',
  'gmt+05:30': 'Asia/Kolkata',
  est: 'America/New_York',
  edt: 'America/New_York',
  'eastern time': 'America/New_York',
  cst: 'America/Chicago',
  'central time': 'America/Chicago',
  mst: 'America/Denver',
  'mountain time': 'America/Denver',
  pst: 'America/Los_Angeles',
  pdt: 'America/Los_Angeles',
  'pacific time': 'America/Los_Angeles',
  bst: 'Europe/London',
  'uk time': 'Europe/London',
  'london time': 'Europe/London',
  cet: 'Europe/Berlin',
  cest: 'Europe/Berlin',
};

/** True when Intl accepts `tz` as a resolvable IANA timezone id. */
function isResolvableTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Normalizes a loose timezone string to a valid IANA id, or `null` when it cannot
 * be resolved (the agent then asks the customer rather than guessing).
 */
export function normalizeTimezone(input: string | null | undefined): string | null {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;

  if (isResolvableTimeZone(trimmed)) return trimmed;

  const alias = TZ_ALIASES[trimmed.toLowerCase()];
  if (alias && isResolvableTimeZone(alias)) return alias;

  return null;
}

/**
 * The offset (ms) of `tz` at the instant `date`: how far the zone's wall clock is
 * ahead of UTC. Positive east of UTC. DST-correct because it is evaluated at the
 * given instant.
 */
function timeZoneOffsetMs(tz: string, date: Date): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = dtf.formatToParts(date);
  const map: Record<string, number> = {};
  for (const part of parts) {
    if (part.type !== 'literal') map[part.type] = Number(part.value);
  }
  const asUtc = Date.UTC(
    map.year ?? 1970,
    (map.month ?? 1) - 1,
    map.day ?? 1,
    // `hour` can come back as 24 at midnight in some environments.
    (map.hour ?? 0) % 24,
    map.minute ?? 0,
    map.second ?? 0,
  );
  return asUtc - date.getTime();
}

/** A UTC half-open window `[from, to)` as ISO strings. */
export interface UtcRange {
  from: string;
  to: string;
}

/**
 * Converts a customer-local calendar date (`YYYY-MM-DD`) into the UTC window that
 * covers that whole local day, DST-safe. Returns `null` for an unparseable date.
 */
export function zonedDateRangeUtc(dateStr: string, tz: string): UtcRange | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr.trim());
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  // Guess the instant for local midnight, then correct by the real offset there.
  const startGuess = Date.UTC(year, month - 1, day, 0, 0, 0);
  const startOffset = timeZoneOffsetMs(tz, new Date(startGuess));
  const from = new Date(startGuess - startOffset);

  const endGuess = Date.UTC(year, month - 1, day + 1, 0, 0, 0);
  const endOffset = timeZoneOffsetMs(tz, new Date(endGuess - startOffset));
  const to = new Date(endGuess - endOffset);

  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return null;
  return { from: from.toISOString(), to: to.toISOString() };
}

/**
 * Formats a UTC instant as the customer's local date + time, e.g.
 * `Thu, Nov 20, 3:00 PM`. Returns `null` when the inputs are unusable.
 */
export function formatSlotLocal(utcIso: string, tz: string): string | null {
  const date = new Date(utcIso);
  if (Number.isNaN(date.getTime())) return null;
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    }).format(date);
  } catch {
    return null;
  }
}

/** The customer-local calendar date (`YYYY-MM-DD`) of a UTC instant. `null` if unusable. */
export function localDateKey(utcIso: string, tz: string): string | null {
  const date = new Date(utcIso);
  if (Number.isNaN(date.getTime())) return null;
  try {
    // en-CA renders ISO-style YYYY-MM-DD.
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(date);
  } catch {
    return null;
  }
}

/** A human day label, e.g. `Monday, Nov 24`. Falls back to the date key. */
export function localDayLabel(utcIso: string, tz: string): string | null {
  const date = new Date(utcIso);
  if (Number.isNaN(date.getTime())) return null;
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      weekday: 'long',
      month: 'short',
      day: 'numeric',
    }).format(date);
  } catch {
    return null;
  }
}

/** A human wall-clock time, e.g. `10:00 AM`. Falls back to null. */
export function localTimeLabel(utcIso: string, tz: string): string | null {
  const date = new Date(utcIso);
  if (Number.isNaN(date.getTime())) return null;
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    }).format(date);
  } catch {
    return null;
  }
}

/** A human label for a timezone, e.g. `GMT+5:30`. Falls back to the id. */
export function timezoneLabel(tz: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      timeZoneName: 'shortOffset',
      hour: 'numeric',
    }).formatToParts(new Date());
    const name = parts.find((p) => p.type === 'timeZoneName')?.value;
    return name ?? tz;
  } catch {
    return tz;
  }
}
