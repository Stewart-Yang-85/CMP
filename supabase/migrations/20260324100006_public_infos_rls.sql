-- Phase 27 T150: RLS policies for public_infos
-- SELECT: any authenticated user
-- INSERT/UPDATE/DELETE: service_role only (application layer enforces platform_admin)

ALTER TABLE IF EXISTS public_infos ENABLE ROW LEVEL SECURITY;

-- Block anonymous access entirely
DROP POLICY IF EXISTS public_infos_no_anon ON public_infos;
CREATE POLICY public_infos_no_anon ON public_infos
  FOR ALL TO anon
  USING (false)
  WITH CHECK (false);

-- Authenticated users can SELECT
DROP POLICY IF EXISTS public_infos_select_authenticated ON public_infos;
CREATE POLICY public_infos_select_authenticated ON public_infos
  FOR SELECT TO authenticated
  USING (true);

-- Only service_role can INSERT (app layer checks platform_admin)
DROP POLICY IF EXISTS public_infos_insert_service ON public_infos;
CREATE POLICY public_infos_insert_service ON public_infos
  FOR INSERT TO service_role
  WITH CHECK (true);

-- Only service_role can UPDATE
DROP POLICY IF EXISTS public_infos_update_service ON public_infos;
CREATE POLICY public_infos_update_service ON public_infos
  FOR UPDATE TO service_role
  USING (true)
  WITH CHECK (true);

-- Only service_role can DELETE
DROP POLICY IF EXISTS public_infos_delete_service ON public_infos;
CREATE POLICY public_infos_delete_service ON public_infos
  FOR DELETE TO service_role
  USING (true);
