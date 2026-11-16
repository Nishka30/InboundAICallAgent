/**
 * Health model for the Inbound service.
 *
 * The scaffold owns no external dependency yet (no database, no provider
 * connection established at boot), so readiness currently reports ready whenever
 * the process is up. The `checks` map is kept as a structured, extensible seam:
 * when the inbound call lifecycle adds a datastore or a Guided Boost reachability
 * probe, each becomes an entry here and readiness turns to 503 if a required one
 * is down — matching the CallScheduler contract.
 */

export interface LivenessResult {
  status: 'ok';
  service: string;
  uptimeSeconds: number;
  timestamp: string;
}

export interface ReadinessResult {
  status: 'ready' | 'not_ready';
  checks: Record<string, { status: 'up' | 'down'; latencyMs?: number }>;
  timestamp: string;
}

const SERVICE_NAME = 'inbound-caller';

/** Liveness: the HTTP process is up. Deliberately touches no dependency. */
export function getLiveness(): LivenessResult {
  return {
    status: 'ok',
    service: SERVICE_NAME,
    uptimeSeconds: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
  };
}

/**
 * Readiness: are all required dependencies reachable? No required dependency
 * exists yet, so this is ready while the process runs. Returns `checks` empty
 * rather than fabricating a dependency status.
 */
export function getReadiness(): ReadinessResult {
  return {
    status: 'ready',
    checks: {},
    timestamp: new Date().toISOString(),
  };
}
