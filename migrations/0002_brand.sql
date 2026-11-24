-- 0002_brand — per-call brand.
--
-- The brand for an inbound call is resolved ONCE from the dialled inbound number
-- (Retell `to_number`) at record creation and persisted here, so every downstream
-- Guided Boost request for the call uses a stable brand rather than re-deriving it
-- from a nullable field on each tool invocation.
--
-- The column is nullable so this migration is safe on a populated table; new rows
-- always set it, and existing rows are backfilled at startup from `inbound_number`
-- using the application's resolveBrand() rules (see src/db/backfillBrands.ts).
-- Idempotent: safe to run repeatedly.

ALTER TABLE inbound_calls ADD COLUMN IF NOT EXISTS brand TEXT;

CREATE INDEX IF NOT EXISTS idx_inbound_calls_brand ON inbound_calls (brand);
