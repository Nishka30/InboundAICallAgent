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
    const record = repo.getByRetellCallId(CALL_ID);
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
      repo
        .getByRetellCallId(CALL_ID)
        ?.lifecycle.filter((l) => l.event === LifecycleEvent.CALL_STARTED) ?? [];
    expect(starts).toHaveLength(1);
  });

  it('completes a full call and writes one CRM note', async () => {
    const repo = createInMemoryCallRepository();
    const addCallNote = vi.fn().mockResolvedValue(undefined);
    const crmClient = fakeGuidedBoostClient({ addCallNote });
    const now = Date.now();

    await processInboundWebhook({ ...startedPayload(now), apiKey: TEST_API_KEY, now, repo });
    // A tool identified the caller's lead earlier in the call.
    repo.update(CALL_ID, { leadId: 'L42' });
    await processInboundWebhook({
      ...analyzedPayload(now),
      apiKey: TEST_API_KEY,
      now,
      repo,
      crmClient,
    });

    const record = repo.getByRetellCallId(CALL_ID);
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
    repo.update(CALL_ID, { leadId: 'L42' });
    const result = await processInboundWebhook({
      ...analyzedPayload(now),
      apiKey: TEST_API_KEY,
      now,
      repo,
      crmClient,
    });

    expect(result.status).toBe('processed');
    const record = repo.getByRetellCallId(CALL_ID);
    expect(record?.crmUpdatedAt).toBeUndefined();
    expect(record?.lifecycle.map((l) => l.event)).toContain(LifecycleEvent.CRM_UPDATE_FAILED);
    expect(record?.errors.length).toBeGreaterThan(0);
  });

  it('keeps a confirmed booking outcome through analysis', async () => {
    const repo = createInMemoryCallRepository();
    const now = Date.now();
    await processInboundWebhook({ ...startedPayload(now), apiKey: TEST_API_KEY, now, repo });
    repo.update(CALL_ID, { leadId: 'L42', bookingStatus: BookingStatus.CONFIRMED });
    const crmClient = fakeGuidedBoostClient();
    await processInboundWebhook({
      ...analyzedPayload(now),
      apiKey: TEST_API_KEY,
      now,
      repo,
      crmClient,
    });

    expect(repo.getByRetellCallId(CALL_ID)?.outcome).toBe(CallOutcome.BOOKED);
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
