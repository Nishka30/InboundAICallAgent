import {
  env,
  requireGuidedBoostConfig,
  type Env,
  type GuidedBoostConfig,
} from '../../config/env.js';

/**
 * Placeholder Guided Boost API client.
 *
 * Guided Boost is a SEPARATE repository, integrated over HTTP only. This client
 * owns authentication and transport concerns for that integration, mirroring the
 * CallScheduler `leadApi` / `callerQueue` clients: a small typed client that
 * attaches `X-Lead-API-Key` (plus the `X-Agent-Email` / `X-Agent-Name` write
 * identity on writes), with bounded retries and boundary validation.
 *
 * SCOPE FOR THIS STEP: configuration + header plumbing only. No endpoints are
 * called yet. The inbound-specific methods (identify caller by phone, fetch
 * context, offer team slots, book, write a call note) are intentionally NOT
 * implemented here — several depend on Guided Boost contract decisions that are
 * out of scope for the scaffold, and no new Guided Boost endpoint is introduced.
 */

export interface GuidedBoostClientOptions {
  config?: GuidedBoostConfig;
  /** Injected for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

export class GuidedBoostClient {
  private readonly config: GuidedBoostConfig;
  private readonly fetchImpl: typeof fetch;

  constructor(options: GuidedBoostClientOptions = {}, envSource: Env = env) {
    // Throws a clear, value-free error if the API key is not configured.
    this.config = options.config ?? requireGuidedBoostConfig(envSource);
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  /** The resolved base URL this client targets. Safe to log (no secret). */
  get baseUrl(): string {
    return this.config.baseUrl;
  }

  /**
   * Read headers for an authenticated Guided Boost GET.
   * The API key is attached here and nowhere else; headers are never logged.
   */
  protected readHeaders(): Record<string, string> {
    return {
      'X-Lead-API-Key': this.config.apiKey,
      Accept: 'application/json',
    };
  }

  /**
   * Write headers for an authenticated Guided Boost POST/PATCH, carrying the
   * fixed agent identity Guided Boost records against the action.
   */
  protected writeHeaders(): Record<string, string> {
    return {
      ...this.readHeaders(),
      'Content-Type': 'application/json',
      'X-Agent-Email': this.config.agentEmail,
      'X-Agent-Name': this.config.agentName,
    };
  }

  /**
   * Transport seam for the integration methods below. A bounded, timed request
   * against the configured base URL. Retries (`this.config.maxRetries`) are added
   * alongside the first real endpoint; this scaffold only establishes the shape.
   */
  protected request(path: string, init?: RequestInit): Promise<Response> {
    return this.fetchImpl(`${this.config.baseUrl}${path}`, {
      ...init,
      signal: AbortSignal.timeout(this.config.timeoutMs),
      redirect: 'error',
    });
  }

  // --- Inbound integration surface (NOT YET IMPLEMENTED) -------------------
  // Planned, in later steps, reusing Guided Boost's EXISTING authenticated
  // endpoints — no new Guided Boost API is added by this service:
  //
  //   identifyCallerByPhone(e164)  -> GET /api/crm/search (persons index) or a
  //                                   future inbound-specific lookup
  //   getLeadContext(leadId)       -> GET /api/crm/leads/:id
  //   getTeamSlots(leadId, tz)     -> GET /api/crm/leads/:id/team-slots
  //   bookTeamCall(...)            -> POST /api/crm/appointments/team
  //   writeCallNote(leadId, ...)   -> POST /api/crm/leads/:id/notes (kind 'call')
  //
  // `this.fetchImpl`, `this.config.timeoutMs` and `this.config.maxRetries` are
  // the seams those methods will use.
}
