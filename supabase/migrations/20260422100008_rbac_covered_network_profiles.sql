-- Phase 30 T225: CoveredNetworkProfile catalog permissions (catalog.covered_network_profiles.*)

BEGIN;

INSERT INTO public.permissions (code, name, description, category) VALUES
  ('catalog.covered_network_profiles.list', 'List Covered Network Profiles', 'List covered network profile catalog entries', 'catalog'),
  ('catalog.covered_network_profiles.read', 'Read Covered Network Profile', 'View covered network profile details', 'catalog'),
  ('catalog.covered_network_profiles.write', 'Write Covered Network Profile', 'Create or update covered network profile drafts', 'catalog'),
  ('catalog.covered_network_profiles.publish', 'Publish Covered Network Profile', 'Publish a covered network profile', 'catalog'),
  ('catalog.covered_network_profiles.deprecate', 'Deprecate Covered Network Profile', 'Deprecate a covered network profile', 'catalog')
ON CONFLICT (code) DO NOTHING;

INSERT INTO public.role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM public.roles r, public.permissions p
WHERE r.code = 'reseller_admin' AND p.code IN (
  'catalog.covered_network_profiles.list',
  'catalog.covered_network_profiles.read',
  'catalog.covered_network_profiles.write',
  'catalog.covered_network_profiles.publish',
  'catalog.covered_network_profiles.deprecate'
)
ON CONFLICT DO NOTHING;

INSERT INTO public.role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM public.roles r, public.permissions p
WHERE r.code = 'reseller_sales_director' AND p.code IN (
  'catalog.covered_network_profiles.list',
  'catalog.covered_network_profiles.read'
)
ON CONFLICT DO NOTHING;

INSERT INTO public.role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM public.roles r, public.permissions p
WHERE r.code = 'reseller_sales' AND p.code IN (
  'catalog.covered_network_profiles.list',
  'catalog.covered_network_profiles.read'
)
ON CONFLICT DO NOTHING;

COMMIT;
