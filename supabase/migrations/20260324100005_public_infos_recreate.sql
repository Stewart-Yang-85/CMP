-- Phase 27 (T148-T152): Recreate public_infos as a standalone PLMN catalog table.
-- Previously dropped in V009 (20260313100001_deprecate_legacy_carriers.sql).
-- Now recreated as an independent reference table (no FK from operators).
--
-- Rollback: DROP TABLE IF EXISTS public_infos CASCADE;

CREATE TABLE IF NOT EXISTS public_infos (
  public_info_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name           text NOT NULL,
  country        text,
  mcc            char(3) NOT NULL,
  mnc            char(3) NOT NULL,
  lte_bands      text,
  created_at     timestamptz NOT NULL DEFAULT current_timestamp,
  updated_at     timestamptz NOT NULL DEFAULT current_timestamp
);

-- Enforce unique PLMN pair (mcc + mnc)
CREATE UNIQUE INDEX IF NOT EXISTS idx_public_infos_mcc_mnc
  ON public_infos(mcc, mnc);

-- Index for name search (case-insensitive)
CREATE INDEX IF NOT EXISTS idx_public_infos_name_lower
  ON public_infos(lower(name));
