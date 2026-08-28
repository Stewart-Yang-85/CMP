# Alert Type Catalog

**Feature**: `iot-cmp-reseller`  
**Status**: V1.1 clarification  
**Scope**: `alerts.alert_type`, `GET /v1/alerts*`, internal `createAlert()`, and `events.event_type = ALERT_TRIGGERED`

This document is the canonical catalog for CMP alert types. `alerts` stores operational alert state, while `events` stores the corresponding event stream. When a new alert row is created, the system SHOULD emit `ALERT_TRIGGERED` with the alert context.

Rule enablement, thresholds, suppression, and delivery channels are defined separately in [alert-rule-config.md](./alert-rule-config.md). Alert configuration supports `PLATFORM`, `RESELLER`, and `ENTERPRISE` scopes.

## General Rules

### Severity

| Severity | Meaning | Response expectation |
|----------|---------|----------------------|
| `P0` | Critical | Immediate incident response |
| `P1` | High | Operational priority; data path or connectivity risk |
| `P2` | Medium | Business risk; reseller/customer operations should review |
| `P3` | Low | Health signal / optimization item |

### Status

| Status | Meaning |
|--------|---------|
| `OPEN` | Active/unacknowledged alert |
| `ACKED` | Manually acknowledged |
| `RESOLVED` | No longer active / closed |
| `SUPPRESSED` | Temporarily muted by rule or policy |

### Scope

V1.1 catalog alert rows are normally reseller-scoped and SHOULD set `reseller_id` when the alert belongs to a reseller. Enterprise-level and SIM-level alerts SHOULD also set `customer_id` (`enterpriseId` in APIs). SIM-level alerts SHOULD set `sim_id`; list APIs MAY join `sims.iccid` for display. Future platform-level system alerts MAY use `reseller_id = null`.

### Deduplication And Suppression

`createAlert()` MUST avoid creating duplicate noisy rows. Current reseller-scoped deduplication key:

```text
reseller_id + alert_type + window_start + sim_id
```

If `reseller_id` or `sim_id` is absent, the dedupe key uses `IS NULL` semantics for that dimension. When a matching row exists, the system updates the existing row (`status=OPEN`, `last_seen_at`, `current_value`, `metadata`, etc.) instead of inserting a new row.

**`ALERT_MERGED` / audit `ALERT_MERGE`** are emitted only when the merge is **material**: `status` changes and/or `current_value` changes. Routine refreshes that only bump `last_seen_at` / `window_end` (same OPEN status and same metric) MUST NOT write a new `events` row.

Optional suppression windows MAY skip a repeated alert for the same scope + subject + alert type while `suppressed_until` or the configured suppress interval is still active.

### Event Emission

When a new alert row is created, the system SHOULD emit:

```text
events.event_type = ALERT_TRIGGERED
```

The event scope MUST use `events.enterprise_id` / `events.reseller_id` columns. Alert payload SHOULD include `alertId`, `alertType`, `severity`, `customerId`, `simId`, `threshold`, `currentValue`, `windowStart`, and `windowEnd` when available.

## Alert Types

### `POOL_USAGE_HIGH`

Product package in-profile usage has consumed more than the configured percentage of the applicable quota.

| Attribute | Value |
|-----------|-------|
| Default severity | `P2` |
| Scope | Package-level; `customer_id` set, `sim_id` set only for per-SIM `ONE_TIME` alerts |
| Data source | Prefer current-period `usage_package_daily_summary.in_profile_mb`; when historical rows have not been rated/backfilled, fallback to in-profile `rating_results` classifications (`IN_PACKAGE`, covered `OVERAGE`, `TIERED_VOLUME`), then usage aggregation plus active subscriptions |
| Trigger | `usedMb / applicableQuotaMb * 100 >= thresholdValue` |
| Threshold | Percentage, `threshold_unit=PERCENT`; default seed is `80` |
| `current_value` | Current usage ratio percentage |
| Suggested metadata | `message`, `packageId`, `pricePlanId`, `pricePlanType`, `simId`, `quotaMb`, `usedMb`, `usageRatio`, `thresholdPercent`, `tierIndex`, `tierLimitMb` |

Price plan semantics:

- `ONE_TIME`: evaluate each subscribed SIM independently against `quotaMb`.
- `SIM_DEPENDENT_BUNDLE`: evaluate the package pool; quota is `perSimQuotaMb * activeSimCount`.
- `FIXED_BUNDLE`: evaluate the package pool against `totalQuotaMb`.
- `TIERED_PRICING` (`TIERED_VOLUME_PRICING` internally): evaluate package cumulative in-profile usage against each tier upper bound; crossing `threshold%` of a tier emits an alert for that tier.

Operational meaning: a package or pool is nearing or exceeding expected quota consumption. Operators should check top SIMs, recent usage spikes, package allocation, and whether throttling, upsell, or customer notification is required.

### `OUT_OF_PROFILE_SURGE`

Product package out-of-profile usage has consumed more than the configured percentage of the applicable quota in the current billing period.

| Attribute | Value |
|-----------|-------|
| Default severity | `P2` |
| Scope | Package-level; `customer_id` set, `sim_id` set only for per-SIM `ONE_TIME` alerts |
| Data source | Current-period `usage_package_daily_summary.out_of_profile_mb` |
| Trigger | `outOfProfileMb / applicableQuotaMb * 100 >= thresholdValue` |
| Threshold | Percentage, `threshold_unit=PERCENT`; default seed is `20` |
| `current_value` | Current out-of-profile usage ratio percentage |
| Suggested metadata | `message`, `packageId`, `pricePlanId`, `pricePlanType`, `simId`, `quotaMb`, `outOfProfileMb`, `usageRatio`, `thresholdPercent`, `tierIndex`, `tierLimitMb`, `periodStart`, `periodEnd` |

Price plan semantics mirror `POOL_USAGE_HIGH`, but use `out_of_profile_mb`: `ONE_TIME` is evaluated per SIM/subscription, `SIM_DEPENDENT_BUNDLE` and `FIXED_BUNDLE` are evaluated at package-pool level, and `TIERED_PRICING` emits one alert per crossed tier threshold. Fallback packages and zero-quota/tier-zero plans are skipped because there is no meaningful percentage denominator.

Operational meaning: a package or pool is accumulating materially high out-of-profile usage. Check roaming profile coverage, fallback package mappings, unexpected visited networks, top SIMs, and whether the customer needs a package/profile adjustment.

### `SILENT_SIM`

SIM has remained `DEACTIVATED` longer than the configured threshold after being sold or assigned, indicating it is not creating active service revenue.

| Attribute | Value |
|-----------|-------|
| Default severity | `P3` |
| Scope | SIM-level (`customer_id` and `sim_id` set) |
| Data source | SIM status and latest status-change timestamp (`last_status_change_at`, with fallback to other available SIM timestamps) |
| Trigger | `status = DEACTIVATED` and deactivated duration is older than the configured cutoff |
| Threshold | Deactivated duration in hours; default seed is `4320` (about 180 days / 6 months) |
| `current_value` | Current deactivated duration in hours |
| Suggested metadata | `message`, `status`, `deactivatedSince`, `inactiveHours` |

Operational meaning: a sold or allocated SIM has stayed deactivated for too long and is not producing active service revenue. Check customer rollout progress, whether the SIM should be reactivated, reclaimed, replaced, or moved to a different commercial workflow.

### `UNEXPECTED_ROAMING`

SIM has out-of-profile roaming usage in the current billing period that reaches or exceeds a configured absolute MB threshold (default **20 MB**).

| Attribute | Value |
|-----------|-------|
| Default severity | `P1` |
| Scope | SIM-level (`customer_id` and `sim_id` set) |
| Data source | Current-period `usage_package_daily_summary.out_of_profile_mb`; optional `visited_mccmnc` for metadata |
| Trigger | Current-period SIM `out_of_profile_mb >= threshold` (absolute volume) |
| Threshold | Absolute data volume; default seed `threshold_value=20`, `threshold_unit=MB` (KB/GB also accepted and converted to MB for comparison) |
| `current_value` | Current-period out-of-profile MB for the SIM |
| Suggested metadata | `message`, `outOfProfileMb`, `thresholdMb`, `thresholdUnit`, `packageIds`, `pricePlanIds`, `usageDays`, `visitedMccMncs` |

Operational meaning: the SIM is consuming meaningful data on a network that the subscribed product package does not cover. Check CoveredNetworkProfile/RoamingProfile coverage, customer travel pattern, package fit, OOP cost exposure, and whether the customer should switch package or add coverage.

### `CDR_DELAY`

CDR files received through a reseller-scoped upstream integration have not been ingested within the configured delay threshold.

| Attribute | Value |
|-----------|-------|
| Default severity | `P1` |
| Scope | Reseller-level (`reseller_id` set, `customer_id = null`, `sim_id = null`) |
| Data source | `cdr_files` plus early `cdr_file_sim_refs` extracted from the received file |
| Trigger | `received_at <= now - cdrDelayHours`, `ingested_at IS NULL`, and the file can be associated with a reseller integration or indexed ICCID references |
| Threshold | CDR delay threshold in hours |
| `current_value` | Number of delayed CDR files for the reseller |
| Suggested metadata | `message`, `delayedFiles`, `cdrFileIds`, `affectedIccidCount`, `sampleIccids`, `supplierIds`, `operatorIds`, `thresholdUnit` |

Operational meaning: the reseller's rating/billing data may be incomplete because one or more received CDR files are waiting too long for ingestion. Check the reseller integration endpoint/SFTP inbox, parser mapping for the `supplierId + operatorId` pair, ingestion workers, queue backlog, and DB write failures.

### `UPSTREAM_DISCONNECT`

CMP cannot reach an active reseller-scoped upstream integration after repeated token API probes.

| Attribute | Value |
|-----------|-------|
| Default severity | `P1` |
| Scope | Reseller-level (`reseller_id` set; `customer_id` and `sim_id` null) |
| Data source | `upstream_integrations` and `upstream_integration_health_checks` |
| Trigger | Active `upstream_integrations(reseller_id, supplier_id, operator_id)` token probe status is `DISCONNECTED` and consecutive failures reach threshold |
| Threshold | Consecutive token probe failures; default `3 ATTEMPTS` |
| `current_value` | Consecutive failed token probe count |
| Suggested metadata | `message`, `integrationId`, `supplierId`, `operatorId`, `probeApi`, `failureCount`, `lastSuccessAt`, `lastFailureAt`, `lastErrorCode`, `lastErrorMessage`, `thresholdUnit` |

Operational meaning: CMP may be unable to provision, diagnose, synchronize, or receive reliable upstream status for the reseller's supplier/operator integration. Check the token/login endpoint, endpoint URL, credentials, network path, supplier maintenance window, timeout/retry policy, and whether the probe worker is writing health rows correctly.

### `WEBHOOK_DELIVERY_FAILED`

Outbound webhook delivery exhausted retry attempts and requires operational attention. This alert is created inline by the webhook delivery service, not by `runAlertEvaluation()`.

| Attribute | Value |
|-----------|-------|
| Default severity | `P2` |
| Scope | Usually reseller/customer integration scope; `reseller_id` MUST be set when known |
| Data source | Webhook delivery/retry subsystem |
| Trigger | `webhook_deliveries` starts with `attempt=1`; failed deliveries are retried by worker when `status=PENDING` and `next_retry_at <= now`; when a failed retry makes `nextAttempt > maxAttempts`, delivery is marked `FAILED` and this alert is created |
| Threshold | Configured retry attempt threshold; default `3 ATTEMPTS` |
| `current_value` | Failed attempt number |
| Suggested metadata | `message`, `webhookId`, `deliveryId`, `eventId`, `url`, `responseCode`, `responseBody`, `maxAttempts`, `thresholdUnit` |

Operational meaning: an integration endpoint may be down, misconfigured, rejecting signatures, returning HTTP errors, or timing out. Check the delivery record, endpoint URL, TLS, response code/body, signing secret, retry schedule, and whether manual retry is required.

## OpenAPI Alignment Notes

OpenAPI alert type enums MUST include all alert types in this catalog, including `WEBHOOK_DELIVERY_FAILED`.

`GET /v1/alerts`, `GET /v1/alerts/summary`, and `GET /v1/alerts/trends` SHOULD use this catalog for validation and documentation. If new alert types are added, update this file, OpenAPI enums, alerting service validation, and any dashboard/notification templates together.
