/**
 * Core domain types for an inbound call.
 *
 * This service owns the TELEPHONY / call side only. Guided Boost remains the
 * system of record for leads, people, bookings and ownership; the fields below
 * hold just enough to run and later debug a single inbound call.
 */

/**
 * The lifecycle timeline recorded for every inbound call. These are REAL system
 * events — each one is appended only when it actually happens, so the timeline is
 * an honest audit trail, never a fabricated sequence.
 */
export const LifecycleEvent = {
  INBOUND_RECEIVED: 'INBOUND_RECEIVED',
  CALL_STARTED: 'CALL_STARTED',
  CALLER_IDENTIFIED: 'CALLER_IDENTIFIED',
  NEW_CALLER: 'NEW_CALLER',
  EXISTING_CALLER: 'EXISTING_CALLER',
  LEAD_RESOLVED: 'LEAD_RESOLVED',
  LEAD_RESOLUTION_FAILED: 'LEAD_RESOLUTION_FAILED',
  LEAD_CREATED: 'LEAD_CREATED',
  LEAD_CAPTURED: 'LEAD_CAPTURED',
  CONVERSATION_ACTIVE: 'CONVERSATION_ACTIVE',
  TOOL_CALLED: 'TOOL_CALLED',
  CONSULTATION_REQUESTED: 'CONSULTATION_REQUESTED',
  BOOKING_ATTEMPTED: 'BOOKING_ATTEMPTED',
  BOOKING_CONFIRMED: 'BOOKING_CONFIRMED',
  BOOKING_FAILED: 'BOOKING_FAILED',
  CONSULTATION_BOOKED: 'CONSULTATION_BOOKED',
  CONSULTATION_NOT_BOOKED: 'CONSULTATION_NOT_BOOKED',
  EXISTING_LEAD_ISSUE: 'EXISTING_LEAD_ISSUE',
  URGENT_ESCALATION: 'URGENT_ESCALATION',
  CALL_ENDED: 'CALL_ENDED',
  CALL_ANALYZED: 'CALL_ANALYZED',
  CRM_UPDATED: 'CRM_UPDATED',
  CRM_UPDATE_FAILED: 'CRM_UPDATE_FAILED',
  CALL_COMPLETED: 'CALL_COMPLETED',
  ERROR: 'ERROR',
} as const;

export type LifecycleEventName = (typeof LifecycleEvent)[keyof typeof LifecycleEvent];

/** Internal status of the inbound call as a whole. */
export const CallStatus = {
  RECEIVED: 'RECEIVED',
  IN_PROGRESS: 'IN_PROGRESS',
  ENDED: 'ENDED',
  ANALYZED: 'ANALYZED',
  FAILED: 'FAILED',
} as const;

export type CallStatusName = (typeof CallStatus)[keyof typeof CallStatus];

/** Order used to prevent a late/duplicate webhook from downgrading status. */
export const CALL_STATUS_RANK: Record<CallStatusName, number> = {
  RECEIVED: 0,
  IN_PROGRESS: 1,
  ENDED: 2,
  ANALYZED: 3,
  // FAILED is terminal but orthogonal; treated as high so it is not downgraded.
  FAILED: 3,
};

/** Who the caller turned out to be after Guided Boost lookup. */
export const CallerType = {
  EXISTING_LEAD: 'EXISTING_LEAD',
  EXISTING_CUSTOMER: 'EXISTING_CUSTOMER',
  UNKNOWN: 'UNKNOWN',
} as const;

export type CallerTypeName = (typeof CallerType)[keyof typeof CallerType];

/** Business outcome of the inbound call. Defaults to UNKNOWN — never guessed. */
export const CallOutcome = {
  BOOKED: 'BOOKED',
  INFORMATION_PROVIDED: 'INFORMATION_PROVIDED',
  CALLBACK_REQUESTED: 'CALLBACK_REQUESTED',
  NOT_INTERESTED: 'NOT_INTERESTED',
  NO_BOOKING: 'NO_BOOKING',
  VOICEMAIL: 'VOICEMAIL',
  FAILED: 'FAILED',
  UNKNOWN: 'UNKNOWN',
} as const;

export type CallOutcomeName = (typeof CallOutcome)[keyof typeof CallOutcome];

/** Booking delivery state for the call. */
export const BookingStatus = {
  NONE: 'NONE',
  ATTEMPTED: 'ATTEMPTED',
  CONFIRMED: 'CONFIRMED',
  FAILED: 'FAILED',
} as const;

export type BookingStatusName = (typeof BookingStatus)[keyof typeof BookingStatus];

/** Delivery state of the captured inquiry to the new-lead API. */
export const InquiryStatus = {
  NONE: 'NONE',
  /** Captured on the call record but not sent (API disabled/unconfigured). */
  CAPTURED: 'CAPTURED',
  /** Sent to the new-lead API and accepted. */
  SENT: 'SENT',
  /** Send attempted and failed; retained locally for follow-up. */
  FAILED: 'FAILED',
} as const;

export type InquiryStatusName = (typeof InquiryStatus)[keyof typeof InquiryStatus];

/** How urgent the caller's issue is (existing-caller flow). */
export const Urgency = {
  NORMAL: 'NORMAL',
  URGENT: 'URGENT',
} as const;

export type UrgencyName = (typeof Urgency)[keyof typeof Urgency];

/** The ONLY supported consultation channels. Arbitrary values are rejected. */
export const MEETING_TYPES = ['phone', 'whatsapp', 'video'] as const;
export type MeetingType = (typeof MEETING_TYPES)[number];

export function isMeetingType(value: unknown): value is MeetingType {
  return typeof value === 'string' && (MEETING_TYPES as readonly string[]).includes(value);
}

/** One entry on a call's lifecycle timeline. */
export interface LifecycleEntry {
  event: LifecycleEventName;
  at: string;
  /** Non-PII structured context: ids, flags, statuses. Never phone/email/transcript. */
  detail?: Record<string, unknown>;
}

/**
 * Information collected from the caller during the conversation. Every field is
 * optional — the caller is never forced through a questionnaire.
 */
export interface CollectedInfo {
  name?: string;
  email?: string;
  destination?: string;
  travelDates?: string;
  travelers?: string;
  interests?: string;
  budget?: string;
  travelStyle?: string;
  /** The caller's actual inquiry / request in their own words. */
  inquiry?: string;
  consultationPreference?: MeetingType;
  notes?: string;
  timezone?: string;
}

/** The full in-service record of one inbound call. */
export interface CallRecord {
  /** Internal id, generated when the inbound call is first seen. */
  id: string;
  /** Retell's call id. Unique; the idempotency key for webhooks and tools. */
  retellCallId: string;
  agentId?: string;
  direction: string;
  /** The service's own inbound number that was dialled (Retell `to_number`). */
  inboundNumber?: string;
  /** The caller's number (Retell `from_number`), E.164 when valid. Sensitive. */
  callerNumber?: string;

  status: CallStatusName;
  outcome: CallOutcomeName;

  callerType: CallerTypeName;
  leadId?: string;
  personKey?: string;
  /** True when THIS call created the lead in Guided Boost. */
  leadCreated: boolean;

  startedAt?: string;
  endedAt?: string;
  durationMs?: number;

  transcript?: string;
  summary?: string;
  sentiment?: string;
  disconnectionReason?: string;
  recordingUrl?: string;

  bookingStatus: BookingStatusName;
  appointmentId?: string;
  /** Short, non-PII reason a booking could not be completed. */
  bookingFailureReason?: string;

  // --- Business-flow state ---------------------------------------------------
  /** The caller asked to speak with a human consultant. */
  consultationRequested: boolean;
  /** The caller asked specifically for their existing consultant/owner. */
  requestedExistingConsultant: boolean;
  /** Delivery state of the captured inquiry to the new-lead API. */
  inquiryStatus: InquiryStatusName;
  /** Urgency of an existing caller's issue. */
  urgency: UrgencyName;
  /** True once the existing caller's personKey was resolved to a lead id. */
  leadResolved: boolean;
  /** True when the identified caller already has an active appointment. */
  hasExistingConsultation: boolean;
  /** The caller's current owner/salesperson, when known. Preserved across the flow. */
  ownerEmail?: string;
  ownerName?: string;

  collectedInfo: CollectedInfo;

  lifecycle: LifecycleEntry[];
  /** Webhook/event identities already applied, for idempotent delivery. */
  processedEventKeys: string[];
  /** Whether the terminal CRM update has been delivered (once). */
  crmUpdatedAt?: string;

  /** Sanitized, non-PII error notes for debugging. */
  errors: string[];

  createdAt: string;
  updatedAt: string;
}
