-- Reseller-scoped catalog modules (Commercial Terms, Control Policy, Carrier Service) do not
-- bind to enterprise; enterprise is expressed on Package / Price Plan only (spec: 产品与租户分层原则).

BEGIN;

ALTER TABLE public.commercial_terms_modules
  DROP CONSTRAINT IF EXISTS commercial_terms_modules_enterprise_id_fkey;

DROP INDEX IF EXISTS idx_commercial_terms_modules_enterprise_id;

ALTER TABLE public.commercial_terms_modules
  DROP COLUMN IF EXISTS enterprise_id;

ALTER TABLE public.control_policy_modules
  DROP CONSTRAINT IF EXISTS control_policy_modules_enterprise_id_fkey;

DROP INDEX IF EXISTS idx_control_policy_modules_enterprise_id;

ALTER TABLE public.control_policy_modules
  DROP COLUMN IF EXISTS enterprise_id;

ALTER TABLE public.carrier_service_modules
  DROP CONSTRAINT IF EXISTS carrier_service_modules_enterprise_id_fkey;

DROP INDEX IF EXISTS idx_carrier_service_modules_enterprise_id;

ALTER TABLE public.carrier_service_modules
  DROP COLUMN IF EXISTS enterprise_id;

COMMIT;
