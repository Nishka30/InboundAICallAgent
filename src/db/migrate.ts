import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getPool, closePool } from './pool.js';
import { logger } from '../lib/logger.js';

/**
 * Minimal, dependency-free migration runner.
 *
 * Applies every `*.sql` file in `migrations/` (sorted by name) that has not yet
 * been recorded in a `_migrations` bookkeeping table. Each file runs in its own
 * transaction. A session-level advisory lock serializes concurrent runners (e.g.
 * two instances booting at once), so running it at startup is safe and needs no
 * manual step on deploy.
 *
 * The connection string is never read or logged here — the pool owns it.
 */

// Arbitrary, stable lock id shared by all instances of this service.
const MIGRATION_LOCK_ID = 727_413;

/** Absolute path to the committed migrations directory (works from src/ and dist/). */
function migrationsDir(): string {
  return fileURLToPath(new URL('../../migrations/', import.meta.url));
}

export async function runMigrations(): Promise<{ applied: string[]; alreadyApplied: number }> {
  const pool = getPool();
  const client = await pool.connect();
  const applied: string[] = [];

  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);

    await client.query(
      `CREATE TABLE IF NOT EXISTS _migrations (
         name       TEXT PRIMARY KEY,
         applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
       )`,
    );

    const done = await client.query<{ name: string }>('SELECT name FROM _migrations');
    const seen = new Set(done.rows.map((r) => r.name));

    const dir = migrationsDir();
    const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();

    for (const file of files) {
      if (seen.has(file)) continue;
      const sql = await readFile(join(dir, file), 'utf8');

      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO _migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
      applied.push(file);
      logger.info({ migration: file }, 'migration applied');
    }

    return { applied, alreadyApplied: seen.size };
  } finally {
    try {
      await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]);
    } catch {
      // best-effort unlock; the session ending releases it anyway
    }
    client.release();
  }
}

// --- CLI entry: `npm run migrate` (node dist/db/migrate.js) ------------------
const invokedDirectly =
  Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1] as string).href;

if (invokedDirectly) {
  runMigrations()
    .then(async ({ applied, alreadyApplied }) => {
      if (applied.length === 0) {
        logger.info({ alreadyApplied }, 'migrations up to date; nothing to apply');
      } else {
        logger.info({ applied, alreadyApplied }, 'migrations applied');
      }
      await closePool();
      process.exit(0);
    })
    .catch(async (error: unknown) => {
      logger.fatal(
        { err: error instanceof Error ? { name: error.name, message: error.message } : undefined },
        'migration run failed',
      );
      await closePool().catch(() => {});
      process.exit(1);
    });
}
