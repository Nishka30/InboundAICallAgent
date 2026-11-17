import {
  env,
  requireGuidedBoostConfig,
  type Env,
  type GuidedBoostConfig,
} from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import { classifyStatus, GuidedBoostError, sanitizePath } from './errors.js';
import {
  createLeadResponseSchema,
  errorBodySchema,
  extractSlots,
  leadDetailSchema,
  leadSummarySchema,
  personHistorySchema,
  teamAppointmentResponseSchema,
  type LeadDetail,
  type LeadSummary,
  type PersonHistory,
  type TeamSlot,
} from './schemas.js';
import type { MeetingType } from '../../domain/call.js';

/**
 * Guided Boost API client.
 *
 * Guided Boost is a SEPARATE system, integrated over HTTP only and treated as the
 * source of truth for all lead/person/booking data. This client owns ALL transport
 * and auth for that integration — no raw `fetch` lives anywhere else.
 *
 * Auth (reused from CallScheduler, unchanged): reads send `X-Lead-API-Key`;
 * authorized writes additionally send the fixed `X-Agent-Email` / `X-Agent-Name`
 * caller identity. The key is attached only in headers and is never logged.
 *
 * Reliability: GETs are retried with bounded exponential backoff on 429/5xx/network
 * only; writes are SINGLE-SHOT (a booking/note is not safe to blindly retry).
 *
 * Endpoint confidence:
 *   CONFIRMED (verified in CallScheduler against the live host):
 *     GET  /api/crm/leads/:id
 *     GET  /api/crm/persons/:personKey
 *     GET  /api/crm/leads/:id/team-slots
 *     POST /api/crm/appointments/team
 *     POST /api/crm/leads/:id/notes
 *   ASSUMED (no confirmed Guided Boost endpoint yet — see PROJECT_CONTEXT.md §10):
 *     GET  /api/crm/leads/search?phone=   (identify caller by phone)
 *     POST /api/crm/leads                 (create a lead for an unknown caller)
 *     PATCH /api/crm/leads/:id            (update a lead)
 *   The ASSUMED reads degrade to "unknown/none" so an inbound call never fails
 *   merely because the endpoint is not yet available; the writes surface a typed
 *   failure the caller handles gracefully.
 */

export interface GuidedBoostClientOptions {
  config?: GuidedBoostConfig;
  /** Injected for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Injected for tests so backoff does not actually sleep. */
  sleep?: (ms: number) => Promise<void>;
}

export interface CreateLeadInput {
  name?: string;
  email?: string;
  phone?: string;
  destination?: string;
  travelDates?: string;
  travelers?: string;
  interests?: string;
  budget?: string;
  travelStyle?: string;
  notes?: string;
  /** Correlates the created lead with this inbound call. */
  source?: string;
}

export interface CreatedLead {
  leadId: string | null;
  personKey: string | null;
}

export interface BookTeamAppointmentInput {
  leadId: string;
  /** The exact UTC instant from a team slot — never a locally computed time. */
  startsAt: string;
  meetingType: MeetingType;
  customerTz: string;
  notes: string;
}

export interface BookTeamAppointmentResult {
  appointmentId: string | null;
  status: string | null;
  agentName: string | null;
  startsAt: string | null;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export class GuidedBoostClient {
  private readonly config: GuidedBoostConfig;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: GuidedBoostClientOptions = {}, envSource: Env = env) {
    this.config = options.config ?? requireGuidedBoostConfig(envSource);
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.sleep = options.sleep ?? defaultSleep;
  }

  /** Safe to log — no secret. */
  get baseUrl(): string {
    return this.config.baseUrl;
  }

  // --- Caller identification --------------------------------------------------

  /**
   * ASSUMED endpoint. Looks up a lead by E.164 phone. Returns the lead summary, or
   * `null` when none matches OR the endpoint is not available (any permanent
   * failure) — so an inbound call proceeds as a new inquiry rather than failing.
   */
  async findLeadByPhone(e164: string): Promise<LeadSummary | null> {
    const query = new URLSearchParams({ phone: e164 });
    let payload: unknown;
    try {
      payload = await this.getJson('/api/crm/leads/search', query);
    } catch (error) {
      if (error instanceof GuidedBoostError && error.permanent) {
        logger.warn(
          { kind: error.kind, status: error.status },
          'guided boost: phone lookup unavailable; treating caller as unknown',
        );
        return null;
      }
      throw error;
    }
    return this.firstLeadSummary(payload);
  }

  private firstLeadSummary(payload: unknown): LeadSummary | null {
    if (payload === null || payload === undefined) return null;
    if (Array.isArray(payload)) {
      for (const row of payload) {
        const parsed = leadSummarySchema.safeParse(row);
        if (parsed.success) return parsed.data;
      }
      return null;
    }
    if (typeof payload === 'object') {
      const record = payload as Record<string, unknown>;
      // Direct lead object.
      const direct = leadSummarySchema.safeParse(record);
      if (direct.success && typeof record['id'] !== 'undefined') return direct.data;
      // Or an envelope holding the single array of results.
      const arrayKey = Object.keys(record).find((k) => Array.isArray(record[k]));
      if (arrayKey) return this.firstLeadSummary(record[arrayKey]);
    }
    return null;
  }

  /** CONFIRMED. `GET /api/crm/leads/:id`. */
  async getLead(leadId: string): Promise<LeadDetail> {
    const path = `/api/crm/leads/${encodeURIComponent(leadId)}`;
    const payload = await this.getJson(path);
    const parsed = leadDetailSchema.safeParse(payload);
    if (!parsed.success) {
      throw new GuidedBoostError('contract', 'lead detail did not match the expected shape', {
        path: '/api/crm/leads/:id',
      });
    }
    return parsed.data;
  }

  /** CONFIRMED. `GET /api/crm/persons/:personKey` (`email:<addr>` or `lead:<id>`). */
  async getPerson(personKey: string): Promise<PersonHistory> {
    const path = `/api/crm/persons/${encodeURIComponent(personKey)}`;
    const payload = await this.getJson(path);
    const parsed = personHistorySchema.safeParse(payload);
    if (!parsed.success) {
      throw new GuidedBoostError('contract', 'person history did not match the expected shape', {
        path: '/api/crm/persons/:personKey',
      });
    }
    return parsed.data;
  }

  // --- Lead write surface -----------------------------------------------------

  /** ASSUMED endpoint. `POST /api/crm/leads`. Single-shot. */
  async createLead(input: CreateLeadInput): Promise<CreatedLead> {
    const body: Record<string, unknown> = { is_lead: true };
    if (input.name !== undefined) body['name'] = input.name;
    if (input.email !== undefined) body['email'] = input.email;
    if (input.phone !== undefined) body['phone'] = input.phone;
    if (input.destination !== undefined) body['destination'] = input.destination;
    if (input.travelDates !== undefined) body['travel_dates'] = input.travelDates;
    if (input.travelers !== undefined) body['travelers'] = input.travelers;
    if (input.interests !== undefined) body['interests'] = input.interests;
    if (input.budget !== undefined) body['budget'] = input.budget;
    if (input.travelStyle !== undefined) body['travel_style'] = input.travelStyle;
    if (input.notes !== undefined) body['free_text'] = input.notes;
    if (input.source !== undefined) body['source'] = input.source;

    const payload = await this.write('POST', '/api/crm/leads', body);
    const parsed = createLeadResponseSchema.safeParse(payload);
    const leadId = parsed.success ? (parsed.data.id ?? parsed.data.lead_id ?? null) : null;
    const personKey = parsed.success ? (parsed.data.person_key ?? null) : null;
    return { leadId, personKey };
  }

  /** ASSUMED endpoint. `PATCH /api/crm/leads/:id`. Single-shot. */
  async updateLead(leadId: string, input: CreateLeadInput): Promise<void> {
    const body: Record<string, unknown> = {};
    if (input.name !== undefined) body['name'] = input.name;
    if (input.email !== undefined) body['email'] = input.email;
    if (input.phone !== undefined) body['phone'] = input.phone;
    if (input.destination !== undefined) body['destination'] = input.destination;
    if (input.travelDates !== undefined) body['travel_dates'] = input.travelDates;
    if (input.travelers !== undefined) body['travelers'] = input.travelers;
    if (input.interests !== undefined) body['interests'] = input.interests;
    if (input.budget !== undefined) body['budget'] = input.budget;
    if (input.travelStyle !== undefined) body['travel_style'] = input.travelStyle;
    if (input.notes !== undefined) body['free_text'] = input.notes;
    if (Object.keys(body).length === 0) return;
    await this.write('PATCH', `/api/crm/leads/${encodeURIComponent(leadId)}`, body);
  }

  /** CONFIRMED. `POST /api/crm/leads/:id/notes` with `{ kind: 'call', note }`. */
  async addCallNote(leadId: string, note: string): Promise<void> {
    await this.write('POST', `/api/crm/leads/${encodeURIComponent(leadId)}/notes`, {
      kind: 'call',
      note,
    });
  }

  // --- Booking ----------------------------------------------------------------

  /** CONFIRMED. `GET /api/crm/leads/:id/team-slots?tz=&from=&to=`. */
  async getTeamSlots(
    leadId: string,
    tz: string,
    range: { from?: string; to?: string } = {},
  ): Promise<{ slots: TeamSlot[]; mode: string | null }> {
    const query = new URLSearchParams({ tz });
    if (range.from) query.set('from', range.from);
    if (range.to) query.set('to', range.to);
    const path = `/api/crm/leads/${encodeURIComponent(leadId)}/team-slots`;
    const payload = await this.getJson(path, query);
    return extractSlots(payload);
  }

  /** CONFIRMED. `POST /api/crm/appointments/team`. Single-shot (not idempotent). */
  async bookTeamAppointment(input: BookTeamAppointmentInput): Promise<BookTeamAppointmentResult> {
    const body = {
      lead_id: input.leadId,
      starts_at: input.startsAt,
      meeting_type: input.meetingType,
      customer_tz: input.customerTz,
      notes: input.notes,
      booked_by: 'caller',
    };
    const payload = await this.write('POST', '/api/crm/appointments/team', body);
    const parsed = teamAppointmentResponseSchema.safeParse(payload);
    if (!parsed.success || !parsed.data.appointment) {
      throw new GuidedBoostError('contract', 'booking response did not match the expected shape', {
        path: '/api/crm/appointments/team',
      });
    }
    const appt = parsed.data.appointment;
    return {
      appointmentId: appt.id ?? null,
      status: appt.status ?? null,
      agentName: appt.agent_name ?? null,
      startsAt: appt.starts_at ?? null,
    };
  }

  // --- Transport --------------------------------------------------------------

  private readHeaders(): Record<string, string> {
    return { 'X-Lead-API-Key': this.config.apiKey, Accept: 'application/json' };
  }

  private writeHeaders(): Record<string, string> {
    return {
      ...this.readHeaders(),
      'Content-Type': 'application/json',
      'X-Agent-Email': this.config.agentEmail,
      'X-Agent-Name': this.config.agentName,
    };
  }

  private async getJson(path: string, query?: URLSearchParams): Promise<unknown> {
    const suffix = query && [...query].length > 0 ? `?${query.toString()}` : '';
    const url = `${this.config.baseUrl}${path}${suffix}`;
    let lastError: GuidedBoostError | undefined;

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt += 1) {
      if (attempt > 0) {
        const delay = lastError?.retryAfterMs ?? backoffDelayMs(attempt);
        logger.warn(
          { path: sanitizePath(path), attempt, delayMs: delay, kind: lastError?.kind },
          'retrying guided boost request',
        );
        await this.sleep(delay);
      }
      try {
        return await this.performRequest('GET', url, path, this.readHeaders());
      } catch (error) {
        if (!(error instanceof GuidedBoostError) || error.permanent) throw error;
        lastError = error;
      }
    }
    throw lastError ?? new GuidedBoostError('network', 'request failed', { path });
  }

  private async write(
    method: 'POST' | 'PATCH',
    path: string,
    body: Record<string, unknown>,
  ): Promise<unknown> {
    const url = `${this.config.baseUrl}${path}`;
    return this.performRequest(method, url, path, this.writeHeaders(), JSON.stringify(body));
  }

  private async performRequest(
    method: 'GET' | 'POST' | 'PATCH',
    url: string,
    path: string,
    headers: Record<string, string>,
    body?: string,
  ): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers,
        ...(body === undefined ? {} : { body }),
        signal: AbortSignal.timeout(this.config.timeoutMs),
        redirect: 'error',
      });
    } catch (error) {
      const timedOut = error instanceof Error && error.name === 'TimeoutError';
      throw new GuidedBoostError(
        'network',
        timedOut ? `request timed out after ${String(this.config.timeoutMs)}ms` : 'request failed',
        { path, cause: error },
      );
    }

    if (!response.ok) {
      throw new GuidedBoostError(
        classifyStatus(response.status),
        `guided boost ${method} ${sanitizePath(path)} returned ${String(response.status)}${await describeErrorBody(response)}`,
        { status: response.status, path, ...parseRetryAfter(response.headers.get('retry-after')) },
      );
    }

    try {
      // Some writes (notes) may return an empty body; that is a success.
      const text = await response.text();
      return text.length === 0 ? null : JSON.parse(text);
    } catch (error) {
      throw new GuidedBoostError('contract', 'response body was not valid JSON', {
        status: response.status,
        path,
        cause: error,
      });
    }
  }
}

/** Reads only the documented `{ error }` field, never the whole body. */
async function describeErrorBody(response: Response): Promise<string> {
  try {
    const body: unknown = await response.json();
    const parsed = errorBodySchema.safeParse(body);
    return parsed.success ? `: ${parsed.data.error.slice(0, 200)}` : '';
  } catch {
    return '';
  }
}

function parseRetryAfter(header: string | null): { retryAfterMs?: number } {
  if (!header) return {};
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return { retryAfterMs: Math.min(seconds * 1_000, 60_000) };
  }
  const date = Date.parse(header);
  if (!Number.isNaN(date)) {
    return { retryAfterMs: Math.max(0, Math.min(date - Date.now(), 60_000)) };
  }
  return {};
}

/** Exponential backoff with jitter: ~250ms, ~500ms, ~1s, capped at 8s. */
function backoffDelayMs(attempt: number): number {
  const base = Math.min(250 * 2 ** (attempt - 1), 8_000);
  return Math.round(base * (0.5 + Math.random() * 0.5));
}
