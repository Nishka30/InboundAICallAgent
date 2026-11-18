import { logger } from '../lib/logger.js';
import { maskPhone, normalizePhoneToE164 } from '../lib/phone.js';
import { CallerType, type CallerTypeName } from '../domain/call.js';
import { GuidedBoostClient } from '../integrations/guidedBoost/client.js';
import type { SearchResult } from '../integrations/guidedBoost/schemas.js';

/**
 * Result of identifying an inbound caller. Always resolves (never throws): if
 * Guided Boost cannot be reached or the number cannot be normalized, the caller is
 * reported as UNKNOWN and the conversation continues as a new inquiry. A caller is
 * NEVER assumed to be a lead just because they phoned in.
 *
 * `GET /api/crm/search` returns a PERSON-centric match keyed by `personKey` (not a
 * lead id), so an identified caller carries `personKey` + name + current owner. A
 * `leadId` is NOT available from search; resolving `personKey` → a specific lead
 * (via `GET /api/crm/persons/:personKey`) is a separate step the booking flow needs.
 */
export interface CallerIdentity {
  callerType: CallerTypeName;
  e164: string | null;
  leadId?: string;
  personKey?: string;
  name?: string;
  salesAgentEmail?: string;
  salesAgentName?: string;
  leadStatus?: string;
  /** True when a lookup was actually performed (vs. skipped for a bad number). */
  lookupPerformed: boolean;
}

export interface IdentifyCallerDeps {
  client?: GuidedBoostClient;
}

/**
 * Identifies the caller from a raw phone number.
 *
 * `normalizePhoneToE164` runs first so the lookup is consistent; an un-normalizable
 * number short-circuits to UNKNOWN without a wasted request. A phone-matched search
 * result marks the caller as a KNOWN existing lead (the search result alone does not
 * cleanly separate "lead" vs "customer" — that needs the person profile — so a match
 * is reported as EXISTING_LEAD with `leadStatus` for context).
 */
export async function identifyCaller(
  rawPhone: string | null | undefined,
  deps: IdentifyCallerDeps = {},
): Promise<CallerIdentity> {
  const e164 = normalizePhoneToE164(rawPhone);

  if (e164 === null) {
    logger.info({ caller: maskPhone(rawPhone ?? null) }, 'caller number not normalizable; unknown');
    return { callerType: CallerType.UNKNOWN, e164: null, lookupPerformed: false };
  }

  const client = deps.client ?? new GuidedBoostClient();

  let match: SearchResult | null;
  try {
    match = await client.findLeadByPhone(e164);
  } catch (error) {
    // Guided Boost unreachable: do NOT fail the call — continue as unknown.
    logger.warn(
      { caller: maskPhone(e164), err: error instanceof Error ? error.name : 'unknown' },
      'caller identification failed; continuing as unknown caller',
    );
    return { callerType: CallerType.UNKNOWN, e164, lookupPerformed: true };
  }

  if (!match) {
    return { callerType: CallerType.UNKNOWN, e164, lookupPerformed: true };
  }

  const identity: CallerIdentity = {
    callerType: CallerType.EXISTING_LEAD,
    e164,
    lookupPerformed: true,
  };
  if (match.personKey) identity.personKey = match.personKey;
  if (typeof match.name === 'string' && match.name.length > 0) identity.name = match.name;
  if (typeof match.salesAgentEmail === 'string' && match.salesAgentEmail.length > 0)
    identity.salesAgentEmail = match.salesAgentEmail;
  if (typeof match.salesAgent === 'string' && match.salesAgent.length > 0)
    identity.salesAgentName = match.salesAgent;
  if (typeof match.leadStatus === 'string' && match.leadStatus.length > 0)
    identity.leadStatus = match.leadStatus;

  return identity;
}
