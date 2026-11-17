import { logger } from '../lib/logger.js';
import { maskPhone, normalizePhoneToE164 } from '../lib/phone.js';
import { CallerType, type CallerTypeName } from '../domain/call.js';
import { GuidedBoostClient } from '../integrations/guidedBoost/client.js';
import type { LeadSummary } from '../integrations/guidedBoost/schemas.js';

/**
 * Result of identifying an inbound caller. Always resolves (never throws): if
 * Guided Boost cannot be reached or the number cannot be normalized, the caller is
 * reported as UNKNOWN and the conversation continues as a new inquiry. A caller is
 * NEVER assumed to be a lead just because they phoned in.
 */
export interface CallerIdentity {
  callerType: CallerTypeName;
  e164: string | null;
  leadId?: string;
  personKey?: string;
  name?: string;
  salesAgentEmail?: string;
  salesAgentName?: string;
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
 * number short-circuits to UNKNOWN without a wasted request. "Existing customer"
 * vs "existing lead" is distinguished by the lead's `is_lead` flag when present
 * (a person who has booked/transacted but is not an open lead reads as a customer).
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

  let lead: LeadSummary | null;
  try {
    lead = await client.findLeadByPhone(e164);
  } catch (error) {
    // Guided Boost unreachable: do NOT fail the call — continue as unknown.
    logger.warn(
      { caller: maskPhone(e164), err: error instanceof Error ? error.name : 'unknown' },
      'caller identification failed; continuing as unknown caller',
    );
    return { callerType: CallerType.UNKNOWN, e164, lookupPerformed: true };
  }

  if (!lead) {
    return { callerType: CallerType.UNKNOWN, e164, lookupPerformed: true };
  }

  const callerType: CallerTypeName =
    lead.is_lead === false ? CallerType.EXISTING_CUSTOMER : CallerType.EXISTING_LEAD;

  const identity: CallerIdentity = {
    callerType,
    e164,
    leadId: lead.id,
    lookupPerformed: true,
  };
  if (lead.person_key) identity.personKey = lead.person_key;
  if (typeof lead.name === 'string' && lead.name.length > 0) identity.name = lead.name;
  if (typeof lead.sales_agent_email === 'string' && lead.sales_agent_email.length > 0)
    identity.salesAgentEmail = lead.sales_agent_email;
  if (typeof lead.sales_agent === 'string' && lead.sales_agent.length > 0)
    identity.salesAgentName = lead.sales_agent;

  return identity;
}
