import { describe, expect, it, vi } from 'vitest';
import { identifyCaller } from './callerIdentification.service.js';
import { CallerType } from '../domain/call.js';
import { fakeGuidedBoostClient } from '../testing/helpers.js';

const PHONE = '+13035550100';

/** A known, phone-verified identify response; override per test. */
function identifyResponse(overrides: Record<string, unknown> = {}) {
  return {
    known: true,
    verified_by_phone: true,
    has_booking: false,
    person_id: 'p-1',
    person_key: 'lead:L1',
    name: 'Ada',
    owner: { name: 'Grace', email: 'grace@example.com' },
    lead: { lead_id: 'L1', status: 'Booked', created_at: '2026-01-01' },
    trip: null,
    payment: null,
    consultation: null,
    ...overrides,
  };
}

function clientReturning(response: unknown) {
  const identifyInboundCaller = vi.fn().mockResolvedValue(response);
  return { client: fakeGuidedBoostClient({ identifyInboundCaller }), identifyInboundCaller };
}

describe('identifyCaller (POST /api/caller/inbound/identify)', () => {
  it('reports a NEW caller when known is false', async () => {
    const { client } = clientReturning({ known: false, verified_by_phone: false });
    const identity = await identifyCaller(PHONE, { client });

    expect(identity.known).toBe(false);
    expect(identity.callerType).toBe(CallerType.UNKNOWN);
    expect(identity.verifiedByPhone).toBe(false);
    expect(identity.lookupPerformed).toBe(true);
    expect(identity.leadId).toBeUndefined();
  });

  it('maps an existing caller verified by phone', async () => {
    const { client } = clientReturning(identifyResponse());
    const identity = await identifyCaller(PHONE, { client });

    expect(identity.known).toBe(true);
    expect(identity.callerType).toBe(CallerType.EXISTING_LEAD);
    expect(identity.verifiedByPhone).toBe(true);
    expect(identity.personId).toBe('p-1');
    expect(identity.personKey).toBe('lead:L1');
    expect(identity.name).toBe('Ada');
    expect(identity.leadId).toBe('L1');
    expect(identity.leadStatus).toBe('Booked');
  });

  it('maps an existing caller with a booking/trip', async () => {
    const { client } = clientReturning(
      identifyResponse({
        has_booking: true,
        trip: {
          name: 'Everest Base Camp',
          starts_on: '2027-04-16',
          ends_on: '2027-04-29',
          state: 'upcoming',
        },
      }),
    );
    const identity = await identifyCaller(PHONE, { client });

    expect(identity.hasBooking).toBe(true);
    expect(identity.trip?.name).toBe('Everest Base Camp');
    expect(identity.trip?.startsOn).toBe('2027-04-16');
    expect(identity.trip?.state).toBe('upcoming');
  });

  it('maps an existing consultation (do-not-rebook signal)', async () => {
    const { client } = clientReturning(
      identifyResponse({
        consultation: {
          starts_at: '2027-01-02T10:00:00Z',
          agent_name: 'Grace',
          agent_email: 'grace@example.com',
          lead_id: 'L1',
        },
      }),
    );
    const identity = await identifyCaller(PHONE, { client });

    expect(identity.hasExistingConsultation).toBe(true);
    expect(identity.existingConsultationSummary).toContain('Grace');
  });

  it('preserves owner information', async () => {
    const { client } = clientReturning(
      identifyResponse({ owner: { name: 'Grace', email: 'grace@example.com' } }),
    );
    const identity = await identifyCaller(PHONE, { client });

    expect(identity.salesAgentName).toBe('Grace');
    expect(identity.salesAgentEmail).toBe('grace@example.com');
  });

  it('handles null payment fields safely', async () => {
    const { client } = clientReturning(
      identifyResponse({
        payment: {
          received: true,
          payments: 2,
          last_paid_on: '2026-11-12',
          by_card: null,
          charged_as: null,
        },
      }),
    );
    const identity = await identifyCaller(PHONE, { client });

    expect(identity.payment?.received).toBe(true);
    expect(identity.payment?.payments).toBe(2);
    expect(identity.payment?.lastPaidOn).toBe('2026-11-12');
    expect(identity.payment?.byCard).toBeUndefined();
    expect(identity.payment?.chargedAs).toBeUndefined();
  });

  it('continues as unknown when Guided Boost fails (never crashes the call)', async () => {
    const identifyInboundCaller = vi.fn().mockRejectedValue(new Error('gb down'));
    const client = fakeGuidedBoostClient({ identifyInboundCaller });
    const identity = await identifyCaller(PHONE, { client });

    expect(identity.known).toBe(false);
    expect(identity.callerType).toBe(CallerType.UNKNOWN);
    expect(identity.lookupPerformed).toBe(true);
  });

  it('sends the configured brand (default HW), overridable per call', async () => {
    const { client, identifyInboundCaller } = clientReturning(identifyResponse());

    await identifyCaller(PHONE, { client });
    expect(identifyInboundCaller).toHaveBeenCalledWith({
      brand: 'HW',
      phone: PHONE,
      email: null,
    });

    await identifyCaller(PHONE, { client, brand: 'TH' });
    expect(identifyInboundCaller).toHaveBeenLastCalledWith({
      brand: 'TH',
      phone: PHONE,
      email: null,
    });
  });

  it('does not look up when there is no usable phone or email', async () => {
    const { client, identifyInboundCaller } = clientReturning(identifyResponse());
    const identity = await identifyCaller('2318310814', { client }); // un-normalizable, no email

    expect(identity.callerType).toBe(CallerType.UNKNOWN);
    expect(identity.e164).toBeNull();
    expect(identity.lookupPerformed).toBe(false);
    expect(identifyInboundCaller).not.toHaveBeenCalled();
  });
});
