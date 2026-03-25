-- Add deprecated_at column to price_plans for DEPRECATED status support
-- Rollback: ALTER TABLE price_plans DROP COLUMN IF EXISTS deprecated_at;

ALTER TABLE price_plans ADD COLUMN IF NOT EXISTS deprecated_at timestamptz;
