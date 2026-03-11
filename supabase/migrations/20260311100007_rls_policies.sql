-- V007_rls_policies.sql
-- Row Level Security policies for all non-golden-test tables
-- Sources: 0030 + api_clients RLS (from api_clients.sql)
-- Note: 0004 (rating_results) and 0008_bills_rls stay in V002 (golden-test-scoped)
--
-- Rollback:
--   (drop individual policies or disable RLS on each table)

-- ============================================================
-- api_clients RLS (from api_clients.sql)
-- ============================================================

alter table if exists api_clients enable row level security;

drop policy if exists no_anon_access on api_clients;
create policy no_anon_access on api_clients
  for all
  to anon
  using (false)
  with check (false);

-- ============================================================
-- Billing/integration tables RLS (from 0030)
-- ============================================================

alter table if exists reseller_branding enable row level security;
drop policy if exists reseller_branding_no_anon_access on reseller_branding;
create policy reseller_branding_no_anon_access on reseller_branding for all to anon using (false) with check (false);
drop policy if exists reseller_branding_authenticated_full_access on reseller_branding;
create policy reseller_branding_authenticated_full_access on reseller_branding for all to authenticated using (true) with check (true);

alter table if exists dunning_records enable row level security;
drop policy if exists dunning_records_no_anon_access on dunning_records;
create policy dunning_records_no_anon_access on dunning_records for all to anon using (false) with check (false);
drop policy if exists dunning_records_authenticated_full_access on dunning_records;
create policy dunning_records_authenticated_full_access on dunning_records for all to authenticated using (true) with check (true);

alter table if exists dunning_actions enable row level security;
drop policy if exists dunning_actions_no_anon_access on dunning_actions;
create policy dunning_actions_no_anon_access on dunning_actions for all to anon using (false) with check (false);
drop policy if exists dunning_actions_authenticated_full_access on dunning_actions;
create policy dunning_actions_authenticated_full_access on dunning_actions for all to authenticated using (true) with check (true);

alter table if exists alerts enable row level security;
drop policy if exists alerts_no_anon_access on alerts;
create policy alerts_no_anon_access on alerts for all to anon using (false) with check (false);
drop policy if exists alerts_authenticated_full_access on alerts;
create policy alerts_authenticated_full_access on alerts for all to authenticated using (true) with check (true);

alter table if exists webhook_subscriptions enable row level security;
drop policy if exists webhook_subscriptions_no_anon_access on webhook_subscriptions;
create policy webhook_subscriptions_no_anon_access on webhook_subscriptions for all to anon using (false) with check (false);
drop policy if exists webhook_subscriptions_authenticated_full_access on webhook_subscriptions;
create policy webhook_subscriptions_authenticated_full_access on webhook_subscriptions for all to authenticated using (true) with check (true);

alter table if exists webhook_deliveries enable row level security;
drop policy if exists webhook_deliveries_no_anon_access on webhook_deliveries;
create policy webhook_deliveries_no_anon_access on webhook_deliveries for all to anon using (false) with check (false);
drop policy if exists webhook_deliveries_authenticated_full_access on webhook_deliveries;
create policy webhook_deliveries_authenticated_full_access on webhook_deliveries for all to authenticated using (true) with check (true);

alter table if exists vendor_product_mappings enable row level security;
drop policy if exists vendor_product_mappings_no_anon_access on vendor_product_mappings;
create policy vendor_product_mappings_no_anon_access on vendor_product_mappings for all to anon using (false) with check (false);
drop policy if exists vendor_product_mappings_authenticated_full_access on vendor_product_mappings;
create policy vendor_product_mappings_authenticated_full_access on vendor_product_mappings for all to authenticated using (true) with check (true);

alter table if exists provisioning_orders enable row level security;
drop policy if exists provisioning_orders_no_anon_access on provisioning_orders;
create policy provisioning_orders_no_anon_access on provisioning_orders for all to anon using (false) with check (false);
drop policy if exists provisioning_orders_authenticated_full_access on provisioning_orders;
create policy provisioning_orders_authenticated_full_access on provisioning_orders for all to authenticated using (true) with check (true);

alter table if exists reconciliation_runs enable row level security;
drop policy if exists reconciliation_runs_no_anon_access on reconciliation_runs;
create policy reconciliation_runs_no_anon_access on reconciliation_runs for all to anon using (false) with check (false);
drop policy if exists reconciliation_runs_authenticated_full_access on reconciliation_runs;
create policy reconciliation_runs_authenticated_full_access on reconciliation_runs for all to authenticated using (true) with check (true);

alter table if exists apn_profiles enable row level security;
drop policy if exists apn_profiles_no_anon_access on apn_profiles;
create policy apn_profiles_no_anon_access on apn_profiles for all to anon using (false) with check (false);
drop policy if exists apn_profiles_authenticated_full_access on apn_profiles;
create policy apn_profiles_authenticated_full_access on apn_profiles for all to authenticated using (true) with check (true);

alter table if exists roaming_profiles enable row level security;
drop policy if exists roaming_profiles_no_anon_access on roaming_profiles;
create policy roaming_profiles_no_anon_access on roaming_profiles for all to anon using (false) with check (false);
drop policy if exists roaming_profiles_authenticated_full_access on roaming_profiles;
create policy roaming_profiles_authenticated_full_access on roaming_profiles for all to authenticated using (true) with check (true);

alter table if exists profile_versions enable row level security;
drop policy if exists profile_versions_no_anon_access on profile_versions;
create policy profile_versions_no_anon_access on profile_versions for all to anon using (false) with check (false);
drop policy if exists profile_versions_authenticated_full_access on profile_versions;
create policy profile_versions_authenticated_full_access on profile_versions for all to authenticated using (true) with check (true);

alter table if exists profile_change_requests enable row level security;
drop policy if exists profile_change_requests_no_anon_access on profile_change_requests;
create policy profile_change_requests_no_anon_access on profile_change_requests for all to anon using (false) with check (false);
drop policy if exists profile_change_requests_authenticated_full_access on profile_change_requests;
create policy profile_change_requests_authenticated_full_access on profile_change_requests for all to authenticated using (true) with check (true);

alter table if exists billing_config enable row level security;
drop policy if exists billing_config_no_anon_access on billing_config;
create policy billing_config_no_anon_access on billing_config for all to anon using (false) with check (false);
drop policy if exists billing_config_authenticated_full_access on billing_config;
create policy billing_config_authenticated_full_access on billing_config for all to authenticated using (true) with check (true);

alter table if exists dunning_policies enable row level security;
drop policy if exists dunning_policies_no_anon_access on dunning_policies;
create policy dunning_policies_no_anon_access on dunning_policies for all to anon using (false) with check (false);
drop policy if exists dunning_policies_authenticated_full_access on dunning_policies;
create policy dunning_policies_authenticated_full_access on dunning_policies for all to authenticated using (true) with check (true);

alter table if exists control_policies enable row level security;
drop policy if exists control_policies_no_anon_access on control_policies;
create policy control_policies_no_anon_access on control_policies for all to anon using (false) with check (false);
drop policy if exists control_policies_authenticated_full_access on control_policies;
create policy control_policies_authenticated_full_access on control_policies for all to authenticated using (true) with check (true);

alter table if exists late_fee_rules enable row level security;
drop policy if exists late_fee_rules_no_anon_access on late_fee_rules;
create policy late_fee_rules_no_anon_access on late_fee_rules for all to anon using (false) with check (false);
drop policy if exists late_fee_rules_authenticated_full_access on late_fee_rules;
create policy late_fee_rules_authenticated_full_access on late_fee_rules for all to authenticated using (true) with check (true);
