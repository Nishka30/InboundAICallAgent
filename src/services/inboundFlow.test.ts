import { describe, expect, it, vi } from 'vitest';
import { processToolRequest } from './inboundTools.service.js';
import {
  createInMemoryCallRepository,
  type CallRepository,
} from '../repositories/callRepository.js';
import { BookingStatus, InquiryStatus, LifecycleEvent, Urgency } from '../domain/call.js';
import { TOOL } from '../integrations/retell/functionSchemas.js';
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

  it('sends a NEW inquiry with consultation_status not_requested and links the lead', async () => {
    const repo = await seeded();
    const submitInboundInquiry = vi.fn().mockResolvedValue({
      ok: true,
      lead_id: 'NL1',
      person_key: 'lead:P1',
      person_id: 'p9',
      created: true,
      known_person: false,
      owner: { name: 'Grace', email: 'grace@x.com' },
    });
    const client = fakeGuidedBoostClient({ submitInboundInquiry });
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
      expect(result.payload['outcome']).toBe('sent');
      expect(result.payload['lead_id']).toBe('NL1');
    }
    // Correct brand + consultation_status + caller phone/email + question in notes.
    expect(submitInboundInquiry).toHaveBeenCalledWith(
      expect.objectContaining({
        brand: 'HW',
        consultationStatus: 'not_requested',
        phone: '+12318310814',
        email: 'ada@x.com',
        name: 'Ada',
        destination: 'Everest',
        callId: CALL_ID,
      }),
    );
    expect((submitInboundInquiry.mock.calls[0]?.[0] as { notes?: string })?.notes).toContain(
      'Everest Base Camp',
    );

    // Persisted + linked to the inbound call record.
    const record = await repo.getByRetellCallId(CALL_ID);
    expect(record?.inquiryStatus).toBe(InquiryStatus.SENT);
    expect(record?.leadId).toBe('NL1');
    expect(record?.leadCreated).toBe(true);
    expect(record?.personKey).toBe('lead:P1');
    expect(record?.ownerName).toBe('Grace');
    expect(await events(repo)).toContain(LifecycleEvent.LEAD_CAPTURED);
  });

  it('sends consultation_status requested when the caller asked for a consultant', async () => {
    const repo = await seeded();
    const submitInboundInquiry = vi.fn().mockResolvedValue({ ok: true, created: true });
    const client = fakeGuidedBoostClient({ submitInboundInquiry });
    await run(
      TOOL.SUBMIT_INQUIRY,
      { inquiry: 'I would like to speak with someone', consultation_requested: true },
      { repo, client },
    );
    expect(submitInboundInquiry).toHaveBeenCalledWith(
      expect.objectContaining({ consultationStatus: 'requested' }),
    );
  });

  it('sends consultation_status booking_failed after a failed booking', async () => {
    const repo = await seeded('L1');
    const submitInboundInquiry = vi
      .fn()
      .mockResolvedValue({ ok: true, lead_id: 'L1', created: false });
    const client = fakeGuidedBoostClient({
      // chosen slot not in the returned set → booking refused
      getTeamSlots: vi
        .fn()
        .mockResolvedValue({ slots: [{ starts_at: '2026-12-01T10:00:00.000Z' }], mode: 'pool' }),
      submitInboundInquiry,
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
    expect((await repo.getByRetellCallId(CALL_ID))?.bookingStatus).toBe(BookingStatus.FAILED);

    const inquiry = await run(
      TOOL.SUBMIT_INQUIRY,
      { booking_failed: true, inquiry: 'Everest' },
      { repo, client },
    );
    if (inquiry.status === 'ok') expect(inquiry.payload['outcome']).toBe('sent');
    expect(submitInboundInquiry).toHaveBeenCalledWith(
      expect.objectContaining({ consultationStatus: 'booking_failed' }),
    );
    // The booking-failure context is folded into notes for the human.
    expect((submitInboundInquiry.mock.calls[0]?.[0] as { notes?: string })?.notes).toContain(
      'booking could not be completed',
    );
  });

  it('sends consultation_status booked when a consultation was booked', async () => {
    const repo = await seeded('L1');
    await repo.update(CALL_ID, { bookingStatus: BookingStatus.CONFIRMED });
    const submitInboundInquiry = vi.fn().mockResolvedValue({ ok: true, created: false });
    const client = fakeGuidedBoostClient({ submitInboundInquiry });
    await run(TOOL.SUBMIT_INQUIRY, { inquiry: 'Looking forward to it' }, { repo, client });
    expect(submitInboundInquiry).toHaveBeenCalledWith(
      expect.objectContaining({ consultationStatus: 'booked' }),
    );
  });

  it('an existing guest can submit a new question via submit_inquiry (goes to notes)', async () => {
    const repo = await seeded('L5');
    const submitInboundInquiry = vi.fn().mockResolvedValue({
      ok: true,
      lead_id: 'L5',
      created: false,
      owner: { name: 'Grace', email: 'grace@x.com' },
    });
    const client = fakeGuidedBoostClient({ submitInboundInquiry });
    const result = await run(
      TOOL.SUBMIT_INQUIRY,
      { inquiry: 'Question about my baggage allowance' },
      { repo, client },
    );
    if (result.status === 'ok') expect(result.payload['outcome']).toBe('sent');
    expect((submitInboundInquiry.mock.calls[0]?.[0] as { notes?: string })?.notes).toContain(
      'baggage allowance',
    );
  });

  it('treats created:false as a successful idempotent outcome (no second local lead)', async () => {
    const repo = await seeded();
    const submitInboundInquiry = vi
      .fn()
      .mockResolvedValue({ ok: true, lead_id: 'L1', created: false, known_person: true });
    const client = fakeGuidedBoostClient({ submitInboundInquiry });
    const result = await run(TOOL.SUBMIT_INQUIRY, { inquiry: 'Trip' }, { repo, client });

    if (result.status === 'ok') expect(result.payload['outcome']).toBe('sent');
    const record = await repo.getByRetellCallId(CALL_ID);
    expect(record?.inquiryStatus).toBe(InquiryStatus.SENT);
    expect(record?.leadId).toBe('L1');
    expect(record?.leadCreated).toBe(false);
  });

  it('submits with a valid email when no phone is available', async () => {
    const repo = createInMemoryCallRepository();
    await repo.createOrGetInbound({ retellCallId: CALL_ID }); // no caller number
    const submitInboundInquiry = vi.fn().mockResolvedValue({ ok: true, created: true });
    const client = fakeGuidedBoostClient({ submitInboundInquiry });
    // A tool payload WITHOUT from_number, so the call record has no phone.
    const { rawBody, signature } = signedPayload(
      {
        call: { call_id: CALL_ID },
        name: TOOL.SUBMIT_INQUIRY,
        args: { email: 'ada@x.com', inquiry: 'Trip' },
      },
      TEST_API_KEY,
    );
    const result = await processToolRequest({
      rawBody,
      signature,
      apiKey: TEST_API_KEY,
      repo,
      client,
    });

    if (result.status === 'ok') expect(result.payload['outcome']).toBe('sent');
    expect(submitInboundInquiry).toHaveBeenCalledWith(
      expect.objectContaining({ phone: null, email: 'ada@x.com' }),
    );
  });

  it('preserves the inquiry locally when Guided Boost fails (call still completes)', async () => {
    const repo = await seeded();
    const submitInboundInquiry = vi.fn().mockRejectedValue(new Error('gb down'));
    const client = fakeGuidedBoostClient({ submitInboundInquiry });
    const result = await run(TOOL.SUBMIT_INQUIRY, { inquiry: 'Everest' }, { repo, client });

    expect(result.status).toBe('ok'); // the call is not failed
    if (result.status === 'ok') {
      expect(result.payload['captured']).toBe(true);
      expect(result.payload['outcome']).toBe('failed');
    }
    const record = await repo.getByRetellCallId(CALL_ID);
    expect(record?.inquiryStatus).toBe(InquiryStatus.FAILED);
    expect(record?.errors.length ?? 0).toBeGreaterThan(0);
    expect(await events(repo)).toContain(LifecycleEvent.CRM_UPDATE_FAILED);
  });

  it('missing optional info does not break inquiry submission', async () => {
    const repo = await seeded();
    const result = await run(TOOL.SUBMIT_INQUIRY, {}, { repo, client: fakeGuidedBoostClient() });
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.payload['captured']).toBe(true);
      expect(result.payload['outcome']).toBe('sent');
    }
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
    const record = await repo.getByRetellCallId(CALL_ID);
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

  it('logs a simple issue (normal question) via the issue API, linked to the lead', async () => {
    const repo = await seeded('L5');
    const submitInboundIssue = vi
      .fn()
      .mockResolvedValue({ ok: true, lead_id: 'L5', lead_created: false, alert_sent: true });
    const client = fakeGuidedBoostClient({ submitInboundIssue });
    const result = await run(
      TOOL.LOG_ISSUE,
      { issue: 'Question about my baggage allowance' },
      { repo, client },
    );
    if (result.status === 'ok') expect(result.payload['logged']).toBe(true);
    expect(submitInboundIssue).toHaveBeenCalledWith(
      expect.objectContaining({
        brand: 'HW',
        kind: 'question',
        urgency: 'normal',
        issue: 'Question about my baggage allowance',
        leadId: 'L5',
        phone: '+12318310814',
        callId: CALL_ID,
      }),
    );
    expect(await events(repo)).toContain(LifecycleEvent.EXISTING_LEAD_ISSUE);
  });

  it.each([
    ['existing_booking', 'My booking dates look wrong'],
    ['complaint', 'I am unhappy with the service'],
    ['other', 'A general request'],
  ])('sends kind %s when the agent classifies it', async (kind, issue) => {
    const repo = await seeded('L5');
    const submitInboundIssue = vi.fn().mockResolvedValue({ ok: true, lead_id: 'L5' });
    const client = fakeGuidedBoostClient({ submitInboundIssue });
    await run(TOOL.LOG_ISSUE, { issue, kind }, { repo, client });
    expect(submitInboundIssue).toHaveBeenCalledWith(expect.objectContaining({ kind }));
  });

  it('maps request_existing_consultant to kind wants_consultant', async () => {
    const repo = await seeded('L5');
    const submitInboundIssue = vi.fn().mockResolvedValue({ ok: true, lead_id: 'L5' });
    const client = fakeGuidedBoostClient({ submitInboundIssue });
    await run(
      TOOL.LOG_ISSUE,
      { issue: 'Please have my consultant call me', request_existing_consultant: true },
      { repo, client },
    );
    expect((await repo.getByRetellCallId(CALL_ID))?.requestedExistingConsultant).toBe(true);
    expect(submitInboundIssue).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'wants_consultant' }),
    );
  });

  it('urgent issue: alerts, copies admins, and records the escalation', async () => {
    const repo = await seeded('L5');
    const submitInboundIssue = vi.fn().mockResolvedValue({
      ok: true,
      lead_id: 'L5',
      lead_created: false,
      owner: { name: 'Grace', email: 'grace@x.com' },
      alerted: { to: ['grace@x.com'], cc: ['admin@x.com'] },
      alert_sent: true,
    });
    const client = fakeGuidedBoostClient({ submitInboundIssue });
    const result = await run(
      TOOL.LOG_ISSUE,
      { issue: 'My flight tomorrow was cancelled!', urgency: 'urgent' },
      { repo, client },
    );
    if (result.status === 'ok') {
      expect(result.payload['urgent']).toBe(true);
      expect(result.payload['escalated']).toBe(true);
    }
    expect(submitInboundIssue).toHaveBeenCalledWith(expect.objectContaining({ urgency: 'urgent' }));
    const record = await repo.getByRetellCallId(CALL_ID);
    expect(record?.urgency).toBe(Urgency.URGENT);
    expect(await events(repo)).toContain(LifecycleEvent.URGENT_ESCALATION);
    const escalation = record?.lifecycle.find((l) => l.event === LifecycleEvent.URGENT_ESCALATION);
    expect(escalation?.detail?.['adminCopied']).toBe(true);
    expect(escalation?.detail?.['alertSent']).toBe(true);
  });

  it('no lead → Guided Boost creates one, and the owner/result are persisted', async () => {
    const repo = await seeded(); // no lead on the record
    const submitInboundIssue = vi.fn().mockResolvedValue({
      ok: true,
      lead_id: 'NEW1',
      lead_created: true,
      owner: { name: 'Grace', email: 'grace@x.com' },
      alert_sent: true,
    });
    const client = fakeGuidedBoostClient({ submitInboundIssue });
    await run(TOOL.LOG_ISSUE, { issue: 'I need help with my trip' }, { repo, client });

    // Called with lead_id null + phone identifier; the API created the lead.
    expect(submitInboundIssue).toHaveBeenCalledWith(
      expect.objectContaining({ leadId: null, phone: '+12318310814' }),
    );
    const record = await repo.getByRetellCallId(CALL_ID);
    expect(record?.leadId).toBe('NEW1');
    expect(record?.leadCreated).toBe(true);
    expect(record?.ownerName).toBe('Grace');
    const issueEvent = record?.lifecycle.find(
      (l) => l.event === LifecycleEvent.EXISTING_LEAD_ISSUE,
    );
    expect(issueEvent?.detail?.['delivery']).toBe('sent');
    expect(issueEvent?.detail?.['leadCreated']).toBe(true);
  });

  it('preserves the issue locally when Guided Boost fails (safe response, call completes)', async () => {
    const repo = await seeded('L5');
    const submitInboundIssue = vi.fn().mockRejectedValue(new Error('gb down'));
    const client = fakeGuidedBoostClient({ submitInboundIssue });
    const result = await run(TOOL.LOG_ISSUE, { issue: 'Something is wrong' }, { repo, client });

    expect(result.status).toBe('ok');
    if (result.status === 'ok') expect(result.payload['logged']).toBe(true); // safe response
    const record = await repo.getByRetellCallId(CALL_ID);
    expect(record?.errors.length ?? 0).toBeGreaterThan(0);
    expect(await events(repo)).toContain(LifecycleEvent.CRM_UPDATE_FAILED);
    expect(await events(repo)).toContain(LifecycleEvent.EXISTING_LEAD_ISSUE);
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
    const record = await repo.getByRetellCallId(CALL_ID);
    expect(record?.leadResolved).toBe(false);
    expect(record?.leadId).toBeUndefined();
    expect(await events(repo)).toContain(LifecycleEvent.EXISTING_CALLER);
  });
});

// --- Phone / email / scheduler ordering -------------------------------------

describe('caller phone and brand separation', () => {
  it('sends the ORIGINAL caller number (from_number) as phone, never the dialed number', async () => {
    const repo = createInMemoryCallRepository();
    const submitInboundInquiry = vi.fn().mockResolvedValue({ ok: true, created: true });
    const client = fakeGuidedBoostClient({ submitInboundInquiry });
    // from_number = the caller; to_number = the dialed/brand line (must NOT be phone).
    const { rawBody, signature } = signedPayload(
      {
        call: { call_id: CALL_ID, from_number: '+13035550100', to_number: '+12318310814' },
        name: TOOL.SUBMIT_INQUIRY,
        args: { inquiry: 'Trip', email: 'ada@x.com' },
      },
      TEST_API_KEY,
    );
    await processToolRequest({ rawBody, signature, apiKey: TEST_API_KEY, repo, client });

    const arg = submitInboundInquiry.mock.calls[0]?.[0] as { phone?: string; email?: string };
    expect(arg.phone).toBe('+13035550100'); // caller's own number
    expect(arg.phone).not.toBe('+12318310814'); // not the dialed/brand number
    expect(arg.email).toBe('ada@x.com'); // email is passed through to the inquiry
  });
});

describe('scheduler ordering (inquiry → lead_id → team-slots)', () => {
  it('makes the team-slots request once the inquiry has provided a lead_id', async () => {
    const repo = await seeded(); // NEW caller: no lead yet
    const submitInboundInquiry = vi
      .fn()
      .mockResolvedValue({ ok: true, lead_id: 'NL9', created: true });
    const getTeamSlots = vi
      .fn()
      .mockResolvedValue({ slots: [{ starts_at: '2026-12-01T10:00:00.000Z' }], mode: 'pool' });
    const client = fakeGuidedBoostClient({ submitInboundInquiry, getTeamSlots });

    // Before any inquiry, get_available_slots cannot run (no lead) and makes no request.
    const early = await run(TOOL.GET_AVAILABLE_SLOTS, { timezone: 'UTC' }, { repo, client });
    if (early.status === 'ok') expect(early.payload['available']).toBe(false);
    expect(getTeamSlots).not.toHaveBeenCalled();

    // Submit the inquiry first; it returns and persists the lead_id.
    await run(TOOL.SUBMIT_INQUIRY, { inquiry: 'Everest', email: 'ada@x.com' }, { repo, client });
    expect((await repo.getByRetellCallId(CALL_ID))?.leadId).toBe('NL9');

    // Now the team-slots request fires with the lead_id and tz (no from/to).
    const slots = await run(TOOL.GET_AVAILABLE_SLOTS, { timezone: 'UTC' }, { repo, client });
    expect(getTeamSlots).toHaveBeenCalledTimes(1);
    expect(getTeamSlots.mock.calls[0]?.[0]).toBe('NL9');
    expect(getTeamSlots.mock.calls[0]?.[2]).toBeUndefined();
    if (slots.status === 'ok') {
      expect(slots.payload['available']).toBe(true);
      expect(slots.payload['mode']).toBe('dates');
    }
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
