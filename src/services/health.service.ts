/**
 * Health model for the Inbound service.
 *
 * Liveness reports the process is up. Readiness reports whether the configuration
 * the inbound flow actually needs is present — WITHOUT exposing any secret value
 * (only a boolean up/down per check). The one truly required secret is
 * `RETELL_API_KEY` (no webhook can be verified without it), so its absence makes
 * the service `not_ready`. Guided Boost config is reported but non-fatal: a call
 * still runs, degrading to an unknown caller if the CRM is unreachable.
 */

import { env } from '../config/env.js';

export interface LivenessResult {
  status: 'ok';
  service: string;
  uptimeSeconds: number;
  timestamp: string;
}

export interface ReadinessResult {
  status: 'ready' | 'not_ready';
  checks: Record<string, { status: 'up' | 'down' }>;
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
 * Readiness: is the required configuration present? Reports a boolean per check —
 * never a secret value. `retell_webhook_key` being down makes the service
 * not_ready; `guided_boost_api` is reported for visibility but does not block
 * readiness.
 */
export function getReadiness(): ReadinessResult {
  const retellConfigured = Boolean(env.RETELL_API_KEY);
  const guidedBoostConfigured = Boolean(env.GUIDED_BOOST_API_KEY);

  return {
    status: retellConfigured ? 'ready' : 'not_ready',
    checks: {
      retell_webhook_key: { status: retellConfigured ? 'up' : 'down' },
      guided_boost_api: { status: guidedBoostConfigured ? 'up' : 'down' },
    },
    timestamp: new Date().toISOString(),
  };
}
