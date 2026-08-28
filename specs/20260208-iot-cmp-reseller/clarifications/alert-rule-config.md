# Alert Rule Configuration

**Feature**: `iot-cmp-reseller`  
**Status**: V1.1 clarification  
**Scope**: alert enablement, thresholds, severity, suppression, and delivery configuration

This document defines how CMP alert rules are configured. It complements [alert-type-catalog.md](./alert-type-catalog.md), which defines the meaning of each `alertType`.

## Goals

Alert rules MUST be configurable at multiple business scopes:

1. **PLATFORM** — platform default applied when no reseller/enterprise override exists.
2. **RESELLER** — reseller-specific default applied to all enterprises under that reseller.
3. **ENTERPRISE** — enterprise-specific override for one enterprise under one reseller.

The system SHOULD NOT require SIM-level rule configuration in V1.1. SIMs are alert trigger subjects, not rule configuration subjects.

## Logical Configuration Tables

The system treats alert configuration as multiple logical configuration tables:

- One **PLATFORM default configuration table**
- One independent **RESELLER configuration table** per reseller
- One **ENTERPRISE override configuration table** per enterprise under a reseller

V1.1 Phase 44 represents these logical tables with an ABC object model:

- **A. `alert_type_catalog`**: one row per implemented `alertType`; defines allowed configuration scopes, default severity/threshold/window/suppression/delivery, display text, and whether the type is enabled.
- **B. `alert_config_profiles`**: one configuration table object per PLATFORM / RESELLER / ENTERPRISE scope identity. A profile has `ACTIVE` / `INACTIVE` status and version/audit metadata.
- **C. `alert_config_items`**: one rule item per `(config_profile_id, alert_type)` containing enabled state, severity, threshold, window, suppression, and delivery settings.

Each item represents one alert rule entry under one profile:

```text
(config_profile_id, alert_type) -> rule config
```

All items under the same profile form one logical configuration table. The profile row carries the scope identity.

Examples:

```text
PLATFORM table:
  alert_config_profiles(scope_type=PLATFORM, status=ACTIVE)
    -> alert_config_items(POOL_USAGE_HIGH)
    -> alert_config_items(SILENT_SIM)

RESELLER R1 table:
  alert_config_profiles(scope_type=RESELLER, reseller_id=R1, status=ACTIVE)
    -> alert_config_items(POOL_USAGE_HIGH)
    -> alert_config_items(WEBHOOK_DELIVERY_FAILED)

ENTERPRISE E1 table under R1:
  alert_config_profiles(scope_type=ENTERPRISE, reseller_id=R1, enterprise_id=E1, status=ACTIVE)
    -> alert_config_items(POOL_USAGE_HIGH)
    -> alert_config_items(SILENT_SIM)
```

When an alert candidate is evaluated, the engine MUST automatically load the effective logical configuration table according to the candidate's `resellerId` and optional `enterpriseId`.

## Scope Model

`scope_type` MUST be one of:

| scope_type | reseller_id | enterprise_id | Meaning |
|------------|-------------|---------------|---------|
| `PLATFORM` | `NULL` | `NULL` | Global default rule configuration |
| `RESELLER` | required | `NULL` | Reseller-level default |
| `ENTERPRISE` | required | required | Enterprise-level override under a reseller |

Rules:

- `PLATFORM` rows are maintained by platform admins only.
- `RESELLER` rows are maintained by platform admins or the owning reseller.
- `ENTERPRISE` rows are maintained by platform admins or the owning reseller; customer self-service MAY be added later for a safe subset.
- `ENTERPRISE.enterprise_id` MUST belong to `RESELLER.reseller_id`.
- At most one `ACTIVE` profile may exist for the same PLATFORM / RESELLER / ENTERPRISE scope identity.
- At most one item may exist for the same `(config_profile_id, alert_type)`.
- An item write MUST validate `alert_type_catalog.allowed_scope_types`; for example, `CDR_DELAY` and `WEBHOOK_DELIVERY_FAILED` are not enterprise-configurable in V1.1.

## Resolution Order

When evaluating an alert for a reseller and optional enterprise, the system MUST resolve configuration in this order:

1. `ENTERPRISE` active profile item for `(reseller_id, enterprise_id, alert_type)`
2. `RESELLER` active profile item for `(reseller_id, alert_type)`
3. `PLATFORM` active profile item for `(alert_type)`
4. Built-in fallback, only when no DB config exists

The first matching config wins. A disabled config at a more specific scope MUST stop evaluation for that alert type, even if broader scopes are enabled.

Example:

```text
PLATFORM  POOL_USAGE_HIGH enabled=true threshold=80 PERCENT
RESELLER  R1 POOL_USAGE_HIGH enabled=true threshold=75 PERCENT
ENTERPRISE R1 E1 POOL_USAGE_HIGH enabled=false
```

Evaluation:

- Enterprise `E1` under `R1`: disabled, no alert.
- Enterprise `E2` under `R1`: threshold `75%`.
- Enterprise under other reseller: platform threshold `80%`, unless that reseller has its own override.

## Physical Tables

Table names:

```text
alert_type_catalog
alert_config_profiles
alert_config_items
```

`alert_type_catalog` columns:

| Column | Type | Required | Meaning |
|--------|------|----------|---------|
| `alert_type` | enum | yes | Implemented alert type from [alert-type-catalog.md](./alert-type-catalog.md) |
| `enabled` | boolean | yes | Whether this alert type is active at this scope |
| `allowed_scope_types` | text[] | yes | Which scopes can configure this alert type |
| `default_severity` | enum | yes | Default severity when alert fires |
| `default_threshold_value` | numeric | conditional | Default numeric threshold when applicable |
| `default_threshold_unit` | text | conditional | Unit for default threshold |
| `default_window_minutes` | integer | no | Default evaluation window |
| `default_suppress_minutes` | integer | yes | Default suppression interval |
| `default_delivery_channels` | text[] | yes | Default `PORTAL`, `WEBHOOK` channels |
| `default_delivery_targets` | jsonb | no | Default channel targets and routing details |
| `default_threshold_config` | jsonb | no | Extension for compound thresholds |
| `display_name` | text | yes | UI label |
| `description` | text | no | Explanation |
| `sort_order` | integer | yes | Swagger/UI ordering hint |

`alert_config_profiles` columns:

| Column | Type | Required | Meaning |
|--------|------|----------|---------|
| `config_profile_id` | uuid | yes | Primary key |
| `scope_type` | text | yes | `PLATFORM` / `RESELLER` / `ENTERPRISE` |
| `reseller_id` | uuid | conditional | Required for RESELLER/ENTERPRISE |
| `enterprise_id` | uuid | conditional | Required for ENTERPRISE |
| `status` | text | yes | `ACTIVE` / `INACTIVE` |
| `name` | text | no | Display name |
| `description` | text | no | Explanation |
| `version` | integer | yes | Incremented on update |
| `created_by` / `updated_by` | uuid | no | Actor metadata |
| `created_at` | timestamptz | yes | Creation time |
| `updated_at` | timestamptz | yes | Last update time |

`alert_config_items` columns:

| Column | Type | Required | Meaning |
|--------|------|----------|---------|
| `config_item_id` | uuid | yes | Primary key |
| `config_profile_id` | uuid | yes | Parent profile |
| `alert_type` | enum | yes | Alert type from catalog |
| `enabled` | boolean | yes | Whether this alert type is active for the profile |
| `severity` | text | yes | Severity when alert fires |
| `threshold_value` | numeric | conditional | Numeric threshold when applicable |
| `threshold_unit` | text | conditional | Unit for `threshold_value` |
| `window_minutes` | integer | no | Evaluation window override |
| `threshold_config` | jsonb | no | Extension for compound thresholds |
| `suppress_minutes` | integer | yes | Minimum interval before repeated alerts are emitted |
| `delivery_channels` | text[] | yes | `PORTAL`, `WEBHOOK` |
| `delivery_targets` | jsonb | no | Channel targets and routing details |
| `version` | integer | yes | Incremented on update |
| `created_at` | timestamptz | yes | Creation time |
| `updated_at` | timestamptz | yes | Last update time |

Recommended constraints:

```sql
CHECK (scope_type IN ('PLATFORM', 'RESELLER', 'ENTERPRISE'))
CHECK (status IN ('ACTIVE', 'INACTIVE'))
CHECK (severity IN ('P0', 'P1', 'P2', 'P3'))
CHECK (threshold_unit IS NULL OR threshold_unit IN ('PERCENT', 'KB', 'MB', 'GB', 'HOURS', 'MINUTES', 'ATTEMPTS', 'COUNT'))
CHECK (suppress_minutes >= 0)
CHECK (delivery_channels <@ ARRAY['PORTAL','WEBHOOK'])
```

Recommended unique indexes:

```sql
UNIQUE (status) WHERE scope_type = 'PLATFORM' AND status = 'ACTIVE'
UNIQUE (reseller_id) WHERE scope_type = 'RESELLER' AND status = 'ACTIVE'
UNIQUE (enterprise_id) WHERE scope_type = 'ENTERPRISE' AND status = 'ACTIVE'
UNIQUE (config_profile_id, alert_type)
```

## Threshold Units

Thresholds MUST be typed. Do not interpret a bare number without a unit.

| Unit | Meaning | Examples |
|------|---------|----------|
| `PERCENT` | Percentage ratio | `80` for 80% pool usage |
| `KB` / `MB` / `GB` | Data volume | SIM surge threshold |
| `HOURS` / `MINUTES` | Duration | silent SIM, CDR delay |
| `ATTEMPTS` | Retry/failure attempts | upstream disconnect token probes, webhook delivery failures |
| `COUNT` | Count of items/events | delayed CDR files or future count rules |

For rules without a threshold, `threshold_value` and `threshold_unit` SHOULD be `NULL`; `enabled`, `severity`, `suppress_minutes`, and delivery settings still apply.

## Alert Type Defaults

These are recommended platform defaults. Actual values may be seeded by migration and adjusted by operations.

| alertType | scope default | threshold_value | threshold_unit | severity | Notes |
|-----------|---------------|-----------------|----------------|----------|-------|
| `POOL_USAGE_HIGH` | PLATFORM/RESELLER/ENTERPRISE | `80` | `PERCENT` | `P2` | Use percentage of configured pool/quota, not an absolute 100GB-style value |
| `OUT_OF_PROFILE_SURGE` | PLATFORM/RESELLER/ENTERPRISE | `20` | `PERCENT` | `P2` | Use percentage of the subscribed package quota, based on current-period out-of-profile usage |
| `SILENT_SIM` | PLATFORM/RESELLER/ENTERPRISE | `4320` | `HOURS` | `P3` | Long-running `DEACTIVATED` SIM; default is about 180 days / 6 months |
| `UNEXPECTED_ROAMING` | PLATFORM/RESELLER/ENTERPRISE | `20` | `MB` | `P1` | Current-period SIM-level OOP roaming volume; absolute MB threshold (default 20 MB) |
| `CDR_DELAY` | PLATFORM/RESELLER | configurable | `HOURS` | `P1` | Reseller-scoped CDR ingestion delay; uses `cdr_files` plus `cdr_file_sim_refs` |
| `UPSTREAM_DISCONNECT` | PLATFORM/RESELLER | `3` | `ATTEMPTS` | `P1` | Reseller-scoped upstream integration token probe; not SIM-level |
| `WEBHOOK_DELIVERY_FAILED` | PLATFORM/RESELLER | configurable | `ATTEMPTS` | `P2` | Example: alert after 3 failed attempts |

## Delivery Configuration

Rule configuration MUST include alert delivery preferences.

`delivery_channels` SHOULD support:

| Channel | Meaning |
|---------|---------|
| `PORTAL` | Show in portal/in-app notification center |
| `WEBHOOK` | Deliver to configured outbound webhook |

`delivery_targets` MAY include:

```json
{
  "roles": ["reseller_admin", "reseller_ops"],
  "emails": ["ops@example.com"],
  "webhookIds": ["uuid"],
  "notifyCustomer": false
}
```

Rules:

- `PORTAL` SHOULD be the default channel.
- Webhook targets SHOULD reference managed webhook subscriptions, not raw URLs.
- Enterprise-level configs MAY choose whether to notify customer users, reseller users, or both.

## Effective Resolution

Each reseller and enterprise can have an independent active `alert_config_profiles` row and one `alert_config_items` row per alert type.

For alert types that allow `ENTERPRISE` scope (`POOL_USAGE_HIGH`, `OUT_OF_PROFILE_SURGE`, `SILENT_SIM`, `UNEXPECTED_ROAMING`), the evaluator resolves configuration in this order:

```text
ENTERPRISE item -> RESELLER item -> PLATFORM item -> built-in fallback
```

For reseller-level alert types (`CDR_DELAY`, `UPSTREAM_DISCONNECT`, `WEBHOOK_DELIVERY_FAILED`), alerts are not bound to enterprise/SIM and resolve configuration in this order:

```text
RESELLER item -> PLATFORM item -> built-in fallback
```

If a more specific item exists with `enabled=false`, it explicitly disables that alert at that scope and blocks fallback to broader RESELLER/PLATFORM configuration.

## API Shape

V1.1 Fastify canonical runtime uses the **Alert Configurations** API as the current configuration surface. These endpoints manage the ABC model directly:

```text
GET /v1/alert-types
PATCH /v1/alert-types/{alertType}
```

The `alert-types` endpoints manage the `alert_type_catalog` directory and are **platform admin only**. Single-item reads use `GET /v1/alert-types?alertType=...`; Swagger UI does not expose a duplicate `GET /v1/alert-types/{alertType}` operation. For `PATCH /v1/alert-types/{alertType}`, the path segment is a compatibility placeholder and the submitted item is selected from request body `alertType`.

```text
GET /v1/alert-config-profiles
POST /v1/alert-config-profiles?scopeType=&resellerId=&enterpriseId=
GET /v1/alert-config-profiles/{profileId}
PUT /v1/alert-config-profiles/{profileId}?scopeType=&resellerId=&enterpriseId=
GET /v1/alert-config-profiles/effective?alertType=&resellerId=&enterpriseId=
```

The profile endpoints are available only to **platform admins** and **reseller admins**. Reseller admins are scoped to their own reseller and child enterprises. Enterprise/customer tokens MUST NOT access any Alert Configurations endpoint, including catalog, profile list/detail, full-profile create/update, or effective diagnostics.

The canonical management surface treats one profile and all of its items as a single configuration document:

- `GET /v1/alert-config-profiles` lists profile headers from `alert_config_profiles`.
- `GET /v1/alert-config-profiles/{profileId}` returns the profile header plus all `alert_config_items` under it.
- `POST /v1/alert-config-profiles` creates the profile and all allowed items. `scopeType`, `resellerId`, and `enterpriseId` are query parameters; the request body contains only profile metadata and `items`.
- `PUT /v1/alert-config-profiles/{profileId}` fully replaces/upserts the profile and all allowed items. Query scope identity must match the existing profile; the request body contains only profile metadata and `items`.
- `GET /v1/alert-config-profiles/effective` remains a read-only diagnostic endpoint for final effective configuration.

Item-level endpoints are removed from the canonical API surface:

```text
GET /v1/alert-config-profiles/{profileId}/items
PUT /v1/alert-config-profiles/{profileId}/items/{alertType}
PATCH /v1/alert-config-profiles/{profileId}/items/{alertType}
```

Because there are no legacy clients to preserve, backend routes and OpenAPI entries for these item-level endpoints MUST be removed rather than kept for compatibility. Clients MUST use the profile-level full-document create/update APIs.

Legacy single-table endpoints from Phase 43 are deprecated after Phase 44 and MUST NOT be treated as the canonical Swagger UI surface for new work:

```text
GET /v1/alert-configs?scopeType=&resellerId=&enterpriseId=&alertType=&page=&pageSize=
POST /v1/alert-configs
PATCH /v1/alert-configs/{configId}
GET /v1/alert-configs/effective?alertType=&resellerId=&enterpriseId=
```

Example full profile request:

```text
POST /v1/alert-config-profiles?scopeType=RESELLER&resellerId=0925eb82-53ef-4522-8d81-07ebaa17d819
```

```json
{
  "name": "Reseller default alert profile",
  "status": "ACTIVE",
  "items": [
    {
      "alertType": "POOL_USAGE_HIGH",
      "enabled": true,
      "severity": "P2",
      "thresholdValue": 80,
      "thresholdUnit": "PERCENT",
      "windowMinutes": 60,
      "suppressMinutes": 60,
      "deliveryChannels": ["PORTAL", "WEBHOOK"],
      "deliveryTargets": {
        "roles": ["reseller_admin"],
        "webhookIds": ["uuid"]
      }
    }
  ]
}
```

Later APIs MAY split delivery config into a separate resource if routing becomes complex.

## Evaluation Contract

Alert evaluation jobs MUST:

1. Identify `reseller_id` and optional `enterprise_id` for the candidate alert.
2. Resolve the effective rule config using the resolution order above.
3. Stop if `enabled=false`.
4. Validate threshold according to `threshold_unit`.
5. Apply `suppress_minutes`.
6. Create or update `alerts`.
7. Emit `ALERT_TRIGGERED` when a new alert row is created.
8. Dispatch notifications according to `delivery_channels` / `delivery_targets` where the channel is implemented.

## Migration Notes

Alert evaluation retains built-in defaults as the last fallback. Phase 44 introduced ABC configuration with a compatibility path from `alert_rule_configs`:

1. Add `alert_type_catalog`, `alert_config_profiles`, and `alert_config_items`.
2. Seed catalog defaults and one active PLATFORM profile with seven default items.
3. Migrate existing `alert_rule_configs` RESELLER/ENTERPRISE rows into profiles/items where present.
4. Resolve `runAlertEvaluation()` and webhook retry configuration from ABC profiles/items, then built-in fallback.
5. Remove item-level Alert Configurations routes from the canonical API surface; new UI, Swagger, tests, and documentation should use profile-level full-document endpoints.

During transition, existing alert rows remain valid. Configuration affects new evaluations only.
