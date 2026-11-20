import {
  env,
  requireGuidedBoostConfig,
  type Env,
  type GuidedBoostConfig,
} from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import { normalizePhoneToE164 } from '../../lib/phone.js';
import { classifyStatus, GuidedBoostError, sanitizePath } from './errors.js';
import {
  createLeadResponseSchema,
  errorBodySchema,
  extractSearchResults,
  extractSlots,
  inboundIdentifyResponseSchema,
  inboundInquiryResponseSchema,
  leadDetailSchema,
  personHistorySchema,
  teamAppointmentResponseSchema,
  type InboundIdentifyResponse,
  type InboundInquiryResponse,
  type LeadDetail,
  type PersonHistory,
  type SearchResult,
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
 * Endpoint confidence (verified against CallScheduler's integration + docs):
 *   CONFIRMED (used by CallScheduler against the live host):
 *     GET  /api/crm/leads/:id
 *     GET  /api/crm/persons/:personKey
 *     GET  /api/crm/leads/:id/team-slots
 *     POST /api/crm/appointments/team
 *     POST /api/crm/leads/:id/notes
 *   EXISTS BUT RESPONSE UNVERIFIED:
 *     GET  /api/crm/search   — a real Guided Boost route (named in CallScheduler's
 *       architecture doc, "deliberately unused" because its response was never
 *       verified). Used here for phone lookup with a DEFENSIVE parse plus an
 *       explicit phone-match check, so an unexpected shape only ever yields
 *       "unknown caller" — never a misidentification. The query parameter name is
 *       not documented (`q` is used); confirm with Guided Boost.
 *   NOT A CONFIRMED CONTRACT (no such endpoint found in any Guided Boost source or
 *   the CallScheduler integration):
 *     create a lead, update lead fields.
 *   `LEAD_WRITE_ENDPOINTS_CONFIRMED` gates those two writes: while false they do
 *   NOT fire a request at an unconfirmed path — they raise an `unsupported` error
 *   the tools turn into a graceful "captured for follow-up" result, and the
 *   collected info is retained on the local call record. Flip the flag (and set the
 *   real path/schema) once Guided Boost confirms the endpoints.
 */

/** The phone-lookup search endpoint (real route; response contract unverified). */
const SEARCH_PATH = '/api/crm/search';

/** Authoritative inbound caller identification (Guided Boost "WHO IS RINGING"). */
const INBOUND_IDENTIFY_PATH = '/api/caller/inbound/identify';

/** Inbound new-inquiry capture (Guided Boost "A NEW INQUIRY"). */
const INBOUND_INQUIRY_PATH = '/api/caller/inbound/inquiries';

/** Consultation status sent on an inbound inquiry. */
export type ConsultationStatus = 'not_requested' | 'requested' | 'booking_failed' | 'booked';

export interface SubmitInboundInquiryInput {
  brand: string;
  name?: string;
  phone?: string | null;
  email?: string | null;
  destination?: string;
  travelDates?: string;
  travelers?: number;
  budget?: string;
  preferences?: string;
  notes?: string;
  consultationStatus?: ConsultationStatus;
  timeZone?: string;
  summary?: string;
  transcript?: string;
  recordingUrl?: string;
  callId?: string;
  startedAt?: string;
  endedAt?: string;
}

/**
 * Whether Guided Boost's lead create/update endpoints are confirmed. FALSE until
 * Guided Boost provides the real contract — see the class doc. Do not flip this to
 * true without also setting the correct path + request/response schema.
 */
const LEAD_WRITE_ENDPOINTS_CONFIRMED = false;

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
   * AUTHORITATIVE inbound caller identification — `POST /api/caller/inbound/identify`
   * (Guided Boost "WHO IS RINGING", API 1). One call returns whether the caller is
   * known, whether they are verified by the number they called from, their owner,
   * newest lead, booking/consultation state and a (non-amount) payment summary.
   *
   * `brand` is required; at least one of `phone`/`email` is required (the caller's
   * E.164 phone is sent whenever available). Idempotent, so it is retried on
   * transient failures like a read. Sends `X-Lead-API-Key` plus the fixed
   * `X-Agent-Email`/`X-Agent-Name` identity (the existing POST convention); the key
   * is never logged. Throws `GuidedBoostError` on a permanent failure / bad shape —
   * the caller-identification service turns that into a graceful "unknown caller".
   */
  async identifyInboundCaller(input: {
    brand: string;
    phone?: string | null;
    email?: string | null;
  }): Promise<InboundIdentifyResponse> {
    const brand = input.brand.trim();
    if (!brand) {
      throw new GuidedBoostError('client', 'brand is required for caller identification', {
        path: INBOUND_IDENTIFY_PATH,
      });
    }
    const phone = input.phone ?? null;
    const email = input.email ?? null;
    if (!phone && !email) {
      throw new GuidedBoostError('client', 'phone or email is required for caller identification', {
        path: INBOUND_IDENTIFY_PATH,
      });
    }

    const payload = await this.postJsonRetried(INBOUND_IDENTIFY_PATH, { brand, phone, email });
    const parsed = inboundIdentifyResponseSchema.safeParse(payload);
    if (!parsed.success) {
      throw new GuidedBoostError('contract', 'inbound identify response did not match the shape', {
        path: INBOUND_IDENTIFY_PATH,
      });
    }
    return parsed.data;
  }

  /**
   * Looks up a caller by E.164 phone via `GET /api/crm/search`.
   *
   * The response (`{ results, persons }`, verified live) is parsed into
   * person-centric `SearchResult`s keyed by `personKey`. A candidate is accepted
   * ONLY when its own `phone`/`whatsapp` normalizes to the same E.164, or when the
   * server explicitly reports it matched a phone field (`matchedIn`) for our exact
   * query — so an ignored param or a wrong record never misidentifies the caller.
   * Returns `null` on no match OR any permanent failure (e.g. the endpoint is
   * unavailable), so the call proceeds as a new inquiry rather than failing.
   */
  async findLeadByPhone(e164: string): Promise<SearchResult | null> {
    // Query-param name is not documented; `q` is the generic search convention.
    const query = new URLSearchParams({ q: e164 });
    let payload: unknown;
    try {
      payload = await this.getJson(SEARCH_PATH, query);
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
    return this.matchCallerByPhone(payload, e164);
  }

  /** Accepts a search result whose phone/whatsapp matches, or that matched a phone field. */
  private matchCallerByPhone(payload: unknown, e164: string): SearchResult | null {
    const candidates = extractSearchResults(payload);
    for (const result of candidates) {
      const phone = normalizePhoneToE164(result.phone ?? null);
      const whatsapp = normalizePhoneToE164(result.whatsapp ?? null);
      if (phone === e164 || whatsapp === e164) return result;
      // No normalizable phone on the record, but the server says it matched a phone
      // field for our exact E.164 query — trust that server-side match.
      const matchedIn = (result.matchedIn ?? '').toLowerCase();
      if (!result.phone && !result.whatsapp && /phone|whatsapp|mobile/.test(matchedIn)) {
        return result;
      }
    }
    if (candidates.length > 0) {
      logger.info(
        { candidates: candidates.length },
        'guided boost: search returned candidates but none matched the caller number; unknown',
      );
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

  /**
   * Creates a lead. NOT a confirmed Guided Boost contract: while
   * `LEAD_WRITE_ENDPOINTS_CONFIRMED` is false this raises `unsupported` WITHOUT a
   * network call, so we never fire at an unconfirmed path. When Guided Boost
   * confirms the endpoint, flip the flag and set the real path/schema below.
   */
  async createLead(input: CreateLeadInput): Promise<CreatedLead> {
    if (!LEAD_WRITE_ENDPOINTS_CONFIRMED) {
      throw new GuidedBoostError('unsupported', 'lead creation endpoint is not confirmed', {
        path: '/api/crm/leads',
      });
    }
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

  /**
   * Updates lead fields. NOT a confirmed Guided Boost contract — gated exactly like
   * {@link createLead}; raises `unsupported` without a network call while the flag
   * is false.
   */
  async updateLead(leadId: string, input: CreateLeadInput): Promise<void> {
    if (!LEAD_WRITE_ENDPOINTS_CONFIRMED) {
      throw new GuidedBoostError('unsupported', 'lead update endpoint is not confirmed', {
        path: '/api/crm/leads/:id',
      });
    }
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

  /**
   * Submits an inbound inquiry — `POST /api/caller/inbound/inquiries` (Guided Boost
   * "A NEW INQUIRY", API 2). Creates a lead (or updates the one a recent identical
   * inquiry created within 30 minutes — the API's own idempotency), and also serves
   * an existing guest's new question (put into `notes`).
   *
   * `brand` is required and at least one of `phone`/`email`; all other fields are
   * sent only when available (empty values are omitted). `source` is always
   * `inbound_ai_caller`. Safe to retry (David's 30-minute dedup), so it is retried
   * on transient failures. Sends `X-Lead-API-Key` + the `X-Agent-Email`/`X-Agent-Name`
   * write identity; the key is never logged. Throws `GuidedBoostError` on a
   * permanent failure or a malformed response.
   */
  async submitInboundInquiry(input: SubmitInboundInquiryInput): Promise<InboundInquiryResponse> {
    const brand = input.brand.trim();
    if (!brand) {
      throw new GuidedBoostError('client', 'brand is required to submit an inquiry', {
        path: INBOUND_INQUIRY_PATH,
      });
    }
    const phone = input.phone ?? null;
    const email = input.email ?? null;
    if (!phone && !email) {
      throw new GuidedBoostError('client', 'phone or email is required to submit an inquiry', {
        path: INBOUND_INQUIRY_PATH,
      });
    }

    // Required + identity fields. phone/email are sent as null when absent (the API
    // contract); every other optional field is OMITTED unless it has a real value.
    const body: Record<string, unknown> = { brand, source: 'inbound_ai_caller', phone, email };
    const put = (key: string, value: string | undefined): void => {
      if (value !== undefined && value.length > 0) body[key] = value;
    };
    put('name', input.name);
    put('destination', input.destination);
    put('travel_dates', input.travelDates);
    if (typeof input.travelers === 'number' && Number.isFinite(input.travelers)) {
      body['travelers'] = input.travelers;
    }
    put('budget', input.budget);
    put('preferences', input.preferences);
    put('notes', input.notes);
    put('consultation_status', input.consultationStatus);
    put('time_zone', input.timeZone);
    put('summary', input.summary);
    put('transcript', input.transcript);
    put('recording_url', input.recordingUrl);
    put('call_id', input.callId);
    put('started_at', input.startedAt);
    put('ended_at', input.endedAt);

    const payload = await this.postJsonRetried(INBOUND_INQUIRY_PATH, body);
    const parsed = inboundInquiryResponseSchema.safeParse(payload);
    if (!parsed.success) {
      throw new GuidedBoostError('contract', 'inbound inquiry response did not match the shape', {
        path: INBOUND_INQUIRY_PATH,
      });
    }
    return parsed.data;
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

  /**
   * A POST that is safe to retry (an idempotent lookup such as identify). Mirrors
   * `getJson`'s bounded backoff on transient failures, but POSTs a body with the
   * write headers. Only ever use this for read-only POSTs, never for writes that
   * mutate (`write` stays single-shot).
   */
  private async postJsonRetried(path: string, body: Record<string, unknown>): Promise<unknown> {
    const url = `${this.config.baseUrl}${path}`;
    const payload = JSON.stringify(body);
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
        return await this.performRequest('POST', url, path, this.writeHeaders(), payload);
      } catch (error) {
        if (!(error instanceof GuidedBoostError) || error.permanent) throw error;
        lastError = error;
      }
    }
    throw lastError ?? new GuidedBoostError('network', 'request failed', { path });
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
