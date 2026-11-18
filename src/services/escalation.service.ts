import { logger } from '../lib/logger.js';
import { GuidedBoostClient } from '../integrations/guidedBoost/client.js';

/**
 * Escalation boundary for urgent existing-caller issues.
 *
 * Guided Boost does not currently expose a dedicated escalation/notification API,
 * so the default implementation uses the CONFIRMED CRM-note endpoint to record the
 * issue against the lead, clearly marked URGENT, preserving the existing
 * owner/consultant relationship. The interface is deliberately isolated so a real
 * escalation/notification mechanism can be wired in later WITHOUT changing the
 * inbound flow — swap the implementation here.
 */

export interface EscalationRequest {
  leadId: string;
  issue: string;
  /** The current owner/consultant to preserve/route to, when known. */
  ownerName?: string | undefined;
  ownerEmail?: string | undefined;
}

export interface EscalationResult {
  escalated: boolean;
  /** How it was routed, for observability. */
  via: 'crm_note' | 'none';
}

export interface EscalationService {
  escalate(request: EscalationRequest): Promise<EscalationResult>;
}

/** Default escalation: an URGENT CRM note on the lead (confirmed endpoint). */
export class CrmNoteEscalationService implements EscalationService {
  constructor(private readonly client: GuidedBoostClient) {}

  async escalate(request: EscalationRequest): Promise<EscalationResult> {
    const lines = ['⚠️ URGENT — inbound call escalation', `Issue: ${request.issue}`];
    if (request.ownerName || request.ownerEmail) {
      lines.push(`Owner/consultant: ${request.ownerName ?? ''} ${request.ownerEmail ?? ''}`.trim());
    }
    lines.push('Requested urgent follow-up during an inbound AI call.');
    try {
      await this.client.addCallNote(request.leadId, lines.join('\n'));
      return { escalated: true, via: 'crm_note' };
    } catch (error) {
      logger.error(
        { leadId: request.leadId, err: error instanceof Error ? error.name : 'unknown' },
        'escalation: urgent CRM note failed',
      );
      return { escalated: false, via: 'none' };
    }
  }
}

/** Builds the default escalation service, or null when Guided Boost is unconfigured. */
export function defaultEscalationService(client?: GuidedBoostClient): EscalationService | null {
  try {
    return new CrmNoteEscalationService(client ?? new GuidedBoostClient());
  } catch {
    return null;
  }
}
