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

import { env, databaseEnabled } from '../config/env.js';
import { getPool } from '../db/pool.js';

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

/** Pings Postgres with a trivial query. Never throws; the connection string is never logged. */
async function databaseUp(): Promise<boolean> {
  try {
    await getPool().query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}

/**
 * Readiness: is the required configuration present AND are required dependencies
 * reachable? Reports a boolean per check — never a secret value.
 * `retell_webhook_key` being down makes the service not_ready. When Postgres
 * persistence is enabled, an unreachable database also makes it not_ready (so the
 * endpoint confirms the DB connection). `guided_boost_api` is reported for
 * visibility but does not block readiness.
 */
export async function getReadiness(): Promise<ReadinessResult> {
  const retellConfigured = Boolean(env.RETELL_API_KEY);
  const guidedBoostConfigured = Boolean(env.GUIDED_BOOST_API_KEY);
  const dbReachable = databaseEnabled ? await databaseUp() : null;

  const checks: ReadinessResult['checks'] = {
    retell_webhook_key: { status: retellConfigured ? 'up' : 'down' },
    guided_boost_api: { status: guidedBoostConfigured ? 'up' : 'down' },
  };
  if (databaseEnabled) {
    checks['database'] = { status: dbReachable ? 'up' : 'down' };
  }

  const ready = retellConfigured && (databaseEnabled ? dbReachable === true : true);

  return {
    status: ready ? 'ready' : 'not_ready',
    checks,
    timestamp: new Date().toISOString(),
  };
}
