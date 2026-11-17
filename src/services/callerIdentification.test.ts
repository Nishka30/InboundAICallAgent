import { describe, expect, it, vi } from 'vitest';
import { identifyCaller } from './callerIdentification.service.js';
import { CallerType } from '../domain/call.js';
import { fakeGuidedBoostClient } from '../testing/helpers.js';

describe('identifyCaller', () => {
  it('identifies an existing lead by phone', async () => {
    const client = fakeGuidedBoostClient({
      findLeadByPhone: vi.fn().mockResolvedValue({
        id: 'L1',
        name: 'Ada',
        is_lead: true,
        person_key: 'lead:L1',
        sales_agent: 'Grace',
        sales_agent_email: 'grace@example.com',
      }),
    });

    const identity = await identifyCaller('+12318310814', { client });

    expect(identity.callerType).toBe(CallerType.EXISTING_LEAD);
    expect(identity.leadId).toBe('L1');
    expect(identity.name).toBe('Ada');
    expect(identity.salesAgentEmail).toBe('grace@example.com');
    expect(identity.e164).toBe('+12318310814');
  });

  it('identifies an existing customer (is_lead false)', async () => {
    const client = fakeGuidedBoostClient({
      findLeadByPhone: vi.fn().mockResolvedValue({ id: 'P9', is_lead: false }),
    });

    const identity = await identifyCaller('+12318310814', { client });

    expect(identity.callerType).toBe(CallerType.EXISTING_CUSTOMER);
    expect(identity.leadId).toBe('P9');
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
