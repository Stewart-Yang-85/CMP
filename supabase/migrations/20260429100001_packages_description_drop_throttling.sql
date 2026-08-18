-- User-facing package description; drop legacy `throttling_policy` (superseded by control_policy modules).

BEGIN;

ALTER TABLE public.packages
  ADD COLUMN IF NOT EXISTS description text;

ALTER TABLE public.packages
  DROP COLUMN IF EXISTS throttling_policy;

COMMIT;
