import { env, type Env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { normalizeTimezone } from '../lib/timezone.js';
import { verifyRetellSignature } from '../integrations/retell/webhookVerify.js';
import {
  addCallNoteArgsSchema,
  bookConsultationArgsSchema,
  createLeadArgsSchema,
  functionRequestSchema,
  getAvailableSlotsArgsSchema,
  getLeadArgsSchema,
  identifyCallerArgsSchema,
  logIssueArgsSchema,
  readFunctionArgs,
  submitInquiryArgsSchema,
  TOOL,
  updateCallOutcomeArgsSchema,
  updateLeadArgsSchema,
  type FunctionRequest,
} from '../integrations/retell/functionSchemas.js';
import {
  BookingStatus,
  CallOutcome,
  LifecycleEvent,
  Urgency,
  type CallRecord,
  type CallOutcomeName,
} from '../domain/call.js';
import { callRepository, type CallRepository } from '../repositories/callRepository.js';
import { GuidedBoostClient } from '../integrations/guidedBoost/client.js';
import { GuidedBoostError } from '../integrations/guidedBoost/errors.js';
import {
  identifyCaller,
  type CallerPayment,
  type CallerTrip,
} from './callerIdentification.service.js';
import { bookConsultation, getAvailableSlots } from './booking.service.js';
import { submitInquiry } from './inquiry.service.js';
import { submitIssue } from './issue.service.js';

/**
 * Backend functions ("tools") the inbound Retell agent calls during a conversation.
 *
 * Security model, mirroring CallScheduler's booking tool:
 *   1. The request is authenticated with the SAME `x-retell-signature` scheme as
 *      the webhook, fail closed.
 *   2. The call is bound SERVER-SIDE from `call.call_id`; a lead id in the model's
 *      `args` is accepted only as a hint and never lets the agent act on an
 *      unrelated lead's data in a way we did not ourselves establish.
 *   3. A logical failure (missing info, no availability, booking rejected) is
 *      returned to the agent as a normal result payload so it can respond
 *      gracefully — not as an HTTP error.
 *
 * A booking is reported to the caller as successful ONLY when the backend returns
 * `booked === true`.
 */

export interface ToolRequestInput {
  rawBody: string;
  signature: string | undefined;
  apiKey?: string | undefined;
  now?: number;
  repo?: CallRepository;
  client?: GuidedBoostClient;
  config?: Env;
}

export type ToolResult =
  | { status: 'misconfigured' }
  | { status: 'unauthorized' }
  | { status: 'bad_request'; reason: string }
  | { status: 'ok'; name: string; payload: Record<string, unknown> };

export async function processToolRequest(input: ToolRequestInput): Promise<ToolResult> {
  const apiKey = input.apiKey ?? env.RETELL_API_KEY;
  const repo = input.repo ?? callRepository;
  const config = input.config ?? env;

  if (!apiKey) return { status: 'misconfigured' };
  if (!input.signature) return { status: 'unauthorized' };

  const verified = verifyRetellSignature(input.rawBody, apiKey, input.signature, {
    timeoutMs: config.RETELL_WEBHOOK_REPLAY_WINDOW_MS,
    ...(input.now === undefined ? {} : { now: input.now }),
  });
  if (!verified) return { status: 'unauthorized' };

  let json: unknown;
  try {
    json = JSON.parse(input.rawBody);
  } catch {
    return { status: 'bad_request', reason: 'body is not valid JSON' };
  }

  const parsed = functionRequestSchema.safeParse(json);
  if (!parsed.success) {
    return { status: 'bad_request', reason: 'payload did not match the expected shape' };
  }
  const request = parsed.data;
  const name = request.name ?? '';

  // Bind the call SERVER-SIDE (create the record if the tool fired before the
  // call_started webhook was processed — ordering is not guaranteed).
  const record = await repo.createOrGetInbound({
    retellCallId: request.call.call_id,
    agentId: request.call.agent_id ?? undefined,
    inboundNumber: request.call.to_number ?? undefined,
    callerNumber: request.call.from_number ?? undefined,
  });

  await repo.recordLifecycle(record.retellCallId, LifecycleEvent.TOOL_CALLED, { tool: name });
  logger.info({ retellCallId: record.retellCallId, tool: name }, 'inbound tool called');

  const client = input.client;
  const payload = await dispatch(name, request, record, repo, client);
  return { status: 'ok', name, payload };
}

async function dispatch(
  name: string,
  request: FunctionRequest,
  record: CallRecord,
  repo: CallRepository,
  client: GuidedBoostClient | undefined,
): Promise<Record<string, unknown>> {
  const rawArgs = readFunctionArgs(request);

  switch (name) {
    case TOOL.IDENTIFY_CALLER:
      return identifyCallerTool(rawArgs, record, repo, client);
    case TOOL.GET_LEAD:
      return getLeadTool(rawArgs, record, client);
    case TOOL.CREATE_LEAD:
      return createLeadTool(rawArgs, record, repo, client);
    case TOOL.UPDATE_LEAD:
      return updateLeadTool(rawArgs, record, repo, client);
    case TOOL.SUBMIT_INQUIRY:
      return submitInquiryTool(rawArgs, record, repo, client);
    case TOOL.LOG_ISSUE:
      return logIssueTool(rawArgs, record, repo, client);
    case TOOL.ADD_CALL_NOTE:
      return addCallNoteTool(rawArgs, record, client);
    case TOOL.UPDATE_CALL_OUTCOME:
      return updateCallOutcomeTool(rawArgs, record, repo);
    case TOOL.GET_AVAILABLE_SLOTS:
      return getSlotsTool(rawArgs, record, repo, client);
    case TOOL.BOOK_CONSULTATION:
      return bookTool(rawArgs, record, repo, client);
    default:
      return { error: `unsupported tool "${name || '(none)'}"` };
  }
}

function gbClient(injected: GuidedBoostClient | undefined): GuidedBoostClient | null {
  if (injected) return injected;
  try {
    return new GuidedBoostClient();
  } catch {
    return null;
  }
}

// --- tools -------------------------------------------------------------------

async function identifyCallerTool(
  rawArgs: Record<string, unknown>,
  record: CallRecord,
  repo: CallRepository,
  client: GuidedBoostClient | undefined,
): Promise<Record<string, unknown>> {
  const args = identifyCallerArgsSchema.safeParse(rawArgs);
  const phone =
    args.success && args.data.phone_number ? args.data.phone_number : record.callerNumber;

  // ONE authoritative Guided Boost call resolves identity, owner, newest lead,
  // booking/consultation state and phone-verification together.
  const identity = await identifyCaller(phone, client ? { client } : {});
  const known = identity.known;

  const patch: Parameters<CallRepository['update']>[1] = { callerType: identity.callerType };
  if (identity.personKey) patch.personKey = identity.personKey;
  if (identity.leadId) {
    patch.leadId = identity.leadId;
    patch.leadResolved = true;
  }
  if (identity.salesAgentName) patch.ownerName = identity.salesAgentName;
  if (identity.salesAgentEmail) patch.ownerEmail = identity.salesAgentEmail;
  // Persist the consultation guard so book_consultation refuses a duplicate even
  // for an unverified caller (server-side enforcement, regardless of what the agent
  // is told).
  if (identity.hasExistingConsultation) patch.hasExistingConsultation = true;
  await repo.update(record.retellCallId, patch);
  if (identity.name) await repo.mergeCollectedInfo(record.retellCallId, { name: identity.name });
  await repo.recordLifecycle(record.retellCallId, LifecycleEvent.CALLER_IDENTIFIED, {
    callerType: identity.callerType,
    matched: known,
    verifiedByPhone: identity.verifiedByPhone,
    hasBooking: identity.hasBooking,
    hasConsultation: identity.hasExistingConsultation,
  });

  if (!known) {
    await repo.recordLifecycle(record.retellCallId, LifecycleEvent.NEW_CALLER, {});
    return {
      known: false,
      caller_type: identity.callerType,
      verified_by_phone: identity.verifiedByPhone,
    };
  }

  await repo.recordLifecycle(record.retellCallId, LifecycleEvent.EXISTING_CALLER, {});
  if (identity.leadId) {
    await repo.recordLifecycle(record.retellCallId, LifecycleEvent.LEAD_RESOLVED, {
      leadId: identity.leadId,
    });
  }

  // Always-safe identity fields (never payment/booking specifics).
  const response: Record<string, unknown> = {
    known: true,
    caller_type: identity.callerType,
    verified_by_phone: identity.verifiedByPhone,
    has_existing_consultation: identity.hasExistingConsultation,
  };
  if (identity.personKey) response['person_key'] = identity.personKey;
  if (identity.personId) response['person_id'] = identity.personId;
  if (identity.leadId) response['lead_id'] = identity.leadId;
  if (identity.name) response['name'] = identity.name;
  if (identity.salesAgentName) response['existing_owner'] = identity.salesAgentName;
  if (identity.leadStatus) response['lead_status'] = identity.leadStatus;

  if (identity.verifiedByPhone) {
    // Verified: the caller phoned from the number on their own record, so
    // booking/payment information may be surfaced (payment carries no amounts).
    response['has_booking'] = identity.hasBooking;
    if (identity.trip) response['trip'] = compactTrip(identity.trip);
    if (identity.existingConsultationSummary) {
      response['existing_consultation'] = identity.existingConsultationSummary;
    }
    if (identity.payment) response['payment'] = compactPayment(identity.payment);
  } else {
    // NOT verified by phone: do NOT expose or confirm any booking/payment/trip
    // details. The agent should verify identity or route to the owner.
    response['details_withheld'] = true;
    response['routing'] = 'route_to_owner_unless_identity_verified';
  }

  return response;
}

async function getLeadTool(
  rawArgs: Record<string, unknown>,
  record: CallRecord,
  client: GuidedBoostClient | undefined,
): Promise<Record<string, unknown>> {
  const args = getLeadArgsSchema.safeParse(rawArgs);
  const leadId = args.success ? args.data.lead_id : record.leadId;
  if (!leadId) return { found: false, error: 'No lead id is available for this call.' };

  const gb = gbClient(client);
  if (!gb) return { found: false, error: 'Lead lookup is unavailable right now.' };

  try {
    const detail = await gb.getLead(leadId);
    const captured: Record<string, unknown> = detail.current ?? detail.captured ?? {};
    return {
      found: true,
      lead_id: leadId,
      ...pickString(captured, 'name'),
      ...pickString(captured, 'destination'),
      ...pickString(captured, 'lead_status'),
      ...pickString(captured, 'sales_agent'),
      ...(detail.personKey ? { person_key: detail.personKey } : {}),
    };
  } catch (error) {
    logger.warn({ err: errName(error) }, 'get_lead tool: lookup failed');
    return { found: false, error: 'I could not retrieve the lead details just now.' };
  }
}

async function createLeadTool(
  rawArgs: Record<string, unknown>,
  record: CallRecord,
  repo: CallRepository,
  client: GuidedBoostClient | undefined,
): Promise<Record<string, unknown>> {
  const args = createLeadArgsSchema.safeParse(rawArgs);
  if (!args.success) return { created: false, error: 'Some provided details were invalid.' };

  const data = args.data;

  // Always retain what the caller told us on the local call record, even if
  // Guided Boost cannot persist it — it still reaches the CRM in the end-of-call note.
  await repo.mergeCollectedInfo(record.retellCallId, collectedFrom(data));

  // Avoid duplicate creation within the same call.
  if (record.leadId) {
    return { created: false, already_exists: true, lead_id: record.leadId };
  }

  const gb = gbClient(client);
  if (!gb) return { created: false, error: 'Lead creation is unavailable right now.' };

  const phone = data.phone ?? record.callerNumber;
  const input = {
    ...(data.name ? { name: data.name } : {}),
    ...(data.email ? { email: data.email } : {}),
    ...(phone ? { phone } : {}),
    ...(data.destination ? { destination: data.destination } : {}),
    ...(data.travel_dates ? { travelDates: data.travel_dates } : {}),
    ...(data.travelers ? { travelers: data.travelers } : {}),
    ...(data.interests ? { interests: data.interests } : {}),
    ...(data.budget ? { budget: data.budget } : {}),
    ...(data.travel_style ? { travelStyle: data.travel_style } : {}),
    ...(data.notes ? { notes: data.notes } : {}),
    source: 'inbound-call',
  };

  try {
    const created = await gb.createLead(input);
    if (!created.leadId) {
      return { created: false, error: 'The lead could not be created just now.' };
    }
    const patch: Parameters<CallRepository['update']>[1] = {
      leadId: created.leadId,
      leadCreated: true,
    };
    if (created.personKey) patch.personKey = created.personKey;
    await repo.update(record.retellCallId, patch);
    await repo.recordLifecycle(record.retellCallId, LifecycleEvent.LEAD_CREATED, {
      leadId: created.leadId,
    });
    return { created: true, lead_id: created.leadId };
  } catch (error) {
    if (error instanceof GuidedBoostError && error.kind === 'unsupported') {
      // No confirmed create endpoint yet: details are kept on the call record and
      // will be written into the end-of-call note once a lead exists / is added.
      return {
        created: false,
        captured: true,
        reason: 'I’ve noted all of that; a consultant will follow up to set everything up.',
      };
    }
    logger.warn({ err: errName(error) }, 'create_lead tool: creation failed');
    return { created: false, error: 'The lead could not be created just now.' };
  }
}

async function updateLeadTool(
  rawArgs: Record<string, unknown>,
  record: CallRecord,
  repo: CallRepository,
  client: GuidedBoostClient | undefined,
): Promise<Record<string, unknown>> {
  const args = updateLeadArgsSchema.safeParse(rawArgs);
  if (!args.success) return { updated: false, error: 'Some provided details were invalid.' };

  const leadId = args.data.lead_id ?? record.leadId;
  if (!leadId) {
    return { updated: false, error: 'No lead to update yet; identify or create the lead first.' };
  }

  // Always keep the locally-collected info, even if Guided Boost is unavailable.
  await repo.mergeCollectedInfo(record.retellCallId, collectedFrom(args.data));

  const gb = gbClient(client);
  if (!gb) return { updated: false, error: 'Lead update is unavailable right now.' };

  const data = args.data;
  try {
    await gb.updateLead(leadId, {
      ...(data.name ? { name: data.name } : {}),
      ...(data.email ? { email: data.email } : {}),
      ...(data.phone ? { phone: data.phone } : {}),
      ...(data.destination ? { destination: data.destination } : {}),
      ...(data.travel_dates ? { travelDates: data.travel_dates } : {}),
      ...(data.travelers ? { travelers: data.travelers } : {}),
      ...(data.interests ? { interests: data.interests } : {}),
      ...(data.budget ? { budget: data.budget } : {}),
      ...(data.travel_style ? { travelStyle: data.travel_style } : {}),
      ...(data.notes ? { notes: data.notes } : {}),
    });
    return { updated: true, lead_id: leadId };
  } catch (error) {
    if (error instanceof GuidedBoostError && error.kind === 'unsupported') {
      return {
        updated: false,
        captured: true,
        reason: 'I’ve noted that; it will be saved with the call summary.',
      };
    }
    logger.warn({ err: errName(error) }, 'update_lead tool: update failed');
    // The info is retained locally and will be included in the end-of-call note.
    return { updated: false, error: 'I noted that but could not save it to the CRM just now.' };
  }
}

async function addCallNoteTool(
  rawArgs: Record<string, unknown>,
  record: CallRecord,
  client: GuidedBoostClient | undefined,
): Promise<Record<string, unknown>> {
  const args = addCallNoteArgsSchema.safeParse(rawArgs);
  if (!args.success) return { added: false, error: 'A note is required.' };

  const leadId = args.data.lead_id ?? record.leadId;
  if (!leadId) return { added: false, error: 'No lead to attach the note to yet.' };

  const gb = gbClient(client);
  if (!gb) return { added: false, error: 'Notes are unavailable right now.' };

  try {
    await gb.addCallNote(leadId, args.data.note);
    return { added: true };
  } catch (error) {
    logger.warn({ err: errName(error) }, 'add_call_note tool: failed');
    return { added: false, error: 'I could not save that note just now.' };
  }
}

async function updateCallOutcomeTool(
  rawArgs: Record<string, unknown>,
  record: CallRecord,
  repo: CallRepository,
): Promise<Record<string, unknown>> {
  const args = updateCallOutcomeArgsSchema.safeParse(rawArgs);
  if (!args.success) return { recorded: false, error: 'An outcome is required.' };

  const outcome = normalizeOutcome(args.data.outcome);
  const patch: Parameters<CallRepository['update']>[1] = { outcome };
  if (args.data.summary) patch.summary = args.data.summary;
  await repo.update(record.retellCallId, patch);
  return { recorded: true, outcome };
}

async function getSlotsTool(
  rawArgs: Record<string, unknown>,
  record: CallRecord,
  repo: CallRepository,
  client: GuidedBoostClient | undefined,
): Promise<Record<string, unknown>> {
  const args = getAvailableSlotsArgsSchema.safeParse(rawArgs);
  if (!args.success) {
    return {
      available: false,
      reason: 'I need the customer’s timezone to look up available times.',
    };
  }
  if (!record.leadId) {
    return {
      available: false,
      reason: 'I need to identify or create the lead before I can look up availability.',
    };
  }

  const tz = normalizeTimezone(args.data.timezone);
  if (tz) await repo.mergeCollectedInfo(record.retellCallId, { timezone: tz });

  const result = await getAvailableSlots(
    {
      leadId: record.leadId,
      timezone: args.data.timezone,
      date: args.data.date,
      from: args.data.from,
      to: args.data.to,
    },
    client ? { client } : {},
  );
  return { ...result };
}

async function bookTool(
  rawArgs: Record<string, unknown>,
  record: CallRecord,
  repo: CallRepository,
  client: GuidedBoostClient | undefined,
): Promise<Record<string, unknown>> {
  const args = bookConsultationArgsSchema.safeParse(rawArgs);
  if (!args.success) {
    return {
      booked: false,
      reason: 'I still need the confirmed time, channel (phone/WhatsApp/video) and confirmation.',
    };
  }
  if (!record.leadId) {
    return { booked: false, reason: 'I need to create the lead before I can book a consultation.' };
  }

  // Duplicate-consultation protection: an identified existing caller who already has
  // an active appointment is not re-booked (no duplicate consultation). The agent
  // can capture any changes against the existing booking instead.
  if (record.hasExistingConsultation) {
    return {
      booked: false,
      already_has_consultation: true,
      reason:
        'You already have a consultation scheduled, so I won’t create a duplicate. I can pass along anything you need for it.',
    };
  }

  await repo.update(record.retellCallId, {
    bookingStatus: BookingStatus.ATTEMPTED,
    consultationRequested: true,
  });
  await repo.recordLifecycle(record.retellCallId, LifecycleEvent.CONSULTATION_REQUESTED, {});
  await repo.recordLifecycle(record.retellCallId, LifecycleEvent.BOOKING_ATTEMPTED, {
    meetingType: args.data.meeting_type,
  });

  const note = buildBookingNote(args.data, record);
  const result = await bookConsultation(
    {
      leadId: record.leadId,
      confirmed: args.data.confirmed,
      startsAt: args.data.starts_at,
      meetingType: args.data.meeting_type,
      ...(args.data.timezone ? { timezone: args.data.timezone } : {}),
      ...(record.collectedInfo.timezone ? { fallbackTimezone: record.collectedInfo.timezone } : {}),
      note,
    },
    client ? { client } : {},
  );

  if (result.booked) {
    await repo.update(record.retellCallId, {
      bookingStatus: BookingStatus.CONFIRMED,
      appointmentId: result.appointment_id,
      outcome: CallOutcome.BOOKED,
    });
    await repo.mergeCollectedInfo(record.retellCallId, {
      consultationPreference: args.data.meeting_type,
    });
    await repo.recordLifecycle(record.retellCallId, LifecycleEvent.BOOKING_CONFIRMED, {
      appointmentId: result.appointment_id,
    });
    await repo.recordLifecycle(record.retellCallId, LifecycleEvent.CONSULTATION_BOOKED, {
      appointmentId: result.appointment_id,
    });
    return { ...result };
  }

  // Not booked: record WHY, so the agent can fall back to capturing the inquiry
  // (submit_inquiry) without losing the request. Never reports success.
  await repo.update(record.retellCallId, {
    bookingStatus: BookingStatus.FAILED,
    bookingFailureReason: result.reason.slice(0, 200),
  });
  await repo.recordLifecycle(record.retellCallId, LifecycleEvent.BOOKING_FAILED, {});
  await repo.recordLifecycle(record.retellCallId, LifecycleEvent.CONSULTATION_NOT_BOOKED, {});
  return { ...result };
}

/**
 * Captures a new caller's inquiry and sends it to the new-lead API so the team can
 * follow up. The business path for "does not want a consultant" and "booking could
 * not be completed" — a VALID outcome, not a failure.
 */
async function submitInquiryTool(
  rawArgs: Record<string, unknown>,
  record: CallRecord,
  repo: CallRepository,
  client: GuidedBoostClient | undefined,
): Promise<Record<string, unknown>> {
  const args = submitInquiryArgsSchema.safeParse(rawArgs);
  if (!args.success) {
    return { captured: false, error: 'Some provided details were invalid.' };
  }
  const data = args.data;

  // Always retain everything on the local record first — never lose the inquiry.
  const collected = collectedFrom(data);
  if (data.inquiry) collected['inquiry'] = data.inquiry;
  await repo.mergeCollectedInfo(record.retellCallId, collected);

  const patch: Parameters<CallRepository['update']>[1] = {};
  if (data.consultation_requested === true) patch.consultationRequested = true;
  if (Object.keys(patch).length > 0) await repo.update(record.retellCallId, patch);

  const result = await submitInquiry(record.retellCallId, repo, client ? { client } : {});

  return {
    captured: true,
    outcome: result.outcome,
    ...(result.leadId ? { lead_id: result.leadId } : {}),
    message:
      result.outcome === 'sent'
        ? 'Your inquiry has been sent to our team; a consultant will follow up.'
        : 'I’ve captured your inquiry so our team can follow up with you.',
  };
}

/**
 * Logs an existing caller's issue to Guided Boost via the issue API (API 3), which
 * writes it to the guest's lead, emails their assigned agent (admins too when
 * urgent / when there is no agent), and creates a lead if the caller had none. This
 * is the single issue/escalation path. The caller is never told anything failed: a
 * delivery failure is preserved locally and surfaced only in the internal trace.
 */
async function logIssueTool(
  rawArgs: Record<string, unknown>,
  record: CallRecord,
  repo: CallRepository,
  client: GuidedBoostClient | undefined,
): Promise<Record<string, unknown>> {
  const args = logIssueArgsSchema.safeParse(rawArgs);
  if (!args.success) return { logged: false, error: 'An issue description is required.' };
  const { issue } = args.data;
  const urgent = args.data.urgency === 'urgent';
  // Classify: explicit kind wins; otherwise a request for the existing consultant
  // maps to wants_consultant, and everything else defaults to a question.
  const kind = args.data.kind ?? (args.data.request_existing_consultant ? 'wants_consultant' : 'question');

  await repo.mergeCollectedInfo(record.retellCallId, { inquiry: issue });
  const patch: Parameters<CallRepository['update']>[1] = {
    urgency: urgent ? Urgency.URGENT : Urgency.NORMAL,
  };
  if (args.data.request_existing_consultant === true) patch.requestedExistingConsultant = true;
  await repo.update(record.retellCallId, patch);

  const result = await submitIssue(
    record.retellCallId,
    repo,
    { issue, kind, urgency: urgent ? 'urgent' : 'normal' },
    client ? { client } : {},
  );

  if (result.outcome === 'failed') {
    // Preserved locally for retry; the agent still gives a reassuring response.
    return {
      logged: true,
      persisted: 'local',
      urgent,
      message: urgent
        ? 'I’ve flagged this as urgent for our team to follow up as a priority.'
        : 'I’ve noted your issue for the team to follow up.',
    };
  }

  return {
    logged: true,
    urgent,
    escalated: result.alertSent === true,
    message: urgent
      ? 'I’ve flagged this as urgent for our team to follow up as a priority.'
      : 'I’ve added your issue to your record for follow-up.',
  };
}

// --- helpers -----------------------------------------------------------------

function pickString(source: Record<string, unknown>, key: string): Record<string, string> {
  const value = source[key];
  return typeof value === 'string' && value.length > 0 ? { [key]: value } : {};
}

function collectedFrom(data: {
  name?: string | undefined;
  email?: string | undefined;
  destination?: string | undefined;
  travel_dates?: string | undefined;
  travelers?: string | undefined;
  interests?: string | undefined;
  budget?: string | undefined;
  travel_style?: string | undefined;
  notes?: string | undefined;
}): Record<string, string> {
  const out: Record<string, string> = {};
  if (data.name) out['name'] = data.name;
  if (data.email) out['email'] = data.email;
  if (data.destination) out['destination'] = data.destination;
  if (data.travel_dates) out['travelDates'] = data.travel_dates;
  if (data.travelers) out['travelers'] = data.travelers;
  if (data.interests) out['interests'] = data.interests;
  if (data.budget) out['budget'] = data.budget;
  if (data.travel_style) out['travelStyle'] = data.travel_style;
  if (data.notes) out['notes'] = data.notes;
  return out;
}

const OUTCOME_ALIASES: Record<string, CallOutcomeName> = {
  booked: CallOutcome.BOOKED,
  appointment_booked: CallOutcome.BOOKED,
  information_provided: CallOutcome.INFORMATION_PROVIDED,
  info: CallOutcome.INFORMATION_PROVIDED,
  callback_requested: CallOutcome.CALLBACK_REQUESTED,
  callback: CallOutcome.CALLBACK_REQUESTED,
  not_interested: CallOutcome.NOT_INTERESTED,
  no_booking: CallOutcome.NO_BOOKING,
  voicemail: CallOutcome.VOICEMAIL,
};

function normalizeOutcome(raw: string): CallOutcomeName {
  return OUTCOME_ALIASES[raw.trim().toLowerCase().replace(/\s+/g, '_')] ?? CallOutcome.UNKNOWN;
}

function buildBookingNote(
  data: {
    confirmed_destination?: string | undefined;
    notes?: string | undefined;
    meeting_type: string;
  },
  record: CallRecord,
): string {
  const lines = ['Consultation booked via inbound AI call.'];
  const dest = data.confirmed_destination ?? record.collectedInfo.destination;
  if (dest) lines.push(`Destination: ${dest}`);
  lines.push(`Channel: ${data.meeting_type}`);
  if (record.collectedInfo.travelDates) lines.push(`Dates: ${record.collectedInfo.travelDates}`);
  if (record.collectedInfo.travelers) lines.push(`Travelers: ${record.collectedInfo.travelers}`);
  if (data.notes) lines.push(`Notes: ${data.notes}`);
  return lines.join('\n');
}

function errName(error: unknown): string {
  return error instanceof Error ? error.name : 'unknown';
}

/** Trip summary for the agent (verified callers only). Omits empty fields. */
function compactTrip(trip: CallerTrip): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (trip.name) out['name'] = trip.name;
  if (trip.startsOn) out['starts_on'] = trip.startsOn;
  if (trip.endsOn) out['ends_on'] = trip.endsOn;
  if (trip.state) out['state'] = trip.state;
  return out;
}

/**
 * Payment summary for the agent (verified callers only). Carries NO amounts — the
 * API does not provide them — only status flags/dates. Omits null/empty fields.
 */
function compactPayment(payment: CallerPayment): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (payment.received !== undefined) out['received'] = payment.received;
  if (payment.payments !== undefined) out['payments'] = payment.payments;
  if (payment.lastPaidOn) out['last_paid_on'] = payment.lastPaidOn;
  if (payment.byCard !== undefined) out['by_card'] = payment.byCard;
  if (payment.chargedAs) out['charged_as'] = payment.chargedAs;
  return out;
}
