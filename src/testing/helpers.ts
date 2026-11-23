import { createHmac } from 'node:crypto';
import { vi } from 'vitest';
import type { GuidedBoostClient } from '../integrations/guidedBoost/client.js';

/** Signs a body exactly as Retell does: HMAC-SHA256(rawBody + timestamp) by key. */
export function signRetell(rawBody: string, apiKey: string, timestampMs = Date.now()): string {
  const digest = createHmac('sha256', apiKey)
    .update(rawBody + String(timestampMs))
    .digest('hex');
  return `v=${timestampMs},d=${digest}`;
}

export const TEST_API_KEY = 'test_retell_key';

/** Builds a signed body + header pair for a webhook/tool payload. */
export function signedPayload(
  value: unknown,
  apiKey = TEST_API_KEY,
  timestampMs = Date.now(),
): { rawBody: string; signature: string } {
  const rawBody = JSON.stringify(value);
  return { rawBody, signature: signRetell(rawBody, apiKey, timestampMs) };
}

/** A fully mocked GuidedBoostClient; override individual methods per test. */
export function fakeGuidedBoostClient(
  overrides: Partial<Record<keyof GuidedBoostClient, unknown>> = {},
): GuidedBoostClient {
  const base = {
    baseUrl: 'https://guided-boost.test',
    identifyInboundCaller: vi.fn().mockResolvedValue({
      known: false,
      verified_by_phone: false,
      has_booking: false,
      person_id: null,
      person_key: null,
      name: null,
      owner: null,
      lead: null,
      trip: null,
      payment: null,
      consultation: null,
    }),
    findLeadByPhone: vi.fn().mockResolvedValue(null),
    getLead: vi.fn().mockResolvedValue({}),
    getPerson: vi.fn().mockResolvedValue({ leads: [], appointments: [] }),
    createLead: vi.fn().mockResolvedValue({ leadId: null, personKey: null }),
    submitInboundInquiry: vi.fn().mockResolvedValue({
      ok: true,
      lead_id: null,
      person_id: null,
      person_key: null,
      created: true,
      known_person: false,
      owner: null,
    }),
    submitInboundIssue: vi.fn().mockResolvedValue({
      ok: true,
      lead_id: null,
      lead_created: false,
      owner: null,
      alerted: { to: [], cc: [] },
      alert_sent: true,
    }),
    submitInboundCall: vi.fn().mockResolvedValue({ ok: true, call_id: null, created: true }),
    updateLead: vi.fn().mockResolvedValue(undefined),
    addCallNote: vi.fn().mockResolvedValue(undefined),
    getTeamSlots: vi.fn().mockResolvedValue({ slots: [], mode: null }),
    bookTeamAppointment: vi
      .fn()
      .mockResolvedValue({ appointmentId: null, status: null, agentName: null, startsAt: null }),
    ...overrides,
  };
  return base as unknown as GuidedBoostClient;
}
