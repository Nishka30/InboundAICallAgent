import { randomUUID } from 'node:crypto';
import {
  BookingStatus,
  CALL_STATUS_RANK,
  CallOutcome,
  CallStatus,
  CallerType,
  type CallRecord,
  type CallStatusName,
  type CollectedInfo,
  type LifecycleEntry,
  type LifecycleEventName,
} from '../domain/call.js';

/**
 * In-memory inbound call store.
 *
 * This is the MINIMAL persistence the first working version needs: enough to run
 * one call, keep webhooks + tools idempotent, and answer "what happened to this
 * inbound call?" for its lifetime. It is intentionally behind a small interface so
 * it can be swapped for a durable store (Postgres/Prisma, mirroring CallScheduler's
 * `CallRecord`) WITHOUT changing any caller.
 *
 * LIMITATION (documented, not hidden): state lives in process memory, so it does
 * not survive a restart and is not shared across instances. That is acceptable for
 * a single-instance first version and a single live test; durability is a
 * follow-up (see README / PROJECT_CONTEXT.md).
 */
export interface CallRepository {
  createOrGetInbound(input: CreateInboundInput): CallRecord;
  getByRetellCallId(retellCallId: string): CallRecord | undefined;
  getById(id: string): CallRecord | undefined;
  update(retellCallId: string, patch: CallRecordPatch): CallRecord | undefined;
  advanceStatus(retellCallId: string, status: CallStatusName): CallRecord | undefined;
  recordLifecycle(
    retellCallId: string,
    event: LifecycleEventName,
    detail?: Record<string, unknown>,
  ): CallRecord | undefined;
  mergeCollectedInfo(retellCallId: string, info: Partial<CollectedInfo>): CallRecord | undefined;
  /** Returns true the FIRST time an event key is seen; false on every repeat. */
  markEventProcessed(retellCallId: string, eventKey: string): boolean;
  recordError(retellCallId: string, note: string): void;
  count(): number;
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
    | 'crmUpdatedAt'
  >
>;

class InMemoryCallRepository implements CallRepository {
  private readonly byRetellId = new Map<string, CallRecord>();
  private readonly byId = new Map<string, CallRecord>();

  createOrGetInbound(input: CreateInboundInput): CallRecord {
    const existing = this.byRetellId.get(input.retellCallId);
    if (existing) {
      // Fill in fields that may only now be known, without overwriting good data.
      if (input.agentId && !existing.agentId) existing.agentId = input.agentId;
      if (input.inboundNumber && !existing.inboundNumber)
        existing.inboundNumber = input.inboundNumber;
      if (input.callerNumber && !existing.callerNumber)
        existing.callerNumber = input.callerNumber;
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

  getByRetellCallId(retellCallId: string): CallRecord | undefined {
    return this.byRetellId.get(retellCallId);
  }

  getById(id: string): CallRecord | undefined {
    return this.byId.get(id);
  }

  update(retellCallId: string, patch: CallRecordPatch): CallRecord | undefined {
    const record = this.byRetellId.get(retellCallId);
    if (!record) return undefined;
    Object.assign(record, patch);
    this.touch(record);
    return record;
  }

  /** Moves status forward only; never downgrades on a late/duplicate webhook. */
  advanceStatus(retellCallId: string, status: CallStatusName): CallRecord | undefined {
    const record = this.byRetellId.get(retellCallId);
    if (!record) return undefined;
    if (CALL_STATUS_RANK[status] >= CALL_STATUS_RANK[record.status]) {
      record.status = status;
      this.touch(record);
    }
    return record;
  }

  recordLifecycle(
    retellCallId: string,
    event: LifecycleEventName,
    detail?: Record<string, unknown>,
  ): CallRecord | undefined {
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

  mergeCollectedInfo(retellCallId: string, info: Partial<CollectedInfo>): CallRecord | undefined {
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

  markEventProcessed(retellCallId: string, eventKey: string): boolean {
    const record = this.byRetellId.get(retellCallId);
    if (!record) return false;
    if (record.processedEventKeys.includes(eventKey)) return false;
    record.processedEventKeys.push(eventKey);
    this.touch(record);
    return true;
  }

  recordError(retellCallId: string, note: string): void {
    const record = this.byRetellId.get(retellCallId);
    if (!record) return;
    record.errors.push(`${new Date().toISOString()} ${note}`);
    this.touch(record);
  }

  count(): number {
    return this.byRetellId.size;
  }

  private touch(record: CallRecord): void {
    record.updatedAt = new Date().toISOString();
  }
}

/** Process-wide singleton. Swap the implementation here to add durability. */
export const callRepository: CallRepository = new InMemoryCallRepository();

/** Exposed for tests that need a fresh, isolated store. */
export function createInMemoryCallRepository(): CallRepository {
  return new InMemoryCallRepository();
}
