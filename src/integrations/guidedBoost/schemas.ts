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

/** `GET /api/crm/persons/<personKey>` — person history (owner, status, counts). */
export const personHistorySchema = z
  .object({
    personKey: z.string().nullish(),
    profile: z.record(z.unknown()).nullish(),
    leads: z.array(z.unknown()).nullish(),
    appointments: z.array(z.unknown()).nullish(),
    notes: z.array(z.unknown()).nullish(),
  })
  .passthrough();

export type PersonHistory = z.infer<typeof personHistorySchema>;

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
      const mode =
        parsed.success && parsed.data.decision?.mode ? parsed.data.decision.mode : null;
      return { slots, mode };
    }
  }
  return { slots: [], mode: null };
}
