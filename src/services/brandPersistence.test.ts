import { describe, expect, it, vi } from 'vitest';
import { processToolRequest } from './inboundTools.service.js';
import { processInboundWebhook } from './inboundWebhook.service.js';
import { createInMemoryCallRepository } from '../repositories/callRepository.js';
import { resolveBrand } from '../lib/brand.js';
import { TOOL } from '../integrations/retell/functionSchemas.js';
import { fakeGuidedBoostClient, signedPayload, TEST_API_KEY } from '../testing/helpers.js';
import type { Env } from '../config/env.js';

/**
 * Brand persistence: the brand is resolved ONCE from the dialled number and stored
 * on the call record; services/tools then read `record.brand` instead of
 * re-resolving from a nullable field on every call.
 */

/** A PatagoniaHero-style brand map, built the same way production config is. */
function source(over: Partial<Env>): Env {
  return { GUIDED_BOOST_BRAND: 'HW', INBOUND_BRAND_NUMBERS: undefined, ...over } as Env;
}
const PH_NUMBER = '+15550000003';
const PH_MAP = source({ INBOUND_BRAND_NUMBERS: `${PH_NUMBER}=PH`, GUIDED_BOOST_BRAND: 'HW' });

function toolPayload(callId: string, name: string, args: Record<string, unknown>) {
  // No to_number here on purpose: the persisted brand must win over re-resolution.
  return signedPayload(
    { call: { call_id: callId, from_number: '+13035550100' }, name, args },
    TEST_API_KEY,
  );
}

describe('repository brand persistence', () => {
  it('persists the supplied brand (Patagonia-style mapped number → PH)', async () => {
    const repo = createInMemoryCallRepository();
    const brand = resolveBrand(PH_NUMBER, PH_MAP); // 'PH'
    const record = await repo.createOrGetInbound({
      retellCallId: 'c1',
      inboundNumber: PH_NUMBER,
      brand,
    });
    expect(brand).toBe('PH');
    expect(record.brand).toBe('PH');
    expect((await repo.getByRetellCallId('c1'))?.brand).toBe('PH');
  });

  it('defaults to the fallback brand (HW) when none is supplied', async () => {
    const repo = createInMemoryCallRepository();
    const record = await repo.createOrGetInbound({ retellCallId: 'c2' });
    expect(record.brand).toBe('HW');
  });

  it('sets brand once — a later create does not overwrite it', async () => {
    const repo = createInMemoryCallRepository();
    await repo.createOrGetInbound({ retellCallId: 'c3', inboundNumber: PH_NUMBER, brand: 'PH' });
    // A later contact (e.g. a tool before call_started) must not change the brand.
    await repo.createOrGetInbound({ retellCallId: 'c3', brand: 'HW' });
    expect((await repo.getByRetellCallId('c3'))?.brand).toBe('PH');
  });
});

describe('webhook persists brand at call_started', () => {
  it('resolves the brand from the dialled number and stores it (HW in single-brand mode)', async () => {
    const repo = createInMemoryCallRepository();
    const now = Date.now();
    const { rawBody, signature } = signedPayload(
      {
        event: 'call_started',
        call: {
          call_id: 'wc1',
          to_number: '+12318310814', // dialled/brand line
          from_number: '+13035550100', // the caller
          start_timestamp: now,
        },
      },
      TEST_API_KEY,
      now,
    );

    await processInboundWebhook({ rawBody, signature, apiKey: TEST_API_KEY, now, repo });

    const record = await repo.getByRetellCallId('wc1');
    // Global env has no INBOUND_BRAND_NUMBERS → default brand, persisted on the record.
    expect(record?.brand).toBe('HW');
    expect(record?.inboundNumber).toBe('+12318310814');
  });
});

describe('tools use the persisted brand (not re-resolution)', () => {
  it('identify_caller sends the persisted brand to Guided Boost', async () => {
    const repo = createInMemoryCallRepository();
    await repo.createOrGetInbound({ retellCallId: 'tc1', inboundNumber: PH_NUMBER, brand: 'PH' });
    const identifyInboundCaller = vi
      .fn()
      .mockResolvedValue({ known: false, verified_by_phone: false });
    const client = fakeGuidedBoostClient({ identifyInboundCaller });

    const { rawBody, signature } = toolPayload('tc1', TOOL.IDENTIFY_CALLER, {});
    await processToolRequest({ rawBody, signature, apiKey: TEST_API_KEY, repo, client });

    expect(identifyInboundCaller).toHaveBeenCalledWith(
      expect.objectContaining({ brand: 'PH', phone: '+13035550100' }),
    );
  });

  it('submit_inquiry sends the persisted brand even when the tool payload has no dialled number', async () => {
    const repo = createInMemoryCallRepository();
    await repo.createOrGetInbound({ retellCallId: 'tc2', inboundNumber: PH_NUMBER, brand: 'PH' });
    const submitInboundInquiry = vi.fn().mockResolvedValue({ ok: true, created: true });
    const client = fakeGuidedBoostClient({ submitInboundInquiry });

    const { rawBody, signature } = toolPayload('tc2', TOOL.SUBMIT_INQUIRY, {
      name: 'Ada',
      inquiry: 'Patagonia W Trek',
    });
    await processToolRequest({ rawBody, signature, apiKey: TEST_API_KEY, repo, client });

    expect(submitInboundInquiry).toHaveBeenCalledWith(expect.objectContaining({ brand: 'PH' }));
  });

  it('keeps existing HW behavior for an HW-number call', async () => {
    const repo = createInMemoryCallRepository();
    await repo.createOrGetInbound({
      retellCallId: 'tc3',
      inboundNumber: '+12318310814',
      brand: 'HW',
    });
    const submitInboundInquiry = vi.fn().mockResolvedValue({ ok: true, created: true });
    const client = fakeGuidedBoostClient({ submitInboundInquiry });

    const { rawBody, signature } = toolPayload('tc3', TOOL.SUBMIT_INQUIRY, {
      name: 'Ada',
      inquiry: 'Everest',
    });
    await processToolRequest({ rawBody, signature, apiKey: TEST_API_KEY, repo, client });

    expect(submitInboundInquiry).toHaveBeenCalledWith(expect.objectContaining({ brand: 'HW' }));
  });
});
