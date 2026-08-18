# Rating Scenario Catalog

**Feature**: `iot-cmp-reseller`  
**Scope**: Rating Rollup coverage for `usage_daily_summary` -> `rating_results` -> `usage_package_daily_summary`  
**Purpose**: Define the scenario catalog before expanding seed data, verification scripts, and automated tests.

## 1. Coverage Principle

This catalog intentionally avoids a full Cartesian product of every dimension. The goal is to cover every meaningful rating behavior with a small, maintainable scenario set:

- Cover each `PricePlan.type` primary behavior.
- Cover all usage classifications: in-profile, out-of-profile, and unclassified.
- Cover subscription selection and filtering: `MAIN`, `ADD_ON`, `ACTIVE`, and non-active states.
- Cover SIM lifecycle status effects at rating input time.
- Cover fallback package attribution when no active subscription can rate the usage.
- Add targeted cross-dimension scenarios where business behavior changes, instead of multiplying every dimension by every other dimension.

## 2. Rating Dimensions

### 2.1 Price Plan Type

- `ONE_TIME`
- `FIXED_BUNDLE`
- `SIM_DEPENDENT_BUNDLE`
- `TIERED_PRICING`
- `RatingFallbackPackage`, represented by `default_fallback_package_mappings` and a fallback `package_id`

### 2.2 Subscription Type

- `MAIN`
- `ADD_ON`

### 2.3 Subscription State

- `ACTIVE`
- Non-active representative states:
  - `EXPIRED`
  - `CANCELLED`
  - `SUSPENDED`
  - `SCHEDULED`

### 2.4 SIM Status

- `ACTIVATED` or `ACTIVE`, depending on the database enum value used by the current environment
- `DEACTIVE`
- `TEST_READY`
- `INVENTORY`
- `RETIRED`

### 2.5 Usage Classification

- `IN_PROFILE`
- `OUT_OF_PROFILE`
- `UNCLASSIFIED`

## 3. Common Assertions

Every scenario should define expected values for:

- `rating_results.matched_subscription_id`
- `rating_results.matched_package_id`
- `rating_results.matched_price_plan_id`
- `rating_results.classification`
- `rating_results.charged_mb`
- `rating_results.amount`
- `usage_daily_summary.in_profile_mb`
- `usage_daily_summary.out_of_profile_mb`
- `usage_daily_summary.unclassified_mb`
- `usage_package_daily_summary.subscription_id`
- `usage_package_daily_summary.package_id`
- `usage_package_daily_summary.price_plan_type`
- `usage_package_daily_summary.in_profile_mb`
- `usage_package_daily_summary.out_of_profile_mb`
- `usage_package_daily_summary.unclassified_mb`
- `usage_package_daily_summary.uplink_mb`
- `usage_package_daily_summary.downlink_mb`
- `usage_package_daily_summary.total_mb`

`usage_package_daily_summary.uplink_mb`, `downlink_mb`, and `total_mb` are SIM-day totals copied from `usage_daily_summary`. They are not package-attributed usage. If one SIM-day produces multiple package summary rows, these three fields may repeat on each row for the same SIM-day.

## 4. Current Verified Baseline

These scenarios are already manually verified and should be preserved as regression seeds.

### R-BL-001: ONE_TIME in-profile high usage

- Price plan: `ONE_TIME`
- Subscription type: `MAIN`
- Subscription state: `ACTIVE`
- SIM status: active
- Usage: in-profile
- Expected:
  - Usage is attributed to the ONE_TIME package.
  - `in_profile_mb` is greater than 80% of quota.
  - `out_of_profile_mb = 0`
  - `unclassified_mb = 0`
  - Package summary row exists.

### R-BL-002: FIXED_BUNDLE pooled in-profile high usage, SIM B

- Price plan: `FIXED_BUNDLE`
- Subscription type: `MAIN`
- Subscription state: `ACTIVE`
- SIM status: active
- Usage: in-profile
- Expected:
  - Usage is attributed to the shared FIXED_BUNDLE package.
  - This SIM contributes to pool consumption.
  - Package-level pool total across paired SIMs is greater than 80% of quota.

### R-BL-003: FIXED_BUNDLE pooled in-profile high usage, SIM C

- Price plan: `FIXED_BUNDLE`
- Subscription type: `MAIN`
- Subscription state: `ACTIVE`
- SIM status: active
- Usage: in-profile
- Expected:
  - Usage is attributed to the same FIXED_BUNDLE package as R-BL-002.
  - This SIM contributes to pool consumption.
  - Package-level pool total across paired SIMs is greater than 80% of quota.

### R-BL-004: Active subscription out-of-profile high usage

- Price plan: existing subscribed package, currently represented by `SIM_DEPENDENT_BUNDLE`
- Subscription type: `MAIN`
- Subscription state: `ACTIVE`
- SIM status: active
- Usage: out-of-profile
- Expected:
  - Usage is attributed to the active subscribed package.
  - `out_of_profile_mb` is greater than 20% of quota.
  - `in_profile_mb = 0`
  - Package summary row exists.

### R-BL-005: No active subscription fallback package

- Price plan: fallback package
- Subscription type: none
- Subscription state: none
- SIM status: active or inventory, depending on seed availability
- Usage: fallback-attributed
- Expected:
  - Usage is attributed to `default_fallback_package_mappings.package_id`.
  - `matched_subscription_id = null`
  - Package summary row exists for fallback package.

## 5. Expanded Scenario Catalog

### 5.1 Price Plan Primary Behavior

#### R-PP-001: ONE_TIME main active in-profile

- Price plan: `ONE_TIME`
- Subscription type: `MAIN`
- Subscription state: `ACTIVE`
- SIM status: active
- Usage: in-profile
- Expected:
  - Matched package is the ONE_TIME package.
  - Matched price plan type is `ONE_TIME`.
  - Usage goes to `in_profile_mb`.
  - Amount is zero unless the one-time fee is intentionally modeled in rating output.

#### R-PP-002: ONE_TIME main active out-of-profile

- Price plan: `ONE_TIME`
- Subscription type: `MAIN`
- Subscription state: `ACTIVE`
- SIM status: active
- Usage: out-of-profile
- Expected:
  - Matched package is the ONE_TIME package when an OOP tariff/rule exists.
  - Usage goes to `out_of_profile_mb`.
  - Amount follows the configured OOP rule.

#### R-PP-003: ONE_TIME main active unclassified

- Price plan: `ONE_TIME`
- Subscription type: `MAIN`
- Subscription state: `ACTIVE`
- SIM status: active
- Usage: unclassified
- Expected:
  - No in-profile or OOP profile matches.
  - Usage goes to `unclassified_mb`.
  - Package attribution follows current rating fallback behavior for unmatched usage.

#### R-PP-004: FIXED_BUNDLE main active in-profile

- Price plan: `FIXED_BUNDLE`
- Subscription type: `MAIN`
- Subscription state: `ACTIVE`
- SIM status: active
- Usage: in-profile
- Expected:
  - Usage is attributed to the shared fixed bundle package.
  - Usage contributes to package-level pool consumption.
  - Package summary row exists at SIM-day-package grain.

#### R-PP-005: FIXED_BUNDLE main active out-of-profile

- Price plan: `FIXED_BUNDLE`
- Subscription type: `MAIN`
- Subscription state: `ACTIVE`
- SIM status: active
- Usage: out-of-profile
- Expected:
  - Usage is attributed to the fixed bundle package if OOP tariff/rule exists.
  - Usage goes to `out_of_profile_mb`.
  - Amount follows configured OOP pricing.

#### R-PP-006: FIXED_BUNDLE main active unclassified

- Price plan: `FIXED_BUNDLE`
- Subscription type: `MAIN`
- Subscription state: `ACTIVE`
- SIM status: active
- Usage: unclassified
- Expected:
  - Usage goes to `unclassified_mb`.
  - No false in-profile classification occurs.

#### R-PP-007: SIM_DEPENDENT_BUNDLE main active in-profile

- Price plan: `SIM_DEPENDENT_BUNDLE`
- Subscription type: `MAIN`
- Subscription state: `ACTIVE`
- SIM status: active
- Usage: in-profile
- Expected:
  - Usage is attributed to the SIM-dependent package.
  - Usage is evaluated against per-SIM quota, not a shared pool.

#### R-PP-008: SIM_DEPENDENT_BUNDLE main active out-of-profile

- Price plan: `SIM_DEPENDENT_BUNDLE`
- Subscription type: `MAIN`
- Subscription state: `ACTIVE`
- SIM status: active
- Usage: out-of-profile
- Expected:
  - Usage goes to `out_of_profile_mb`.
  - Amount follows configured OOP pricing.

#### R-PP-009: SIM_DEPENDENT_BUNDLE main active unclassified

- Price plan: `SIM_DEPENDENT_BUNDLE`
- Subscription type: `MAIN`
- Subscription state: `ACTIVE`
- SIM status: active
- Usage: unclassified
- Expected:
  - Usage goes to `unclassified_mb`.
  - No package quota consumption is counted as in-profile.

#### R-PP-010: TIERED_PRICING main active in-profile

- Price plan: `TIERED_PRICING`
- Subscription type: `MAIN`
- Subscription state: `ACTIVE`
- SIM status: active
- Usage: in-profile
- Expected:
  - Usage is attributed to the tiered pricing package.
  - Tier selection is based on configured tier thresholds.
  - Amount reflects matched tier pricing.

#### R-PP-011: TIERED_PRICING main active out-of-profile

- Price plan: `TIERED_PRICING`
- Subscription type: `MAIN`
- Subscription state: `ACTIVE`
- SIM status: active
- Usage: out-of-profile
- Expected:
  - Usage goes to `out_of_profile_mb` when OOP rule exists.
  - Amount follows OOP or tiered OOP pricing, depending on configured model.

#### R-PP-012: TIERED_PRICING main active unclassified

- Price plan: `TIERED_PRICING`
- Subscription type: `MAIN`
- Subscription state: `ACTIVE`
- SIM status: active
- Usage: unclassified
- Expected:
  - Usage goes to `unclassified_mb`.
  - No tier amount is charged unless unclassified usage is explicitly billable.

#### R-PP-013: ONE_TIME main quota exhausted to fallback

- Price plan: `ONE_TIME`
- Subscription type: `MAIN`
- Subscription state: `ACTIVE`
- SIM status: active
- Usage: in-profile total exceeds `quotaMb`
- Expected:
  - Usage within quota is attributed to the ONE_TIME package as `IN_PACKAGE`.
  - Excess usage is not charged by ONE_TIME `overageRatePerMb`.
  - Excess usage is routed to Default Fallback Package; if fallback cannot find an OOP rate, the excess is `UNCLASSIFIED`.

#### R-PP-014: ONE_TIME add-on quota exhausted to main

- Price plan: `ONE_TIME`
- Subscription type: `MAIN_AND_ADD_ON`
- Subscription state: `ACTIVE`
- SIM status: active
- Usage: in-profile total exceeds ADD_ON `quotaMb`
- Expected:
  - ADD_ON is selected first and rates usage within its quota.
  - Excess usage is attempted against MAIN before fallback.
  - If MAIN can cover the visited network, excess usage remains in-profile under MAIN.

#### R-PP-015: TIERED_PRICING main highest tier exhausted to fallback

- Price plan: `TIERED_PRICING`
- Subscription type: `MAIN`
- Subscription state: `ACTIVE`
- SIM status: active
- Usage: in-profile total exceeds highest `toMb`
- Expected:
  - Usage up to the highest tier is attributed as `TIERED_VOLUME`.
  - Usage above the highest tier is not extended at the last tier's `ratePerMb`.
  - Excess usage is routed to Default Fallback Package; if fallback cannot find an OOP rate, the excess is `UNCLASSIFIED`.

### 5.2 Fallback Package Behavior

#### R-FB-001: No subscription, fallback mapping exists

- Subscription: none
- Fallback mapping: active
- Usage: any valid usage
- Expected:
  - Usage is attributed to fallback package.
  - `matched_subscription_id = null`
  - `matched_package_id = fallback package_id`

#### R-FB-002: Only non-active subscription, fallback mapping exists

- Subscription type: `MAIN`
- Subscription state: non-active
- Fallback mapping: active
- Usage: any valid usage
- Expected:
  - Non-active subscription is ignored.
  - Usage is attributed to fallback package.

#### R-FB-003: No subscription, no fallback mapping

- Subscription: none
- Fallback mapping: none or inactive
- Usage: any valid usage
- Expected:
  - Usage is not attributed to a package.
  - `matched_package_id = null`
  - Verify whether `rating_results` is emitted as unclassified or skipped according to current rating rules.

#### R-FB-004: Fallback package with in-profile classification

- Subscription: none
- Fallback mapping: active
- Fallback package has covered profile
- Usage: in-profile for fallback package
- Expected:
  - Usage is attributed to fallback package.
  - Usage goes to `in_profile_mb`.

#### R-FB-005: Fallback package with out-of-profile classification

- Subscription: none
- Fallback mapping: active
- Usage: out-of-profile for fallback package
- Expected:
  - Usage is attributed to fallback package.
  - Usage goes to `out_of_profile_mb`.

#### R-FB-006: Fallback package with unclassified usage

- Subscription: none
- Fallback mapping: active
- Usage: unclassified
- Expected:
  - Usage is attributed to fallback package if fallback package is chosen before classification.
  - Usage goes to `unclassified_mb`.

### 5.3 MAIN and ADD_ON Selection

#### R-SUB-001: MAIN only active

- Subscription type: `MAIN`
- Subscription state: `ACTIVE`
- Usage: in-profile
- Expected:
  - MAIN subscription is selected.
  - Usage is attributed to MAIN package.

#### R-SUB-002: ADD_ON only active

- Subscription type: `ADD_ON`
- Subscription state: `ACTIVE`
- Usage: in-profile
- Expected:
  - ADD_ON subscription is selected.
  - Usage is attributed to ADD_ON package.

#### R-SUB-003: MAIN and ADD_ON active, usage matches ADD_ON

- Subscription types: `MAIN` and `ADD_ON`
- Subscription states: both `ACTIVE`
- Usage: matches ADD_ON package profile
- Expected:
  - ADD_ON subscription is selected when its package profile is the better match.
  - MAIN package is not charged for that usage row.

#### R-SUB-004: MAIN and ADD_ON active, usage matches MAIN only

- Subscription types: `MAIN` and `ADD_ON`
- Subscription states: both `ACTIVE`
- Usage: matches MAIN package profile, not ADD_ON
- Expected:
  - MAIN subscription is selected.
  - ADD_ON package is not charged for that usage row.

#### R-SUB-005: MAIN active, ADD_ON non-active

- Subscription types: `MAIN` and `ADD_ON`
- MAIN state: `ACTIVE`
- ADD_ON state: non-active
- Usage: would otherwise match ADD_ON
- Expected:
  - Non-active ADD_ON is ignored.
  - MAIN is selected if MAIN can rate the usage.
  - Otherwise fallback/unclassified behavior applies.

#### R-SUB-006: MAIN non-active, ADD_ON active

- Subscription types: `MAIN` and `ADD_ON`
- MAIN state: non-active
- ADD_ON state: `ACTIVE`
- Usage: matches ADD_ON
- Expected:
  - Non-active MAIN is ignored.
  - ADD_ON is selected.

### 5.4 Subscription State Filtering

#### R-STATE-001: ACTIVE subscription rates usage

- Subscription state: `ACTIVE`
- Usage: in-profile
- Expected:
  - Subscription is eligible.
  - Usage is attributed to its package.

#### R-STATE-002: EXPIRED subscription ignored

- Subscription state: `EXPIRED`
- Usage: would match package if active
- Expected:
  - Subscription is ignored.
  - Fallback applies if configured.

#### R-STATE-003: CANCELLED subscription ignored

- Subscription state: `CANCELLED`
- Usage: would match package if active
- Expected:
  - Subscription is ignored.
  - Fallback applies if configured.

#### R-STATE-004: SUSPENDED subscription ignored or explicitly handled

- Subscription state: `SUSPENDED`
- Usage: would match package if active
- Expected:
  - Expected behavior must match rating policy.
  - If only `ACTIVE` is billable, subscription is ignored.
  - If suspended usage is still billable, this scenario should assert package attribution.

#### R-STATE-005: SCHEDULED subscription not yet active

- Subscription state: `SCHEDULED`
- Usage date: before effective start
- Expected:
  - Subscription is ignored.
  - Fallback applies if configured.

### 5.5 SIM Status Coverage

These scenarios verify whether SIM lifecycle status affects rating eligibility. If rating policy is "rate any usage that has reached `usage_daily_summary`", all statuses should still produce rating outputs. If rating policy filters by SIM status, these expectations must be updated before implementation.

#### R-SIM-001: Active SIM rates usage

- SIM status: active
- Subscription state: `ACTIVE`
- Usage: in-profile
- Expected:
  - Usage is rated normally.

#### R-SIM-002: TEST_READY SIM with usage

- SIM status: `TEST_READY`
- Subscription state: `ACTIVE`
- Usage: in-profile
- Expected:
  - Usage is rated if test usage is billable or operationally tracked.
  - Otherwise verify explicit skip behavior.

#### R-SIM-003: DEACTIVE SIM with historical usage

- SIM status: `DEACTIVE`
- Subscription state: `ACTIVE` during usage date or historical rating window
- Usage: in-profile
- Expected:
  - Historical usage is rated if usage date falls within eligible subscription period.

#### R-SIM-004: INVENTORY SIM with usage

- SIM status: `INVENTORY`
- Subscription: none
- Usage: any
- Expected:
  - This is an anomaly case.
  - Fallback applies if configured, otherwise unclassified/no-package behavior is asserted.

#### R-SIM-005: RETIRED SIM with historical usage

- SIM status: `RETIRED`
- Subscription: historical or none
- Usage: historical usage
- Expected:
  - Historical usage should remain rateable if it belongs to the rating period.
  - New usage after retirement should be treated as anomaly input.

### 5.6 Usage Classification Cross-Checks

#### R-USAGE-001: Exact covered MCC-MNC in-profile

- Usage visited network: exact covered profile match
- Expected:
  - `classification = IN_PACKAGE` or equivalent in-profile classification.
  - `in_profile_mb > 0`

#### R-USAGE-002: MCC wildcard covered in-profile

- Usage visited network: covered by wildcard profile rule
- Expected:
  - Usage is in-profile.
  - Exact and wildcard matching order remains deterministic.

#### R-USAGE-003: Roaming OOP match

- Usage visited network: not covered, but matches OOP roaming tariff/rule
- Expected:
  - Usage is out-of-profile.
  - `out_of_profile_mb > 0`
  - Amount follows configured OOP rate.

#### R-USAGE-004: No covered or OOP rule

- Usage visited network: no matching covered profile and no matching OOP rule
- Expected:
  - Usage is unclassified.
  - `unclassified_mb > 0`

#### R-USAGE-005: Zero usage row

- Usage total: `0 MB`
- Expected:
  - No positive rating result is emitted, or emitted result has zero charged usage according to existing behavior.
  - No false alert candidate is created.

## 6. Recommended Automation Shape

Future seed and verification scripts should treat this file as the source scenario list and encode each scenario with a matching ID:

```js
{
  id: 'R-PP-004',
  pricePlanType: 'FIXED_BUNDLE',
  subscriptionType: 'MAIN',
  subscriptionState: 'ACTIVE',
  simStatus: 'ACTIVE',
  usageClass: 'IN_PROFILE',
  expects: {
    packageAttributed: true,
    fallbackAttributed: false,
    inProfileMb: '>0',
    outOfProfileMb: 0,
    unclassifiedMb: 0,
  },
}
```

The next implementation phase should create:

- A scenario seed catalog matching these IDs.
- A seed tool that is idempotent and can seed one scenario, one group, or all scenarios.
- A verification tool that reads `rating_results`, `usage_daily_summary`, and `usage_package_daily_summary` and asserts each scenario's expected outputs.

## 7. Phase 46 Runbook

This runbook validates the rating scenario matrix end-to-end. It is safe to run the read-only and dry-run steps without Supabase write credentials. Steps that use `--apply` require `SUPABASE_SERVICE_ROLE_KEY`.

### 7.1 Preconditions

- Use the Fastify/TypeScript runtime path: run `npm run build` before invoking tools that import compiled services from `dist/`.
- Configure `.env` with `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` for seed, cleanup, rollup, and DB assertions.
- Choose one billing period, for example `2026-06`, and use the same `--period` value for every command.

### 7.2 Recommended Sequence

1. Preview scenario data:

```powershell
node tools/seed_rating_scenarios.js --period 2026-06 --dry-run
node tools/seed_rating_scenarios.js --period 2026-06 --group fallback --dry-run
```

2. Apply scenario data:

```powershell
node tools/seed_rating_scenarios.js --period 2026-06 --apply
```

3. Trigger Rating Rollup and wait for derived rows:

```powershell
npm run build
node tools/run_rating_scenario_rollup.js --period 2026-06 --apply --json
```

4. Verify scenario outputs:

```powershell
node tools/verify_rating_scenarios.js --period 2026-06 --rating-results --usage-daily --package-summary
node tools/verify_rating_scenarios.js --period 2026-06 --group baseline --alert-candidates
```

5. Optional API spot check for an individual SIM:

```powershell
curl.exe -X GET "http://localhost:13080/v1/sims/<ICCID>/usage?startDate=2026-06-01&endDate=2026-06-30&page=1&pageSize=20" -H "accept: application/json" -H "X-API-Key: cmp-admin-key"
```

### 7.3 Cleanup / Reset

Use cleanup before reseeding a period or a subset of scenarios. Cleanup defaults to dry-run.

```powershell
node tools/seed_rating_scenarios.js --period 2026-06 --group fallback --cleanup --json
node tools/seed_rating_scenarios.js --period 2026-06 --group fallback --cleanup --apply
```

Shared RS46 package and price plan fixtures are not removed by default. To attempt deletion of unreferenced shared fixtures:

```powershell
node tools/seed_rating_scenarios.js --period 2026-06 --cleanup --include-shared-fixtures --json
```

### 7.4 Acceptance Commands

These commands are the Phase 46 smoke acceptance set:

```powershell
npm run build
npx vitest run tests/ratingScenarios.test.ts
node tools/verify_rating_scenarios.js --period 2026-06 --json
node tools/verify_rating_scenarios.js --period 2026-06 --group baseline --alert-candidates
```

After seed and rollup have been applied, run the strict DB assertions:

```powershell
node tools/verify_rating_scenarios.js --period 2026-06 --rating-results --usage-daily --package-summary --json
```

