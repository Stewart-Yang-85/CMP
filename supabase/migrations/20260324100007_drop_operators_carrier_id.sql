-- Phase 27 T153: Final data-decoupling — drop operators.carrier_id if it still exists.
-- This column was already dropped by V009 (20260313100001_deprecate_legacy_carriers.sql)
-- for most deployments, but this migration is idempotent and ensures cleanup.
--
-- Rollback: ALTER TABLE operators ADD COLUMN carrier_id uuid;

-- 1) Drop FK constraint referencing public_infos(public_info_id) if it exists
DO $$
DECLARE
  fk_name text;
BEGIN
  FOR fk_name IN
    SELECT con.conname
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_namespace ns ON ns.oid = rel.relnamespace
    WHERE ns.nspname = 'public'
      AND rel.relname = 'operators'
      AND con.contype = 'f'
      AND EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'operators'
          AND column_name = 'carrier_id'
      )
      AND con.conname LIKE '%carrier%'
  LOOP
    EXECUTE format('ALTER TABLE public.operators DROP CONSTRAINT IF EXISTS %I', fk_name);
  END LOOP;
END $$;

-- 2) Drop any unique constraint that depends on carrier_id
DO $$
DECLARE
  idx_name text;
BEGIN
  FOR idx_name IN
    SELECT i.relname
    FROM pg_index ix
    JOIN pg_class i ON i.oid = ix.indexrelid
    JOIN pg_class t ON t.oid = ix.indrelid
    JOIN pg_namespace ns ON ns.oid = t.relnamespace
    JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(ix.indkey)
    WHERE ns.nspname = 'public'
      AND t.relname = 'operators'
      AND a.attname = 'carrier_id'
      AND ix.indisunique
  LOOP
    EXECUTE format('DROP INDEX IF EXISTS public.%I', idx_name);
  END LOOP;
END $$;

-- 3) Drop the column itself
ALTER TABLE IF EXISTS operators DROP COLUMN IF EXISTS carrier_id;
