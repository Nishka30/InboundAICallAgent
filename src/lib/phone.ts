/**
 * Phone-number normalization for caller identification.
 *
 * Inbound callers arrive as a `from_number` that Retell already presents in E.164
 * for real PSTN calls, but we never trust that blindly: we validate, and we
 * normalize common near-E.164 forms (a leading `00` international prefix, spaces,
 * dashes, parentheses) so the Guided Boost lookup is consistent.
 *
 * We deliberately do NOT depend on a heavyweight phone library for this first
 * version: the goal is a safe, predictable E.164 string to look up, not full
 * national-format parsing. A value that cannot be made into valid E.164 is
 * returned as `null`, and the caller is treated as unknown rather than guessed.
 */

/** Strict E.164: a leading `+`, a non-zero country digit, 7–15 digits total. */
const E164 = /^\+[1-9]\d{6,14}$/;

export function isE164(value: string): boolean {
  return E164.test(value);
}

/**
 * Normalizes a raw caller number to E.164, or returns `null` when it cannot be
 * confidently normalized.
 *
 * Rules:
 *   - strip spaces, dashes, dots, parentheses;
 *   - a leading `00` is the international access prefix → `+`;
 *   - an existing leading `+` is kept;
 *   - a bare run of digits with no `+`/`00` is ambiguous (no country code), so it
 *     is rejected rather than assigned a default country.
 */
export function normalizePhoneToE164(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;

  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;

  // Keep a leading +, drop every other non-digit.
  const hasPlus = trimmed.startsWith('+');
  let digits = trimmed.replace(/[^\d]/g, '');

  let candidate: string;
  if (hasPlus) {
    candidate = `+${digits}`;
  } else if (digits.startsWith('00')) {
    digits = digits.slice(2);
    candidate = `+${digits}`;
  } else {
    // No country-code indicator: ambiguous. Do not invent a default country.
    return null;
  }

  return E164.test(candidate) ? candidate : null;
}

/**
 * A redaction helper for logs: keeps only the last two digits so a number can be
 * correlated across log lines without exposing it. Never log the full number.
 */
export function maskPhone(value: string | null | undefined): string {
  if (typeof value !== 'string' || value.length === 0) return '(none)';
  const tail = value.slice(-2);
  return `***${tail}`;
}
