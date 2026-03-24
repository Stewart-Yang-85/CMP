-- Phase 21: Add remark column to sims table
-- Zero-downtime: nullable TEXT column, no default, no lock escalation
-- Rollback: ALTER TABLE sims DROP COLUMN IF EXISTS remark;

BEGIN;

ALTER TABLE sims ADD COLUMN IF NOT EXISTS remark TEXT;

COMMENT ON COLUMN sims.remark IS 'Free-text remark / note attached to a SIM card';

COMMIT;
