import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { maskPhone, normalizePhoneToE164 } from '../lib/phone.js';
import { CallerType, type CallerTypeName } from '../domain/call.js';
import { GuidedBoostClient } from '../integrations/guidedBoost/client.js';
import type { InboundIdentifyResponse } from '../integrations/guidedBoost/schemas.js';

/**
 * Result of identifying an inbound caller. Always resolves (never throws): if
 * Guided Boost cannot be reached, the number cannot be normalized, or the response
 * is malformed, the caller is reported as UNKNOWN and the conversation continues as
 * a new inquiry. A caller is NEVER assumed to be a lead just because they phoned in.
 *
 * Backed by the AUTHORITATIVE Guided Boost caller-identification endpoint
 * (`POST /api/caller/inbound/identify`, "WHO IS RINGING"), which returns identity,
 * owner, newest lead, booking/consultation state and phone-verification in ONE
 * call — so no separate person/lead resolution step is needed.
 */
export interface CallerTrip {
  name?: string;
  startsOn?: string;
  endsOn?: string;
  state?: string;
}

export interface CallerPayment {
  received?: boolean;
  payments?: number;
  lastPaidOn?: string;
  byCard?: boolean;
  chargedAs?: string;
}

export interface CallerIdentity {
  callerType: CallerTypeName;
  e164: string | null;
  /** True when a lookup was actually performed (vs. skipped for no phone/email). */
  lookupPerformed: boolean;
  /** Whether Guided Boost recognises this caller. */
  known: boolean;
  /**
   * The caller is calling from the phone number on their own record. ONLY when
   * true may booking/payment details be confirmed to the caller.
   */
  verifiedByPhone: boolean;

  personId?: string;
  personKey?: string;
  leadId?: string;
  leadStatus?: string;
  name?: string;
  /** Owner / sales agent this guest belongs to on the requested brand. */
  salesAgentEmail?: string;
  salesAgentName?: string;

  /** They have a consultation booked that is still ahead → do NOT book another. */
  hasExistingConsultation: boolean;
  existingConsultationSummary?: string;
  /** They have a trip booked that is still ahead or underway. */
  hasBooking: boolean;
  trip?: CallerTrip;
  /** Payment summary — never contains amounts. */
  payment?: CallerPayment;
}

export interface IdentifyCallerDeps {
  client?: GuidedBoostClient;
  /** Brand code/domain; defaults to the configured GUIDED_BOOST_BRAND. */
  brand?: string;
  /** Optional email to identify by when no usable phone is available. */
  email?: string | null;
}

function unknownIdentity(e164: string | null, lookupPerformed: boolean): CallerIdentity {
  return {
    callerType: CallerType.UNKNOWN,
    e164,
    lookupPerformed,
    known: false,
    verifiedByPhone: false,
    hasExistingConsultation: false,
    hasBooking: false,
  };
}

/**
 * Identifies the caller via the authoritative Guided Boost inbound-identify API.
 *
 * The caller's number is normalized to E.164 first so the lookup is consistent. The
 * lookup needs a brand (from config) plus at least a phone or an email; with
 * neither it short-circuits to UNKNOWN without a wasted request. Any failure
 * (unreachable, auth, bad shape) is swallowed into UNKNOWN so the call proceeds as
 * a new inquiry rather than failing.
 */
export async function identifyCaller(
  rawPhone: string | null | undefined,
  deps: IdentifyCallerDeps = {},
): Promise<CallerIdentity> {
  const e164 = normalizePhoneToE164(rawPhone);
  const email = deps.email ?? null;

  if (e164 === null && !email) {
    logger.info(
      { caller: maskPhone(rawPhone ?? null) },
      'caller has no usable phone or email; unknown',
    );
    return unknownIdentity(null, false);
  }

  let client: GuidedBoostClient;
  try {
    client = deps.client ?? new GuidedBoostClient();
  } catch {
    // Guided Boost not configured: do not fail the call.
    return unknownIdentity(e164, false);
  }

  const brand = deps.brand ?? env.GUIDED_BOOST_BRAND;

  let response: InboundIdentifyResponse;
  try {
    response = await client.identifyInboundCaller({
      brand,
      phone: e164,
      email,
    });
  } catch (error) {
    // Unreachable / auth / bad shape: continue as unknown (never crash the call).
    logger.warn(
      { caller: maskPhone(e164), err: error instanceof Error ? error.name : 'unknown' },
      'caller identification failed; continuing as unknown caller',
    );
    return unknownIdentity(e164, true);
  }

  return mapIdentity(response, e164);
}

/** Maps the Guided Boost identify response into the caller identity domain shape. */
function mapIdentity(response: InboundIdentifyResponse, e164: string | null): CallerIdentity {
  const verifiedByPhone = Boolean(response.verified_by_phone);

  if (!response.known) {
    return {
      callerType: CallerType.UNKNOWN,
      e164,
      lookupPerformed: true,
      known: false,
      verifiedByPhone,
      hasExistingConsultation: false,
      hasBooking: false,
    };
  }

  const identity: CallerIdentity = {
    callerType: CallerType.EXISTING_LEAD,
    e164,
    lookupPerformed: true,
    known: true,
    verifiedByPhone,
    hasExistingConsultation: Boolean(response.consultation),
    hasBooking: Boolean(response.has_booking),
  };

  if (response.person_id) identity.personId = response.person_id;
  if (response.person_key) identity.personKey = response.person_key;
  if (response.name) identity.name = response.name;
  if (response.owner?.name) identity.salesAgentName = response.owner.name;
  if (response.owner?.email) identity.salesAgentEmail = response.owner.email;
  if (response.lead?.lead_id) identity.leadId = response.lead.lead_id;
  if (response.lead?.status) identity.leadStatus = response.lead.status;

  if (response.trip) {
    const trip: CallerTrip = {};
    if (response.trip.name) trip.name = response.trip.name;
    if (response.trip.starts_on) trip.startsOn = response.trip.starts_on;
    if (response.trip.ends_on) trip.endsOn = response.trip.ends_on;
    if (response.trip.state) trip.state = response.trip.state;
    if (Object.keys(trip).length > 0) identity.trip = trip;
  }

  if (response.payment) {
    const payment: CallerPayment = {};
    if (typeof response.payment.received === 'boolean') payment.received = response.payment.received;
    if (typeof response.payment.payments === 'number') payment.payments = response.payment.payments;
    if (response.payment.last_paid_on) payment.lastPaidOn = response.payment.last_paid_on;
    if (typeof response.payment.by_card === 'boolean') payment.byCard = response.payment.by_card;
    if (response.payment.charged_as) payment.chargedAs = response.payment.charged_as;
    if (Object.keys(payment).length > 0) identity.payment = payment;
  }

  if (response.consultation) {
    const parts: string[] = [];
    if (response.consultation.starts_at) parts.push(`at ${response.consultation.starts_at}`);
    if (response.consultation.agent_name) parts.push(`with ${response.consultation.agent_name}`);
    const summary = parts.join(' ').trim();
    identity.existingConsultationSummary = summary.length > 0 ? summary : 'already scheduled';
  }

  return identity;
}
