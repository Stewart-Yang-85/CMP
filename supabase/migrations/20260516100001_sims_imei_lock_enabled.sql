-- IME Lock: persist whether a SIM requires device IME binding (API: imeiLockEnabled).
-- bound_imei stores the 15-digit IMEI when IME Lock is enabled.

ALTER TABLE public.sims
  ADD COLUMN IF NOT EXISTS imei_lock_enabled boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.sims.imei_lock_enabled IS
  'When true, SIM is IME Lock enabled; bound_imei must hold the locked 15-digit device IMEI.';

UPDATE public.sims
SET imei_lock_enabled = true
WHERE bound_imei IS NOT NULL
  AND btrim(bound_imei) <> '';
