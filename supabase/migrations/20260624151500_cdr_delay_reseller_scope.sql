-- US9 follow-up: CDR_DELAY is reseller-scoped, backed by early CDR file SIM references.

BEGIN;

ALTER TABLE public.cdr_files
  ADD COLUMN IF NOT EXISTS reseller_id uuid REFERENCES public.tenants(tenant_id),
  ADD COLUMN IF NOT EXISTS operator_id uuid REFERENCES public.operators(operator_id);

CREATE INDEX IF NOT EXISTS idx_cdr_files_reseller_received
  ON public.cdr_files (reseller_id, received_at)
  WHERE ingested_at IS NULL;

CREATE TABLE IF NOT EXISTS public.cdr_file_sim_refs (
  cdr_file_sim_ref_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cdr_file_id uuid NOT NULL REFERENCES public.cdr_files(cdr_file_id) ON DELETE CASCADE,
  iccid text NOT NULL,
  sim_id uuid REFERENCES public.sims(sim_id),
  reseller_id uuid REFERENCES public.tenants(tenant_id),
  enterprise_id uuid REFERENCES public.tenants(tenant_id),
  created_at timestamptz NOT NULL DEFAULT current_timestamp,
  CONSTRAINT cdr_file_sim_refs_iccid_chk CHECK (iccid <> '')
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_cdr_file_sim_refs_file_iccid
  ON public.cdr_file_sim_refs (cdr_file_id, iccid);

CREATE INDEX IF NOT EXISTS idx_cdr_file_sim_refs_reseller
  ON public.cdr_file_sim_refs (reseller_id, cdr_file_id);

CREATE INDEX IF NOT EXISTS idx_cdr_file_sim_refs_enterprise
  ON public.cdr_file_sim_refs (enterprise_id, cdr_file_id);

CREATE INDEX IF NOT EXISTS idx_cdr_file_sim_refs_sim
  ON public.cdr_file_sim_refs (sim_id);

UPDATE public.alert_type_catalog
SET
  description = 'CDR files for a reseller integration are delayed beyond the configured threshold.',
  updated_at = current_timestamp
WHERE alert_type = 'CDR_DELAY';

COMMIT;
