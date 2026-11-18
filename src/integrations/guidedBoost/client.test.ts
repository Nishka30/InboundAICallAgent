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
  newLeadEnabled: false,
  newLeadPath: undefined,
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

describe('new-lead API (createLeadFromInboundInquiry)', () => {
  it('raises unsupported without a network call while unconfigured', async () => {
    const { impl, calls } = fakeFetch({ body: {} });
    await expect(client(impl).createLeadFromInboundInquiry({ name: 'Ada' })).rejects.toMatchObject({
      name: 'GuidedBoostError',
      kind: 'unsupported',
    });
    expect(calls).toHaveLength(0);
  });

  it('POSTs to the configured path with write headers when enabled', async () => {
    const { impl, calls } = fakeFetch({ status: 200, body: { id: 'NL9' } });
    const configured = new GuidedBoostClient({
      config: { ...CONFIG, newLeadEnabled: true, newLeadPath: '/api/crm/inbound-leads' },
      fetchImpl: impl,
      sleep: () => Promise.resolve(),
    });
    const created = await configured.createLeadFromInboundInquiry({ name: 'Ada', inquiry: 'Trip' });
    expect(created.leadId).toBe('NL9');
    expect(calls[0]?.url).toBe('https://gb.test/api/crm/inbound-leads');
    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers['X-Lead-API-Key']).toBe('test_lead_key');
    expect(headers['X-Agent-Email']).toBe('agent@test');
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
