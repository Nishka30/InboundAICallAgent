import { describe, expect, it, vi } from 'vitest';
import { processToolRequest } from './inboundTools.service.js';
import {
  createInMemoryCallRepository,
  type CallRepository,
} from '../repositories/callRepository.js';
import { BookingStatus, CallOutcome } from '../domain/call.js';
import { TOOL } from '../integrations/retell/functionSchemas.js';
import { GuidedBoostError } from '../integrations/guidedBoost/errors.js';
import { fakeGuidedBoostClient, signedPayload, TEST_API_KEY } from '../testing/helpers.js';

const CALL_ID = 'call_tool_1';

function toolPayload(name: string, args: Record<string, unknown>, now = Date.now()) {
  return signedPayload(
    { call: { call_id: CALL_ID, from_number: '+12318310814' }, name, args },
    TEST_API_KEY,
    now,
  );
}

async function seededRepo(leadId?: string): Promise<CallRepository> {
  const repo = createInMemoryCallRepository();
  await repo.createOrGetInbound({ retellCallId: CALL_ID, callerNumber: '+12318310814' });
  if (leadId) await repo.update(CALL_ID, { leadId });
  return repo;
}

describe('processToolRequest — security', () => {
  it('rejects an invalid signature', async () => {
    const { rawBody } = toolPayload(TOOL.IDENTIFY_CALLER, {});
    const result = await processToolRequest({
      rawBody,
      signature: 'v=1,d=bad',
      apiKey: TEST_API_KEY,
    });
    expect(result.status).toBe('unauthorized');
  });

  it('rejects when no api key is configured', async () => {
    const { rawBody, signature } = toolPayload(TOOL.IDENTIFY_CALLER, {});
    const result = await processToolRequest({ rawBody, signature, apiKey: undefined });
    expect(result.status).toBe('misconfigured');
  });
});

describe('identify_caller tool', () => {
  it('identifies a known caller and records the person key', async () => {
    const repo = await seededRepo();
    const client = fakeGuidedBoostClient({
      identifyInboundCaller: vi.fn().mockResolvedValue({
        known: true,
        verified_by_phone: true,
        person_key: 'lead:L1',
        name: 'Ada',
        owner: { name: 'Grace', email: 'grace@example.com' },
        lead: { lead_id: 'L1', status: 'New Lead' },
      }),
    });
    const { rawBody, signature } = toolPayload(TOOL.IDENTIFY_CALLER, {});

    const result = await processToolRequest({
      rawBody,
      signature,
      apiKey: TEST_API_KEY,
      repo,
      client,
    });

    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.payload['known']).toBe(true);
      expect(result.payload['person_key']).toBe('lead:L1');
      expect(result.payload['name']).toBe('Ada');
      expect(result.payload['verified_by_phone']).toBe(true);
    }
    expect((await repo.getByRetellCallId(CALL_ID))?.personKey).toBe('lead:L1');
  });
});

describe('create_lead tool', () => {
  it('creates a lead and associates it with the call', async () => {
    const repo = await seededRepo();
    const createLead = vi.fn().mockResolvedValue({ leadId: 'L9', personKey: 'lead:L9' });
    const client = fakeGuidedBoostClient({ createLead });
    const { rawBody, signature } = toolPayload(TOOL.CREATE_LEAD, {
      name: 'Ada',
      destination: 'Everest',
    });

    const result = await processToolRequest({
      rawBody,
      signature,
      apiKey: TEST_API_KEY,
      repo,
      client,
    });

    expect(result.status).toBe('ok');
    if (result.status === 'ok') expect(result.payload['created']).toBe(true);
    const record = await repo.getByRetellCallId(CALL_ID);
    expect(record?.leadId).toBe('L9');
    expect(record?.leadCreated).toBe(true);
    expect(createLead).toHaveBeenCalledTimes(1);
  });

  it('is duplicate-safe when a lead already exists', async () => {
    const repo = await seededRepo('EXISTING');
    const createLead = vi.fn();
    const client = fakeGuidedBoostClient({ createLead });
    const { rawBody, signature } = toolPayload(TOOL.CREATE_LEAD, { name: 'Ada' });

    const result = await processToolRequest({
      rawBody,
      signature,
      apiKey: TEST_API_KEY,
      repo,
      client,
    });

    if (result.status === 'ok') {
      expect(result.payload['created']).toBe(false);
      expect(result.payload['already_exists']).toBe(true);
    }
    expect(createLead).not.toHaveBeenCalled();
  });

  it('degrades gracefully when creation fails', async () => {
    const repo = await seededRepo();
    const client = fakeGuidedBoostClient({
      createLead: vi.fn().mockRejectedValue(new Error('gb down')),
    });
    const { rawBody, signature } = toolPayload(TOOL.CREATE_LEAD, { name: 'Ada' });

    const result = await processToolRequest({
      rawBody,
      signature,
      apiKey: TEST_API_KEY,
      repo,
      client,
    });

    expect(result.status).toBe('ok');
    if (result.status === 'ok') expect(result.payload['created']).toBe(false);
    expect((await repo.getByRetellCallId(CALL_ID))?.leadId).toBeUndefined();
  });

  it('captures details locally when the create endpoint is unconfirmed', async () => {
    const repo = await seededRepo();
    const client = fakeGuidedBoostClient({
      createLead: vi.fn().mockRejectedValue(new GuidedBoostError('unsupported', 'not confirmed')),
    });
    const { rawBody, signature } = toolPayload(TOOL.CREATE_LEAD, {
      name: 'Ada',
      destination: 'Everest',
    });

    const result = await processToolRequest({
      rawBody,
      signature,
      apiKey: TEST_API_KEY,
      repo,
      client,
    });

    if (result.status === 'ok') {
      expect(result.payload['created']).toBe(false);
      expect(result.payload['captured']).toBe(true);
    }
    const record = await repo.getByRetellCallId(CALL_ID);
    expect(record?.collectedInfo.name).toBe('Ada');
    expect(record?.collectedInfo.destination).toBe('Everest');
    expect(record?.leadId).toBeUndefined();
  });
});

describe('update_lead tool', () => {
  it('captures details locally when the update endpoint is unconfirmed', async () => {
    const repo = await seededRepo('L1');
    const client = fakeGuidedBoostClient({
      updateLead: vi.fn().mockRejectedValue(new GuidedBoostError('unsupported', 'not confirmed')),
    });
    const { rawBody, signature } = toolPayload(TOOL.UPDATE_LEAD, { budget: '5000 USD' });

    const result = await processToolRequest({
      rawBody,
      signature,
      apiKey: TEST_API_KEY,
      repo,
      client,
    });

    if (result.status === 'ok') {
      expect(result.payload['updated']).toBe(false);
      expect(result.payload['captured']).toBe(true);
    }
    expect((await repo.getByRetellCallId(CALL_ID))?.collectedInfo.budget).toBe('5000 USD');
  });
});

describe('book_consultation tool', () => {
  const SLOT = '2026-11-20T09:30:00.000Z';

  it('books when the backend confirms (booked === true)', async () => {
    const repo = await seededRepo('L1');
    const client = fakeGuidedBoostClient({
      getTeamSlots: vi.fn().mockResolvedValue({ slots: [{ starts_at: SLOT }], mode: 'pool' }),
      bookTeamAppointment: vi.fn().mockResolvedValue({
        appointmentId: 'A1',
        status: 'booked',
        agentName: 'Grace',
        startsAt: SLOT,
      }),
    });
    const { rawBody, signature } = toolPayload(TOOL.BOOK_CONSULTATION, {
      confirmed: true,
      starts_at: SLOT,
      meeting_type: 'phone',
      timezone: 'Asia/Kolkata',
    });

    const result = await processToolRequest({
      rawBody,
      signature,
      apiKey: TEST_API_KEY,
      repo,
      client,
    });

    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.payload['booked']).toBe(true);
      expect(result.payload['appointment_id']).toBe('A1');
    }
    const record = await repo.getByRetellCallId(CALL_ID);
    expect(record?.bookingStatus).toBe(BookingStatus.CONFIRMED);
    expect(record?.outcome).toBe(CallOutcome.BOOKED);
  });

  it('does not book when the chosen slot is no longer available (booked === false)', async () => {
    const repo = await seededRepo('L1');
    const bookTeamAppointment = vi.fn();
    const client = fakeGuidedBoostClient({
      getTeamSlots: vi
        .fn()
        .mockResolvedValue({ slots: [{ starts_at: '2026-11-21T09:30:00.000Z' }], mode: 'pool' }),
      bookTeamAppointment,
    });
    const { rawBody, signature } = toolPayload(TOOL.BOOK_CONSULTATION, {
      confirmed: true,
      starts_at: SLOT,
      meeting_type: 'phone',
      timezone: 'Asia/Kolkata',
    });

    const result = await processToolRequest({
      rawBody,
      signature,
      apiKey: TEST_API_KEY,
      repo,
      client,
    });

    if (result.status === 'ok') expect(result.payload['booked']).toBe(false);
    expect(bookTeamAppointment).not.toHaveBeenCalled();
    expect((await repo.getByRetellCallId(CALL_ID))?.bookingStatus).toBe(BookingStatus.FAILED);
  });

  it('does not claim success when the backend omits an appointment id', async () => {
    const repo = await seededRepo('L1');
    const client = fakeGuidedBoostClient({
      getTeamSlots: vi.fn().mockResolvedValue({ slots: [{ starts_at: SLOT }], mode: 'pool' }),
      bookTeamAppointment: vi
        .fn()
        .mockResolvedValue({ appointmentId: null, status: null, agentName: null, startsAt: null }),
    });
    const { rawBody, signature } = toolPayload(TOOL.BOOK_CONSULTATION, {
      confirmed: true,
      starts_at: SLOT,
      meeting_type: 'video',
      timezone: 'Asia/Kolkata',
    });

    const result = await processToolRequest({
      rawBody,
      signature,
      apiKey: TEST_API_KEY,
      repo,
      client,
    });

    if (result.status === 'ok') expect(result.payload['booked']).toBe(false);
    expect((await repo.getByRetellCallId(CALL_ID))?.bookingStatus).toBe(BookingStatus.FAILED);
  });

  it('rejects an invalid meeting_type', async () => {
    const repo = await seededRepo('L1');
    const getTeamSlots = vi.fn();
    const client = fakeGuidedBoostClient({ getTeamSlots });
    const { rawBody, signature } = toolPayload(TOOL.BOOK_CONSULTATION, {
      confirmed: true,
      starts_at: SLOT,
      meeting_type: 'travel consultation',
      timezone: 'Asia/Kolkata',
    });

    const result = await processToolRequest({
      rawBody,
      signature,
      apiKey: TEST_API_KEY,
      repo,
      client,
    });

    if (result.status === 'ok') expect(result.payload['booked']).toBe(false);
    expect(getTeamSlots).not.toHaveBeenCalled();
  });

  it('refuses to book before a lead exists', async () => {
    const repo = await seededRepo();
    const getTeamSlots = vi.fn();
    const client = fakeGuidedBoostClient({ getTeamSlots });
    const { rawBody, signature } = toolPayload(TOOL.BOOK_CONSULTATION, {
      confirmed: true,
      starts_at: SLOT,
      meeting_type: 'phone',
      timezone: 'Asia/Kolkata',
    });

    const result = await processToolRequest({
      rawBody,
      signature,
      apiKey: TEST_API_KEY,
      repo,
      client,
    });

    if (result.status === 'ok') expect(result.payload['booked']).toBe(false);
    expect(getTeamSlots).not.toHaveBeenCalled();
  });
});
