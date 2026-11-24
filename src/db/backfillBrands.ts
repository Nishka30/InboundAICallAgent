import { getPool } from './pool.js';
import { resolveBrand } from '../lib/brand.js';
import { logger } from '../lib/logger.js';

/**
 * One-time backfill of the `brand` column for rows created before 0002_brand.
 *
 * Existing calls are resolved from their stored `inbound_number` using the SAME
 * `resolveBrand()` rules the live flow uses, so historical calls keep the correct
 * brand (single-brand HW data resolves to the default brand, exactly as before).
 *
 * Idempotent and cheap: it only touches rows where `brand IS NULL`, and resolves
 * once per distinct inbound number. Safe to run on every boot — after the first
 * run there is nothing left to update.
 */
export async function backfillBrands(): Promise<number> {
  const pool = getPool();

  const { rows } = await pool.query<{ inbound_number: string | null }>(
    'SELECT DISTINCT inbound_number FROM inbound_calls WHERE brand IS NULL',
  );
  if (rows.length === 0) return 0;

  let updated = 0;
  for (const row of rows) {
    const brand = resolveBrand(row.inbound_number);
    // `IS NOT DISTINCT FROM` matches a NULL inbound_number as well as a value.
    const result = await pool.query(
      `UPDATE inbound_calls
       SET brand = $1, updated_at = now()
       WHERE brand IS NULL AND inbound_number IS NOT DISTINCT FROM $2`,
      [brand, row.inbound_number],
    );
    updated += result.rowCount ?? 0;
  }

  logger.info({ updated }, 'brand backfill complete');
  return updated;
}
