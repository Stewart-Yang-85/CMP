-- =============================================================================
-- CMP manual test seed (Supabase SQL Editor)
-- -----------------------------------------------------------------------------
-- Enterprise (tenant_id): 2a02a58e-6343-4744-b3db-b059ba20debd
-- ICCIDs: 89860099000000100011, 89860099000000100012, 89860099000000100013
--
-- Creates: supplier + operator, PUBLISHED roaming profile snapshot,
--          price plan snapshot, commercial / control / carrier modules,
--          package + PUBLISHED package version, SIM rows.
--
-- Prerequisites: migrations through carrier deprecation (operators without
-- legacy carriers), price plan snapshot (package_versions.price_plan_id), and
-- roaming snapshot lifecycle (`roaming_profiles.status` = DRAFT|PUBLISHED|DEPRECATED;
-- `mccmnc_list` is jsonb: array of `{ "mcc", "mnc", "ratePerMb" }` after migration 20260418200002).
--
-- Enterprise is a tenants row (tenant_type=ENTERPRISE, parent_id = reseller tenants.tenant_id).
-- Set v_reseller_id_override to your row in public.resellers when the enterprise already belongs to that reseller.
--
-- Re-runs: uses fixed UUIDs and ON CONFLICT upserts where possible. If your DB
-- already owns the same primary keys with different semantics, delete those
-- rows first or change the UUID constants below.
--
-- After run: use RAISE NOTICE output (or the constants) in Swagger for
-- packageVersionId, pricePlanId, module IDs. Subscription E2E can use another
-- enterprise; this seed is for catalog + SIM fixtures on the tenant above.
-- =============================================================================

begin;

do $seed$
declare
  -- When NOT NULL, use this public.resellers.id (script sets reseller_tenant_id := resellers.tenant_id).
  -- Set to NULL to create and use the built-in seed reseller (a1111111-… / b2222222-…).
  v_reseller_id_override uuid := '23a796a6-069e-4ff0-8e8f-35ffed64881d';

  v_ent_tenant       uuid := '2a02a58e-6343-4744-b3db-b059ba20debd';
  v_reseller_tenant  uuid := 'a1111111-1111-4111-8111-111111111111';
  v_reseller_id      uuid := 'b2222222-2222-4222-8222-222222222222';
  v_supplier_id      uuid := 'd4444444-4444-4444-8444-444444444444';
  v_operator_id      uuid := 'e5555555-5555-4555-8555-555555555555';
  v_bo_tata_id       uuid := '1413a2b1-8888-4e5a-9a66-949ca1f56d72';
  v_roam_profile_id  uuid := 'f6666666-6666-4666-8666-666666666666';
  v_commercial_id    uuid := 'b8888888-8888-4888-8888-888888888888';
  v_control_id       uuid := 'c9999999-9999-4999-9999-999999999999';
  v_carrier_mod_id   uuid := 'd0a0a0a0-0a0a-4a0a-8a0a-0a0a0a0a0a0a';
  v_price_plan_id    uuid := 'e1b1b1b1-1b1b-4b1b-8b1b-1b1b1b1b1b1b';
  v_package_id       uuid := 'f2c2c2c2-2c2c-4c2c-8c2c-2c2c2c2c2c2c';
  v_pkg_version_id   uuid := 'a3d3d3d3-3d3d-4d3d-8d3d-3d3d3d3d3d3d';
  v_sim1             uuid := 'b4e4e4e4-4e4e-4e4e-8e4e-4e4e4e4e4e4e';
  v_sim2             uuid := 'c5f5f5f5-5f5f-4f5f-8f5f-5f5f5f5f5f5f';
  v_sim3             uuid := 'd6a6a6a6-6a6a-4a6a-8a6a-6a6a6a6a6a6a';

  v_payg             jsonb;
  v_carrier_cfg      jsonb;
  v_roaming_json     jsonb;
  v_reseller_resolved uuid;
  v_reseller_tenant_id uuid;
begin
  v_payg := jsonb_build_object(
    'zones', jsonb_build_object(
      'china', jsonb_build_object(
        'mccmnc', jsonb_build_array('460-*'),
        'ratePerMb', 0.015
      )
    )
  );

  v_carrier_cfg := jsonb_build_object(
    'supplierId', v_supplier_id::text,
    'operatorId', v_operator_id::text,
    'apn', 'internet',
    'rat', '4G',
    'roamingProfileId', v_roam_profile_id::text
  );

  v_roaming_json := jsonb_build_object(
    'type', 'MCCMNC_ALLOWLIST',
    'mccmnc', jsonb_build_array('460-00', '460-01'),
    'rat', '4G',
    'profileId', v_roam_profile_id::text
  );

  -- business_operators seed (TATA) from V004 — keep stable MCC/MNC
  insert into business_operators (operator_id, mcc, mnc, name)
  values (v_bo_tata_id, '204', '08', 'TATA')
  on conflict (operator_id) do nothing;

  insert into suppliers (supplier_id, name, status)
  values (v_supplier_id, 'CMP Seed Supplier', 'ACTIVE')
  on conflict (supplier_id) do nothing;

  insert into operators (operator_id, supplier_id, business_operator_id, name, status)
  values (v_operator_id, v_supplier_id, v_bo_tata_id, 'CMP Seed Operator', 'ACTIVE')
  on conflict (operator_id) do nothing;

  if v_reseller_id_override is not null then
    select r.id, r.tenant_id
      into v_reseller_resolved, v_reseller_tenant_id
    from resellers r
    where r.id = v_reseller_id_override
       or r.tenant_id = v_reseller_id_override
    limit 1;
    if v_reseller_resolved is null then
      raise exception 'resellers row not found for id/tenant_id %; fix v_reseller_id_override', v_reseller_id_override;
    end if;
  else
    insert into tenants (tenant_id, tenant_type, parent_id, name, enterprise_status)
    values (v_reseller_tenant, 'RESELLER', null, 'CMP Seed Reseller', null)
    on conflict (tenant_id) do nothing;

    insert into resellers (id, tenant_id, name, status)
    values (v_reseller_id, v_reseller_tenant, 'CMP Seed Reseller', 'ACTIVE')
    on conflict (tenant_id) do nothing;

    select r.id into v_reseller_resolved from resellers r where r.tenant_id = v_reseller_tenant limit 1;
    if v_reseller_resolved is null then
      raise exception 'reseller row missing for tenant_id % (seed reseller tenant)', v_reseller_tenant;
    end if;

    select r.tenant_id into v_reseller_tenant_id from resellers r where r.id = v_reseller_resolved limit 1;
    if v_reseller_tenant_id is null then
      raise exception 'resellers.tenant_id missing for id %', v_reseller_resolved;
    end if;
  end if;

  insert into tenants (tenant_id, tenant_type, parent_id, name, enterprise_status)
  values (v_ent_tenant, 'ENTERPRISE', v_reseller_tenant_id, 'CMP Seed Enterprise', 'ACTIVE')
  on conflict (tenant_id) do update
    set parent_id = excluded.parent_id,
        name = excluded.name,
        enterprise_status = excluded.enterprise_status,
        updated_at = current_timestamp;

  insert into price_plans (
    price_plan_id,
    enterprise_id,
    reseller_id,
    name,
    type,
    service_type,
    currency,
    billing_cycle_type,
    first_cycle_proration,
    source_price_plan_id,
    version,
    status,
    effective_from,
    monthly_fee,
    deactivated_monthly_fee,
    per_sim_quota_mb,
    payg_rates,
    is_current,
    updated_at
  )
  values (
    v_price_plan_id,
    v_ent_tenant,
    v_reseller_tenant_id,
    'CMP Seed SIM-Dependent Plan',
    'SIM_DEPENDENT_BUNDLE',
    'DATA',
    'CNY',
    'CALENDAR_MONTH',
    'NONE',
    null,
    1,
    'PUBLISHED',
    date_trunc('month', current_timestamp at time zone 'utc'),
    9.99,
    0,
    1024,
    v_payg,
    true,
    current_timestamp
  )
  on conflict (price_plan_id) do update set
    reseller_id = excluded.reseller_id,
    name = excluded.name,
    type = excluded.type,
    service_type = excluded.service_type,
    currency = excluded.currency,
    monthly_fee = excluded.monthly_fee,
    per_sim_quota_mb = excluded.per_sim_quota_mb,
    payg_rates = excluded.payg_rates,
    is_current = excluded.is_current,
    status = excluded.status,
    updated_at = current_timestamp;

  insert into commercial_terms_modules (
    commercial_terms_id,
    enterprise_id,
    name,
    commercial_terms,
    updated_at
  )
  values (
    v_commercial_id,
    v_ent_tenant,
    'Seed commercial terms',
    jsonb_build_object(
      'commitmentPeriodMonths', 12,
      'testPeriodDays', 0
    ),
    current_timestamp
  )
  on conflict (commercial_terms_id) do update set
    enterprise_id = excluded.enterprise_id,
    name = excluded.name,
    commercial_terms = excluded.commercial_terms,
    updated_at = current_timestamp;

  insert into control_policy_modules (
    control_policy_id,
    enterprise_id,
    name,
    control_policy,
    updated_at
  )
  values (
    v_control_id,
    v_ent_tenant,
    'Seed control policy',
    jsonb_build_object(
      'enabled', true,
      'cutoffThresholdMb', 10240
    ),
    current_timestamp
  )
  on conflict (control_policy_id) do update set
    enterprise_id = excluded.enterprise_id,
    name = excluded.name,
    control_policy = excluded.control_policy,
    updated_at = current_timestamp;

  insert into roaming_profiles (
    roaming_profile_id,
    name,
    mccmnc_list,
    supplier_id,
    operator_id,
    status,
    published_at,
    effective_from,
    updated_at
  )
  values (
    v_roam_profile_id,
    'CMP Seed Roaming',
    jsonb_build_array(
      jsonb_build_object('mcc', '460', 'mnc', '00', 'ratePerMb', 0.0015),
      jsonb_build_object('mcc', '460', 'mnc', '01', 'ratePerMb', 0.0015)
    ),
    v_supplier_id,
    v_operator_id,
    'PUBLISHED',
    current_timestamp,
    date_trunc('month', current_timestamp at time zone 'utc'),
    current_timestamp
  )
  on conflict (roaming_profile_id) do update set
    name = excluded.name,
    mccmnc_list = excluded.mccmnc_list,
    supplier_id = excluded.supplier_id,
    operator_id = excluded.operator_id,
    status = excluded.status,
    published_at = excluded.published_at,
    effective_from = excluded.effective_from,
    updated_at = current_timestamp;

  insert into carrier_service_modules (
    carrier_service_id,
    enterprise_id,
    name,
    supplier_id,
    operator_id,
    apn_profile_id,
    roaming_profile_id,
    rat,
    status,
    published_at,
    effective_from,
    updated_at
  )
  values (
    v_carrier_mod_id,
    v_ent_tenant,
    'CMP Seed Carrier',
    v_supplier_id,
    v_operator_id,
    null,
    v_roam_profile_id,
    '4G',
    'PUBLISHED',
    current_timestamp,
    date_trunc('month', current_timestamp at time zone 'utc'),
    current_timestamp
  )
  on conflict (carrier_service_id) do update set
    enterprise_id = excluded.enterprise_id,
    name = excluded.name,
    supplier_id = excluded.supplier_id,
    operator_id = excluded.operator_id,
    apn_profile_id = excluded.apn_profile_id,
    roaming_profile_id = excluded.roaming_profile_id,
    rat = excluded.rat,
    status = excluded.status,
    published_at = excluded.published_at,
    effective_from = excluded.effective_from,
    updated_at = current_timestamp;

  insert into packages (package_id, enterprise_id, name)
  values (v_package_id, v_ent_tenant, 'CMP Seed Subscription Package')
  on conflict (package_id) do update set name = excluded.name;

  insert into package_versions (
    package_version_id,
    package_id,
    version,
    status,
    effective_from,
    supplier_id,
    operator_id,
    service_type,
    apn,
    roaming_profile,
    carrier_service_id,
    carrier_service_config,
    control_policy_id,
    control_policy,
    commercial_terms_id,
    commercial_terms,
    price_plan_id
  )
  values (
    v_pkg_version_id,
    v_package_id,
    1,
    'PUBLISHED',
    current_timestamp,
    v_supplier_id,
    v_operator_id,
    'DATA',
    'internet',
    v_roaming_json,
    v_carrier_mod_id,
    v_carrier_cfg,
    v_control_id,
    jsonb_build_object('enabled', true, 'cutoffThresholdMb', 10240),
    v_commercial_id,
    jsonb_build_object('commitmentPeriodMonths', 12, 'testPeriodDays', 0),
    v_price_plan_id
  )
  on conflict (package_version_id) do update set
    status = excluded.status,
    effective_from = excluded.effective_from,
    supplier_id = excluded.supplier_id,
    operator_id = excluded.operator_id,
    apn = excluded.apn,
    roaming_profile = excluded.roaming_profile,
    carrier_service_id = excluded.carrier_service_id,
    carrier_service_config = excluded.carrier_service_config,
    control_policy_id = excluded.control_policy_id,
    control_policy = excluded.control_policy,
    commercial_terms_id = excluded.commercial_terms_id,
    commercial_terms = excluded.commercial_terms,
    price_plan_id = excluded.price_plan_id;

  insert into sims (sim_id, iccid, primary_imsi, supplier_id, enterprise_id, reseller_id, operator_id, status, apn)
  values
    (v_sim1, '89860099000000100011', '460001234567890', v_supplier_id, v_ent_tenant, v_reseller_tenant_id, v_operator_id, 'TEST_READY', 'internet'),
    (v_sim2, '89860099000000100012', '460001234567891', v_supplier_id, v_ent_tenant, v_reseller_tenant_id, v_operator_id, 'TEST_READY', 'internet'),
    (v_sim3, '89860099000000100013', '460001234567892', v_supplier_id, v_ent_tenant, v_reseller_tenant_id, v_operator_id, 'TEST_READY', 'internet')
  on conflict (iccid) do update set
    primary_imsi = excluded.primary_imsi,
    supplier_id = excluded.supplier_id,
    enterprise_id = excluded.enterprise_id,
    reseller_id = excluded.reseller_id,
    operator_id = excluded.operator_id,
    status = excluded.status,
    apn = excluded.apn;

  raise notice '--- CMP seed applied ---';
  raise notice 'enterpriseId (tenants.tenant_id): %', v_ent_tenant;
  raise notice 'resellerTenantId (tenants.parent_id for enterprise): %', v_reseller_tenant_id;
  raise notice 'resellerId (resellers.id, create_customer RPC only): %', v_reseller_resolved;
  raise notice 'supplierId: %', v_supplier_id;
  raise notice 'operatorId: %', v_operator_id;
  raise notice 'roamingProfileId (roaming_profiles snapshot): %', v_roam_profile_id;
  raise notice 'pricePlanId: %', v_price_plan_id;
  raise notice 'commercialTermsId: %', v_commercial_id;
  raise notice 'controlPolicyId: %', v_control_id;
  raise notice 'carrierServiceModuleId: %', v_carrier_mod_id;
  raise notice 'packageId: %', v_package_id;
  raise notice 'packageVersionId: %', v_pkg_version_id;
  raise notice 'ICCIDs: 89860099000000100011, 89860099000000100012, 89860099000000100013';
end
$seed$;

commit;
