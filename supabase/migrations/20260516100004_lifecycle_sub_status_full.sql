-- Extend lifecycle_sub_status for all outbound lifecycle directions (spec US2 [V1.1])
-- Renamed from 20260516100001_* to avoid version clash with 20260516100001_sims_imei_lock_enabled.sql
ALTER TYPE public.lifecycle_sub_status ADD VALUE IF NOT EXISTS 'deactivating';
ALTER TYPE public.lifecycle_sub_status ADD VALUE IF NOT EXISTS 'deactivation_failed';
ALTER TYPE public.lifecycle_sub_status ADD VALUE IF NOT EXISTS 'reactivating';
ALTER TYPE public.lifecycle_sub_status ADD VALUE IF NOT EXISTS 'reactivation_failed';
ALTER TYPE public.lifecycle_sub_status ADD VALUE IF NOT EXISTS 'retiring';
ALTER TYPE public.lifecycle_sub_status ADD VALUE IF NOT EXISTS 'retire_failed';

ALTER TABLE public.sims
  ADD COLUMN IF NOT EXISTS status_sync_conflict boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.sims.status_sync_conflict IS
  'True when steady-state status drifts from upstream_status after reconciliation retries are exhausted.';
