import { logger } from '../lib/logger.js';
import { GuidedBoostClient } from '../integrations/guidedBoost/client.js';
import {
  firstActiveAppointment,
  hasActiveAppointment,
  pickPrimaryLead,
  readProfileOwner,
} from '../integrations/guidedBoost/schemas.js';

/**
 * Resolves an identified existing caller from their `personKey`:
 *   personKey → GET /api/crm/persons/:personKey → primary lead id + owner +
 *   whether they already have an active consultation.
 *
 * Verified contract (live 2026-11-18): the person's `leads[]` wrap the raw lead
 * columns under `current`/`captured` (lead id in `current.id`), and top-level
 * `appointments[]` holds team bookings. NEVER throws: on any failure the caller
 * stays identified (personKey preserved) but `resolved` is false, so the flow can
 * continue without a duplicate lead.
 */

export interface ExistingCallerResolution {
  /** The resolved lead id, when the person has a usable lead. */
  leadId?: string;
  leadStatus?: string;
  ownerEmail?: string;
  ownerName?: string;
  /** The person already has a non-cancelled appointment. */
  hasExistingConsultation: boolean;
  /** Short description of the existing appointment, when present (non-PII-ish). */
  existingConsultationSummary?: string;
  /** True when a lead id was resolved. */
  resolved: boolean;
  /** True when Guided Boost responded (vs. unreachable). */
  reachable: boolean;
}

export interface ResolveExistingCallerDeps {
  client?: GuidedBoostClient;
}

export async function resolveExistingCaller(
  personKey: string,
  deps: ResolveExistingCallerDeps = {},
): Promise<ExistingCallerResolution> {
  let client: GuidedBoostClient;
  try {
    client = deps.client ?? new GuidedBoostClient();
  } catch {
    return { hasExistingConsultation: false, resolved: false, reachable: false };
  }

  let person;
  try {
    person = await client.getPerson(personKey);
  } catch (error) {
    logger.warn(
      { err: error instanceof Error ? error.name : 'unknown' },
      'existing caller: person lookup failed; preserving identity without a lead id',
    );
    return { hasExistingConsultation: false, resolved: false, reachable: false };
  }

  const primary = pickPrimaryLead(person);
  const owner = readProfileOwner(person);
  const hasConsultation = hasActiveAppointment(person);
  const appt = firstActiveAppointment(person);

  const resolution: ExistingCallerResolution = {
    hasExistingConsultation: hasConsultation,
    resolved: primary !== null,
    reachable: true,
  };
  if (primary) {
    resolution.leadId = primary.leadId;
    if (primary.leadStatus) resolution.leadStatus = primary.leadStatus;
    if (primary.salesAgentEmail) resolution.ownerEmail = primary.salesAgentEmail;
  }
  // Profile owner takes precedence for the human-facing name/email when present.
  if (owner.email) resolution.ownerEmail = owner.email;
  if (owner.name) resolution.ownerName = owner.name;
  if (appt) {
    const when = appt.starts_at ? ` at ${appt.starts_at}` : '';
    const type = appt.meeting_type ? ` (${appt.meeting_type})` : '';
    resolution.existingConsultationSummary = `${appt.status ?? 'scheduled'}${type}${when}`.trim();
  }

  return resolution;
}
