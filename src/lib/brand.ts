import { env, type Env } from '../config/env.js';
import { logger } from './logger.js';
import { normalizePhoneToE164 } from './phone.js';

/**
 * Brand resolution: the phone number the caller DIALED (Retell `to_number`, stored
 * as the call record's `inboundNumber`) determines the brand sent on every Guided
 * Boost request. This is kept conceptually separate from the caller's OWN number
 * (`from_number` / `callerNumber`), which is only ever used to identify the guest.
 *
 * Mapping is config-driven (`INBOUND_BRAND_NUMBERS`), so new brand numbers are
 * added without touching application logic. When no mapping is configured the
 * service runs in single-brand mode on `GUIDED_BOOST_BRAND`.
 */

/** Parses `+123=HW,+124=TH` into an E.164 → brand map. Bad entries are skipped. */
export function parseBrandMap(raw: string | undefined): Map<string, string> {
  const map = new Map<string, string>();
  if (!raw) return map;
  for (const entry of raw.split(',')) {
    const eq = entry.indexOf('=');
    if (eq <= 0) continue;
    const numberPart = entry.slice(0, eq).trim();
    const brand = entry.slice(eq + 1).trim();
    if (!numberPart || !brand) continue;
    const e164 = normalizePhoneToE164(numberPart) ?? numberPart;
    map.set(e164, brand);
  }
  return map;
}

/**
 * Resolves the brand for a dialed number. Uses the configured mapping first; when a
 * mapping is configured but the dialed number is not in it, falls back to the
 * default brand and logs a WARNING (so a misconfiguration is visible rather than
 * silently sending a wrong brand). With no mapping configured, always the default.
 */
export function resolveBrand(dialedNumber: string | null | undefined, source: Env = env): string {
  const fallback = source.GUIDED_BOOST_BRAND;
  const map = parseBrandMap(source.INBOUND_BRAND_NUMBERS);
  if (map.size === 0) return fallback;

  const e164 = normalizePhoneToE164(dialedNumber ?? null);
  if (e164 && map.has(e164)) return map.get(e164) as string;

  logger.warn(
    { dialed: e164 ? 'mapped_miss' : 'unnormalizable' },
    'brand: dialed number not in INBOUND_BRAND_NUMBERS; using default brand',
  );
  return fallback;
}
