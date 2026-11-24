import { describe, expect, it, vi } from 'vitest';
import { GuidedBoostClient } from './client.js';
import { GuidedBoostError } from './errors.js';
import type { GuidedBoostConfig } from '../../config/env.js';

const CONFIG: GuidedBoostConfig = {
  baseUrl: 'https://gb.test',
  apiKey: 'test_lead_key',
  agentEmail: 'agent@test',
  agentName: 'Agent',
  timeoutMs: 5000,
  maxRetries: 0,
};

interface FakeResponse {
  status?: number;
  body?: unknown;
}

function fakeFetch(responses: FakeResponse[] | FakeResponse) {
  const queue = Array.isArray(responses) ? [...responses] : [responses];
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const impl = vi.fn((url: string | URL | Request, init?: RequestInit) => {
    const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
    calls.push({ url: urlStr, init });
    const r = queue.shift() ?? { status: 200, body: null };
    const status = r.status ?? 200;
    const text = r.body === undefined || r.body === null ? '' : JSON.stringify(r.body);
    return Promise.resolve(
      new Response(text, { status, headers: { 'content-type': 'application/json' } }),
    );
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

function client(fetchImpl: typeof fetch) {
  return new GuidedBoostClient({ config: CONFIG, fetchImpl, sleep: () => Promise.resolve() });
}

describe('findLeadByPhone (GET /api/crm/search)', () => {
  // Shape verified live 2026-11-17: { results: [{ personKey, name, phone, salesAgent, ... }], persons: [] }
  it('matches a result whose phone equals the caller number', async () => {
    const { impl, calls } = fakeFetch({
      body: {
        results: [
          { personKey: 'email:ada@x.com', name: 'Ada', phone: '+12318310814', salesAgent: 'Grace' },
        ],
        persons: [],
      },
    });
    const match = await client(impl).findLeadByPhone('+12318310814');

    expect(match?.personKey).toBe('email:ada@x.com');
    expect(match?.salesAgent).toBe('Grace');
    expect(calls[0]?.url).toBe('https://gb.test/api/crm/search?q=%2B12318310814');
  });

  it('matches on the whatsapp field too', async () => {
    const { impl } = fakeFetch({
      body: { results: [{ personKey: 'lead:P9', whatsapp: '+12318310814' }] },
    });
    const match = await client(impl).findLeadByPhone('+12318310814');
    expect(match?.personKey).toBe('lead:P9');
  });

  it('accepts a phone-less result when the server reports matchedIn=phone', async () => {
    const { impl } = fakeFetch({
      body: { results: [{ personKey: 'lead:P7', matchedIn: 'phone' }] },
    });
    const match = await client(impl).findLeadByPhone('+12318310814');
    expect(match?.personKey).toBe('lead:P7');
  });

  it('returns null when a candidate phone does not match (no misidentification)', async () => {
    const { impl } = fakeFetch({
      body: { results: [{ personKey: 'lead:P2', phone: '+19999999999' }] },
    });
    expect(await client(impl).findLeadByPhone('+12318310814')).toBeNull();
  });

  it('returns null on an empty result set', async () => {
    const { impl } = fakeFetch({ body: { results: [], persons: [] } });
    expect(await client(impl).findLeadByPhone('+12318310814')).toBeNull();
  });

  it('degrades to null when the endpoint is unavailable (404)', async () => {
    const { impl } = fakeFetch({ status: 404, body: { error: 'not found' } });
    expect(await client(impl).findLeadByPhone('+12318310814')).toBeNull();
  });

  it('tolerates non-string fields on the record (regression: must not reject the match)', async () => {
    // The live response carries numbers/objects in fields we do not interpret
    // (e.g. a numeric lastActivityAt). A strict schema wrongly rejected the whole
    // record; the parser must still extract the match.
    const { impl } = fakeFetch({
      body: {
        results: [
          {
            personKey: 'email:ada@x.com',
            name: 'Ada',
            phone: '+12318310814',
            lastActivityAt: 1730000000000,
            matchedIn: { field: 'phone' },
            extra: { nested: true },
          },
        ],
      },
    });
    const match = await client(impl).findLeadByPhone('+12318310814');
    expect(match?.personKey).toBe('email:ada@x.com');
  });
});

describe('authentication headers', () => {
  it('sends only the read key on a GET', async () => {
    const { impl, calls } = fakeFetch({ body: { captured: {}, current: {} } });
    await client(impl).getLead('L1');
    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers['X-Lead-API-Key']).toBe('test_lead_key');
    expect(headers['Accept']).toBe('application/json');
    expect(headers['X-Agent-Email']).toBeUndefined();
  });

  it('adds the agent write identity on a POST (add call note)', async () => {
    const { impl, calls } = fakeFetch({ status: 200, body: null });
    await client(impl).addCallNote('L1', 'hello');
    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers['X-Lead-API-Key']).toBe('test_lead_key');
    expect(headers['X-Agent-Email']).toBe('agent@test');
    expect(headers['X-Agent-Name']).toBe('Agent');
    expect(headers['Content-Type']).toBe('application/json');
    expect(calls[0]?.url).toBe('https://gb.test/api/crm/leads/L1/notes');
  });
});

describe('unconfirmed write endpoints are not fired', () => {
  it('createLead raises unsupported without any network call', async () => {
    const { impl, calls } = fakeFetch({ body: {} });
    await expect(client(impl).createLead({ name: 'Ada' })).rejects.toMatchObject({
      name: 'GuidedBoostError',
      kind: 'unsupported',
    });
    expect(calls).toHaveLength(0);
  });

  it('updateLead raises unsupported without any network call', async () => {
    const { impl, calls } = fakeFetch({ body: {} });
    await expect(client(impl).updateLead('L1', { name: 'Ada' })).rejects.toBeInstanceOf(
      GuidedBoostError,
    );
    expect(calls).toHaveLength(0);
  });
});

describe('submitInboundInquiry (POST /api/caller/inbound/inquiries)', () => {
  it('POSTs brand/source + write headers and returns the created lead', async () => {
    const { impl, calls } = fakeFetch({
      status: 201,
      body: { ok: true, lead_id: 'NL9', person_key: 'lead:P1', created: true },
    });
    const result = await client(impl).submitInboundInquiry({
      brand: 'HW',
      phone: '+13035550100',
      email: null,
      name: 'Ada',
      travelers: 2,
      consultationStatus: 'not_requested',
      callId: 'call_1',
    });

    expect(result.lead_id).toBe('NL9');
    expect(result.created).toBe(true);
    expect(calls[0]?.url).toBe('https://gb.test/api/caller/inbound/inquiries');
    expect(calls[0]?.init?.method).toBe('POST');
    const body = JSON.parse(calls[0]?.init?.body as string) as Record<string, unknown>;
    expect(body['brand']).toBe('HW');
    expect(body['source']).toBe('inbound_ai_caller');
    expect(body['phone']).toBe('+13035550100');
    expect(body['email']).toBeNull();
    expect(body['travelers']).toBe(2);
    expect(body['consultation_status']).toBe('not_requested');
    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers['X-Lead-API-Key']).toBe('test_lead_key');
    expect(headers['X-Agent-Email']).toBe('agent@test');
    expect(headers['X-Agent-Name']).toBe('Agent');
  });

  it('omits empty optional fields (no meaningless empty strings)', async () => {
    const { impl, calls } = fakeFetch({ status: 200, body: { ok: true, created: false } });
    await client(impl).submitInboundInquiry({ brand: 'HW', phone: '+13035550100', name: '' });
    const body = JSON.parse(calls[0]?.init?.body as string) as Record<string, unknown>;
    expect(body).not.toHaveProperty('name');
    expect(body).not.toHaveProperty('destination');
    expect(body['brand']).toBe('HW');
  });

  it('treats created:false (200) as a success, not an error', async () => {
    const { impl } = fakeFetch({ status: 200, body: { ok: true, lead_id: 'L1', created: false } });
    const result = await client(impl).submitInboundInquiry({ brand: 'HW', email: 'ada@x.com' });
    expect(result.created).toBe(false);
    expect(result.lead_id).toBe('L1');
  });

  it('throws a contract error on an invalid (non-object) response', async () => {
    const { impl } = fakeFetch({ status: 200, body: 'not-an-object' });
    await expect(
      client(impl).submitInboundInquiry({ brand: 'HW', phone: '+13035550100' }),
    ).rejects.toMatchObject({ name: 'GuidedBoostError', kind: 'contract' });
  });

  it('refuses to call with neither phone nor email', async () => {
    const { impl, calls } = fakeFetch({ status: 200, body: { ok: true } });
    await expect(
      client(impl).submitInboundInquiry({ brand: 'HW', phone: null, email: null }),
    ).rejects.toMatchObject({ name: 'GuidedBoostError', kind: 'client' });
    expect(calls).toHaveLength(0);
  });
});

describe('identifyInboundCaller (POST /api/caller/inbound/identify)', () => {
  it('POSTs brand/phone/email with the write headers', async () => {
    const { impl, calls } = fakeFetch({
      body: { known: true, verified_by_phone: true, person_key: 'lead:L1' },
    });
    const result = await client(impl).identifyInboundCaller({
      brand: 'HW',
      phone: '+13035550100',
      email: null,
    });

    expect(result.known).toBe(true);
    expect(result.verified_by_phone).toBe(true);
    expect(calls[0]?.url).toBe('https://gb.test/api/caller/inbound/identify');
    expect(calls[0]?.init?.method).toBe('POST');
    const body = JSON.parse(calls[0]?.init?.body as string) as {
      brand: string;
      phone: string | null;
      email: string | null;
    };
    expect(body).toEqual({ brand: 'HW', phone: '+13035550100', email: null });
    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers['X-Lead-API-Key']).toBe('test_lead_key');
    expect(headers['X-Agent-Email']).toBe('agent@test');
    expect(headers['X-Agent-Name']).toBe('Agent');
  });

  it('throws a contract error on an invalid response shape (known missing)', async () => {
    const { impl } = fakeFetch({ body: { verified_by_phone: true } });
    await expect(
      client(impl).identifyInboundCaller({ brand: 'HW', phone: '+13035550100' }),
    ).rejects.toMatchObject({ name: 'GuidedBoostError', kind: 'contract' });
  });

  it('refuses to call with neither phone nor email', async () => {
    const { impl, calls } = fakeFetch({ body: { known: false } });
    await expect(
      client(impl).identifyInboundCaller({ brand: 'HW', phone: null, email: null }),
    ).rejects.toMatchObject({ name: 'GuidedBoostError', kind: 'client' });
    expect(calls).toHaveLength(0);
  });
});

describe('submitInboundIssue (POST /api/caller/inbound/issues)', () => {
  it('POSTs brand/issue/kind/urgency + write headers (single-shot)', async () => {
    const { impl, calls } = fakeFetch({
      status: 200,
      body: { ok: true, lead_id: 'L5', lead_created: false, alert_sent: true },
    });
    const result = await client(impl).submitInboundIssue({
      brand: 'HW',
      issue: 'My booking looks wrong',
      phone: '+13035550100',
      leadId: 'L5',
      kind: 'existing_booking',
      urgency: 'urgent',
      callId: 'call_1',
    });

    expect(result.ok).toBe(true);
    expect(result.alert_sent).toBe(true);
    expect(calls).toHaveLength(1); // not retried
    expect(calls[0]?.url).toBe('https://gb.test/api/caller/inbound/issues');
    expect(calls[0]?.init?.method).toBe('POST');
    const body = JSON.parse(calls[0]?.init?.body as string) as Record<string, unknown>;
    expect(body['brand']).toBe('HW');
    expect(body['issue']).toBe('My booking looks wrong');
    expect(body['kind']).toBe('existing_booking');
    expect(body['urgency']).toBe('urgent');
    expect(body['lead_id']).toBe('L5');
    expect(body['phone']).toBe('+13035550100');
    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers['X-Lead-API-Key']).toBe('test_lead_key');
    expect(headers['X-Agent-Email']).toBe('agent@test');
    expect(headers['X-Agent-Name']).toBe('Agent');
  });

  it('defaults urgency to normal and sends lead_id null when absent', async () => {
    const { impl, calls } = fakeFetch({ status: 200, body: { ok: true } });
    await client(impl).submitInboundIssue({
      brand: 'HW',
      issue: 'A question',
      phone: '+13035550100',
    });
    const body = JSON.parse(calls[0]?.init?.body as string) as Record<string, unknown>;
    expect(body['urgency']).toBe('normal');
    expect(body['lead_id']).toBeNull();
    expect(body).not.toHaveProperty('summary');
  });

  it('throws a contract error on an invalid (non-object) response', async () => {
    const { impl } = fakeFetch({ status: 200, body: 'not-an-object' });
    await expect(
      client(impl).submitInboundIssue({ brand: 'HW', issue: 'x', phone: '+13035550100' }),
    ).rejects.toMatchObject({ name: 'GuidedBoostError', kind: 'contract' });
  });

  it('requires an issue', async () => {
    const { impl, calls } = fakeFetch({ status: 200, body: { ok: true } });
    await expect(
      client(impl).submitInboundIssue({ brand: 'HW', issue: '   ', phone: '+13035550100' }),
    ).rejects.toMatchObject({ name: 'GuidedBoostError', kind: 'client' });
    expect(calls).toHaveLength(0);
  });
});

describe('no secret leakage', () => {
  it('never puts the api key in an error message', async () => {
    const { impl } = fakeFetch({ status: 500, body: { error: 'boom' } });
    try {
      await client(impl).getLead('L1');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(GuidedBoostError);
      expect((error as Error).message).not.toContain('test_lead_key');
    }
  });
});
