import { randomUUID } from 'node:crypto';
import {
  CALL_STATUS_RANK,
  LifecycleEvent,
  type BookingStatusName,
  type CallOutcomeName,
  type CallRecord,
  type CallStatusName,
  type CallerTypeName,
  type CollectedInfo,
  type InquiryStatusName,
  type LifecycleEntry,
  type LifecycleEventName,
  type UrgencyName,
} from '../domain/call.js';
import { getPool } from '../db/pool.js';
import type { CallRepository, CallRecordPatch, CreateInboundInput } from './callRepository.js';

/**
 * Postgres-backed inbound call store (production).
 *
 * Mirrors InMemoryCallRepository behaviour exactly, so the services and their
 * tests are unchanged apart from awaiting the (now async) interface:
 *   - createOrGetInbound is an idempotent upsert keyed by retell_call_id.
 *   - markEventProcessed is atomic (INSERT ... ON CONFLICT DO NOTHING), so a
 *     duplicate webhook delivery is a safe no-op even under concurrency.
 *   - advanceStatus is monotonic (SELECT ... FOR UPDATE then conditional update).
 *   - a full CallRecord is reconstructed from the call row plus its event timeline
 *     and idempotency keys in a single query.
 *
 * The connection string is owned by the pool and never read or logged here.
 */

/** Patch field -> column. Only these columns are ever written by update(). */
const COLUMN_MAP: Record<string, string> = {
  agentId: 'agent_id',
  inboundNumber: 'inbound_number',
  callerNumber: 'caller_number',
  outcome: 'outcome',
  callerType: 'caller_type',
  leadId: 'lead_id',
  personKey: 'person_key',
  leadCreated: 'lead_created',
  startedAt: 'started_at',
  endedAt: 'ended_at',
  durationMs: 'duration_ms',
  transcript: 'transcript',
  summary: 'summary',
  sentiment: 'sentiment',
  disconnectionReason: 'disconnection_reason',
  recordingUrl: 'recording_url',
  bookingStatus: 'booking_status',
  appointmentId: 'appointment_id',
  bookingFailureReason: 'booking_failure_reason',
  consultationRequested: 'consultation_requested',
  requestedExistingConsultant: 'requested_existing_consultant',
  inquiryStatus: 'inquiry_status',
  urgency: 'urgency',
  leadResolved: 'lead_resolved',
  hasExistingConsultation: 'has_existing_consultation',
  ownerEmail: 'owner_email',
  ownerName: 'owner_name',
  crmUpdatedAt: 'crm_updated_at',
};

const ERROR_EVENTS = new Set<LifecycleEventName>([
  LifecycleEvent.ERROR,
  LifecycleEvent.CRM_UPDATE_FAILED,
  LifecycleEvent.BOOKING_FAILED,
  LifecycleEvent.LEAD_RESOLUTION_FAILED,
]);

type Row = Record<string, unknown>;

const LOAD_SQL = (column: 'retell_call_id' | 'id'): string => `
  SELECT c.*,
    COALESCE(
      (SELECT jsonb_agg(
         jsonb_build_object('event', e.event_type, 'at', e.at, 'detail', e.detail)
         ORDER BY e.id)
       FROM call_events e WHERE e.call_id = c.id),
      '[]'::jsonb
    ) AS lifecycle_json,
    COALESCE(
      (SELECT jsonb_agg(p.event_key ORDER BY p.processed_at, p.event_key)
       FROM processed_events p WHERE p.retell_call_id = c.retell_call_id),
      '[]'::jsonb
    ) AS processed_keys_json
  FROM inbound_calls c
  WHERE c.${column} = $1
`;

export class PostgresCallRepository implements CallRepository {
  async createOrGetInbound(input: CreateInboundInput): Promise<CallRecord> {
    const pool = getPool();
    const id = randomUUID();

    await pool.query(
      `INSERT INTO inbound_calls (id, retell_call_id, agent_id, direction, inbound_number, caller_number)
       VALUES ($1, $2, $3, COALESCE($4, 'inbound'), $5, $6)
       ON CONFLICT (retell_call_id) DO NOTHING`,
      [
        id,
        input.retellCallId,
        input.agentId ?? null,
        input.direction ?? null,
        input.inboundNumber ?? null,
        input.callerNumber ?? null,
      ],
    );

    // Backfill fields that may only now be known, without overwriting good data.
    await pool.query(
      `UPDATE inbound_calls SET
         agent_id       = COALESCE(agent_id, $2),
         inbound_number = COALESCE(inbound_number, $3),
         caller_number  = COALESCE(caller_number, $4),
         direction      = COALESCE($5, direction),
         updated_at     = now()
       WHERE retell_call_id = $1`,
      [
        input.retellCallId,
        input.agentId ?? null,
        input.inboundNumber ?? null,
        input.callerNumber ?? null,
        input.direction ?? null,
      ],
    );

    const record = await this.getByRetellCallId(input.retellCallId);
    if (!record) throw new Error('createOrGetInbound: row missing after upsert');
    return record;
  }

  async getByRetellCallId(retellCallId: string): Promise<CallRecord | undefined> {
    const { rows } = await getPool().query<Row>(LOAD_SQL('retell_call_id'), [retellCallId]);
    const row = rows[0];
    return row ? rowToRecord(row) : undefined;
  }

  async getById(id: string): Promise<CallRecord | undefined> {
    const { rows } = await getPool().query<Row>(LOAD_SQL('id'), [id]);
    const row = rows[0];
    return row ? rowToRecord(row) : undefined;
  }

  async update(retellCallId: string, patch: CallRecordPatch): Promise<CallRecord | undefined> {
    const assignments: string[] = [];
    const values: unknown[] = [retellCallId];

    for (const [key, value] of Object.entries(patch)) {
      const column = COLUMN_MAP[key];
      if (!column || value === undefined) continue;
      values.push(value);
      assignments.push(`${column} = $${values.length}`);
    }

    const setClause =
      assignments.length > 0 ? `${assignments.join(', ')}, updated_at = now()` : 'updated_at = now()';

    await getPool().query(
      `UPDATE inbound_calls SET ${setClause} WHERE retell_call_id = $1`,
      values,
    );
    return this.getByRetellCallId(retellCallId);
  }

  async advanceStatus(
    retellCallId: string,
    status: CallStatusName,
  ): Promise<CallRecord | undefined> {
    const pool = getPool();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const current = await client.query<{ status: string }>(
        'SELECT status FROM inbound_calls WHERE retell_call_id = $1 FOR UPDATE',
        [retellCallId],
      );
      if (current.rows.length === 0) {
        await client.query('ROLLBACK');
        return undefined;
      }
      const currentRank = CALL_STATUS_RANK[current.rows[0]!.status as CallStatusName] ?? -1;
      if (CALL_STATUS_RANK[status] >= currentRank) {
        await client.query(
          'UPDATE inbound_calls SET status = $2, updated_at = now() WHERE retell_call_id = $1',
          [retellCallId, status],
        );
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    return this.getByRetellCallId(retellCallId);
  }

  async recordLifecycle(
    retellCallId: string,
    event: LifecycleEventName,
    detail?: Record<string, unknown>,
  ): Promise<CallRecord | undefined> {
    const pool = getPool();
    await pool.query(
      `INSERT INTO call_events (call_id, retell_call_id, event_type, detail, is_error)
       SELECT c.id, c.retell_call_id, $2, $3::jsonb, $4
       FROM inbound_calls c WHERE c.retell_call_id = $1`,
      [retellCallId, event, detail === undefined ? null : JSON.stringify(detail), ERROR_EVENTS.has(event)],
    );
    await pool.query('UPDATE inbound_calls SET updated_at = now() WHERE retell_call_id = $1', [
      retellCallId,
    ]);
    return this.getByRetellCallId(retellCallId);
  }

  async mergeCollectedInfo(
    retellCallId: string,
    info: Partial<CollectedInfo>,
  ): Promise<CallRecord | undefined> {
    const filtered: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(info)) {
      // Do not overwrite an existing value with an empty one.
      if (value === undefined || value === null || value === '') continue;
      filtered[key] = value;
    }

    if (Object.keys(filtered).length > 0) {
      await getPool().query(
        `UPDATE inbound_calls
         SET collected_info = collected_info || $2::jsonb, updated_at = now()
         WHERE retell_call_id = $1`,
        [retellCallId, JSON.stringify(filtered)],
      );
    }
    return this.getByRetellCallId(retellCallId);
  }

  async markEventProcessed(retellCallId: string, eventKey: string): Promise<boolean> {
    const result = await getPool().query(
      `INSERT INTO processed_events (retell_call_id, event_key)
       VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [retellCallId, eventKey],
    );
    return (result.rowCount ?? 0) === 1;
  }

  async recordError(retellCallId: string, note: string): Promise<void> {
    await getPool().query(
      `UPDATE inbound_calls
       SET errors = errors || to_jsonb($2::text), updated_at = now()
       WHERE retell_call_id = $1`,
      [retellCallId, `${new Date().toISOString()} ${note}`],
    );
  }

  async count(): Promise<number> {
    const { rows } = await getPool().query<{ count: number }>(
      'SELECT count(*)::int AS count FROM inbound_calls',
    );
    return Number(rows[0]?.count ?? 0);
  }
}

// --- row mapping -------------------------------------------------------------

function toIso(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string' || typeof value === 'number') {
    return new Date(value).toISOString();
  }
  return undefined;
}

function text(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}

function mapLifecycle(value: unknown): LifecycleEntry[] {
  if (!Array.isArray(value)) return [];
  return value.map((raw) => {
    const item = raw as { event: LifecycleEventName; at: string; detail?: unknown };
    const entry: LifecycleEntry = { event: item.event, at: String(item.at) };
    if (item.detail !== null && item.detail !== undefined) {
      entry.detail = item.detail as Record<string, unknown>;
    }
    return entry;
  });
}

function rowToRecord(row: Row): CallRecord {
  const record: CallRecord = {
    id: String(row.id),
    retellCallId: String(row.retell_call_id),
    direction: String(row.direction),
    status: row.status as CallStatusName,
    outcome: row.outcome as CallOutcomeName,
    callerType: row.caller_type as CallerTypeName,
    leadCreated: Boolean(row.lead_created),
    bookingStatus: row.booking_status as BookingStatusName,
    consultationRequested: Boolean(row.consultation_requested),
    requestedExistingConsultant: Boolean(row.requested_existing_consultant),
    inquiryStatus: row.inquiry_status as InquiryStatusName,
    urgency: row.urgency as UrgencyName,
    leadResolved: Boolean(row.lead_resolved),
    hasExistingConsultation: Boolean(row.has_existing_consultation),
    collectedInfo: (row.collected_info as CollectedInfo | null) ?? {},
    lifecycle: mapLifecycle(row.lifecycle_json),
    processedEventKeys: Array.isArray(row.processed_keys_json)
      ? row.processed_keys_json.map(String)
      : [],
    errors: Array.isArray(row.errors) ? row.errors.map(String) : [],
    createdAt: toIso(row.created_at) ?? new Date(0).toISOString(),
    updatedAt: toIso(row.updated_at) ?? new Date(0).toISOString(),
  };

  // Optional fields: only present when non-null (exactOptionalPropertyTypes).
  const agentId = text(row.agent_id);
  if (agentId !== undefined) record.agentId = agentId;
  const inboundNumber = text(row.inbound_number);
  if (inboundNumber !== undefined) record.inboundNumber = inboundNumber;
  const callerNumber = text(row.caller_number);
  if (callerNumber !== undefined) record.callerNumber = callerNumber;
  const leadId = text(row.lead_id);
  if (leadId !== undefined) record.leadId = leadId;
  const personKey = text(row.person_key);
  if (personKey !== undefined) record.personKey = personKey;
  const startedAt = toIso(row.started_at);
  if (startedAt !== undefined) record.startedAt = startedAt;
  const endedAt = toIso(row.ended_at);
  if (endedAt !== undefined) record.endedAt = endedAt;
  if (row.duration_ms !== null && row.duration_ms !== undefined) {
    record.durationMs = Number(row.duration_ms);
  }
  const transcript = text(row.transcript);
  if (transcript !== undefined) record.transcript = transcript;
  const summary = text(row.summary);
  if (summary !== undefined) record.summary = summary;
  const sentiment = text(row.sentiment);
  if (sentiment !== undefined) record.sentiment = sentiment;
  const disconnectionReason = text(row.disconnection_reason);
  if (disconnectionReason !== undefined) record.disconnectionReason = disconnectionReason;
  const recordingUrl = text(row.recording_url);
  if (recordingUrl !== undefined) record.recordingUrl = recordingUrl;
  const appointmentId = text(row.appointment_id);
  if (appointmentId !== undefined) record.appointmentId = appointmentId;
  const bookingFailureReason = text(row.booking_failure_reason);
  if (bookingFailureReason !== undefined) record.bookingFailureReason = bookingFailureReason;
  const ownerEmail = text(row.owner_email);
  if (ownerEmail !== undefined) record.ownerEmail = ownerEmail;
  const ownerName = text(row.owner_name);
  if (ownerName !== undefined) record.ownerName = ownerName;
  const crmUpdatedAt = toIso(row.crm_updated_at);
  if (crmUpdatedAt !== undefined) record.crmUpdatedAt = crmUpdatedAt;

  return record;
}
