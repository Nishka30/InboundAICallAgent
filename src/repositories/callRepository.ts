import { randomUUID } from 'node:crypto';
import {
  BookingStatus,
  CALL_STATUS_RANK,
  CallOutcome,
  CallStatus,
  CallerType,
  InquiryStatus,
  Urgency,
  type CallRecord,
  type CallStatusName,
  type CollectedInfo,
  type LifecycleEntry,
  type LifecycleEventName,
} from '../domain/call.js';
import { databaseEnabled } from '../config/env.js';
import { PostgresCallRepository } from './postgresCallRepository.js';

/**
 * Inbound call store.
 *
 * The interface is ASYNC so it can be backed by Postgres (the production store)
 * or by the in-memory implementation below (unit tests, and local dev without a
 * DATABASE_URL). All reads and writes return promises; callers await them. The
 * contract is identical across implementations, which is what the test suite
 * verifies.
 *
 * The lead binding is always taken server-side from the Retell `call_id`; a lead
 * id supplied by the model is only ever a hint.
 */
export interface CallRepository {
  createOrGetInbound(input: CreateInboundInput): Promise<CallRecord>;
  getByRetellCallId(retellCallId: string): Promise<CallRecord | undefined>;
  getById(id: string): Promise<CallRecord | undefined>;
  update(retellCallId: string, patch: CallRecordPatch): Promise<CallRecord | undefined>;
  advanceStatus(retellCallId: string, status: CallStatusName): Promise<CallRecord | undefined>;
  recordLifecycle(
    retellCallId: string,
    event: LifecycleEventName,
    detail?: Record<string, unknown>,
  ): Promise<CallRecord | undefined>;
  mergeCollectedInfo(
    retellCallId: string,
    info: Partial<CollectedInfo>,
  ): Promise<CallRecord | undefined>;
  /** Returns true the FIRST time an event key is seen; false on every repeat. */
  markEventProcessed(retellCallId: string, eventKey: string): Promise<boolean>;
  recordError(retellCallId: string, note: string): Promise<void>;
  count(): Promise<number>;
}

export interface CreateInboundInput {
  retellCallId: string;
  agentId?: string | undefined;
  direction?: string | undefined;
  inboundNumber?: string | undefined;
  callerNumber?: string | undefined;
}

/** A shallow patch of a subset of mutable call fields. */
export type CallRecordPatch = Partial<
  Pick<
    CallRecord,
    | 'agentId'
    | 'inboundNumber'
    | 'callerNumber'
    | 'outcome'
    | 'callerType'
    | 'leadId'
    | 'personKey'
    | 'leadCreated'
    | 'startedAt'
    | 'endedAt'
    | 'durationMs'
    | 'transcript'
    | 'summary'
    | 'sentiment'
    | 'disconnectionReason'
    | 'recordingUrl'
    | 'bookingStatus'
    | 'appointmentId'
    | 'bookingFailureReason'
    | 'consultationRequested'
    | 'requestedExistingConsultant'
    | 'inquiryStatus'
    | 'urgency'
    | 'leadResolved'
    | 'hasExistingConsultation'
    | 'ownerEmail'
    | 'ownerName'
    | 'crmUpdatedAt'
  >
>;

/**
 * In-memory inbound call store. Authoritative for unit tests and used as the
 * local-dev fallback when no DATABASE_URL is set. State lives in process memory
 * (does not survive a restart, not shared across instances) — which is exactly
 * why production uses the Postgres implementation instead.
 */
/* eslint-disable @typescript-eslint/require-await --
   These methods are intentionally async to implement the async CallRepository
   interface; the in-memory store simply has no awaitable work to do. */
class InMemoryCallRepository implements CallRepository {
  private readonly byRetellId = new Map<string, CallRecord>();
  private readonly byId = new Map<string, CallRecord>();

  async createOrGetInbound(input: CreateInboundInput): Promise<CallRecord> {
    const existing = this.byRetellId.get(input.retellCallId);
    if (existing) {
      // Fill in fields that may only now be known, without overwriting good data.
      if (input.agentId && !existing.agentId) existing.agentId = input.agentId;
      if (input.inboundNumber && !existing.inboundNumber)
        existing.inboundNumber = input.inboundNumber;
      if (input.callerNumber && !existing.callerNumber) existing.callerNumber = input.callerNumber;
      if (input.direction) existing.direction = input.direction;
      this.touch(existing);
      return existing;
    }

    const now = new Date().toISOString();
    const record: CallRecord = {
      id: randomUUID(),
      retellCallId: input.retellCallId,
      ...(input.agentId === undefined ? {} : { agentId: input.agentId }),
      direction: input.direction ?? 'inbound',
      ...(input.inboundNumber === undefined ? {} : { inboundNumber: input.inboundNumber }),
      ...(input.callerNumber === undefined ? {} : { callerNumber: input.callerNumber }),
      status: CallStatus.RECEIVED,
      outcome: CallOutcome.UNKNOWN,
      callerType: CallerType.UNKNOWN,
      leadCreated: false,
      bookingStatus: BookingStatus.NONE,
      consultationRequested: false,
      requestedExistingConsultant: false,
      inquiryStatus: InquiryStatus.NONE,
      urgency: Urgency.NORMAL,
      leadResolved: false,
      hasExistingConsultation: false,
      collectedInfo: {},
      lifecycle: [],
      processedEventKeys: [],
      errors: [],
      createdAt: now,
      updatedAt: now,
    };
    this.byRetellId.set(record.retellCallId, record);
    this.byId.set(record.id, record);
    return record;
  }

  async getByRetellCallId(retellCallId: string): Promise<CallRecord | undefined> {
    return this.byRetellId.get(retellCallId);
  }

  async getById(id: string): Promise<CallRecord | undefined> {
    return this.byId.get(id);
  }

  async update(retellCallId: string, patch: CallRecordPatch): Promise<CallRecord | undefined> {
    const record = this.byRetellId.get(retellCallId);
    if (!record) return undefined;
    Object.assign(record, patch);
    this.touch(record);
    return record;
  }

  /** Moves status forward only; never downgrades on a late/duplicate webhook. */
  async advanceStatus(
    retellCallId: string,
    status: CallStatusName,
  ): Promise<CallRecord | undefined> {
    const record = this.byRetellId.get(retellCallId);
    if (!record) return undefined;
    if (CALL_STATUS_RANK[status] >= CALL_STATUS_RANK[record.status]) {
      record.status = status;
      this.touch(record);
    }
    return record;
  }

  async recordLifecycle(
    retellCallId: string,
    event: LifecycleEventName,
    detail?: Record<string, unknown>,
  ): Promise<CallRecord | undefined> {
    const record = this.byRetellId.get(retellCallId);
    if (!record) return undefined;
    const entry: LifecycleEntry = {
      event,
      at: new Date().toISOString(),
      ...(detail === undefined ? {} : { detail }),
    };
    record.lifecycle.push(entry);
    this.touch(record);
    return record;
  }

  async mergeCollectedInfo(
    retellCallId: string,
    info: Partial<CollectedInfo>,
  ): Promise<CallRecord | undefined> {
    const record = this.byRetellId.get(retellCallId);
    if (!record) return undefined;
    for (const [key, value] of Object.entries(info)) {
      // Do not overwrite an existing value with an empty one.
      if (value === undefined || value === null || value === '') continue;
      (record.collectedInfo as Record<string, unknown>)[key] = value;
    }
    this.touch(record);
    return record;
  }

  async markEventProcessed(retellCallId: string, eventKey: string): Promise<boolean> {
    const record = this.byRetellId.get(retellCallId);
    if (!record) return false;
    if (record.processedEventKeys.includes(eventKey)) return false;
    record.processedEventKeys.push(eventKey);
    this.touch(record);
    return true;
  }

  async recordError(retellCallId: string, note: string): Promise<void> {
    const record = this.byRetellId.get(retellCallId);
    if (!record) return;
    record.errors.push(`${new Date().toISOString()} ${note}`);
    this.touch(record);
  }

  async count(): Promise<number> {
    return this.byRetellId.size;
  }

  private touch(record: CallRecord): void {
    record.updatedAt = new Date().toISOString();
  }
}
/* eslint-enable @typescript-eslint/require-await */

/**
 * Process-wide singleton. Postgres in the real application (when DATABASE_URL is
 * configured), in-memory for tests and local dev. Services may still be handed an
 * explicit repository (dependency injection) — this is only the default.
 */
export const callRepository: CallRepository = databaseEnabled
  ? new PostgresCallRepository()
  : new InMemoryCallRepository();

/** Exposed for tests that need a fresh, isolated in-memory store. */
export function createInMemoryCallRepository(): CallRepository {
  return new InMemoryCallRepository();
}
