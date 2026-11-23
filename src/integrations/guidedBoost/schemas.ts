import { z } from 'zod';

/**
 * Boundary schemas for Guided Boost responses.
 *
 * Deliberately PERMISSIVE: every field is nullish and `.passthrough()` keeps
 * unknown fields, because Guided Boost owns these shapes and we must never make a
 * caller's call fail over an unexpected extra field. We read only what the inbound
 * flow needs. The confirmed shapes come from CallScheduler's verified Lead API /
 * calendar clients (validated against the live `guided-boost.lovable.app` host).
 */

const idString = z.union([z.string().min(1), z.number().int()]).transform(String);

/** A lead summary as returned by lookups / listings. */
export const leadSummarySchema = z
  .object({
    id: idString,
    name: z.string().nullish(),
    email: z.string().nullish(),
    phone: z.unknown().nullish(),
    whatsapp: z.unknown().nullish(),
    is_lead: z.boolean().nullish(),
    lead_status: z.string().nullish(),
    sales_agent: z.string().nullish(),
    sales_agent_email: z.string().nullish(),
    person_key: z.string().nullish(),
    person_uuid: z.string().nullish(),
  })
  .passthrough();

export type LeadSummary = z.infer<typeof leadSummarySchema>;

/**
 * One entry of `GET /api/crm/search` (verified live 2026-11-17). The response is
 * `{ results: SearchResult[], persons: SearchResult[] }`; a phone/WhatsApp query
 * returns matches under `results`. A search result is a PERSON-centric record
 * keyed by `personKey` (NOT a lead `id`), carrying the matched `phone`, the owner
 * (`salesAgent`), and `matchedIn` (which field matched). Permissive + passthrough.
 */
/**
 * A field read as a string but tolerant of anything: a non-string/number value
 * becomes `undefined` instead of failing the whole parse. Guided Boost owns this
 * shape and may send numbers/objects/timestamps in fields we do not interpret, so
 * a strict `z.string()` on any one of them would wrongly reject an entire match.
 */
const looseString = z.preprocess(
  (v) => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : undefined),
  z.string().optional(),
);

export const searchResultSchema = z
  .object({
    personKey: looseString,
    name: looseString,
    email: looseString,
    phone: looseString,
    whatsapp: looseString,
    salesAgent: looseString,
    salesAgentEmail: looseString,
    leadStatus: looseString,
    /** Which field the query matched, e.g. `phone` / `whatsapp` / `email`. */
    matchedIn: looseString,
  })
  .passthrough();

export type SearchResult = z.infer<typeof searchResultSchema>;

/**
 * Collects candidate search results from a `/api/crm/search` response: the
 * `results` and `persons` arrays, plus any other top-level array as a fallback.
 */
export function extractSearchResults(payload: unknown): SearchResult[] {
  const out: SearchResult[] = [];
  const consume = (value: unknown): void => {
    if (!Array.isArray(value)) return;
    for (const row of value) {
      const parsed = searchResultSchema.safeParse(row);
      if (parsed.success) out.push(parsed.data);
    }
  };
  if (Array.isArray(payload)) {
    consume(payload);
  } else if (payload && typeof payload === 'object') {
    const record = payload as Record<string, unknown>;
    consume(record['results']);
    consume(record['persons']);
    if (out.length === 0) {
      for (const value of Object.values(record)) consume(value);
    }
  }
  return out;
}

/**
 * `POST /api/caller/inbound/identify` — the authoritative inbound caller
 * identification (Guided Boost "WHO IS RINGING", API 1). ONE call returns
 * identity, owner, newest lead, booking/consultation state, verification and a
 * (non-amount) payment summary. Permissive + passthrough and every nested field
 * nullish, so an unexpected extra/`null` field never fails a live call. `known`
 * is the one required field (new vs existing caller).
 */
export const inboundIdentifyResponseSchema = z
  .object({
    known: z.boolean(),
    verified_by_phone: z.boolean().nullish(),
    has_booking: z.boolean().nullish(),
    person_id: idString.nullish(),
    person_key: z.string().nullish(),
    name: z.string().nullish(),
    owner: z
      .object({ name: z.string().nullish(), email: z.string().nullish() })
      .passthrough()
      .nullish(),
    lead: z
      .object({
        lead_id: idString.nullish(),
        status: z.string().nullish(),
        created_at: z.string().nullish(),
      })
      .passthrough()
      .nullish(),
    trip: z
      .object({
        name: z.string().nullish(),
        starts_on: z.string().nullish(),
        ends_on: z.string().nullish(),
        state: z.string().nullish(),
        lead_id: idString.nullish(),
      })
      .passthrough()
      .nullish(),
    payment: z
      .object({
        received: z.boolean().nullish(),
        payments: z.number().nullish(),
        last_paid_on: z.string().nullish(),
        // `by_card` and `charged_as` can currently be null.
        by_card: z.boolean().nullish(),
        charged_as: z.string().nullish(),
      })
      .passthrough()
      .nullish(),
    consultation: z
      .object({
        starts_at: z.string().nullish(),
        agent_name: z.string().nullish(),
        agent_email: z.string().nullish(),
        lead_id: idString.nullish(),
      })
      .passthrough()
      .nullish(),
  })
  .passthrough();

export type InboundIdentifyResponse = z.infer<typeof inboundIdentifyResponseSchema>;

/** `GET /api/crm/leads/<id>` — permissive detail view. */
export const leadDetailSchema = z
  .object({
    captured: z.record(z.unknown()).nullish(),
    current: z.record(z.unknown()).nullish(),
    personKey: z.string().nullish(),
    answers: z.array(z.unknown()).nullish(),
    phone: z.unknown().nullish(),
    notes: z.array(z.unknown()).nullish(),
  })
  .passthrough();

export type LeadDetail = z.infer<typeof leadDetailSchema>;

/**
 * One entry of a person's `leads[]` (verified live 2026-11-18). Each entry wraps
 * the raw lead columns under `captured` / `current` (the lead id + status live in
 * `current.id` / `current.lead_status`), mirroring the lead-listing/detail shape.
 */
export const personLeadEntrySchema = z
  .object({
    source: z.string().nullish(),
    captured: z.record(z.unknown()).nullish(),
    current: z.record(z.unknown()).nullish(),
    overrides: z.record(z.unknown()).nullish(),
  })
  .passthrough();

export type PersonLeadEntry = z.infer<typeof personLeadEntrySchema>;

/**
 * One entry of a person's `appointments[]` — the team-booking record (shape
 * verified in CallScheduler against the live API). Permissive: every field nullish.
 */
export const personAppointmentSchema = z
  .object({
    id: z.union([z.string(), z.number()]).transform(String).nullish(),
    lead_id: z.union([z.string(), z.number()]).transform(String).nullish(),
    starts_at: z.string().nullish(),
    ends_at: z.string().nullish(),
    status: z.string().nullish(),
    meeting_type: z.string().nullish(),
    customer_tz: z.string().nullish(),
    agent_email: z.string().nullish(),
    agent_name: z.string().nullish(),
  })
  .passthrough();

export type PersonAppointment = z.infer<typeof personAppointmentSchema>;

/** `GET /api/crm/persons/<personKey>` — person history (owner, status, leads, appts). */
export const personHistorySchema = z
  .object({
    personKey: z.string().nullish(),
    profile: z.record(z.unknown()).nullish(),
    leads: z.array(personLeadEntrySchema).nullish(),
    appointments: z.array(personAppointmentSchema).nullish(),
    notes: z.array(z.unknown()).nullish(),
  })
  .passthrough();

export type PersonHistory = z.infer<typeof personHistorySchema>;

/** The resolved primary lead for a caller, derived from a person's `leads[]`. */
export interface ResolvedPersonLead {
  leadId: string;
  leadStatus?: string;
  salesAgentEmail?: string;
  updatedAt?: string;
}

/** Reads a string field from a lead entry's `current` (preferred) or `captured`. */
function leadField(entry: PersonLeadEntry, field: string): string | undefined {
  const fromCurrent = entry.current?.[field];
  if (typeof fromCurrent === 'string' && fromCurrent.length > 0) return fromCurrent;
  const fromCaptured = entry.captured?.[field];
  if (typeof fromCaptured === 'string' && fromCaptured.length > 0) return fromCaptured;
  return undefined;
}

/**
 * Picks the primary lead for an identified caller: the most recently updated,
 * non-deleted lead with an id. Returns `null` when the person has no resolvable
 * lead (so the caller is preserved as identified, but no lead id is invented).
 */
export function pickPrimaryLead(person: PersonHistory): ResolvedPersonLead | null {
  const entries = person.leads ?? [];
  let best: ResolvedPersonLead | null = null;
  let bestTime = -Infinity;
  for (const entry of entries) {
    const deleted = entry.current?.['is_deleted'] ?? entry.captured?.['is_deleted'];
    if (deleted === true) continue;
    const id = leadField(entry, 'id');
    if (!id) continue;
    const updatedAt = leadField(entry, 'updated_at');
    const leadStatus = leadField(entry, 'lead_status');
    const salesAgentEmail = leadField(entry, 'sales_agent_email');
    const time = updatedAt ? Date.parse(updatedAt) : 0;
    if (best === null || time > bestTime) {
      best = {
        leadId: id,
        ...(leadStatus ? { leadStatus } : {}),
        ...(salesAgentEmail ? { salesAgentEmail } : {}),
        ...(updatedAt ? { updatedAt } : {}),
      };
      bestTime = Number.isNaN(time) ? 0 : time;
    }
  }
  return best;
}

/** True when the person has an appointment that is not cancelled. */
export function hasActiveAppointment(person: PersonHistory): boolean {
  return (person.appointments ?? []).some((appt) => {
    const status = (appt.status ?? '').toLowerCase();
    return status !== 'cancelled' && status !== 'canceled';
  });
}

/** The most relevant active appointment, if any. */
export function firstActiveAppointment(person: PersonHistory): PersonAppointment | null {
  return (
    (person.appointments ?? []).find((appt) => {
      const status = (appt.status ?? '').toLowerCase();
      return status !== 'cancelled' && status !== 'canceled';
    }) ?? null
  );
}

/** Reads the owner/sales agent from the person profile, when present. */
export function readProfileOwner(person: PersonHistory): { name?: string; email?: string } {
  const profile = person.profile ?? {};
  const salesAgent = profile['salesAgent'];
  if (salesAgent && typeof salesAgent === 'object') {
    const sa = salesAgent as Record<string, unknown>;
    const name = sa['name'] ?? sa['fullName'];
    const email = sa['email'];
    return {
      ...(typeof name === 'string' && name ? { name } : {}),
      ...(typeof email === 'string' && email ? { email } : {}),
    };
  }
  if (typeof salesAgent === 'string' && salesAgent) return { name: salesAgent };
  return {};
}

/** One availability slot from `GET /api/crm/leads/<id>/team-slots`. */
export const teamSlotSchema = z
  .object({
    starts_at: z.string().min(1),
    ends_at: z.string().nullish(),
    agent_email: z.string().nullish(),
    agent_name: z.string().nullish(),
  })
  .passthrough();

export type TeamSlot = z.infer<typeof teamSlotSchema>;

/**
 * The team-slots response. The exact envelope key is not documented, so (as in
 * CallScheduler) we accept either a bare array or the single top-level array in an
 * object, and also read a `decision.mode` routing hint when present.
 */
export const teamSlotsResponseSchema = z
  .object({
    slots: z.array(teamSlotSchema).nullish(),
    decision: z.object({ mode: z.string().nullish() }).passthrough().nullish(),
  })
  .passthrough();

/** `POST /api/crm/appointments/team` — the booking result. */
export const teamAppointmentResponseSchema = z
  .object({
    appointment: z
      .object({
        id: idString.nullish(),
        starts_at: z.string().nullish(),
        status: z.string().nullish(),
        agent_email: z.string().nullish(),
        agent_name: z.string().nullish(),
        meeting_type: z.string().nullish(),
      })
      .passthrough()
      .nullish(),
    decision: z.object({ mode: z.string().nullish() }).passthrough().nullish(),
  })
  .passthrough();

/** `POST /api/crm/leads` — lead creation result (ASSUMED shape; see client). */
export const createLeadResponseSchema = z
  .object({
    id: idString.nullish(),
    lead_id: idString.nullish(),
    person_key: z.string().nullish(),
  })
  .passthrough();

/**
 * `POST /api/caller/inbound/inquiries` — the new-inquiry API (Guided Boost "A NEW
 * INQUIRY", API 2) response. `created: true` (201) → a new lead was created;
 * `created: false` (200) → an identical/recent inquiry already created a lead
 * within 30 minutes and it was updated (a SUCCESSFUL, idempotent outcome).
 * Permissive + passthrough; every field nullish.
 */
export const inboundInquiryResponseSchema = z
  .object({
    ok: z.boolean().nullish(),
    lead_id: idString.nullish(),
    person_id: idString.nullish(),
    person_key: z.string().nullish(),
    created: z.boolean().nullish(),
    known_person: z.boolean().nullish(),
    owner: z
      .object({ name: z.string().nullish(), email: z.string().nullish() })
      .passthrough()
      .nullish(),
    brand: z.string().nullish(),
  })
  .passthrough();

export type InboundInquiryResponse = z.infer<typeof inboundInquiryResponseSchema>;

/**
 * `POST /api/caller/inbound/issues` — the existing-guest issue API (Guided Boost
 * "AN ISSUE ON AN EXISTING GUEST", API 3) response. Guided Boost writes the issue
 * to the guest's lead, emails the assigned agent (admins too when urgent, or when
 * there is no agent), and creates a lead if the caller had none. Permissive +
 * passthrough; every field nullish. Treated as successful when `ok === true`.
 */
export const inboundIssueResponseSchema = z
  .object({
    ok: z.boolean().nullish(),
    lead_id: idString.nullish(),
    lead_created: z.boolean().nullish(),
    owner: z
      .object({ name: z.string().nullish(), email: z.string().nullish() })
      .passthrough()
      .nullish(),
    alerted: z
      .object({ to: z.array(z.string()).nullish(), cc: z.array(z.string()).nullish() })
      .passthrough()
      .nullish(),
    alert_sent: z.boolean().nullish(),
  })
  .passthrough();

export type InboundIssueResponse = z.infer<typeof inboundIssueResponseSchema>;

/**
 * `POST /api/caller/inbound/calls` — the call-level record API (Guided Boost "call
 * ended", API 4) response. Sent at the end of every inbound call so the CRM's
 * "Inbound calls" page has a row (outcome, summary, transcript, recording), keyed
 * by `call_id`. Permissive + passthrough; treated as successful when `ok === true`.
 */
export const inboundCallResponseSchema = z
  .object({
    ok: z.boolean().nullish(),
    call_id: z.string().nullish(),
    created: z.boolean().nullish(),
    lead_id: idString.nullish(),
  })
  .passthrough();

export type InboundCallResponse = z.infer<typeof inboundCallResponseSchema>;

/** The `{ "error": "..." }` body Guided Boost returns on failure. */
export const errorBodySchema = z.object({ error: z.string() }).passthrough();

/**
 * Finds the first array of slots in a loosely-shaped response: either the `slots`
 * key, a bare top-level array, or the single top-level array in the object.
 */
export function extractSlots(payload: unknown): { slots: TeamSlot[]; mode: string | null } {
  if (Array.isArray(payload)) {
    return { slots: payload.map((s) => teamSlotSchema.parse(s)), mode: null };
  }
  const parsed = teamSlotsResponseSchema.safeParse(payload);
  if (parsed.success && parsed.data.slots) {
    return { slots: parsed.data.slots, mode: parsed.data.decision?.mode ?? null };
  }
  if (payload && typeof payload === 'object') {
    const record = payload as Record<string, unknown>;
    const arrayKey = Object.keys(record).find((k) => Array.isArray(record[k]));
    if (arrayKey) {
      const rows = record[arrayKey] as unknown[];
      const slots: TeamSlot[] = [];
      for (const row of rows) {
        const slot = teamSlotSchema.safeParse(row);
        if (slot.success) slots.push(slot.data);
      }
      const mode = parsed.success && parsed.data.decision?.mode ? parsed.data.decision.mode : null;
      return { slots, mode };
    }
  }
  return { slots: [], mode: null };
}
