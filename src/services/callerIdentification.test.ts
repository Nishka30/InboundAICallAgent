import { describe, expect, it, vi } from 'vitest';
import { identifyCaller } from './callerIdentification.service.js';
import { CallerType } from '../domain/call.js';
import { fakeGuidedBoostClient } from '../testing/helpers.js';

describe('identifyCaller', () => {
  it('identifies a known caller from a phone-matched search result', async () => {
    const client = fakeGuidedBoostClient({
      findLeadByPhone: vi.fn().mockResolvedValue({
        personKey: 'email:ada@example.com',
        name: 'Ada',
        phone: '+12318310814',
        salesAgent: 'Grace',
        salesAgentEmail: 'grace@example.com',
        leadStatus: 'New Lead',
      }),
    });

    const identity = await identifyCaller('+12318310814', { client });

    expect(identity.callerType).toBe(CallerType.EXISTING_LEAD);
    expect(identity.personKey).toBe('email:ada@example.com');
    expect(identity.name).toBe('Ada');
    expect(identity.salesAgentName).toBe('Grace');
    expect(identity.leadStatus).toBe('New Lead');
    expect(identity.e164).toBe('+12318310814');
  });

  it('reports an unknown caller when no lead matches', async () => {
    const client = fakeGuidedBoostClient({
      findLeadByPhone: vi.fn().mockResolvedValue(null),
    });

    const identity = await identifyCaller('+12318310814', { client });

    expect(identity.callerType).toBe(CallerType.UNKNOWN);
    expect(identity.leadId).toBeUndefined();
    expect(identity.lookupPerformed).toBe(true);
  });

  it('does not look up an un-normalizable number', async () => {
    const findLeadByPhone = vi.fn();
    const client = fakeGuidedBoostClient({ findLeadByPhone });

    const identity = await identifyCaller('2318310814', { client });

    expect(identity.callerType).toBe(CallerType.UNKNOWN);
    expect(identity.e164).toBeNull();
    expect(identity.lookupPerformed).toBe(false);
    expect(findLeadByPhone).not.toHaveBeenCalled();
  });

  it('continues as unknown when Guided Boost throws', async () => {
    const client = fakeGuidedBoostClient({
      findLeadByPhone: vi.fn().mockRejectedValue(new Error('network')),
    });

    const identity = await identifyCaller('+12318310814', { client });

    expect(identity.callerType).toBe(CallerType.UNKNOWN);
    expect(identity.lookupPerformed).toBe(true);
  });
});
