import pg from 'pg';
import { requireDatabaseUrl } from '../config/env.js';

/**
 * Lazily-created Postgres connection pool.
 *
 * The pool is built on first use (not at import), so the HTTP server and health
 * probes boot even when DATABASE_URL is absent. The connection string is a secret
 * (it contains the password) and is NEVER logged — only generic, value-free
 * messages are emitted elsewhere.
 *
 * Neon (and most managed Postgres) require TLS. We enable it whenever the URL
 * targets a managed host or explicitly asks for it; `rejectUnauthorized: false`
 * avoids CA-chain friction on the platform while still encrypting the connection.
 */

const { Pool } = pg;

let pool: pg.Pool | null = null;

function needsSsl(url: string): boolean {
  return /sslmode=require|sslmode=verify|neon\.tech|render\.com|amazonaws\.com|\.pooler\./i.test(url);
}

/** Returns the shared pool, creating it on first call. Throws if DATABASE_URL is unset. */
export function getPool(): pg.Pool {
  if (pool) return pool;

  const connectionString = requireDatabaseUrl();
  pool = new Pool({
    connectionString,
    ...(needsSsl(connectionString) ? { ssl: { rejectUnauthorized: false } } : {}),
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });

  // A pool-level error (e.g. an idle client dropped by the server) must never
  // crash the process. Log the error name only — never the connection string.
  pool.on('error', () => {
    // Swallowed deliberately; individual queries surface their own failures.
  });

  return pool;
}

/** Closes the pool if it was created. Safe to call when it never was. */
export async function closePool(): Promise<void> {
  if (!pool) return;
  const current = pool;
  pool = null;
  await current.end();
}

/** True once the pool has been created (used only for diagnostics). */
export function poolCreated(): boolean {
  return pool !== null;
}
