-- V1.1 Phase 23: RBAC Seed Data
--
-- Purpose: Seed roles, permissions, and role_permissions with the 6 business roles
-- and 38+ permission codes defined in spec.md.
--
-- Tasks: T125 (permissions seed), T126 (roles + role_permissions seed)
--
-- platform_admin is NOT seeded here — it bypasses permission checks entirely.

BEGIN;

-- ============================================================
-- T125: Seed permissions (38+ codes across 8 categories)
-- ============================================================

-- Category: bills
INSERT INTO permissions (code, name, description, category) VALUES
  ('bills.list', 'List Bills', 'View bill list with pagination and filters', 'bills'),
  ('bills.read', 'Read Bill', 'View bill details and line items', 'bills'),
  ('bills.line_items.read', 'Read Bill Line Items', 'View SIM-level bill line items (L3) and CSV export', 'bills'),
  ('bills.export', 'Export Bills', 'Download bill files (PDF/CSV)', 'bills'),
  ('bills.mark_paid', 'Mark Bill Paid', 'Transition bill status to PAID', 'bills'),
  ('bills.adjust', 'Adjust Bill', 'Create adjustment notes (credit/debit)', 'bills'),
  ('bills.write_off', 'Write Off Bill', 'Transition OVERDUE bill to WRITTEN_OFF', 'bills')
ON CONFLICT (code) DO NOTHING;

-- Category: sims
INSERT INTO permissions (code, name, description, category) VALUES
  ('sims.list', 'List SIMs', 'View SIM card list with filters', 'sims'),
  ('sims.read', 'Read SIM', 'View SIM card details', 'sims'),
  ('sims.create', 'Create SIM', 'Create individual SIM records', 'sims'),
  ('sims.import', 'Import SIMs', 'Batch import SIM cards via CSV', 'sims'),
  ('sims.export', 'Export SIMs', 'Download SIM list as CSV', 'sims'),
  ('sims.activate', 'Activate SIM', 'Change SIM status to ACTIVATED', 'sims'),
  ('sims.deactivate', 'Deactivate SIM', 'Change SIM status to DEACTIVATED', 'sims'),
  ('sims.reactivate', 'Reactivate SIM', 'Change SIM status back to ACTIVATED', 'sims'),
  ('sims.retire', 'Retire SIM', 'Change SIM status to RETIRED (terminal)', 'sims'),
  ('sims.batch_status_change', 'Batch SIM Status Change', 'Bulk status change operations', 'sims'),
  ('sims.batch_deactivate', 'Batch Deactivate SIMs', 'Bulk deactivation', 'sims'),
  ('sims.assign_inventory', 'Assign Inventory SIMs', 'Assign reseller pool SIMs to child enterprise', 'sims'),
  ('sims.assign_department', 'Assign SIMs to Department', 'Assign enterprise SIMs to a child department via CSV', 'sims'),
  ('sims.reset_connection', 'Reset SIM Connection', 'Trigger connection reset via upstream', 'sims'),
  ('sims.connectivity.read', 'Read SIM Connectivity', 'View connectivity diagnostics', 'sims'),
  ('sims.location.read', 'Read SIM Location', 'View current SIM location', 'sims'),
  ('sims.location.history', 'SIM Location History', 'View historical SIM locations', 'sims')
ON CONFLICT (code) DO NOTHING;

-- Category: subscriptions
INSERT INTO permissions (code, name, description, category) VALUES
  ('subscriptions.list', 'List Subscriptions', 'View subscription list', 'subscriptions'),
  ('subscriptions.read', 'Read Subscription', 'View subscription details', 'subscriptions'),
  ('subscriptions.create', 'Create Subscription', 'Bind SIM to product package', 'subscriptions'),
  ('subscriptions.switch', 'Switch Subscription', 'Switch subscription to different package', 'subscriptions'),
  ('subscriptions.cancel', 'Cancel Subscription', 'Cancel active subscription', 'subscriptions')
ON CONFLICT (code) DO NOTHING;

-- Category: catalog
INSERT INTO permissions (code, name, description, category) VALUES
  ('catalog.packages.list', 'List Packages', 'View product package list', 'catalog'),
  ('catalog.packages.export', 'Export Packages', 'Download package list', 'catalog'),
  ('catalog.package_versions.list', 'List Package Versions', 'View package version history', 'catalog'),
  ('price_plans.read', 'Read Price Plans', 'View price plan details', 'catalog')
ON CONFLICT (code) DO NOTHING;

-- Category: jobs
INSERT INTO permissions (code, name, description, category) VALUES
  ('jobs.read', 'Read Jobs', 'View async job status and history', 'jobs')
ON CONFLICT (code) DO NOTHING;

-- Category: share
INSERT INTO permissions (code, name, description, category) VALUES
  ('share.read', 'Read Shared Resources', 'View shared resource links', 'share'),
  ('share.create', 'Create Share', 'Generate shareable resource links', 'share')
ON CONFLICT (code) DO NOTHING;

-- Category: alerts
INSERT INTO permissions (code, name, description, category) VALUES
  ('alerts.list', 'List Alerts', 'View alert list', 'alerts'),
  ('alerts.read', 'Read Alert', 'View alert details', 'alerts'),
  ('alerts.acknowledge', 'Acknowledge Alert', 'Mark alert as acknowledged', 'alerts'),
  ('alerts.summary', 'Alert Summary', 'View aggregated alert statistics', 'alerts'),
  ('alerts.trends', 'Alert Trends', 'View alert trend analysis', 'alerts')
ON CONFLICT (code) DO NOTHING;

-- Category: reports
INSERT INTO permissions (code, name, description, category) VALUES
  ('reports.usage', 'Usage Reports', 'View usage trend reports', 'reports'),
  ('reports.billing', 'Billing Reports', 'View billing summary reports', 'reports')
ON CONFLICT (code) DO NOTHING;

-- ============================================================
-- T126: Seed roles (6 business roles)
-- ============================================================

INSERT INTO roles (code, name, description, scope) VALUES
  ('reseller_admin', 'Reseller Admin', 'Full management of reseller and sub-enterprises', 'reseller'),
  ('reseller_sales_director', 'Reseller Sales Director', 'Manage assigned enterprise set and sales team', 'reseller'),
  ('reseller_sales', 'Reseller Sales', 'Manage assigned enterprise SIMs and subscriptions', 'reseller'),
  ('reseller_finance', 'Reseller Finance', 'Read-only access to financial data', 'reseller'),
  ('customer_admin', 'Customer Admin', 'Full management of enterprise and all departments', 'customer'),
  ('customer_ops', 'Customer Ops', 'Operational access limited to assigned department SIMs', 'customer')
ON CONFLICT (code) DO NOTHING;

-- ============================================================
-- T126: Seed role_permissions
-- ============================================================

-- Helper: reseller_admin — full SIM lifecycle + billing read + subscriptions + alerts
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.code = 'reseller_admin' AND p.code IN (
  'bills.list', 'bills.read', 'bills.line_items.read', 'bills.export', 'bills.mark_paid', 'bills.adjust', 'bills.write_off',
  'sims.list', 'sims.read', 'sims.create', 'sims.import', 'sims.export',
  'sims.activate', 'sims.deactivate', 'sims.reactivate', 'sims.retire',
  'sims.batch_status_change', 'sims.batch_deactivate', 'sims.assign_inventory', 'sims.assign_department', 'sims.reset_connection',
  'sims.connectivity.read', 'sims.location.read', 'sims.location.history',
  'subscriptions.list', 'subscriptions.read', 'subscriptions.create', 'subscriptions.switch', 'subscriptions.cancel',
  'catalog.packages.list', 'catalog.packages.export', 'catalog.package_versions.list', 'price_plans.read',
  'jobs.read', 'share.read', 'share.create',
  'alerts.list', 'alerts.read', 'alerts.acknowledge', 'alerts.summary', 'alerts.trends',
  'reports.usage', 'reports.billing'
)
ON CONFLICT DO NOTHING;

-- reseller_sales_director — SIM management + subscriptions + limited billing
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.code = 'reseller_sales_director' AND p.code IN (
  'bills.list', 'bills.read', 'bills.export',
  'sims.list', 'sims.read', 'sims.create', 'sims.import', 'sims.export',
  'sims.activate', 'sims.deactivate', 'sims.reactivate', 'sims.retire',
  'sims.batch_status_change', 'sims.batch_deactivate', 'sims.reset_connection',
  'sims.connectivity.read', 'sims.location.read', 'sims.location.history',
  'subscriptions.list', 'subscriptions.read', 'subscriptions.create', 'subscriptions.switch', 'subscriptions.cancel',
  'catalog.packages.list', 'catalog.packages.export', 'catalog.package_versions.list', 'price_plans.read',
  'jobs.read', 'share.read', 'share.create',
  'alerts.list', 'alerts.read', 'alerts.summary',
  'reports.usage'
)
ON CONFLICT DO NOTHING;

-- reseller_sales — assigned enterprise SIM + subscription management
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.code = 'reseller_sales' AND p.code IN (
  'sims.list', 'sims.read', 'sims.create', 'sims.import', 'sims.export',
  'sims.activate', 'sims.deactivate', 'sims.reactivate', 'sims.retire',
  'sims.batch_status_change', 'sims.batch_deactivate', 'sims.reset_connection',
  'sims.connectivity.read', 'sims.location.read', 'sims.location.history',
  'subscriptions.list', 'subscriptions.read', 'subscriptions.create', 'subscriptions.switch', 'subscriptions.cancel',
  'catalog.packages.list', 'catalog.package_versions.list', 'price_plans.read',
  'jobs.read', 'share.read', 'share.create'
)
ON CONFLICT DO NOTHING;

-- reseller_finance — read-only financial data
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.code = 'reseller_finance' AND p.code IN (
  'bills.list', 'bills.read', 'bills.export',
  'sims.list', 'sims.read',
  'subscriptions.list', 'subscriptions.read',
  'catalog.packages.list', 'price_plans.read',
  'reports.usage', 'reports.billing'
)
ON CONFLICT DO NOTHING;

-- customer_admin — full enterprise management
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.code = 'customer_admin' AND p.code IN (
  'bills.list', 'bills.read', 'bills.export', 'bills.mark_paid', 'bills.adjust',
  'sims.list', 'sims.read', 'sims.export', 'sims.assign_department',
  'sims.activate', 'sims.deactivate', 'sims.reactivate', 'sims.retire',
  'sims.batch_status_change', 'sims.reset_connection',
  'sims.connectivity.read', 'sims.location.read', 'sims.location.history',
  'subscriptions.list', 'subscriptions.read', 'subscriptions.create', 'subscriptions.switch', 'subscriptions.cancel',
  'catalog.packages.list', 'catalog.packages.export', 'catalog.package_versions.list', 'price_plans.read',
  'jobs.read', 'share.read', 'share.create',
  'alerts.list', 'alerts.read', 'alerts.acknowledge',
  'reports.usage'
)
ON CONFLICT DO NOTHING;

-- customer_ops — department-scoped SIM read + limited operations
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.code = 'customer_ops' AND p.code IN (
  'sims.list', 'sims.read',
  'sims.connectivity.read', 'sims.location.read',
  'subscriptions.list', 'subscriptions.read',
  'catalog.packages.list', 'price_plans.read',
  'jobs.read'
)
ON CONFLICT DO NOTHING;

COMMIT;
