import { z } from 'zod';
import { MEETING_TYPES } from '../../domain/call.js';

/**
 * Schemas for Retell custom-function ("agent tool") calls.
 *
 * Retell posts the function-call request to the tool URL as
 * `{ call: {...}, name, args }`. `args` is usually a parsed object, but some
 * configurations send a JSON string in `args`/`arguments`; `readFunctionArgs`
 * tolerates both. The authoritative lead binding is ALWAYS taken from
 * `call.call_id` server-side — a lead id inside `args` is never trusted on its own.
 */

const callSchema = z
  .object({
    call_id: z.string().min(1),
    from_number: z.string().nullish(),
    to_number: z.string().nullish(),
    agent_id: z.string().nullish(),
    metadata: z.record(z.unknown()).nullish(),
    retell_llm_dynamic_variables: z.record(z.unknown()).nullish(),
  })
  .passthrough();

export const functionRequestSchema = z
  .object({
    call: callSchema,
    name: z.string().min(1).nullish(),
    args: z.union([z.record(z.unknown()), z.string()]).nullish(),
    arguments: z.union([z.record(z.unknown()), z.string()]).nullish(),
  })
  .passthrough();

export type FunctionRequest = z.infer<typeof functionRequestSchema>;

/** Extracts the function arguments as a plain object, tolerating a JSON string. */
export function readFunctionArgs(request: FunctionRequest): Record<string, unknown> {
  const raw = request.args ?? request.arguments;
  if (raw === null || raw === undefined) return {};
  if (typeof raw === 'string') {
    try {
      const parsed: unknown = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  return raw;
}

/** Tool names the inbound agent may call. */
export const TOOL = {
  IDENTIFY_CALLER: 'identify_caller',
  GET_LEAD: 'get_lead',
  CREATE_LEAD: 'create_lead',
  UPDATE_LEAD: 'update_lead',
  SUBMIT_INQUIRY: 'submit_inquiry',
  LOG_ISSUE: 'log_issue',
  ADD_CALL_NOTE: 'add_call_note',
  UPDATE_CALL_OUTCOME: 'update_call_outcome',
  GET_AVAILABLE_SLOTS: 'get_available_slots',
  BOOK_CONSULTATION: 'book_consultation',
} as const;

export type ToolName = (typeof TOOL)[keyof typeof TOOL];

// --- Per-tool argument schemas. Permissive on optional detail, strict on the
// few fields a tool genuinely requires. ----------------------------------------

const optionalText = z.string().trim().min(1).max(2000).optional();

export const identifyCallerArgsSchema = z.object({
  /** Optional: the tool falls back to the call's own caller number when omitted. */
  phone_number: z.string().trim().min(1).max(32).optional(),
});

export const getLeadArgsSchema = z.object({
  lead_id: z.string().trim().min(1).max(128),
});

export const leadFieldsSchema = z.object({
  name: optionalText,
  email: z.string().trim().email().max(320).optional(),
  phone: z.string().trim().min(1).max(32).optional(),
  destination: optionalText,
  travel_dates: optionalText,
  travelers: optionalText,
  interests: optionalText,
  budget: optionalText,
  travel_style: optionalText,
  notes: optionalText,
});

export const createLeadArgsSchema = leadFieldsSchema;

export const updateLeadArgsSchema = leadFieldsSchema.extend({
  /** Optional: the bound call's lead is used when omitted. */
  lead_id: z.string().trim().min(1).max(128).optional(),
});

export const addCallNoteArgsSchema = z.object({
  note: z.string().trim().min(1).max(5000),
  lead_id: z.string().trim().min(1).max(128).optional(),
});

export const updateCallOutcomeArgsSchema = z.object({
  outcome: z.string().trim().min(1).max(64),
  summary: optionalText,
  lead_id: z.string().trim().min(1).max(128).optional(),
});

export const submitInquiryArgsSchema = leadFieldsSchema.extend({
  /** The caller's actual request/inquiry in their own words. */
  inquiry: optionalText,
  /** True when the caller asked to speak with a human consultant. */
  consultation_requested: z.boolean().optional(),
  /** True when this inquiry is being captured because a booking could not complete. */
  booking_failed: z.boolean().optional(),
});

export const logIssueArgsSchema = z.object({
  issue: z.string().trim().min(1).max(5000),
  urgency: z.enum(['normal', 'urgent']).optional(),
  /** Classification of the issue; defaults to `question` (or `wants_consultant`). */
  kind: z
    .enum(['question', 'existing_booking', 'wants_consultant', 'complaint', 'other'])
    .optional(),
  /** The caller specifically asked for their existing consultant/owner. */
  request_existing_consultant: z.boolean().optional(),
});

export const getAvailableSlotsArgsSchema = z.object({
  timezone: z.string().trim().min(1).max(64),
  /** A single local day (`YYYY-MM-DD`). */
  date: z.string().trim().min(1).max(32).optional(),
  /** Or an explicit UTC range. */
  from: z.string().trim().min(1).max(40).optional(),
  to: z.string().trim().min(1).max(40).optional(),
});

export const bookConsultationArgsSchema = z.object({
  /** The agent must assert the customer confirmed the time + channel. */
  confirmed: z.boolean(),
  /** The exact UTC instant returned by get_available_slots. */
  starts_at: z.string().trim().min(1).max(40),
  meeting_type: z.enum(MEETING_TYPES),
  timezone: z.string().trim().min(1).max(64).optional(),
  confirmed_destination: optionalText,
  notes: optionalText,
});
