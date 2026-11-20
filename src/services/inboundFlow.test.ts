import { describe, expect, it, vi } from 'vitest';
import { processToolRequest } from './inboundTools.service.js';
import {
  createInMemoryCallRepository,
  type CallRepository,
} from '../repositories/callRepository.js';
import { BookingStatus, InquiryStatus, LifecycleEvent, Urgency } from '../domain/call.js';
import { TOOL } from '../integrations/retell/functionSchemas.js';
import { GuidedBoostError } from '../integrations/guidedBoost/errors.js';
import type { EscalationService } from './escalation.service.js';
import { fakeGuidedBoostClient, signedPayload, TEST_API_KEY } from '../testing/helpers.js';

const CALL_ID = 'call_flow_1';

function tool(name: string, args: Record<string, unknown>) {
  return signedPayload(
    { call: { call_id: CALL_ID, from_number: '+12318310814' }, name, args },
    TEST_API_KEY,
  );
}

async function seeded(leadId?: string): Promise<CallRepository> {
  const repo = createInMemoryCallRepository();
  await repo.createOrGetInbound({ retellCallId: CALL_ID, callerNumber: '+12318310814' });
  if (leadId) await repo.update(CALL_ID, { leadId });
  return repo;
}

async function events(repo: CallRepository): Promise<string[]> {
  return (await repo.getByRetellCallId(CALL_ID))?.lifecycle.map((l) => l.event) ?? [];
}

type ToolExtra = Omit<Parameters<typeof processToolRequest>[0], 'rawBody' | 'signature' | 'apiKey'>;

async function run(name: string, args: Record<string, unknown>, extra: ToolExtra) {
  const { rawBody, signature } = tool(name, args);
  return processToolRequest({ rawBody, signature, apiKey: TEST_API_KEY, ...extra });
}

// --- New caller flows --------------------------------------------------------

describe('new caller flow', () => {
  it('identifies an unknown caller as NEW', async () => {
    const repo = await seeded();
    // Default fake client returns known:false (a new caller).
    const client = fakeGuidedBoostClient();
    const result = await run(TOOL.IDENTIFY_CALLER, {}, { repo, client });
    if (result.status === 'ok') expect(result.payload['known']).toBe(false);
    expect(await events(repo)).toContain(LifecycleEvent.NEW_CALLER);
  });

  it('captures the inquiry when the caller does not want a consultant (API pending)', async () => {
    const repo = await seeded();
    const client = fakeGuidedBoostClient({
      createLeadFromInboundInquiry: vi
        .fn()
        .mockRejectedValue(new GuidedBoostError('unsupported', 'not configured')),
    });
    const result = await run(
      TOOL.SUBMIT_INQUIRY,
      {
        name: 'Ada',
        destination: 'Everest',
        inquiry: 'Wants info on Everest Base Camp',
        email: 'ada@x.com',
      },
      { repo, client },
    );
    if (result.status === 'ok') {
      expect(result.payload['captured']).toBe(true);
      expect(result.payload['outcome']).toBe('captured');
    }
    const record = (await repo.getByRetellCallId(CALL_ID));
    expect(record?.inquiryStatus).toBe(InquiryStatus.CAPTURED);
    expect(record?.collectedInfo.destination).toBe('Everest');
    expect(record?.collectedInfo.inquiry).toContain('Everest');
    expect(await events(repo)).toContain(LifecycleEvent.LEAD_CAPTURED);
  });

  it('sends the inquiry to the new-lead API when configured', async () => {
    const repo = await seeded();
    const client = fakeGuidedBoostClient({
      createLeadFromInboundInquiry: vi.fn().mockResolvedValue({ leadId: 'NL1' }),
    });
    const result = await run(
      TOOL.SUBMIT_INQUIRY,
      { name: 'Ada', inquiry: 'Trip' },
      { repo, client },
    );
    if (result.status === 'ok') {
      expect(result.payload['outcome']).toBe('sent');
      expect(result.payload['lead_id']).toBe('NL1');
    }
    expect((await repo.getByRetellCallId(CALL_ID))?.inquiryStatus).toBe(InquiryStatus.SENT);
  });

  it('wants a consultant but booking fails → inquiry captured (not a failure)', async () => {
    const repo = await seeded('L1');
    const client = fakeGuidedBoostClient({
      // chosen slot not in the returned set → booking refused
      getTeamSlots: vi
        .fn()
        .mockResolvedValue({ slots: [{ starts_at: '2026-12-01T10:00:00.000Z' }], mode: 'pool' }),
      createLeadFromInboundInquiry: vi.fn().mockResolvedValue({ leadId: 'NL2' }),
    });

    const book = await run(
      TOOL.BOOK_CONSULTATION,
      {
        confirmed: true,
        starts_at: '2026-11-20T09:30:00.000Z',
        meeting_type: 'phone',
        timezone: 'Asia/Kolkata',
      },
      { repo, client },
    );
    if (book.status === 'ok') expect(book.payload['booked']).toBe(false);
    const afterBook = (await repo.getByRetellCallId(CALL_ID));
    expect(afterBook?.bookingStatus).toBe(BookingStatus.FAILED);
    expect(afterBook?.bookingFailureReason).toBeTruthy();
    expect(await events(repo)).toContain(LifecycleEvent.CONSULTATION_NOT_BOOKED);

    const inquiry = await run(
      TOOL.SUBMIT_INQUIRY,
      { booking_failed: true, inquiry: 'Everest' },
      { repo, client },
    );
    if (inquiry.status === 'ok') expect(inquiry.payload['outcome']).toBe('sent');
  });

  it('missing optional info does not break inquiry capture', async () => {
    const repo = await seeded();
    const client = fakeGuidedBoostClient({
      createLeadFromInboundInquiry: vi.fn().mockResolvedValue({ leadId: null }),
    });
    const result = await run(TOOL.SUBMIT_INQUIRY, {}, { repo, client });
    expect(result.status).toBe('ok');
    if (result.status === 'ok') expect(result.payload['captured']).toBe(true);
  });
});

// --- Existing caller flows ---------------------------------------------------

/** Builds a fake client whose authoritative identify call returns `identify`. */
function identifyClient(identify: Record<string, unknown> = {}) {
  return fakeGuidedBoostClient({
    identifyInboundCaller: vi.fn().mockResolvedValue({
      known: true,
      verified_by_phone: true,
      has_booking: false,
      person_id: 'p-1',
      person_key: 'email:ada@x.com',
      name: 'Ada',
      owner: { name: 'Grace', email: 'grace@x.com' },
      lead: null,
      trip: null,
      payment: null,
      consultation: null,
      ...identify,
    }),
  });
}

describe('existing caller flow', () => {
  it('resolves personKey → leadId with no existing consultation', async () => {
    const repo = await seeded();
    const client = identifyClient({ lead: { lead_id: 'L5', status: 'Open' } });
    const result = await run(TOOL.IDENTIFY_CALLER, {}, { repo, client });

    if (result.status === 'ok') {
      expect(result.payload['known']).toBe(true);
      expect(result.payload['lead_id']).toBe('L5');
      expect(result.payload['has_existing_consultation']).toBe(false);
    }
    const record = (await repo.getByRetellCallId(CALL_ID));
    expect(record?.leadResolved).toBe(true);
    expect(record?.leadId).toBe('L5');
    expect(await events(repo)).toContain(LifecycleEvent.EXISTING_CALLER);
    expect(await events(repo)).toContain(LifecycleEvent.LEAD_RESOLVED);
  });

  it('detects an existing consultation', async () => {
    const repo = await seeded();
    const client = identifyClient({
      lead: { lead_id: 'L5' },
      consultation: {
        starts_at: '2026-12-01T10:00:00Z',
        agent_name: 'Grace',
        agent_email: 'grace@x.com',
        lead_id: 'L5',
      },
    });
    const result = await run(TOOL.IDENTIFY_CALLER, {}, { repo, client });
    if (result.status === 'ok') {
      expect(result.payload['has_existing_consultation']).toBe(true);
      expect(result.payload['existing_consultation']).toContain('Grace');
    }
    expect((await repo.getByRetellCallId(CALL_ID))?.hasExistingConsultation).toBe(true);
  });

  it('exposes booking/trip/payment to a phone-verified caller', async () => {
    const repo = await seeded();
    const client = identifyClient({
      verified_by_phone: true,
      has_booking: true,
      lead: { lead_id: 'L5' },
      trip: { name: 'Everest Base Camp', starts_on: '2027-04-16', state: 'upcoming' },
      payment: { received: true, payments: 2, by_card: null, charged_as: null },
    });
    const result = await run(TOOL.IDENTIFY_CALLER, {}, { repo, client });
    if (result.status === 'ok') {
      expect(result.payload['has_booking']).toBe(true);
      expect(result.payload['trip']).toMatchObject({ name: 'Everest Base Camp' });
      expect(result.payload['payment']).toMatchObject({ received: true, payments: 2 });
    }
  });

  it('withholds booking/payment/trip when NOT verified by phone', async () => {
    const repo = await seeded();
    const client = identifyClient({
      verified_by_phone: false,
      has_booking: true,
      lead: { lead_id: 'L5' },
      trip: { name: 'Everest Base Camp', starts_on: '2027-04-16' },
      payment: { received: true, payments: 2 },
      consultation: { starts_at: '2027-01-01T10:00:00Z', agent_name: 'Grace' },
    });
    const result = await run(TOOL.IDENTIFY_CALLER, {}, { repo, client });
    if (result.status === 'ok') {
      expect(result.payload['known']).toBe(true);
      expect(result.payload['verified_by_phone']).toBe(false);
      expect(result.payload['payment']).toBeUndefined();
      expect(result.payload['trip']).toBeUndefined();
      expect(result.payload['has_booking']).toBeUndefined();
      expect(result.payload['existing_consultation']).toBeUndefined();
      expect(result.payload['details_withheld']).toBe(true);
    }
    // Server-side guard still persists the consultation so booking cannot duplicate it.
    expect((await repo.getByRetellCallId(CALL_ID))?.hasExistingConsultation).toBe(true);
  });

  it('does not duplicate a consultation for a caller who already has one', async () => {
    const repo = await seeded('L5');
    await repo.update(CALL_ID, { hasExistingConsultation: true });
    const getTeamSlots = vi.fn();
    const client = fakeGuidedBoostClient({ getTeamSlots });
    const result = await run(
      TOOL.BOOK_CONSULTATION,
      {
        confirmed: true,
        starts_at: '2026-11-20T09:30:00.000Z',
        meeting_type: 'phone',
        timezone: 'Asia/Kolkata',
      },
      { repo, client },
    );
    if (result.status === 'ok') {
      expect(result.payload['booked']).toBe(false);
      expect(result.payload['already_has_consultation']).toBe(true);
    }
    expect(getTeamSlots).not.toHaveBeenCalled();
  });

  it('logs a simple issue as a CRM note', async () => {
    const repo = await seeded('L5');
    const addCallNote = vi.fn().mockResolvedValue(undefined);
    const client = fakeGuidedBoostClient({ addCallNote });
    const result = await run(
      TOOL.LOG_ISSUE,
      { issue: 'Question about baggage allowance' },
      { repo, client },
    );
    if (result.status === 'ok') expect(result.payload['logged']).toBe(true);
    expect(addCallNote).toHaveBeenCalledTimes(1);
    expect(await events(repo)).toContain(LifecycleEvent.EXISTING_LEAD_ISSUE);
  });

  it('escalates an urgent issue through the escalation service', async () => {
    const repo = await seeded('L5');
    const escalate = vi.fn().mockResolvedValue({ escalated: true, via: 'crm_note' });
    const escalation: EscalationService = { escalate };
    const client = fakeGuidedBoostClient();
    const result = await run(
      TOOL.LOG_ISSUE,
      { issue: 'Flight tomorrow was cancelled!', urgency: 'urgent' },
      { repo, client, escalation },
    );
    if (result.status === 'ok') {
      expect(result.payload['urgent']).toBe(true);
      expect(result.payload['escalated']).toBe(true);
    }
    expect(escalate).toHaveBeenCalledTimes(1);
    expect((await repo.getByRetellCallId(CALL_ID))?.urgency).toBe(Urgency.URGENT);
    expect(await events(repo)).toContain(LifecycleEvent.URGENT_ESCALATION);
  });

  it('records a request for the existing consultant', async () => {
    const repo = await seeded('L5');
    await repo.update(CALL_ID, { ownerName: 'Grace' });
    const addCallNote = vi.fn().mockResolvedValue(undefined);
    const client = fakeGuidedBoostClient({ addCallNote });
    await run(
      TOOL.LOG_ISSUE,
      { issue: 'Please have my consultant call me', request_existing_consultant: true },
      { repo, client },
    );
    expect((await repo.getByRetellCallId(CALL_ID))?.requestedExistingConsultant).toBe(true);
    const note = (addCallNote.mock.calls[0]?.[1] ?? '') as string;
    expect(note).toContain('existing consultant');
  });

  it('keeps a known caller who has no resolvable lead (no duplicate lead)', async () => {
    const repo = await seeded();
    const client = identifyClient({ person_key: 'email:ada@x.com', lead: null });
    const result = await run(TOOL.IDENTIFY_CALLER, {}, { repo, client });
    if (result.status === 'ok') {
      expect(result.payload['known']).toBe(true);
      expect(result.payload['person_key']).toBe('email:ada@x.com');
      expect(result.payload['lead_id']).toBeUndefined();
    }
    const record = (await repo.getByRetellCallId(CALL_ID));
    expect(record?.leadResolved).toBe(false);
    expect(record?.leadId).toBeUndefined();
    expect(await events(repo)).toContain(LifecycleEvent.EXISTING_CALLER);
  });
});

// --- Infrastructure ----------------------------------------------------------

describe('tool infrastructure', () => {
  it('rejects an invalid log_issue payload', async () => {
    const repo = await seeded('L5');
    const client = fakeGuidedBoostClient();
    const result = await run(TOOL.LOG_ISSUE, {}, { repo, client });
    if (result.status === 'ok') expect(result.payload['logged']).toBe(false);
  });
});
