import { describe, expect, it, vi } from 'vitest';
import { processInboundWebhook } from './inboundWebhook.service.js';
import { createInMemoryCallRepository } from '../repositories/callRepository.js';
import { BookingStatus, CallOutcome, CallStatus, LifecycleEvent } from '../domain/call.js';
import { fakeGuidedBoostClient, signedPayload, TEST_API_KEY } from '../testing/helpers.js';

const CALL_ID = 'call_abc123';

function startedPayload(now = Date.now()) {
  return signedPayload(
    {
      event: 'call_started',
      call: {
        call_id: CALL_ID,
        agent_id: 'agent_1',
        direction: 'inbound',
        from_number: '+12318310814',
        to_number: '+12318310814',
        start_timestamp: now,
      },
    },
    TEST_API_KEY,
    now,
  );
}

function analyzedPayload(now = Date.now()) {
  return signedPayload(
    {
      event: 'call_analyzed',
      call: {
        call_id: CALL_ID,
        end_timestamp: now,
        transcript: 'Agent: Hello. Caller: I want info on Everest.',
        call_analysis: {
          call_summary: 'Caller asked about Everest.',
          user_sentiment: 'Positive',
          call_successful: true,
        },
      },
    },
    TEST_API_KEY,
    now,
  );
}

describe('processInboundWebhook — security', () => {
  it('rejects a missing api key as misconfigured', async () => {
    const { rawBody, signature } = startedPayload();
    const result = await processInboundWebhook({ rawBody, signature, apiKey: undefined });
    expect(result.status).toBe('misconfigured');
  });

  it('rejects a missing signature', async () => {
    const { rawBody } = startedPayload();
    const result = await processInboundWebhook({
      rawBody,
      signature: undefined,
      apiKey: TEST_API_KEY,
    });
    expect(result.status).toBe('unauthorized');
  });

  it('rejects an invalid signature', async () => {
    const { rawBody } = startedPayload();
    const result = await processInboundWebhook({
      rawBody,
      signature: 'v=1,d=deadbeef',
      apiKey: TEST_API_KEY,
    });
    expect(result.status).toBe('unauthorized');
  });

  it('rejects a replayed (stale) signature', async () => {
    const stale = Date.now() - 10 * 60 * 1000;
    const { rawBody, signature } = startedPayload(stale);
    const result = await processInboundWebhook({
      rawBody,
      signature,
      apiKey: TEST_API_KEY,
      now: Date.now(),
    });
    expect(result.status).toBe('unauthorized');
  });

  it('rejects a malformed body', async () => {
    const rawBody = '{not json';
    const signature = signedPayload({}).signature; // signature won't match, but body fails first anyway
    const result = await processInboundWebhook({ rawBody, signature, apiKey: TEST_API_KEY });
    // Signature is computed over a different body, so it is unauthorized before parse.
    expect(['unauthorized', 'bad_request']).toContain(result.status);
  });
});

describe('processInboundWebhook — lifecycle', () => {
  it('opens a call record on call_started with the right lifecycle', async () => {
    const repo = createInMemoryCallRepository();
    const now = Date.now();
    const { rawBody, signature } = startedPayload(now);

    const result = await processInboundWebhook({
      rawBody,
      signature,
      apiKey: TEST_API_KEY,
      now,
      repo,
    });

    expect(result.status).toBe('processed');
    const record = (await repo.getByRetellCallId(CALL_ID));
    expect(record?.status).toBe(CallStatus.IN_PROGRESS);
    const events = record?.lifecycle.map((l) => l.event) ?? [];
    expect(events).toContain(LifecycleEvent.INBOUND_RECEIVED);
    expect(events).toContain(LifecycleEvent.CALL_STARTED);
  });

  it('is idempotent for a duplicate (replayed) event', async () => {
    const repo = createInMemoryCallRepository();
    const now = Date.now();
    const { rawBody, signature } = startedPayload(now);

    const first = await processInboundWebhook({
      rawBody,
      signature,
      apiKey: TEST_API_KEY,
      now,
      repo,
    });
    const second = await processInboundWebhook({
      rawBody,
      signature,
      apiKey: TEST_API_KEY,
      now,
      repo,
    });

    expect(first.status === 'processed' && first.changed).toBe(true);
    expect(second.status === 'processed' && second.changed).toBe(false);
    // Lifecycle not duplicated.
    const starts =
      (await repo.getByRetellCallId(CALL_ID))?.lifecycle.filter(
        (l) => l.event === LifecycleEvent.CALL_STARTED,
      ) ?? [];
    expect(starts).toHaveLength(1);
  });

  it('completes a full call and writes one CRM note', async () => {
    const repo = createInMemoryCallRepository();
    const addCallNote = vi.fn().mockResolvedValue(undefined);
    const crmClient = fakeGuidedBoostClient({ addCallNote });
    const now = Date.now();

    await processInboundWebhook({ ...startedPayload(now), apiKey: TEST_API_KEY, now, repo });
    // A tool identified the caller's lead earlier in the call.
    await repo.update(CALL_ID, { leadId: 'L42' });
    await processInboundWebhook({
      ...analyzedPayload(now),
      apiKey: TEST_API_KEY,
      now,
      repo,
      crmClient,
    });

    const record = (await repo.getByRetellCallId(CALL_ID));
    expect(record?.status).toBe(CallStatus.ANALYZED);
    expect(record?.transcript).toContain('Everest');
    expect(record?.summary).toContain('Everest');
    expect(record?.outcome).toBe(CallOutcome.INFORMATION_PROVIDED);
    expect(addCallNote).toHaveBeenCalledTimes(1);
    expect(record?.crmUpdatedAt).toBeDefined();
    expect(record?.lifecycle.map((l) => l.event)).toContain(LifecycleEvent.CRM_UPDATED);
  });

  it('records a CRM failure without failing the webhook', async () => {
    const repo = createInMemoryCallRepository();
    const crmClient = fakeGuidedBoostClient({
      addCallNote: vi.fn().mockRejectedValue(new Error('gb down')),
    });
    const now = Date.now();

    await processInboundWebhook({ ...startedPayload(now), apiKey: TEST_API_KEY, now, repo });
    await repo.update(CALL_ID, { leadId: 'L42' });
    const result = await processInboundWebhook({
      ...analyzedPayload(now),
      apiKey: TEST_API_KEY,
      now,
      repo,
      crmClient,
    });

    expect(result.status).toBe('processed');
    const record = (await repo.getByRetellCallId(CALL_ID));
    expect(record?.crmUpdatedAt).toBeUndefined();
    expect(record?.lifecycle.map((l) => l.event)).toContain(LifecycleEvent.CRM_UPDATE_FAILED);
    expect(record?.errors.length).toBeGreaterThan(0);
  });

  it('keeps a confirmed booking outcome through analysis', async () => {
    const repo = createInMemoryCallRepository();
    const now = Date.now();
    await processInboundWebhook({ ...startedPayload(now), apiKey: TEST_API_KEY, now, repo });
    await repo.update(CALL_ID, { leadId: 'L42', bookingStatus: BookingStatus.CONFIRMED });
    const crmClient = fakeGuidedBoostClient();
    await processInboundWebhook({
      ...analyzedPayload(now),
      apiKey: TEST_API_KEY,
      now,
      repo,
      crmClient,
    });

    expect((await repo.getByRetellCallId(CALL_ID))?.outcome).toBe(CallOutcome.BOOKED);
  });

  it('answers the call_inbound hook with dynamic variables', async () => {
    const now = Date.now();
    const { rawBody, signature } = signedPayload(
      {
        event: 'call_inbound',
        call_inbound: {
          agent_id: 'agent_1',
          from_number: '+12318310814',
          to_number: '+12318310814',
        },
      },
      TEST_API_KEY,
      now,
    );

    const result = await processInboundWebhook({ rawBody, signature, apiKey: TEST_API_KEY, now });

    expect(result.status).toBe('inbound_ack');
    if (result.status === 'inbound_ack') {
      expect(result.response.call_inbound.dynamic_variables?.['agent_name']).toBeDefined();
      expect(result.response.call_inbound.dynamic_variables?.['caller_known']).toBe('no');
    }
  });

  it('ignores an unsupported event', async () => {
    const now = Date.now();
    const { rawBody, signature } = signedPayload(
      { event: 'call_something', call: { call_id: 'x' } },
      TEST_API_KEY,
      now,
    );
    const result = await processInboundWebhook({ rawBody, signature, apiKey: TEST_API_KEY, now });
    expect(result.status).toBe('ignored');
  });
});

describe('processInboundWebhook — call record (API 4)', () => {
  type CallArg = {
    brand: string;
    callId: string;
    outcome?: string;
    transcript?: string;
    recordingUrl?: string;
  };

  async function runFullCall(opts: {
    repo: ReturnType<typeof createInMemoryCallRepository>;
    crmClient: ReturnType<typeof fakeGuidedBoostClient>;
    leadId?: string;
  }) {
    const now = Date.now();
    await processInboundWebhook({ ...startedPayload(now), apiKey: TEST_API_KEY, now, repo: opts.repo });
    if (opts.leadId) await opts.repo.update(CALL_ID, { leadId: opts.leadId });
    return processInboundWebhook({
      ...analyzedPayload(now),
      apiKey: TEST_API_KEY,
      now,
      repo: opts.repo,
      crmClient: opts.crmClient,
    });
  }

  it('sends the call record at call_analyzed with brand, call_id, outcome and transcript', async () => {
    const repo = createInMemoryCallRepository();
    const submitInboundCall = vi.fn().mockResolvedValue({ ok: true, created: true });
    const crmClient = fakeGuidedBoostClient({
      addCallNote: vi.fn().mockResolvedValue(undefined),
      submitInboundCall,
    });
    await runFullCall({ repo, crmClient, leadId: 'L42' });

    expect(submitInboundCall).toHaveBeenCalledTimes(1);
    const arg = submitInboundCall.mock.calls[0]?.[0] as CallArg;
    expect(arg.brand).toBe('HW');
    expect(arg.callId).toBe(CALL_ID);
    expect(arg.outcome).toBe(CallOutcome.INFORMATION_PROVIDED);
    expect(arg.transcript).toContain('Everest');
    const record = await repo.getByRetellCallId(CALL_ID);
    expect(
      record?.lifecycle.some(
        (l) => l.event === LifecycleEvent.CRM_UPDATED && l.detail?.['target'] === 'call_record',
      ),
    ).toBe(true);
  });

  it('sends the call record even when there is no lead and no inquiry', async () => {
    const repo = createInMemoryCallRepository();
    const submitInboundCall = vi.fn().mockResolvedValue({ ok: true, created: true });
    const crmClient = fakeGuidedBoostClient({ submitInboundCall });
    await runFullCall({ repo, crmClient }); // no leadId

    expect(submitInboundCall).toHaveBeenCalledTimes(1);
    const arg = submitInboundCall.mock.calls[0]?.[0] as CallArg;
    expect(arg.callId).toBe(CALL_ID);
  });

  it('records a call-record CRM failure without failing the webhook', async () => {
    const repo = createInMemoryCallRepository();
    const submitInboundCall = vi.fn().mockRejectedValue(new Error('gb down'));
    const crmClient = fakeGuidedBoostClient({ submitInboundCall });
    const result = await runFullCall({ repo, crmClient, leadId: 'L42' });

    expect(result.status).toBe('processed');
    const record = await repo.getByRetellCallId(CALL_ID);
    expect(
      record?.lifecycle.some(
        (l) => l.event === LifecycleEvent.CRM_UPDATE_FAILED && l.detail?.['reason'] === 'call_record',
      ),
    ).toBe(true);
    expect((record?.errors.length ?? 0)).toBeGreaterThan(0);
  });

  it('does not resend the call record on a duplicate call_analyzed event', async () => {
    const repo = createInMemoryCallRepository();
    const submitInboundCall = vi.fn().mockResolvedValue({ ok: true, created: true });
    const crmClient = fakeGuidedBoostClient({ submitInboundCall });
    const now = Date.now();
    await processInboundWebhook({ ...startedPayload(now), apiKey: TEST_API_KEY, now, repo });
    const analyzed = { ...analyzedPayload(now), apiKey: TEST_API_KEY, now, repo, crmClient };
    await processInboundWebhook(analyzed);
    await processInboundWebhook(analyzed); // duplicate

    expect(submitInboundCall).toHaveBeenCalledTimes(1);
  });

  it('omits optional fields that are not available (e.g. no recording_url)', async () => {
    const repo = createInMemoryCallRepository();
    const submitInboundCall = vi.fn().mockResolvedValue({ ok: true, created: true });
    const crmClient = fakeGuidedBoostClient({ submitInboundCall });
    await runFullCall({ repo, crmClient }); // analyzedPayload has no recording_url

    const arg = submitInboundCall.mock.calls[0]?.[0] as CallArg;
    expect(arg.recordingUrl).toBeUndefined();
    expect(arg.transcript).toContain('Everest');
  });
});
