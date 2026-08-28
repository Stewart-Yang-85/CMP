# Data Model: IoT CMP Reseller System

**Feature**: `iot-cmp-reseller` | **Date**: 2026-02-08（`public_infos` 2026-03-24；**Package 单表模型** 2026-04-20；**CoveredNetworkProfile** 2026-04-22 [Phase 30](./tasks.md#phase-30-covered-network) / [spec.md](./spec.md)） | **Spec**: [spec.md](./spec.md)

## 1. 概述

本文档定义 IoT CMP Reseller System 的完整数据模型，包括已有表结构、新增表/字段，以及各实体间的关系。数据库采用 **Supabase（PostgreSQL 15+）**，已有 18 个迁移文件定义了核心 Schema。

## 2. ENUM 类型

### 2.1 已有 ENUM（12 种）

| ENUM | 值 | 用途 |
|------|-----|------|
| `sim_status` | INVENTORY, TEST_READY, ACTIVATED, DEACTIVATED, RETIRED | SIM 主状态（稳态） |
| `lifecycle_sub_status` | normal, activating, activation_failed, deactivating, deactivation_failed, reactivating, reactivation_failed, retiring, retire_failed | SIM 过渡子状态（[V1.1] 须迁移扩展，见 spec US2） |
| `subscription_state` | PENDING, **PROVISIONING**, ACTIVE, CANCELLED, EXPIRED | 订阅状态（**PROVISIONING** = 上游开通 Job 进行中；失败时 **删除行**，不保留失败态枚举） |
| `job_status` | QUEUED, RUNNING, SUCCEEDED, FAILED, CANCELLED | 异步任务状态 |
| `bill_status` | GENERATED, PUBLISHED, PAID, OVERDUE, WRITTEN_OFF | 账单状态 |
| `service_type` | DATA, VOICE, SMS | 电信业务类型 |
| `billing_cycle_type` | CALENDAR_MONTH, CUSTOM_RANGE | 计费周期类型 |
| `first_cycle_proration` | NONE, DAILY_PRORATION | 首期分摊 |
| `price_plan_type` | ONE_TIME, SIM_DEPENDENT_BUNDLE, FIXED_BUNDLE, TIERED_PRICING | 资费计划类型 |
| `note_type` | CREDIT, DEBIT | 调账单类型 |
| `note_status` | DRAFT, APPROVED, APPLIED, CANCELLED | 调账单状态 |
| `subscription_kind` | MAIN, ADD_ON | 订阅种类 |
| `user_status` | ACTIVE, INACTIVE, LOCKED | 用户状态 |

> **变更说明**: `tenant_type` 和 `enterprise_status` ENUM 已移除，由独立表各自的 status 字段取代。

### 2.2 新增 ENUM（CMP.xlsx 对齐）

| ENUM | 值 | 用途 |
|------|-----|------|
| `reseller_status` | active, deactivated, suspended | 代理商状态 |
| `customer_status` | ACTIVE, INACTIVE, SUSPENDED | 客户（企业）状态（行政管控；overdue 移至 Dunning 层） |
| `operator_status` | active, deprecated, error | 运营商状态（含废弃工作流） |
| `sim_form_factor` | consumer_removable, industrial_removable, consumer_embedded, industrial_embedded | SIM 卡形态 |
| `cdr_method` | sftp, api | CDR 话单拉取方式 |
| `role_scope` | platform, reseller, customer | 角色适用范围 |
| `dunning_status` | NORMAL, OVERDUE_WARNING, SUSPENDED, SERVICE_INTERRUPTED | 信控状态 |
| `provisioning_status` | PROVISIONING_IN_PROGRESS, ACTIVE, PROVISIONING_FAILED, SCHEDULED_ON_SUPPLIER, SCHEDULED_LOCALLY | 开通同步状态 |
| `alert_type` | POOL_USAGE_HIGH, OUT_OF_PROFILE_SURGE, SILENT_SIM, UNEXPECTED_ROAMING, CDR_DELAY, UPSTREAM_DISCONNECT, WEBHOOK_DELIVERY_FAILED | 告警类型；真源见 [alert-type-catalog.md](./clarifications/alert-type-catalog.md) |
| `smdp_status` | active, deactivated, suspended | SM-DP+ 系统状态 |
| `smdp_environment` | test, production | SM-DP+ 系统环境 |
| `esim_form_factor` | esim_profile, other | eSIM 形态 |
| `smdp_profile_status` | created, downloaded, enabled, disabled, deleted | SM-DP+ Profile 远程状态 |

> **Alert rule config**：告警启用状态、阈值、抑制窗口与投递方式采用 `PLATFORM` / `RESELLER` / `ENTERPRISE` 三层配置模型；表设计与解析顺序见 [alert-rule-config.md](./clarifications/alert-rule-config.md)。

## 3. 实体关系图（ER Summary）

```
── 组织层 ──────────────────────────────────────────────────────

public_infos（3GPP 公开参考，仅辅助查询；与下方业务子图无连线、无 FK）
business_operators (business dictionary, 1 per PLMN)
         │
         │ 1:N  (同一字典运营商 MAY 经多个 supplier 销售)
         ▼
suppliers ──1:N──┐                      operators
    │            │                    (supplier_id + business_operator_id UNIQUE)
    │            ▼                          │
    │   upstream_integrations ◄──N:1────────┘
    │     (supplier_id + operators.operator_id UNIQUE)
    │
    └──1:N──> sim_cards ◄── operator_id ── operators
                  │
                  │ 1:N
                  ▼
          sim_state_history

    └──1:N──> esim_profiles ◄── operator_id ── operators
                  │
                  │ 1:N
                  ▼
          esim_state_history

resellers ──1:N──> customers
    │                  │
    │                  ├──1:N──> roaming_profiles ──1:N──> roaming_profile_entries
    │                  │                     │
    │                  │                     └── source_roaming_profile_id (self FK)
    │                  │
    │                  ├──1:N──> covered_network_profiles ──1:N──> covered_network_profile_entries
    │                  │                     │
    │                  │                     └── source_covered_network_profile_id (self FK)
    │                  │
    │                  ├──1:N──> price_plans (snapshots, **父表**；类型专有定价在 **1:1 子表**)
    │                  │                     │
    │                  │                     ├── source_price_plan_id (self FK)
    │                  │                     ├── covered_network_profile_id → covered_network_profiles（可空；**in-profile** 资费类型在发布/校验时必填，见 OpenAPI）
    │                  │                     └── 1:1 → price_plan_fixed_bundle | price_plan_sim_dependent_bundle
    │                  │                               | price_plan_one_time | price_plan_tiered_volume_pricing（**Phase 31**）
    │                  │                     （读宽表：**price_plans_expanded** 视图）
    │                  │
    │                  ├──1:N──> apn_profiles
    │                  │                     │
    │                  │                     └── source_apn_profile_id (self FK)
    │                  │
    │                  ├──1:N──> control_policy_modules（`control_policy` JSONB = 快照正文；**无**独立 throttling tiers 子表）
    │                  │
    │                  ├──1:N──> commercial_terms
    │                  │                     │
    │                  │                     └── source_commercial_terms_id (self FK)
    │                  │
    │                  ├──1:N──> carrier_services
    │                  │                     │
    │                  │           (apn_profile_id, roaming_profile_id)
    │                  │
    │                  ├──1:N──> packages（单表单实体：一行即一个可售产品包，绑定四模块；status DRAFT/PUBLISHED/DEPRECATED）
    │                  │              │
    │                  │              (carrier_service_id, price_plan_id, control_policy_id, commercial_terms_id)
    │                  │
    │                  ├──1:N──> subscriptions
    │                  │              │
    │                  │         (sim_id, package_id → packages)
    │                  │
    │                  ├──1:N──> bills ──1:N──> bill_line_items
    │                  │
    │                  ├──1:N──> adjustment_notes ──1:N──> adjustment_note_items
    │                  │
    │                  └──1:N──> dunning_records
    │
    └──1:N──> users

── 第三方系统 ─────────────────────────────────────────────────────

smdp_systems

── RBAC ────────────────────────────────────────────────────────

roles ──M:N──> role_permissions ◄──N:M── permissions
  │
  └──1:N──> users (role_id FK)

── SIM 四方归属链 ──────────────────────────────────────────────

sim_cards.supplier_id  ──FK──> suppliers
sim_cards.operator_id  ──FK──> operators
sim_cards.reseller_id  ──FK──> resellers
sim_cards.customer_id  ──FK──> customers (nullable)

esim_profiles.supplier_id  ──FK──> suppliers
esim_profiles.operator_id  ──FK──> operators
esim_profiles.smdp_system_id ──FK──> smdp_systems
esim_profiles.reseller_id  ──FK──> resellers
esim_profiles.customer_id  ──FK──> customers (nullable)

── 用量 ────────────────────────────────────────────────────────

sim_cards ──1:N──> usage_daily_summary
sim_cards ──1:N──> rating_results
rating_results ──derived──> usage_package_daily_summary
```

## 4. 已有表结构

### 4.1 组织与权限（CMP.xlsx 对齐：独立建表 + RBAC 三表）

#### `suppliers` — 供应商

| 列 | 类型 | 约束 | 说明 |
|----|------|------|------|
| id | uuid | PK, default gen_random_uuid() | 供应商 ID |
| name | text | NOT NULL, UNIQUE | 供应商名称 |
| status | text | NOT NULL, default 'active' | active / suspended |
| created_by | uuid | — | 创建者 |
| created_at | timestamptz | NOT NULL, default now() | 创建时间 |
| updated_at | timestamptz | NOT NULL, default now() | 更新时间 |

#### `public_infos` — 3GPP 公开运营商参考目录（辅助）

> **命名**：物理表为 `public.public_infos`；`public.carriers` 为 **兼容视图**（`carrier_id` ← `public_info_id`），见迁移 `20260311100004_sim_connectivity.sql`。数据**仅供查阅**，不参与计费/订阅等业务规则；**仅 platform_admin 可写**，其余角色只读（RLS + API 层，见 spec FR-054～FR-057、`contracts/public-info-api.md`）。**与 `business_operators`、`operators.operator_id` 业务链无任何外键或语义关联**（V1.1 须去除历史 `operators.carrier_id` → `public_infos` 的 FK，见 FR-057）。

| 列 | 类型 | 约束 | 说明 |
|----|------|------|------|
| public_info_id | uuid | PK, default gen_random_uuid() | 目录行 ID |
| mcc | char(3) | NOT NULL | 移动国家代码（E.212） |
| mnc | char(3) | NOT NULL | 移动网络代码 |
| name | text | — | 运营商公开名称（支持 API 侧 `ilike` 模糊查询） |
| country_name | text | — | 国家/地区名称（英文或展示用文本） |
| lte_bands | text | — | 频段说明（如 LTE 频段文本；未来可扩展 NR 列或 JSONB，由迁移单独立项） |
| | | UNIQUE(mcc, mnc) | PLMN 唯一约束 |

#### `business_operators` — 业务运营商字典

> **规范真源**：[clarifications/operator-identity-model.md](./clarifications/operator-identity-model.md)

| 列 | 类型 | 约束 | 说明 |
|----|------|------|------|
| operator_id | uuid | PK, default gen_random_uuid() | **字典 operator ID**；业务侧「这是哪家运营商」的稳定标识 |
| mcc | char(3) | NOT NULL | 移动国家代码 |
| mnc | char(3) | NOT NULL | 移动网络代码 |
| name | text | NOT NULL | 运营商名称 |

**商业语义**：一行 = 一个业务运营商（PLMN/品牌），**全局唯一**。**MUST NOT** 与 `public_infos` 关联（FR-057）。

**与 `operators` 的关系**：**1 : N**。同一 **`business_operators.operator_id`** **MAY** 在 **`operators`** 中出现多行（不同 **`supplier_id`**），表示「同一运营商经多个上游供应商渠道销售」。这在 V1.1 中为 **正常商业模式**。

#### `operators` — 供应商—运营商商业关联

> **规范真源**：[clarifications/operator-identity-model.md](./clarifications/operator-identity-model.md)

| 列 | 类型 | 约束 | 说明 |
|----|------|------|------|
| operator_id | uuid | PK, default gen_random_uuid() | **关联行 operator ID**；产品库 FK、SIM 归属、**`upstream_integrations`** 的真源 |
| supplier_id | uuid | NOT NULL, FK→suppliers | 供应商 |
| business_operator_id | uuid | NULLABLE, FK→business_operators | 业务运营商字典（与 `public_infos` 无关）；**V1.1 迁移 `T153` 后** `operators` **不再包含** `carrier_id` 列（已物理删除，见 tasks.md T153 硬性验收） |
| name | text | — | 运营商名称快照 |
| status | text | NOT NULL, default 'ACTIVE' | ACTIVE / SUSPENDED |
| created_at | timestamptz | NOT NULL, default now() | 创建时间 |
| updated_at | timestamptz | NOT NULL, default now() | 更新时间 |
| | | **UNIQUE(`supplier_id`, `business_operator_id`)** where `business_operator_id IS NOT NULL` | 同一供应商下，同一字典运营商至多一行 |

**命名要点（避免误解）**：

| 名称 | 物理列 | 用途 |
|------|--------|------|
| 字典 operator ID | `business_operators.operator_id` | API **读**路径 **`operatorId` SHOULD** 优先展示；Webhook URL **SHOULD** 使用 |
| 关联行 operator ID | `operators.operator_id` | **所有产品库表**持久化 FK；**`upstream_integrations.operator_id` MUST** 指向此列 |

#### API 字段 `operatorId`（跨模块）

对外 HTTP **统一字段名 `operatorId`**（**不**另设 `businessOperatorId`）：

| 方向 | 规则 |
|------|------|
| **写入** | 客户端 **MAY** 传字典 ID 或关联行 ID；服务端 **MUST** 解析为 **`operators.operator_id`** 后存库；**SHOULD** 配合 **`supplierId`** |
| **读出** | **`operatorId` SHOULD** 优先展示 **`business_operators.operator_id`**（若 `business_operator_id` 非空） |
| **解析顺序** | ① `operators.operator_id` + `supplier_id` → ② `operators.business_operator_id` + `supplier_id` |

适用：Carrier Service、APN/Roaming Profile、SIM 筛选、**`upstream_integrations`**、入站 Webhook 路径等。详见 [operator-identity-model.md](./clarifications/operator-identity-model.md)。

#### `upstream_integrations` — 上游集成配置（替代旧 `supplier_carriers`）

> **规范真源**：[clarifications/upstream-integration-config.md](./clarifications/upstream-integration-config.md)

| 列 | 类型 | 约束 | 说明 |
|----|------|------|------|
| integration_id | uuid | PK, default gen_random_uuid() | 集成 ID |
| supplier_id | uuid | NOT NULL, FK→suppliers | 供应商 |
| operator_id | uuid | NOT NULL, FK→**operators(operator_id)** | **关联行 PK**（**非** `business_operators.operator_id`） |
| adapter_type | text | NOT NULL | Vendor 实现（如 `wxzhonggeng`） |
| api_endpoint | text | — | 上游 base URL |
| api_key | text | — | 出站 API Key |
| api_secret_encrypted | bytea | — | 出站 API Secret（加密存储） |
| webhook_key | text | — | 入站 Webhook 验签密钥 |
| auth_type | text | — | `api_key` 或 `username_password` |
| username | text | — | 出站用户名（`username_password`） |
| password_encrypted | bytea | — | 出站密码（加密；`username_password`） |
| token_url | text | — | 登录/token 端点覆盖（可选） |
| cdr_enabled | boolean | NOT NULL, default false | 是否启用 CDR |
| cdr_method | cdr_method | — | CDR 拉取方式 sftp / api |
| cdr_endpoint | text | — | CDR 端点 |
| cdr_username | text | — | CDR 用户名 |
| cdr_password_encrypted | bytea | — | CDR 密码（加密存储） |
| cdr_path | text | — | CDR 文件路径 |
| cdr_file_pattern | text | — | CDR 文件名模式 |
| enabled | boolean | NOT NULL, default true | 是否启用 |
| config | jsonb | NOT NULL, default `{}` | 适配器技术参数（endpoint 路径等；**非**业务凭证） |
| deprecated_at | timestamptz | — | 软删时间（`status=DEPRECATED` 时） |
| deprecated_by | text | — | 软删操作者标识（可选） |
| deprecation_reason | text | — | 软删原因（可选） |
| created_by | uuid | — | 创建者 |
| created_at | timestamptz | NOT NULL, default now() | 创建时间 |
| updated_at | timestamptz | NOT NULL, default now() | 更新时间 |
| | | **UNIQUE(`supplier_id`, `operator_id`) WHERE `status IN ('ACTIVE','INACTIVE')`** | 每供应商—运营商仅允许一条“活跃/停用”配置；`DEPRECATED` 历史行可保留 |

**V1.1**：Vendor 适配器、Worker、入站 Webhook **MUST** 从此表加载凭证；**MUST NOT** 从 MVP `.env`（`WXZHONGGENG_*` 等）读取生产业务凭证。

**删除策略（V1.1）**：`DELETE /v1/upstream-integrations/{integrationId}` 采用**软删**，将行置为 `DEPRECATED` 且 `enabled=false`；历史行保留用于审计与回溯。

**凭证加密（V1.1）**：`api_secret_encrypted`（及推荐之 `webhook_key_encrypted`）为 **AES-256-GCM** 密文 BYTEA；密钥来自应用 env **`INTEGRATION_SECRET_KEY`**（非上游凭证）。见 [upstream-integration-config.md](./clarifications/upstream-integration-config.md) §9。

**`adapter_type`**：有限枚举（初值 **`wxzhonggeng`**）；代码 registry 映射至 Vendor 适配器实现。见同上 §10。

**入站 Webhook 目录与集成订阅（Phase 38 · 已迁移）**：

| 表 | 说明 |
|----|------|
| `upstream_inbound_webhook_events` | 平台级入站 **`event_key`** 目录（与出站 `webhook_subscriptions` / **FR-039** 分离） |
| `upstream_integration_webhook_subscriptions` | **`(integration_id, event_key, enabled)`** — 每条集成启用哪些入站通知 |

**WXZG 种子 `event_key`（`upstream_inbound_webhook_events`）**：`subscription`（Subscription；路径 `…/webhooks/wxzhonggeng/subscription`）、`update-location`（Update Location；路径 `…/webhooks/wxzhonggeng/update-location`）、`sim-status-changed`、`traffic-alert`。

**落库约定（`subscription`）**：受理后写入 **`events.event_type = SUBSCRIPTION`**、**`audit_logs.action = WX_WEBHOOK_SUBSCRIPTION`**（上游 `messageType` 如 `ProductChange` 保留在 `payload`）。

**落库约定（`update-location`）**：受理后写入 **`events.event_type = UPDATE_LOCATION`**；**`audit_logs.action`** 仍为 **`WX_WEBHOOK_SIM_ONLINE`**（内部审计码，与上游 `messageType` 可不一致）。

详见 [upstream-inbound-webhook-catalog.md](./clarifications/upstream-inbound-webhook-catalog.md)。

#### `smdp_systems` — SM-DP+ 系统

| 列 | 类型 | 约束 | 说明 |
|----|------|------|------|
| id | uuid | PK, default gen_random_uuid() | SM-DP+ 系统 ID |
| name | text | NOT NULL, UNIQUE | 系统名称 |
| activation_code_format | int | NOT NULL, default 1 | Activation Code Format |
| delimiter | text | NOT NULL, default '$' | Activation Code 分隔符 |
| host_fqdn | text | NOT NULL | FQDN（非 URL） |
| oid | text | NOT NULL, UNIQUE | SM-DP+ OID |
| confirmation_code_required | boolean | NOT NULL, default true | Confirmation Code Required Flag |
| esim_ca_rootca_key_ref | text | — | eSIM CA RootCA public key 标识 |
| delete_notification_on_device_change | boolean | NOT NULL, default false | 设备更换删除提醒 |
| environment | smdp_environment | NOT NULL, default 'test' | test / production |
| status | smdp_status | NOT NULL, default 'active' | active / deactivated / suspended |
| created_by | uuid | — | 创建者 |
| created_at | timestamptz | NOT NULL, default now() | 创建时间 |
| updated_at | timestamptz | NOT NULL, default now() | 更新时间 |

#### `resellers` — 代理商（独立建表，替代旧 `tenants` RESELLER 类型）

| 列 | 类型 | 约束 | 说明 |
|----|------|------|------|
| id | uuid | PK, default gen_random_uuid() | 代理商 ID |
| name | text | NOT NULL | 代理商名称 |
| status | reseller_status | NOT NULL, default 'active' | active / deactivated / suspended |
| contact_email | text | — | 联系邮箱 |
| contact_phone | text | — | 联系电话 |
| created_by | uuid | — | 创建者 |
| created_at | timestamptz | NOT NULL, default now() | 创建时间 |
| updated_at | timestamptz | NOT NULL, default now() | 更新时间 |

#### `customers` — 客户/企业（独立建表，替代旧 `tenants` ENTERPRISE 类型）

| 列 | 类型 | 约束 | 说明 |
|----|------|------|------|
| id | uuid | PK, default gen_random_uuid() | 客户 ID |
| reseller_id | uuid | NOT NULL, FK→resellers | 所属代理商 |
| name | text | NOT NULL | 客户名称 |
| status | customer_status | NOT NULL, default 'ACTIVE' | ACTIVE / INACTIVE / SUSPENDED（行政管控；overdue 移至 Dunning 层） |
| api_key | text | UNIQUE, nullable | M2M API Key（企业自助接入） |
| api_secret_hash | bytea | — | API Secret 哈希（bcrypt/scrypt） |
| webhook_url | text | — | 事件回调 URL |
| auto_suspend_enabled | boolean | NOT NULL, default true | 是否允许自动信控 |
| created_by | uuid | — | 创建者 |
| created_at | timestamptz | NOT NULL, default now() | 创建时间 |
| updated_at | timestamptz | NOT NULL, default now() | 更新时间 |
| | | UNIQUE(reseller_id, name) | 同代理商客户名称唯一 |

> **V1.1 迁移（2026-03-24 确认）**：`reseller_id` 将新增 `reseller_tenant_id` (uuid, FK→tenants(tenant_id)) 替代，数据迁移完成后弃用 `reseller_id`，消除 `resellers.id` 与 `tenants.tenant_id` 双标识歧义。UNIQUE 约束随迁移调整为 `UNIQUE(reseller_tenant_id, name)`。

#### `permissions` — 权限定义（RBAC）

| 列 | 类型 | 约束 | 说明 |
|----|------|------|------|
| id | uuid | PK, default gen_random_uuid() | 权限 ID |
| code | text | NOT NULL, UNIQUE | 权限代码（如 sim:read, bill:export） |
| name | text | NOT NULL | 权限名称 |
| description | text | — | 权限描述 |
| category | text | NOT NULL | 权限分类模块 |

**预置权限分类**: sim、subscription、billing、pricing、customer、reseller、system、report（共 38+ 权限代码）

#### `roles` — 角色定义（RBAC）

| 列 | 类型 | 约束 | 说明 |
|----|------|------|------|
| id | uuid | PK, default gen_random_uuid() | 角色 ID |
| code | text | NOT NULL, UNIQUE | 角色代码 |
| name | text | NOT NULL | 角色显示名 |
| description | text | — | 角色描述 |
| scope | role_scope | NOT NULL | platform / reseller / customer |

**预置角色 (7)**:

| code | scope | 说明 |
|------|-------|------|
| platform_admin | platform | 平台管理员，全局权限 |
| reseller_admin | reseller | 代理商管理员 |
| reseller_sales_director | reseller | 代理商销售总监 |
| reseller_sales | reseller | 代理商销售 |
| reseller_finance | reseller | 代理商财务 |
| customer_admin | customer | 客户管理员 |
| customer_ops | customer | 客户运维 |

#### `role_permissions` — 角色-权限关联（RBAC）

| 列 | 类型 | 约束 | 说明 |
|----|------|------|------|
| role_id | uuid | PK, FK→roles | 角色 ID |
| permission_id | uuid | PK, FK→permissions | 权限 ID |

> 复合主键，实现 M:N 多对多关联。

#### `users` — 用户（CMP.xlsx 对齐）

| 列 | 类型 | 约束 | 说明 |
|----|------|------|------|
| id | uuid | PK, default gen_random_uuid() | 用户 ID |
| email | text | NOT NULL, UNIQUE | 邮箱（全局唯一） |
| name | text | NOT NULL | 显示名称 |
| password_hash | text | NOT NULL | 密码哈希（scrypt） |
| role_id | uuid | NOT NULL, FK→roles | 角色 |
| reseller_id | uuid | FK→resellers, nullable | 代理商归属（reseller scope 时必填） |
| customer_id | uuid | FK→customers, nullable | 客户归属（customer scope 时必填） |
| status | user_status | NOT NULL, default 'ACTIVE' | 用户状态 |
| created_at | timestamptz | NOT NULL, default now() | 创建时间 |
| updated_at | timestamptz | NOT NULL, default now() | 更新时间 |

**数据隔离规则**:
- `scope=platform`: reseller_id=NULL, customer_id=NULL → 全局访问
- `scope=reseller`: reseller_id!=NULL, customer_id=NULL → 访问该代理商及其下属客户
- `scope=customer`: reseller_id=NULL, customer_id!=NULL → 仅访问该客户数据

### 4.2 审计与事件

#### `audit_logs`
| 列 | 类型 | 约束 | 说明 |
|----|------|------|------|
| audit_id | bigserial | PK | 审计 ID |
| actor_user_id | uuid | — | 操作者 |
| actor_role | text | — | 操作者角色 |
| reseller_id | uuid | FK→resellers, nullable | 代理商范围 |
| customer_id | uuid | FK→customers, nullable | 客户范围 |
| action | text | NOT NULL | 操作类型 |
| target_type | text | — | 目标对象类型 |
| target_id | text | — | 目标对象 ID |
| before_data | jsonb | — | 变更前 |
| after_data | jsonb | — | 变更后 |
| request_id | text | — | 请求 ID |
| source_ip | inet | — | 来源 IP |
| created_at | timestamptz | NOT NULL, default now() | 创建时间 |

**查询/展示约定**：`audit_logs` 持久化 **`actor_user_id`**（稳定 UUID），**不**冗余存储 email。`GET /v1/audit-logs` 使用 **`actorEmail`** 作为可读查询参数：服务端先在 `users` 中解析 email：email 不存在返回 **404**；reseller token 下 email 存在但不在该 reseller / 下属 enterprise scope 内返回 **403**；校验通过后按 `actor_user_id` 过滤。reseller token 下 **`resellerId`** 可省略或传 token reseller；非法 UUID 返回 **400**，与 token 不匹配返回 **403**，数据库无该 reseller 返回 **404**。列表 `pageSize` 默认 **20**，最大 **20**；`GET /v1/audit-logs:csv` 使用相同过滤与 scope 规则导出 CSV，`pageSize` 默认 **100**，最大 **1000**。响应中可通过 `actorUserId` + `actorEmail` + `actorLabel` 展示操作者；系统/M2M 审计可能没有 `actor_user_id`，此时 `actorEmail=null`，`actorLabel` 回退到 `actorRole` / `SYSTEM`。

#### `events`
| 列 | 类型 | 约束 | 说明 |
|----|------|------|------|
| event_id | uuid | PK, default gen_random_uuid() | 事件 ID |
| event_type | text | NOT NULL | 事件类型 |
| occurred_at | timestamptz | NOT NULL | 发生时间 |
| enterprise_id | uuid | FK→tenants(tenant_id), nullable | 企业 scope（**ENTERPRISE** `tenants.tenant_id`，= API `enterpriseId`） |
| reseller_id | uuid | FK→tenants(tenant_id), nullable | 代理商 scope（**RESELLER** `tenants.tenant_id`，= API `resellerId`，**FR-058**） |
| actor_user_id | uuid | — | 操作者 |
| request_id | text | — | 请求 ID |
| job_id | uuid | — | 关联 Job |
| payload | jsonb | NOT NULL | 事件负载（**MUST NOT** 含 `resellerId`；scope 以列为准） |

**索引**: `idx_events_type_time(event_type, occurred_at)`；`idx_events_enterprise_time(enterprise_id, occurred_at)`；`idx_events_reseller_time(reseller_id, occurred_at)`

**`event_type` 约定**：列类型为 **`text NOT NULL`**，**无** PostgreSQL ENUM / CHECK；应用可写入新字符串。对外契约以出站 Webhook 白名单为准（[integration-api.md](./contracts/integration-api.md) §4.2、[webhook-delivery.md](./clarifications/webhook-delivery.md)）；其余类型用于审计、`GET /v1/events` 查询与内部编排，**默认不**进入 `webhook_subscriptions.event_types` 投递。

**出站 Webhook 可订阅（7 · FR-039）**

| event_type | 触发条件（摘要） | 主要写入路径 |
|------------|------------------|--------------|
| `SIM_STATUS_CHANGED` | SIM **稳态** `status` 变更（`lifecycle_sub_status=normal`） | `emitEvent` / `simLifecycleFinalize` / reconciliation / worker |
| `JOB_FINISHED` | 异步 Job 终态（如 `SIM_STATUS_CHANGE`、订阅开通 Job） | `simStatusChangeJob` / `subscriptionProvisionJob` |
| `SUBSCRIPTION_CHANGED` | 订阅创建 / 变更 / 退订 | `subscriptionProvisionJob`、订阅 API |
| `BILL_PUBLISHED` | 账单发布 | `billStatusMachine` |
| `PAYMENT_CONFIRMED` | 支付确认 | `billStatusMachine` |
| `ALERT_TRIGGERED` | 告警触发（scope 常为 `reseller_id`） | `alerting` |
| `ENTERPRISE_STATUS_CHANGED` | 企业 `customer_status` 变更 | 租户状态 API |

**计费 / 调账（仅落库，非 Webhook 白名单）**

| event_type | 说明 |
|------------|------|
| `BILL_WRITTEN_OFF` | 账单核销 |
| `BILL_VOIDED` | 账单作废 |
| `BILL_ADJUSTMENT_NOTE_CREATED` | 调账单创建 |
| `BILL_ADJUSTMENT_NOTE_APPROVED` | 调账单审批 |
| `BILL_ADJUSTMENT_NOTE_APPLIED` | 调账单下期结算 **APPLIED** |
| `BILL_ADJUSTMENT_ICCID_WARNING` | 调账行 ICCID 与企业不匹配等校验告警 |

**SIM 批量 / 分配（仅落库）**

| event_type | 说明 |
|------------|------|
| `SIM_BATCH_STATUS_CHANGE` | 批量状态变更 Job 受理 |
| `SIM_BATCH_STATUS_CHANGE_RESULT` | 批量状态变更逐卡结果 |
| `SIM_ASSIGN_INVENTORY` | 批量分配库存受理 |
| `SIM_ASSIGN_INVENTORY_RESULT` | 分配库存逐卡结果 |
| `SIM_ASSIGN_DEPARTMENT` | 批量分配部门受理 |
| `SIM_ASSIGN_DEPARTMENT_RESULT` | 分配部门逐卡结果 |

**订阅开通（仅落库）**

| event_type | 说明 |
|------------|------|
| `SUBSCRIPTION_PROVISION_FAILED` | 上游开通失败（Job 失败路径） |

**上游入站 Webhook → `events`（平台通用 · Phase 38）**

| event_type | 入站 `event_key` | 说明 |
|------------|------------------|------|
| `UPDATE_LOCATION` | `update-location` | 位置 / 上线（`audit_logs.action = WX_WEBHOOK_SIM_ONLINE`） |
| `INBOUND_SIM_STATUS_CHANGED` | `sim-status-changed` | 上游推送状态变更（与本地 `SIM_STATUS_CHANGED` 分工不同；**任意 adapter** 映射落库） |
| `TRAFFIC_ALERT` | `traffic-alert` | 流量阈值告警 |
| `SUBSCRIPTION` | `subscription` | 上游套餐 / 订购变更（`audit_logs.action = WX_WEBHOOK_SUBSCRIPTION`） |

**已更名（历史数据经迁移改写，新写入 MUST NOT 使用旧名）**

| 旧 event_type | 新 event_type | 迁移 |
|---------------|---------------|------|
| `SIM_ONLINE` | `UPDATE_LOCATION` | `20260522120001_rename_sim_online_to_update_location.sql` |
| `PRODUCT_ORDERED` | `SUBSCRIPTION` | `20260522130001_rename_product_order_to_subscription.sql` |
| `WX_SIM_STATUS_CHANGED` | `INBOUND_SIM_STATUS_CHANGED` | `20260621100010_rename_wx_sim_status_to_inbound.sql` |

**运维查询示例**：`SELECT event_type, COUNT(*) FROM events GROUP BY 1 ORDER BY 2 DESC;`

**`GET /v1/events` 查询分层（无 DB 列）**：可选 **`eventCategory`**（5 项枚举，Swagger 下拉）展开为多 `event_type`；可选 **`eventType`** 精确匹配；二者同传时 `eventType` 须属于该大类。可选 **`resellerId`** / **`enterpriseId`** 先按 token scope 校验格式、存在性与租户归属（platform/admin 同传时二者必须匹配；reseller/customer 不得越权）。可选 **`iccid`** 先校验格式、`sims` 表存在性与租户归属，再按 `payload.iccid` 精确过滤指定 SIM 事件。列表 `pageSize` 默认 **20**，最大 **20**；`GET /v1/events:csv` 使用相同过滤与 scope 规则导出 CSV，`pageSize` 默认 **100**，最大 **1000**。全量映射由 **`GET /v1/events/catalog`** 与 `src/utils/eventTypeCatalog.ts` 维护（真源与上文目录表一致）。

#### `jobs`
| 列 | 类型 | 约束 | 说明 |
|----|------|------|------|
| job_id | uuid | PK, default gen_random_uuid() | Job ID |
| job_type | text | NOT NULL | 任务类型 |
| status | job_status | NOT NULL, default 'QUEUED' | 状态 |
| progress_processed | bigint | NOT NULL, default 0 | 已处理数 |
| progress_total | bigint | NOT NULL, default 0 | 总数 |
| error_summary | text | — | 错误摘要 |
| request_id | text | — | 请求 ID |
| actor_user_id | uuid | — | 操作者 |
| actor_role | text | — | 操作者角色（见 `20260512100001_jobs_actor_role.sql`） |
| payload | jsonb | — | 任务负载（0016 新增） |
| reseller_id | uuid | FK→tenants(tenant_id), nullable | 代理商 scope（RESELLER） |
| enterprise_id | uuid | FK→tenants(tenant_id), nullable | 企业 scope（ENTERPRISE；原列名 customer_id，见 §6.3） |
| idempotency_key | text | — | 幂等键 |
| file_hash | text | — | 导入文件哈希 |
| created_at | timestamptz | NOT NULL, default now() | 创建时间 |
| started_at | timestamptz | — | 开始时间 |
| finished_at | timestamptz | — | 完成时间 |

### 4.3 SIM 与 eSIM 管理

#### `sim_cards`（CMP.xlsx 对齐，原 `sims` 重命名）

| 列 | 类型 | 约束 | 说明 |
|----|------|------|------|
| id | uuid | PK, default gen_random_uuid() | SIM ID |
| iccid | text | NOT NULL, UNIQUE | ICCID（18-20 位） |
| imsi_primary | text | NOT NULL | 主 IMSI |
| imsi_secondary_1 | text | — | 副 IMSI 1 |
| imsi_secondary_2 | text | — | 副 IMSI 2 |
| imsi_secondary_3 | text | — | 副 IMSI 3 |
| msisdn | text | — | MSISDN 号码 |
| form_factor | sim_form_factor | NOT NULL, default 'industrial_removable' | SIM 卡形态 |
| supplier_id | uuid | NOT NULL, FK→suppliers | 供应商归属 |
| operator_id | uuid | NOT NULL, FK→operators | 运营商归属 |
| reseller_id | uuid | NOT NULL, FK→resellers | 代理商归属 |
| customer_id | uuid | FK→customers, nullable | 客户归属（分配后填充） |
| status | sim_status | NOT NULL, default 'INVENTORY' | SIM 主状态（5 稳态） |
| lifecycle_sub_status | lifecycle_sub_status | NOT NULL, default 'normal' | 过渡子状态：normal / activating / activation_failed / deactivating / deactivation_failed / reactivating / reactivation_failed / retiring / retire_failed（枚举须迁移扩展，见 spec US2） |
| status_sync_conflict | boolean | NOT NULL, default false | 本地稳态与 upstream_status 漂移冲突 |
| primary_product_package_id | uuid | FK→packages, nullable | 当前主套餐产品包 |
| total_data_usage_kb | bigint | NOT NULL, default 0 | 累计数据用量 (KB) |
| imei | varchar(15) | — | 绑定 IMEI |
| imei_lock_enabled | boolean | NOT NULL, default false | 是否启用 IMEI 锁定 |
| remark | text | — | [V1.1] 备注，标识主要用途（如「研发工程师测试用 SIM」） |
| upstream_status | text | — | 上游供应商同步状态 |
| upstream_status_updated_at | timestamptz | — | 上游状态更新时间 |
| upstream_info | jsonb | — | 上游供应商扩展信息 |
| imported_by | uuid | — | 导入操作者 |
| imported_at | timestamptz | — | 导入时间 |
| activated_at | timestamptz | — | 激活时间 |
| deactivated_at | timestamptz | — | 停机时间 |
| retired_at | timestamptz | — | 拆机时间 |
| updated_at | timestamptz | NOT NULL, default now() | 更新时间 |

**索引**: `idx_sim_cards_reseller_status(reseller_id, status)`, `idx_sim_cards_customer(customer_id)`, `idx_sim_cards_supplier(supplier_id)`

> **四方归属链**: 每张 SIM 卡通过 supplier_id → operator_id → reseller_id → customer_id 明确四方责任。customer_id 在 SIM 从仓库分配给客户后填充。

> **IMEI 锁定**: imei_lock_enabled=true 时，该 SIM 仅可在绑定的 imei 设备上使用，由上游供应商实际执行锁定。

#### `esim_profiles`

| 列 | 类型 | 约束 | 说明 |
|----|------|------|------|
| id | uuid | PK, default gen_random_uuid() | eSIM Profile ID |
| iccid | text | NOT NULL, UNIQUE | eSIM ICCID |
| imsi_primary | text | NOT NULL | 主 IMSI |
| imsi_secondary_1 | text | — | 副 IMSI 1 |
| imsi_secondary_2 | text | — | 副 IMSI 2 |
| imsi_secondary_3 | text | — | 副 IMSI 3 |
| msisdn | text | — | MSISDN |
| form_factor | esim_form_factor | NOT NULL, default 'esim_profile' | eSIM 形态 |
| matching_id | text | NOT NULL | MatchingID（明文存储） |
| activation_code | text | NOT NULL | Activation Code |
| smdp_profile_status | smdp_profile_status | NOT NULL, default 'created' | SM-DP+ 侧状态 |
| smdp_profile_status_updated_at | timestamptz | — | SM-DP+ 状态更新时间 |
| profile_order_id | text | — | 内部订单系统关联 ID |
| eid | text | NOT NULL | 设备 eID |
| imei | varchar(15) | — | 设备 IMEI |
| imei_lock_enabled | boolean | NOT NULL, default false | 是否启用 IMEI 锁定 |
| remark | text | — | [V1.1] 备注，标识主要用途（如「研发工程师测试用 eSIM」） |
| supplier_id | uuid | NOT NULL, FK→suppliers | 供应商归属 |
| operator_id | uuid | NOT NULL, FK→operators | 运营商归属 |
| smdp_system_id | uuid | NOT NULL, FK→smdp_systems | SM-DP+ 系统 |
| reseller_id | uuid | NOT NULL, FK→resellers | 代理商归属 |
| customer_id | uuid | FK→customers, nullable | 客户归属 |
| status | sim_status | NOT NULL, default 'INVENTORY' | eSIM 状态 |
| primary_product_package_id | uuid | FK→packages, nullable | 当前主套餐产品包 |
| total_data_usage_kb | bigint | NOT NULL, default 0 | 累计数据用量 (KB) |
| imported_by | uuid | — | 导入操作者 |
| imported_at | timestamptz | — | 导入时间 |
| activated_at | timestamptz | — | 激活时间 |
| deactivated_at | timestamptz | — | 停机时间 |
| retired_at | timestamptz | — | 拆机时间 |
| updated_at | timestamptz | NOT NULL, default now() | 更新时间 |

**约束**: matching_id 与 eid 必须成对出现；缺失任一字段则禁止下发 Profile 下载

**索引**: `idx_esim_profiles_reseller_status(reseller_id, status)`, `idx_esim_profiles_customer(customer_id)`, `idx_esim_profiles_supplier(supplier_id)`, `idx_esim_profiles_smdp(smdp_system_id)`

> **四方归属链**: 每份 eSIM Profile 通过 supplier_id → operator_id → reseller_id → customer_id 明确四方责任。customer_id 在 eSIM 从仓库分配给客户后填充。

#### `sim_state_history`（Type 2 SCD）
| 列 | 类型 | 约束 | 说明 |
|----|------|------|------|
| history_id | bigserial | PK | 历史 ID |
| sim_id | uuid | NOT NULL, FK→sim_cards | SIM ID |
| before_status | sim_status | — | 变更前状态 |
| after_status | sim_status | NOT NULL | 变更后状态 |
| start_time | timestamptz | NOT NULL | 状态开始时间 |
| end_time | timestamptz | — | 状态结束时间 |
| source | text | NOT NULL | 变更来源 |
| request_id | text | — | 请求 ID |
| occurred_at | timestamptz | NOT NULL, default now() | 记录时间 |

**索引**: `idx_sim_state_history_sim_time(sim_id, start_time)`

#### `esim_state_history`（Type 2 SCD）
| 列 | 类型 | 约束 | 说明 |
|----|------|------|------|
| history_id | bigserial | PK | 历史 ID |
| esim_profile_id | uuid | NOT NULL, FK→esim_profiles | eSIM Profile ID |
| before_status | sim_status | — | 变更前状态 |
| after_status | sim_status | NOT NULL | 变更后状态 |
| start_time | timestamptz | NOT NULL | 状态开始时间 |
| end_time | timestamptz | — | 状态结束时间 |
| source | text | NOT NULL | 变更来源 |
| request_id | text | — | 请求 ID |
| occurred_at | timestamptz | NOT NULL, default now() | 记录时间 |

**索引**: `idx_esim_state_history_profile_time(esim_profile_id, start_time)`

### 4.4 产品与资费

#### `price_plans`（**父表**；**Phase 31** 起类型专有定价列迁出至子表）

与 **`type`** 无关的**公共**快照列仅存于此表；`FIXED_BUNDLE` / `SIM_DEPENDENT_BUNDLE` / `ONE_TIME` / `TIERED_VOLUME_PRICING` 的**金额、配额、阶梯**等在对应 **1:1 子表**（见下）。**读宽表**（批价、订阅解析、部分服务层拼装）：视图 **`price_plans_expanded`**（`LEFT JOIN` 四子表，列名与历史单表时期对齐，便于 `select=` 迁移）。

| 列 | 类型 | 约束 | 说明 |
|----|------|------|------|
| price_plan_id | uuid | PK, default gen_random_uuid() | 资费计划快照 ID |
| enterprise_id | uuid | NOT NULL, FK→`tenants(tenant_id)` | 企业（`tenant_type=ENTERPRISE`） |
| reseller_id | uuid | FK→`tenants(tenant_id)`；宜 **NOT NULL** | **RESELLER** `tenants.tenant_id`，与 `enterprise_id` 行之 **`parent_id`** 一致（**`20260423100001_price_plans_reseller_id.sql`**） |
| name | text | NOT NULL | 名称 |
| type | price_plan_type | NOT NULL | `ONE_TIME` \| `SIM_DEPENDENT_BUNDLE` \| `FIXED_BUNDLE` \| `TIERED_VOLUME_PRICING` |
| service_type | service_type | NOT NULL, default 'DATA' | 业务类型 |
| currency | text | NOT NULL | 币种 |
| billing_cycle_type | billing_cycle_type | NOT NULL, default 'CALENDAR_MONTH' | 计费周期 |
| first_cycle_proration | first_cycle_proration | NOT NULL, default 'NONE' | 首期分摊 |
| proration_rounding | text | NOT NULL，默认 `ROUND_HALF_UP` | 与 API `prorationRounding` 一致 |
| source_price_plan_id | uuid | FK→price_plans | 来源快照 ID（修订/复制链路） |
| version | int | — | 快照版本号（合并 `price_plan_versions` 后保留） |
| status | text | NOT NULL, default 'DRAFT' | `DRAFT` / `PUBLISHED` / `DEPRECATED`（与 **`effective_from`**、**`deprecated_at`** 一致，见 **`20260420100002_price_plans_status.sql`**） |
| effective_from | timestamptz | — | 生效时间（发布时写入） |
| deprecated_at | timestamptz | — | 废弃时间 |
| covered_network_profile_id | uuid | **可空**，FK→`covered_network_profiles` | **in-profile** 覆盖；需 Covered 的类型在 **publish** 链上须非空且指向 **PUBLISHED** 快照 |
| created_at | timestamptz | NOT NULL, default now() | 创建时间 |

**已从父表移除（Phase 31，见 `20260424100001_price_plan_type_extension_tables.sql`）**：`monthly_fee`、`deactivated_monthly_fee`、`one_time_fee`、`quota_mb`、`validity_days`、`per_sim_quota_mb`、`total_quota_mb`、`overage_rate_per_mb`、`tiers`、`expiry_boundary` — 按 `type` 落在子表。

**索引**：`idx_price_plans_enterprise_status(enterprise_id, status)`、`idx_price_plans_reseller_enterprise(reseller_id, enterprise_id)`、`idx_price_plans_covered_network_profile_id(covered_network_profile_id)`（**where** 非空）等（以仓库迁移为准）。

**RLS**：若对 **`price_plans`** 配置租户/代理商策略，**子表**当前默认**不单独暴露**给 PostgREST；访问由 **服务端（service role）** 在已校验父行 **`enterprise_id` / `reseller_id`** 后读写子表。若将来对子表开 **直接 REST**，应加与父行 **`EXISTS (SELECT 1 FROM price_plans p WHERE p.price_plan_id = …)`** 等价的策略，避免重复定义冲突。

**OOP**：**MUST NOT** 在 `price_plans` 上存 **`roaming_profile_id`**；OOP **仅** Package → Carrier → Roaming，见 [spec.md](./spec.md)。

**`payg_rates`**：列已删除（**`20260423100002_price_plans_drop_payg_rates.sql`**），不再作为价目持久化字段。

##### 子表（**PK = `price_plan_id`**，**FK → `price_plans` ON DELETE CASCADE**）

| 表名 | `type` | 列（除 `price_plan_id`） |
|------|--------|---------------------------|
| `price_plan_fixed_bundle` | `FIXED_BUNDLE` | `monthly_fee`, `deactivated_monthly_fee`, `total_quota_mb`, `overage_rate_per_mb` |
| `price_plan_sim_dependent_bundle` | `SIM_DEPENDENT_BUNDLE` | `monthly_fee`, `deactivated_monthly_fee`, `per_sim_quota_mb`, `overage_rate_per_mb` |
| `price_plan_one_time` | `ONE_TIME` | `one_time_fee`, `quota_mb`, `validity_days`, `expiry_boundary` |
| `price_plan_tiered_volume_pricing` | `TIERED_VOLUME_PRICING` | `monthly_fee`, `deactivated_monthly_fee`, `tiers` (jsonb), `overage_rate_per_mb` |

**`tiers` JSONB**（仅阶梯子表；结构示例）:
```json
[
  { "fromMb": 0, "toMb": 1024, "ratePerMb": 10.24 },
  { "fromMb": 1024, "toMb": 5120, "ratePerMb": 8.192 }
]
```

##### 视图 `price_plans_expanded`

扁平化 **父表 + 四子表**，供 **`src/billing.js`**、**`src/services/subscription.ts`** 等 **`select=`** 单表读路径；**`GRANT SELECT`** 予 `anon, authenticated, service_role`（与迁移一致）。应用层价目 **List/Get/Update** 仍通过 **`pricePlan` 服务**拼装分型 JSON，不必依赖该视图。

#### `roaming_profiles`
| 列 | 类型 | 约束 | 说明 |
|----|------|------|------|
| roaming_profile_id | uuid | PK, default gen_random_uuid() | Roaming Profile 快照 ID |
| supplier_id | uuid | NOT NULL, FK→suppliers | 供应商（连通性目录归属键） |
| operator_id | uuid | NOT NULL, FK→operators | 运营商 |
| name | text | NOT NULL | 展示名称（允许重复） |
| mccmnc_list | jsonb | NOT NULL | OOP 费率条目（含 mcc/mnc/ratePerMb 等） |
| status | text | NOT NULL, default 'DRAFT' | DRAFT / PUBLISHED / DEPRECATED |
| published_at | timestamptz | — | 发布时间 |
| effective_from | timestamptz | — | 业务生效时间（通常次月 1 日 UTC） |
| deprecated_at | timestamptz | — | 废弃时间（`DEPRECATED` 时） |
| source_roaming_profile_id | uuid | FK→roaming_profiles | 可选；历史/遗留 lineage，**非**主修订流程 |
| created_at | timestamptz | NOT NULL, default now() | 创建时间 |
| updated_at | timestamptz | NOT NULL, default now() | 更新时间 |

> **归属**：连通性目录，**无** `reseller_id` 列；代理商可见性经 `reseller_suppliers(supplier_id)` 推导（与 `apn_profiles` 一致）。

**索引**: `idx_roaming_profiles_supplier_status(supplier_id, status)` 等（以实际迁移为准）

#### `roaming_profile_entries`
| 列 | 类型 | 约束 | 说明 |
|----|------|------|------|
| entry_id | uuid | PK, default gen_random_uuid() | 条目 ID |
| roaming_profile_id | uuid | NOT NULL, FK→roaming_profiles | 所属 Profile 快照 |
| mcc | char(3) | NOT NULL | 移动国家代码 |
| mnc | varchar(3) | NOT NULL | 移动网络代码（2~3 位数字或 `*`） |
| rate_per_mb | numeric(18,8) | NOT NULL | 单价（currency/MB） |
| created_at | timestamptz | NOT NULL, default now() | 创建时间 |
| updated_at | timestamptz | NOT NULL, default now() | 更新时间 |
| | | UNIQUE(roaming_profile_id, mcc, mnc) | 同一快照内 MCC+MNC 唯一 |

#### `covered_network_profiles`（**CoveredNetworkProfile**；**in-profile** (MCC,MNC) 覆盖快照）[V1.1]

与 [spec.md](./spec.md) **CoveredNetworkProfile**、**in-profile 与 out-of-profile** 一致：将「套内可计费拜访网络集合」抽成**可复用**目录快照，供**多份** `price_plans` 共用同一 `covered_network_profile_id`（例如多档 **Fixed Bundle** 仅配额不同、覆盖相同）。生命周期与 APN / Roaming 目录模块相同：**DRAFT / PUBLISHED / DEPRECATED**。**废弃**：仅当**无** `price_plans` 仍引用本行时允许（实现列出 `price_plan_id`）。

归属列与 **`apn_profiles` / `roaming_profiles`** 一致：**`supplier_id`、`operator_id` 必填**；**`reseller_id` 可空**（迁移 **`20260422100007_covered_network_profiles.sql`**，FK **`tenants.tenant_id`**）。**不**使用 `enterprise_id` / `customer_id` 在本表；企业维度在 **`price_plans`** 与装配 **`packages`** 上体现（**`price_plans`** 企业列名与迁移一致，见上表）。

| 列 | 类型 | 约束 | 说明 |
|----|------|------|------|
| covered_network_profile_id | uuid | PK, default gen_random_uuid() | 对外 **`coveredNetworkProfileId`** |
| reseller_id | uuid | **可空**，FK→`tenants(tenant_id)`（`tenant_type=RESELLER`） | 代理商租户作用域（**与** **`control_policy_modules.reseller_id`** **一致**；**可空** 以兼容仅 **supplier/operator** 定位之目录行，**同** 部分 **`apn_profiles`** 存量） |
| supplier_id | uuid | NOT NULL, FK→suppliers | 供应商 |
| operator_id | uuid | NOT NULL, FK→operators | 运营商 |
| name | text | NOT NULL | 展示名称（允许重复） |
| status | text | NOT NULL, default 'DRAFT' | DRAFT / PUBLISHED / DEPRECATED |
| published_at | timestamptz | — | 发布时间 |
| effective_from | timestamptz | — | 业务生效时间 |
| deprecated_at | timestamptz | — | 废弃时间 |
| source_covered_network_profile_id | uuid | FK→covered_network_profiles | 可选 lineage |
| created_by | uuid | — | 创建者 |
| created_at | timestamptz | NOT NULL, default now() | 创建时间 |
| updated_at | timestamptz | NOT NULL, default now() | 更新时间 |

**索引**: `idx_covered_network_profiles_reseller_status(reseller_id, status)`、`idx_covered_network_profiles_reseller_published(reseller_id, published_at desc)`（命名与 roaming/apn 对齐；以实际迁移为准）。

#### `covered_network_profile_entries`

**覆盖集**规范化存储，规模与 spec **「~600 条/Profile」** 一致时可水平扩展；**无** 套外单价列（单价在 **OOP** 路径由 **`roaming_profile_entries.rate_per_mb`** 等表达）。当父表 `coverage_mode=NONE` 时，本表不得存在对应 entries。

| 列 | 类型 | 约束 | 说明 |
|----|------|------|------|
| entry_id | uuid | PK, default gen_random_uuid() | 条目 ID |
| covered_network_profile_id | uuid | NOT NULL, FK→covered_network_profiles **ON DELETE CASCADE** | 所属 Covered Profile 快照（**迁移** `20260422100007_*`） |
| mcc | char(3) | NOT NULL | 移动国家代码 |
| mnc | varchar(3) | NOT NULL | 移动网络代码（2~3 位数字或 `*`，与 `roaming_profile_entries` 语义一致） |
| created_at | timestamptz | NOT NULL, default now() | 创建时间 |
| updated_at | timestamptz | NOT NULL, default now() | 更新时间 |
| | | **UNIQUE**(covered_network_profile_id, mcc, mnc) | 同一快照内 MCC+MNC 唯一 |

**索引（批价热路径）**: **`UNIQUE(covered_network_profile_id, mcc, mnc)`** 已支持 `(profile_id, mcc, mnc)` 点查；若优化器需要，可补充与 `roaming_profile_entries` 一致的覆盖索引（见 [tasks.md](./tasks.md) **T228**）。

#### `apn_profiles`
| 列 | 类型 | 约束 | 说明 |
|----|------|------|------|
| apn_profile_id | uuid | PK, default gen_random_uuid() | APN Profile 快照 ID |
| supplier_id | uuid | NOT NULL, FK→suppliers | 供应商（连通性目录归属键） |
| operator_id | uuid | NOT NULL, FK→operators | 运营商 |
| name | text | NOT NULL | 展示名称（允许重复） |
| apn | text | NOT NULL | APN |
| auth_type | text | NOT NULL, default 'NONE' | NONE / PAP / CHAP |
| username | text | — | 用户名 |
| password_ref | text | — | 密钥引用 |
| status | text | NOT NULL, default 'DRAFT' | DRAFT / PUBLISHED / DEPRECATED |
| published_at | timestamptz | — | 发布时间 |
| effective_from | timestamptz | — | 业务生效时间 |
| deprecated_at | timestamptz | — | 废弃时间 |
| source_apn_profile_id | uuid | FK→apn_profiles | 可选 lineage（APN 仍支持 `:clone`） |
| created_at | timestamptz | NOT NULL, default now() | 创建时间 |
| updated_at | timestamptz | NOT NULL, default now() | 更新时间 |

> **归属**：连通性目录，**无** `reseller_id` 列；代理商可见性经 `reseller_suppliers(supplier_id)` 推导（与 `roaming_profiles` 一致）。

**索引**: `idx_apn_profiles_supplier_status(supplier_id, status)` 等（以实际迁移为准）

#### `carrier_services`
| 列 | 类型 | 约束 | 说明 |
|----|------|------|------|
| carrier_service_id | uuid | PK, default gen_random_uuid() | Carrier Service ID |
| customer_id | uuid | NOT NULL, FK→customers | 企业 |
| supplier_id | uuid | NOT NULL, FK→suppliers | 供应商 |
| operator_id | uuid | NOT NULL, FK→operators | 运营商 |
| service_type | service_type | NOT NULL, default 'DATA' | 业务类型 |
| rat | text | NOT NULL, default '4G' | 3G / 4G / 5G / NB-IoT |
| apn_profile_id | uuid | FK→apn_profiles | APN Profile 快照 ID |
| roaming_profile_id | uuid | FK→roaming_profiles | Roaming Profile 快照 ID |
| status | text | NOT NULL, default 'ACTIVE' | ACTIVE / INACTIVE |
| effective_from | timestamptz | — | 生效时间 |
| effective_to | timestamptz | — | 失效时间 |
| created_by | uuid | — | 创建者 |
| created_at | timestamptz | NOT NULL, default now() | 创建时间 |
| updated_at | timestamptz | NOT NULL, default now() | 更新时间 |

**索引**: `idx_carrier_services_customer_status(customer_id, status)`、`idx_carrier_services_apn_profile(apn_profile_id)`、`idx_carrier_services_roaming_profile(roaming_profile_id)`

#### `control_policy_modules`（产品包域 Control Policy 快照；**HTTP `/v1/control-policies` 真源**）

与 [spec.md](./spec.md) 控制策略条文及 **`packages.control_policy_id`** 引用一致。策略规则（Cutoff / Throttling 的 `time_window`、`tiers` 等）**随快照固化在列 `control_policy`（JSONB）**，**不**使用独立 `control_policy_throttling_tiers` 物理表。迁移来源：`20260311100006_package_modules.sql`、生命周期与列名 `20260421100001_*`、`20260422100002_*`、`20260422100004_package_module_fk_tenants.sql`（`reseller_id` → `tenants.tenant_id`）；**`enterprise_id` 列已移除**（见 `20260422100006_drop_reseller_module_tables_enterprise_id.sql`）——企业绑定在 **Package**，不在本表。

| 列 | 类型 | 约束 | 说明 |
|----|------|------|------|
| control_policy_id | uuid | PK, default gen_random_uuid() | 对外 **`controlPolicyId`** |
| name | text | NOT NULL | 展示名称（迁移后非空） |
| reseller_id | uuid | FK→tenants(tenant_id) | 代理商租户（可空；语义见 **FR-058**） |
| control_policy | jsonb | NOT NULL | 控制策略正文快照（与 OpenAPI **`controlPolicy`** 对齐；演进见 Phase 29 **T205+**） |
| status | text | NOT NULL, default `DRAFT` | `DRAFT` / `PUBLISHED` / `DEPRECATED` |
| published_at | timestamptz | — | 发布时间 |
| deprecated_at | timestamptz | — | 废弃时间 |
| effective_from | timestamptz | — | 生效时间（发布时回填等） |
| created_at | timestamptz | NOT NULL | 创建时间 |
| updated_at | timestamptz | NOT NULL | 更新时间 |

**索引**: 以迁移为准（如 `reseller_id` 相关索引）；**无** `enterprise_id` 索引。

#### `carrier_service_modules`（产品包域 Carrier Service 快照；**HTTP `/v1/carrier-services` 真源**）

与 [spec.md](./spec.md) **四模块**之 **Carrier Service**、**Package → `carrierServiceId` → OOP `roamingProfileId`** 一致。**`apn_profile_id`、`roaming_profile_id`、`rat`** 与 **`supplier_id` / `operator_id`** 为 **唯一持久化真源**（**FK** 至 **`apn_profiles` / `roaming_profiles`**，`rat` 枚举 `3G` / `4G` / `5G` / `NB-IOT`）。**OpenAPI `carrierServiceConfig`** 由服务层 **`mergedCarrierServiceConfigShape`** 仅从列组装。**`carrier_service_config`（JSONB）** 已由迁移 **`20260427100001_carrier_service_modules_drop_carrier_service_config.sql`** 从本表 **DROP**（回填见该迁移头注释）。

基表来源：`20260311100006_package_modules.sql`；生命周期 **`20260420100001_*`**；**`name`** **`20260420100003_*`**；**`reseller_id` → `tenants.tenant_id`** **`20260422100004_*`**；历史 JSON 内 ID 规范化 **`20260419100001_*`**；**列化 + FK + `rat` NOT NULL** **`20260425100001_carrier_service_modules_apn_roaming_columns.sql`**。

| 列 | 类型 | 约束 | 说明 |
|----|------|------|------|
| carrier_service_id | uuid | PK, default gen_random_uuid() | 对外 **`carrierServiceId`** |
| name | text | NOT NULL | 展示名称 |
| reseller_id | uuid | FK→tenants(tenant_id) | 代理商租户（语义见 **FR-058**） |
| supplier_id | uuid | — | 供应商（与 JSON / 校验一致） |
| operator_id | uuid | — | **`operators.operator_id`（行 PK）**；API 展示 **`business_operator_id`** 见服务层 |
| apn_profile_id | uuid | FK→apn_profiles，可空（存量未回填时） | **APN 快照 ID** |
| roaming_profile_id | uuid | FK→roaming_profiles，可空（存量未回填时） | **Roaming 快照 ID**；OOP 解析真源 |
| rat | text | NOT NULL, default `4G`，CHECK | `3G` / `4G` / `5G` / `NB-IOT` |
| status | text | NOT NULL | `DRAFT` / `PUBLISHED` / `DEPRECATED` |
| published_at | timestamptz | — | 发布时间 |
| deprecated_at | timestamptz | — | 废弃时间 |
| effective_from | timestamptz | — | 生效时间 |
| created_at | timestamptz | NOT NULL | 创建时间 |
| updated_at | timestamptz | NOT NULL | 更新时间 |

**索引（迁移已建或 Phase 33 补充）**: `idx_carrier_service_modules_supplier_operator(supplier_id, operator_id)`；**`idx_carrier_service_modules_apn_profile_id`**；**`idx_carrier_service_modules_roaming_profile_id`**（部分索引、可空列时 **WHERE … IS NOT NULL**，以实际 SQL 为准）。

#### `control_policies`（**计费 / 用量域**；**勿与 `control_policy_modules` 混淆**）

来自迁移 `20260311100005_billing_integration.sql`（历史自 `0033`）。**主键为 `policy_id`**，按 **`enterprise_id` 唯一**一行，字段为 **cutoff/throttle 开关与简单数值**，**不是**「产品包四模块」的 Control Policy 快照，**也无** `POST /v1/control-policies` 写入路径。与 **`control_policy_modules`** 并存时，文档与查询 **MUST** 按表名区分。

| 列 | 类型 | 约束 | 说明 |
|----|------|------|------|
| policy_id | uuid | PK | 与模块表 **`control_policy_id`** 无关 |
| enterprise_id | uuid | NOT NULL, unique, FK→tenants(tenant_id) | 企业 |
| cutoff_enabled | boolean | NOT NULL, default false | — |
| throttle_enabled | boolean | NOT NULL, default false | — |
| throttle_kbps | int | — | — |
| auto_reactivate | boolean | NOT NULL, default false | — |
| created_at | timestamptz | NOT NULL | — |
| updated_at | timestamptz | NOT NULL | — |

#### ~~`control_policy_throttling_tiers`~~（旧版文档草案 — **当前仓库无此表**）

**已废弃叙述**：曾假设 tiers 独立表；**当前实现**中 throttling **tiers** 位于 **`control_policy_modules.control_policy`** JSON（见 [spec.md](./spec.md)）。勿在迁移或新功能中创建本表名，除非未来产品另行立项。

#### `commercial_terms`
| 列 | 类型 | 约束 | 说明 |
|----|------|------|------|
| commercial_terms_id | uuid | PK, default gen_random_uuid() | Commercial Terms 快照 ID |
| customer_id | uuid | NOT NULL, FK→customers | 企业 |
| name | text | NOT NULL | 展示名称（允许重复） |
| test_period_days | int | — | 测试期天数 |
| test_quota_mb | bigint | — | 测试流量配额（MB） |
| test_expiry_condition | text | — | PERIOD_ONLY / QUOTA_ONLY / PERIOD_OR_QUOTA |
| test_expiry_action | text | — | ACTIVATED / DEACTIVATED |
| commitment_period_months | int | — | 承诺期（月） |
| status | text | NOT NULL, default 'DRAFT' | DRAFT / PUBLISHED / DEPRECATED |
| published_at | timestamptz | — | 发布时间 |
| source_commercial_terms_id | uuid | FK→commercial_terms | 来源快照 ID（克隆链路） |
| created_by | uuid | — | 创建者 |
| created_at | timestamptz | NOT NULL, default now() | 创建时间 |
| updated_at | timestamptz | NOT NULL, default now() | 更新时间 |

**索引**: `idx_commercial_terms_customer_status(customer_id, status)`、`idx_commercial_terms_customer_published(customer_id, published_at desc)`

#### `packages`（单表单实体，无 `package_versions`）

与 [spec.md](./spec.md) **FR-016** / **FR-060** 一致：**一行即一个产品包**，主键 **`package_id`** 为订阅、计费与 OpenAPI **`packageId`** 的真源；**不**使用递增 `version` 列或独立版本表作为契约层模型。历史库若存在 `package_versions`，由迁移 `20260422100001_packages_single_entity.sql` 折叠入本表（原 `package_version_id` → `package_id`），并令 `subscriptions.package_id` 等外键指向 `packages.package_id`。

与实现查询列一致（见 `src/services/package.ts` 中 **`PACKAGE_ROW_SELECT`**；**Phase 34** 起持久化 **仅四模块 FK**，正文 JSON **不**存于包行）：

| 列 | 类型 | 约束 | 说明 |
|----|------|------|------|
| package_id | uuid | PK, default gen_random_uuid() | 可售产品包行 ID（对外 **`packageId`** / 兼容别名 `packageVersionId`） |
| enterprise_id | uuid | NOT NULL, FK→tenants(tenant_id) | 企业租户（与 API `enterpriseId` 一致） |
| name | text | NOT NULL | 展示名称 |
| description | text | — | 对用户展示的产品包详细说明（可选） |
| status | text | NOT NULL, default 'DRAFT' | `DRAFT` / `PUBLISHED` / `DEPRECATED` |
| effective_from | timestamptz | — | 生效时间 |
| published_at | timestamptz | — | 发布时间（`PUBLISHED` 时由迁移/应用回填） |
| deprecated_at | timestamptz | — | 废弃时间（`DEPRECATED` 时回填） |
| carrier_service_id | uuid | FK→carrier_service_modules | Carrier Service 模块 |
| control_policy_id | uuid | FK→control_policy_modules | 控制策略模块 |
| commercial_terms_id | uuid | FK→commercial_terms_modules | 商业条款模块 |
| price_plan_id | uuid | NOT NULL, FK→price_plans | 资费计划快照行 |
| created_at | timestamptz | NOT NULL, default now() | 创建时间 |
| updated_at | timestamptz | NOT NULL, default now() | 更新时间 |

**已删除列（迁移 `20260426100001_packages_drop_denormalized_jsonb.sql`）**：`commercial_terms`、`control_policy`、`carrier_service_config`、`roaming_profile`（jsonb）。**读路径**通过 **`price_plan_id`、`carrier_service_id`、`commercial_terms_id`、`control_policy_id`** JOIN 对应快照表组装 OpenAPI 形状。

**已删除列（迁移 `20260428100001_packages_drop_redundant_carrier_columns.sql`）**：`supplier_id`、`operator_id`、`service_type`、`apn`。对外 **`supplierId` / `operatorId` / `serviceType` / `apn`** 由应用在读路径从 **`carrier_service_modules`**、**`price_plans.service_type`**、**`apn_profiles`**（经 `apn_profile_id`）拼装。

**已删除列（迁移 `20260429100001_packages_description_drop_throttling.sql`）**：`throttling_policy`（jsonb，历史遗留；节流规则以 **`control_policy_modules.control_policy`** 为真源）。

**索引（迁移已建）**: `idx_packages_enterprise_status(enterprise_id, status)`、`idx_packages_price_plan_id`、`idx_packages_carrier_service_id`、`idx_packages_commercial_terms_id`、`idx_packages_control_policy_id`

**四模块绑定**（同一行上）：
- 模块 1：Price Plan → `price_plan_id`
- 模块 2：Carrier Service → `carrier_service_id`（内含 APN / Roaming Profile 引用）
- 模块 3：Commercial Terms → `commercial_terms_id`
- 模块 4：Control Policy → `control_policy_id`

#### `default_fallback_package_mappings`（无订阅用量兜底 Package 映射）[V1.1]

当 SIM 产生 usage 但在 `usage_day` 找不到任何有效订阅时，Rating 不应猜测订阅，也不应直接丢入长期 `unclassified_mb`。本表维护 **`enterprise_id + reseller_id + supplier_id + operator_id -> package_id`** 的唯一 ACTIVE 映射，将一个普通已发布 Package 设置为该 enterprise 在该 reseller/supplier/operator 下的 Default Fallback Package。

| 列 | 类型 | 约束 | 说明 |
|----|------|------|------|
| mapping_id | uuid | PK, default gen_random_uuid() | 映射 ID |
| enterprise_id | uuid | NOT NULL, FK→tenants(tenant_id) | 企业租户；必须与 `package_id` 归属企业一致 |
| reseller_id | uuid | NOT NULL, FK→tenants(tenant_id) | 代理商租户 |
| supplier_id | uuid | NOT NULL, FK→suppliers | 供应商 |
| operator_id | uuid | NOT NULL, FK→operators | 运营商 |
| package_id | uuid | NOT NULL, FK→packages(package_id) | 普通 Package；不是专用 package type，也不创建 subscription |
| status | text | NOT NULL, default `ACTIVE`; CHECK `ACTIVE` / `INACTIVE` | 映射状态 |
| created_by | uuid | — | 创建者 |
| updated_by | uuid | — | 最近更新者 |
| created_at | timestamptz | NOT NULL, default now() | 创建时间 |
| updated_at | timestamptz | NOT NULL, default now() | 更新时间 |

**唯一约束**：`UNIQUE(enterprise_id, reseller_id, supplier_id, operator_id) WHERE status='ACTIVE'`，确保同一个四元组最多一条 ACTIVE fallback package 映射。历史停用映射保留用于审计。

**Rating 口径**：命中本表时，`usage_package_daily_summary.subscription_id` 为 `null`，`package_id` 指向 fallback package，并通过 metadata 标记 `fallbackPackage=true`、`fallbackReason=NO_ACTIVE_SUBSCRIPTION`。无 ACTIVE 映射时，usage 才进入 `unclassified_mb` 数据质量桶。

### 4.5 订阅

#### `subscriptions`
| 列 | 类型 | 约束 | 说明 |
|----|------|------|------|
| subscription_id | uuid | PK, default gen_random_uuid() | 订阅 ID |
| enterprise_id | uuid | NOT NULL, FK→tenants(tenant_id) | 企业租户（与 API `enterpriseId` 一致） |
| sim_id | uuid | NOT NULL, FK→sim_cards / sims | SIM |
| subscription_kind | subscription_kind | NOT NULL, default 'MAIN' | 主/叠加 |
| package_id | uuid | NOT NULL, FK→packages | 产品包（`packages.package_id`；迁移前列名为 `package_version_id`） |
| state | subscription_state | NOT NULL, default 见实现 | 状态；**立即创建**默认 **`PROVISIONING`**；预约为 **`PENDING`**；上游成功后 **`ACTIVE`**；**上游失败时删除行**（不保留失败态） |
| effective_at | timestamptz | NOT NULL | 生效时间 |
| expires_at | timestamptz | — | 到期时间 |
| cancelled_at | timestamptz | — | 取消时间 |
| first_subscribed_at | timestamptz | — | 首次订阅时间 |
| commitment_end_at | timestamptz | — | 承诺期结束 |
| created_at | timestamptz | NOT NULL, default now() | 创建时间 |

**索引**: `idx_subscriptions_sim_effective(sim_id, effective_at)`；建议 `idx_subscriptions_package_id(package_id)`（按产品包反查订阅、废弃 Package 前占用校验）

### 4.6 用量

#### `cdr_files`
| 列 | 类型 | 约束 | 说明 |
|----|------|------|------|
| cdr_file_id | uuid | PK, default gen_random_uuid() | CDR 文件 ID |
| supplier_id | uuid | NOT NULL, FK→suppliers | 供应商 |
| file_name | text | NOT NULL | 文件名 |
| checksum | text | — | 校验和 |
| row_count | bigint | — | 行数 |
| source_time_zone | text | — | 源时区 |
| period_start | timestamptz | — | 账期开始 |
| period_end | timestamptz | — | 账期结束 |
| received_at | timestamptz | — | 接收时间 |
| ingested_at | timestamptz | — | 入库时间 |
| status | text | NOT NULL, default 'RECEIVED' | 状态 |
| | | UNIQUE(supplier_id, file_name) | 幂等唯一 |

#### `usage_daily_summary`
| 列 | 类型 | 约束 | 说明 |
|----|------|------|------|
| usage_id | bigserial | PK | 用量 ID |
| supplier_id | uuid | NOT NULL, FK→suppliers | 供应商 |
| enterprise_id | uuid | FK→tenants/customers | 企业 |
| sim_id | uuid | FK→sim_cards | SIM |
| iccid | text | NOT NULL | ICCID |
| usage_day | date | NOT NULL | 用量日期 |
| visited_mccmnc | text | NOT NULL | 到访 MCC+MNC |
| uplink_mb | numeric | NOT NULL, default 0 | 上行 MB |
| downlink_mb | numeric | NOT NULL, default 0 | 下行 MB |
| total_mb | numeric | NOT NULL, default 0 | 原始总流量 MB |
| in_profile_mb | numeric | NOT NULL, default 0 | 已由 rating 判定为 covered / in-profile 的用量 MB，包含包内、covered overage 与 tiered volume |
| out_of_profile_mb | numeric | NOT NULL, default 0 | 已由 rating 判定为 OOP roaming / PAYG / 规则缺失等非 covered 用量 MB |
| unclassified_mb | numeric | NOT NULL, default 0 | 尚未完成 rating 或无法归类的用量 MB |
| rated_at | timestamptz | — | 最近一次分类聚合回写时间 |
| apn | text | — | APN |
| rat | text | — | 接入技术 |
| input_ref | text | — | 来源引用 |
| created_at | timestamptz | NOT NULL, default now() | 创建时间 |
| updated_at | timestamptz | NOT NULL, default now() | 更新时间 |
| | | UNIQUE(iccid, usage_day, visited_mccmnc) | 幂等唯一 |

**索引**: `idx_usage_customer_day(customer_id, usage_day)`（历史命名）、`idx_usage_sim_day(sim_id, usage_day)`；分类聚合列用于 Alerts、Reports、Dashboard 等跨模块读取。`in_profile_mb + out_of_profile_mb + unclassified_mb` 不强制等于 `total_mb`，以容忍舍入、迟到话单、重放和未批价数据。

#### `usage_monthly_summary`
| 列 | 类型 | 约束 | 说明 |
|----|------|------|------|
| usage_month_id | bigserial | PK | 月汇总 ID |
| supplier_id | uuid | NOT NULL, FK→suppliers | 供应商 |
| enterprise_id | uuid | FK→tenants | 企业 |
| sim_id | uuid | FK→sims | SIM |
| iccid | text | NOT NULL | ICCID |
| usage_month | date | NOT NULL | 自然月首日（UTC），如 `2026-07-01` |
| visited_mccmnc | text | NOT NULL | 拜访地 MCC+MNC（与日表同维） |
| uplink_mb / downlink_mb / total_mb | numeric | NOT NULL, default 0 | 该月该拜访地累计量 |
| in_profile_mb / out_of_profile_mb / unclassified_mb | numeric | NOT NULL, default 0 | 自日表分类列求和（批价后才有意义） |
| rated_at | timestamptz | — | 日表 `rated_at` 最大值 |
| rolled_up_at | timestamptz | NOT NULL | 最近一次月 rollup 时间 |
| input_ref | text | — | 来源（job id 等） |
| created_at / updated_at | timestamptz | NOT NULL | |
| | | UNIQUE(iccid, usage_month, visited_mccmnc) | 幂等唯一 |

**管理口径**：由 `USAGE_MONTHLY_ROLLUP`（及日表写入后对**过往自然月**的自动刷新）从 `usage_daily_summary` 聚合写入；**不**绑定出账任务；**不**表达跨月 ONE_TIME / 套餐配额。Reports 对完整过往自然月优先读本表，当月与残月读日表。

**索引**: `idx_usage_monthly_enterprise_month`, `idx_usage_monthly_sim_month`, `idx_usage_monthly_month`。

### 4.7 账单

#### `bills`
| 列 | 类型 | 约束 | 说明 |
|----|------|------|------|
| bill_id | uuid | PK, default gen_random_uuid() | 账单 ID |
| customer_id | uuid | NOT NULL, FK→customers | 企业 |
| period_start | date | NOT NULL | 账期开始 |
| period_end | date | NOT NULL | 账期结束 |
| status | bill_status | NOT NULL, default 'GENERATED' | 状态 |
| currency | text | NOT NULL | 币种 |
| total_amount | numeric(12,2) | NOT NULL, default 0 | 总金额 |
| due_date | date | — | 到期日 |
| generated_at | timestamptz | — | 生成时间 |
| published_at | timestamptz | — | 发布时间 |
| paid_at | timestamptz | — | 支付时间 |
| paid_amount | numeric(12,2) | — | mark-paid 录入实收金额（审计用，不与 total_amount 强校验） |
| payment_ref | text | — | 支付凭证号（mark-paid 必填 `paymentRef`） |
| payment_proof | text | — | 可选付款佐证（mark-paid 可选 `paymentProof`，如银行转账流水备注） |
| written_off_at | timestamptz | — | 坏账核销时间 |
| write_off_reason | text | — | 核销原因（write-off 必填 `reason`） |
| created_at | timestamptz | NOT NULL, default now() | 创建时间 |
| | | UNIQUE(customer_id, period_start, period_end) | 账期唯一 |

#### `bill_line_items`
| 列 | 类型 | 约束 | 说明 |
|----|------|------|------|
| line_item_id | bigserial | PK | 行项 ID |
| bill_id | uuid | NOT NULL, FK→bills | 账单 |
| item_type | text | NOT NULL | 项目类型 |
| sim_id | uuid | — | SIM |
| package_id | uuid | — | 产品包（`packages.package_id`，L3 追溯） |
| amount | numeric(12,2) | NOT NULL | 金额 |
| metadata | jsonb | — | 元数据 |
| created_at | timestamptz | NOT NULL, default now() | 创建时间 |

### 4.8 调账

#### `adjustment_notes`
| 列 | 类型 | 约束 | 说明 |
|----|------|------|------|
| note_id | uuid | PK, default gen_random_uuid() | 调账单 ID |
| enterprise_id | uuid | NOT NULL, FK→tenants | 企业（**ENTERPRISE tenant_id**） |
| source_bill_id | uuid | FK→bills.bill_id, nullable | 关联原账单（手工 **`:adjust`**）；迁移 **20260621100005** |
| note_type | note_type | NOT NULL | 类型 **CREDIT** / **DEBIT** |
| status | note_status | NOT NULL, default DRAFT | **DRAFT** / **APPROVED** / **APPLIED** |
| currency | text | NOT NULL | 币种 |
| total_amount | numeric(12,2) | NOT NULL, default 0 | 总金额（恒为正） |
| reason | text | — | 原因 |
| idempotency_key | text | nullable | 客户端幂等键；与 **source_bill_id** 联合唯一（非空时） |
| input_ref | text | — | 来源引用 |
| calculation_id | text | — | 计算 ID |
| created_at | timestamptz | NOT NULL, default now() | 创建时间 |

**索引**：`idx_adjustment_notes_source_bill_idempotency_key` — UNIQUE **(source_bill_id, idempotency_key)** WHERE 两者均非空（Phase 40）。

#### `adjustment_note_items`
| 列 | 类型 | 约束 | 说明 |
|----|------|------|------|
| note_item_id | bigserial | PK | 行项 ID |
| note_id | uuid | NOT NULL, FK→adjustment_notes | 调账单 |
| item_type | text | NOT NULL | 项目类型 |
| sim_id | uuid | — | SIM |
| amount | numeric(12,2) | NOT NULL | 金额 |
| metadata | jsonb | — | 元数据 |
| created_at | timestamptz | NOT NULL, default now() | 创建时间 |

### 4.9 计费结果

#### `rating_results`
| 列 | 类型 | 约束 | 说明 |
|----|------|------|------|
| rating_result_id | uuid | PK, default gen_random_uuid() | 结果 ID |
| calculation_id | text | NOT NULL | 计算 ID |
| customer_id | uuid | FK→customers | 企业 |
| sim_id | uuid | FK→sim_cards | SIM |
| iccid | text | — | ICCID |
| usage_day | date | — | 用量日期 |
| visited_mccmnc | text | — | MCC+MNC |
| input_ref | text | — | 来源引用 |
| matched_subscription_id | uuid | FK→subscriptions | 匹配订阅 |
| matched_package_id | uuid | FK→packages | 匹配产品包（`packages.package_id`） |
| matched_price_plan_id | uuid | FK→price_plans | 匹配资费快照 |
| classification | text | NOT NULL | 分类 |
| charged_mb | numeric(18,6) | — | 计费流量 (MB) |
| rate_per_mb | numeric(18,8) | — | 单价 (currency/MB) |
| amount | numeric(12,2) | NOT NULL, default 0 | 金额 |
| currency | text | — | 币种 |
| created_at | timestamptz | NOT NULL, default now() | 创建时间 |

**索引**: `idx_rating_results_calc(calculation_id)`, `idx_rating_results_customer_day(customer_id, usage_day)`

#### `usage_package_daily_summary`
| 列 | 类型 | 约束 | 说明 |
|----|------|------|------|
| usage_package_summary_id | uuid | PK, default gen_random_uuid() | Package 日汇总 ID |
| supplier_id | uuid | FK→suppliers | 供应商 |
| reseller_id | uuid | FK→tenants | 代理商 |
| enterprise_id | uuid | FK→tenants/customers | 企业 |
| sim_id | uuid | FK→sim_cards | SIM |
| iccid | text | — | ICCID |
| usage_day | date | NOT NULL | 用量日期 |
| visited_mccmnc | text | NOT NULL | 拜访地 MCC/MNC；保留该维度用于经营分析 |
| subscription_id | uuid | FK→subscriptions | 匹配订阅 |
| package_id | uuid | FK→packages | 匹配产品包 |
| price_plan_id | uuid | FK→price_plans | 匹配资费计划 |
| price_plan_type | text | — | 资费计划类型快照 |
| in_profile_mb | numeric | NOT NULL, default 0 | covered / in-profile 用量 MB，包含包内、covered overage 与 tiered volume |
| out_of_profile_mb | numeric | NOT NULL, default 0 | OOP roaming / PAYG / 规则缺失等非 covered 用量 MB |
| unclassified_mb | numeric | NOT NULL, default 0 | 无法归类或未完整匹配的用量 MB |
| amount | numeric(12,2) | NOT NULL, default 0 | 该粒度下 rating 金额合计 |
| currency | text | — | 币种 |
| calculation_id | text | — | 最近一次生成该汇总的 calculationId |
| rated_at | timestamptz | — | 最近一次 rating 回写时间 |
| created_at | timestamptz | NOT NULL, default now() | 创建时间 |
| updated_at | timestamptz | NOT NULL, default now() | 更新时间 |

**管理口径**：该表不由上游同步任务直接写入，而由 Billing / Rating 在生成 `rating_results` 后聚合派生。业务粒度为 `sim_id + usage_day + subscription_id + package_id + price_plan_id + visited_mccmnc`；同一粒度已存在时覆盖当前有效汇总，并通过 `calculation_id` / `rated_at` 保留最近一次批价追溯。保留 `visited_mccmnc` 是为了支持后续 OOP 来源网络、国家/运营商成本异常、Package 使用结构等经营分析。

**索引**: `idx_usage_package_daily_enterprise_day(enterprise_id, usage_day)`, `idx_usage_package_daily_package_day(package_id, usage_day)`, `idx_usage_package_daily_sim_day(sim_id, usage_day)`

### 4.10 分享链接

#### `share_links`
| 列 | 类型 | 约束 | 说明 |
|----|------|------|------|
| code | text | PK, CHECK(~'^[A-Za-z0-9]{8}$') | 分享码 |
| kind | text | NOT NULL, CHECK(in packages/bills) | 分享类型（`packages` 表示按 `package_id` 分享，无 `packageVersions`） |
| params | jsonb | NOT NULL, CHECK(object) | 参数 |
| reseller_id | uuid | FK→resellers, nullable | 代理商 |
| customer_id | uuid | FK→customers, nullable | 客户 |
| visibility | text | NOT NULL, default 'tenant' | 可见性 |
| expires_at | timestamptz | NOT NULL | 过期时间 |
| created_at | timestamptz | NOT NULL, default now() | 创建时间 |
| created_by_role | text | NOT NULL, default 'ENTERPRISE' | 创建角色 |
| request_id | text | — | 请求 ID |

## 5. 新增表（基于差距分析）

### 5.1 `reseller_branding` — 代理商白标配置

```sql
CREATE TABLE IF NOT EXISTS reseller_branding (
  branding_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reseller_id uuid NOT NULL REFERENCES resellers(id) UNIQUE,
  brand_name text,
  logo_url text,
  custom_domain text,
  primary_color text,
  secondary_color text,
  currency text NOT NULL DEFAULT 'CNY',
  created_at timestamptz NOT NULL DEFAULT current_timestamp,
  updated_at timestamptz NOT NULL DEFAULT current_timestamp
);
```

**用途**: 代理商白标能力（FR-003），同时承载代理商结算币种配置。

### 5.2 `dunning_records` — 信控催收记录

```sql
CREATE TABLE IF NOT EXISTS dunning_records (
  dunning_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES customers(id),
  bill_id uuid NOT NULL REFERENCES bills(bill_id),
  dunning_status dunning_status NOT NULL DEFAULT 'NORMAL',
  overdue_since date,
  grace_period_days int NOT NULL DEFAULT 3,
  suspend_triggered_at timestamptz,
  interruption_triggered_at timestamptz,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT current_timestamp,
  updated_at timestamptz NOT NULL DEFAULT current_timestamp,
  UNIQUE(customer_id, bill_id)
);

CREATE INDEX IF NOT EXISTS idx_dunning_customer_status
  ON dunning_records(customer_id, dunning_status);
```

**用途**: Dunning Process 时间轴追踪（US7, FR-033）。

### 5.3 `dunning_actions` — 信控催收动作日志

```sql
CREATE TABLE IF NOT EXISTS dunning_actions (
  action_id bigserial PRIMARY KEY,
  dunning_id uuid NOT NULL REFERENCES dunning_records(dunning_id),
  action_type text NOT NULL,  -- 'OVERDUE_NOTIFICATION', 'SUSPEND', 'SERVICE_INTERRUPT', 'RESOLVE'
  channel text,               -- 'EMAIL', 'SMS', 'WEBHOOK'
  delivery_status text,       -- 'SENT', 'FAILED', 'PENDING'
  metadata jsonb,
  created_at timestamptz NOT NULL DEFAULT current_timestamp
);
```

**用途**: 催收动作审计（逾期提醒、停机、复机等操作记录）。

### 5.4 `alerts` — 告警记录

```sql
CREATE TYPE alert_severity AS ENUM ('P0', 'P1', 'P2', 'P3');
CREATE TYPE alert_status AS ENUM ('OPEN', 'ACKED', 'RESOLVED', 'SUPPRESSED');

CREATE TABLE IF NOT EXISTS alerts (
  alert_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  alert_type alert_type NOT NULL,
  severity alert_severity NOT NULL,
  status alert_status NOT NULL DEFAULT 'OPEN',
  rule_id uuid,
  rule_version int,
  reseller_id uuid NOT NULL REFERENCES resellers(id),
  customer_id uuid REFERENCES customers(id),
  sim_id uuid REFERENCES sim_cards(id),
  threshold numeric,
  current_value numeric,
  window_start timestamptz NOT NULL,
  window_end timestamptz,
  first_seen_at timestamptz NOT NULL DEFAULT current_timestamp,
  last_seen_at timestamptz NOT NULL DEFAULT current_timestamp,
  acknowledged_at timestamptz,
  acknowledged_by uuid REFERENCES users(id),
  suppressed_until timestamptz,
  delivery_channels text[],
  metadata jsonb,
  created_at timestamptz NOT NULL DEFAULT current_timestamp,
  updated_at timestamptz NOT NULL DEFAULT current_timestamp,
  UNIQUE(reseller_id, sim_id, alert_type, window_start)
);

CREATE INDEX IF NOT EXISTS idx_alerts_reseller_type
  ON alerts(reseller_id, alert_type, created_at);
CREATE INDEX IF NOT EXISTS idx_alerts_status
  ON alerts(status, severity, created_at);
```

**用途**: 告警去重与抑制，`UNIQUE` 约束实现去重键。

### 5.5 `alert_type_catalog` / `alert_config_profiles` / `alert_config_items` — 告警配置 ABC 模型

```sql
CREATE TABLE IF NOT EXISTS alert_type_catalog (
  alert_type alert_type PRIMARY KEY,
  enabled boolean NOT NULL DEFAULT true,
  allowed_scope_types text[] NOT NULL,
  default_severity alert_severity NOT NULL,
  default_threshold_value numeric,
  default_threshold_unit text,
  default_window_minutes int,
  default_suppress_minutes int NOT NULL DEFAULT 30,
  default_delivery_channels text[] NOT NULL DEFAULT ARRAY['PORTAL']::text[],
  default_delivery_targets jsonb NOT NULL DEFAULT '{}'::jsonb,
  default_threshold_config jsonb NOT NULL DEFAULT '{}'::jsonb,
  display_name text NOT NULL,
  description text,
  sort_order int NOT NULL DEFAULT 100,
  created_at timestamptz NOT NULL DEFAULT current_timestamp,
  updated_at timestamptz NOT NULL DEFAULT current_timestamp,
  CHECK (allowed_scope_types <@ ARRAY['PLATFORM','RESELLER','ENTERPRISE']::text[]),
  CHECK (default_threshold_unit IS NULL OR default_threshold_unit IN ('PERCENT', 'KB', 'MB', 'GB', 'HOURS', 'MINUTES', 'ATTEMPTS', 'COUNT')),
  CHECK (default_window_minutes IS NULL OR default_window_minutes > 0),
  CHECK (default_suppress_minutes >= 0),
  CHECK (default_delivery_channels <@ ARRAY['PORTAL','EMAIL','WEBHOOK']::text[])
);

CREATE TABLE IF NOT EXISTS alert_config_profiles (
  config_profile_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope_type text NOT NULL,
  reseller_id uuid REFERENCES tenants(tenant_id),
  enterprise_id uuid REFERENCES tenants(tenant_id),
  status text NOT NULL DEFAULT 'ACTIVE',
  name text,
  description text,
  version int NOT NULL DEFAULT 1,
  created_by uuid REFERENCES users(user_id),
  updated_by uuid REFERENCES users(user_id),
  created_at timestamptz NOT NULL DEFAULT current_timestamp,
  updated_at timestamptz NOT NULL DEFAULT current_timestamp,
  CHECK (scope_type IN ('PLATFORM', 'RESELLER', 'ENTERPRISE')),
  CHECK (status IN ('ACTIVE', 'INACTIVE')),
  CHECK (
    (scope_type = 'PLATFORM' AND reseller_id IS NULL AND enterprise_id IS NULL)
    OR (scope_type = 'RESELLER' AND reseller_id IS NOT NULL AND enterprise_id IS NULL)
    OR (scope_type = 'ENTERPRISE' AND reseller_id IS NOT NULL AND enterprise_id IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_alert_config_profiles_platform_active
  ON alert_config_profiles ((status))
  WHERE scope_type = 'PLATFORM' AND status = 'ACTIVE';

CREATE UNIQUE INDEX IF NOT EXISTS uq_alert_config_profiles_reseller_active
  ON alert_config_profiles (reseller_id)
  WHERE scope_type = 'RESELLER' AND status = 'ACTIVE';

CREATE UNIQUE INDEX IF NOT EXISTS uq_alert_config_profiles_enterprise_active
  ON alert_config_profiles (enterprise_id)
  WHERE scope_type = 'ENTERPRISE' AND status = 'ACTIVE';

CREATE TABLE IF NOT EXISTS alert_config_items (
  config_item_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  config_profile_id uuid NOT NULL REFERENCES alert_config_profiles(config_profile_id) ON DELETE CASCADE,
  alert_type alert_type NOT NULL REFERENCES alert_type_catalog(alert_type),
  enabled boolean NOT NULL DEFAULT true,
  severity alert_severity NOT NULL,
  threshold_value numeric,
  threshold_unit text,
  window_minutes int,
  suppress_minutes int NOT NULL DEFAULT 30,
  delivery_channels text[] NOT NULL DEFAULT ARRAY['PORTAL']::text[],
  delivery_targets jsonb NOT NULL DEFAULT '{}'::jsonb,
  threshold_config jsonb NOT NULL DEFAULT '{}'::jsonb,
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT current_timestamp,
  updated_at timestamptz NOT NULL DEFAULT current_timestamp,
  UNIQUE (config_profile_id, alert_type),
  CHECK (threshold_unit IS NULL OR threshold_unit IN ('PERCENT', 'KB', 'MB', 'GB', 'HOURS', 'MINUTES', 'ATTEMPTS', 'COUNT')),
  CHECK (window_minutes IS NULL OR window_minutes > 0),
  CHECK (suppress_minutes >= 0),
  CHECK (delivery_channels <@ ARRAY['PORTAL','EMAIL','WEBHOOK']::text[])
);

CREATE INDEX IF NOT EXISTS idx_alert_config_items_type
  ON alert_config_items(alert_type, config_profile_id);
```

**用途**: ABC 三表是 V1.1 告警配置真源。`alert_type_catalog` 定义系统已实现的 7 类告警、允许配置的 scope 与默认配置；`alert_config_profiles` 表达 PLATFORM / RESELLER / ENTERPRISE 的配置表对象，同一 scope 实体同时最多一份 `ACTIVE` profile；`alert_config_items` 表达某份配置表中的具体 alertType 配置项，同一 profile 下 `alert_type` 唯一。规则引擎按 ENTERPRISE → RESELLER → PLATFORM → built-in 顺序解析启用状态、阈值、窗口、抑制与投递配置；更具体 scope 的 `enabled=false` 阻断上层配置。旧 `alert_rule_configs` 单表仅作为 Phase 43 兼容与数据迁移来源，不再作为新增配置入口。

### 5.6 `alert_deliveries` — 告警投递记录

```sql
CREATE TABLE IF NOT EXISTS alert_deliveries (
  delivery_id bigserial PRIMARY KEY,
  alert_id uuid NOT NULL REFERENCES alerts(alert_id) ON DELETE CASCADE,
  channel text NOT NULL,
  status text NOT NULL DEFAULT 'PENDING',
  target text,
  event_id uuid REFERENCES events(event_id),
  webhook_delivery_id bigint REFERENCES webhook_deliveries(delivery_id),
  error_code text,
  error_message text,
  delivered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT current_timestamp,
  updated_at timestamptz NOT NULL DEFAULT current_timestamp,
  CHECK (channel IN ('PORTAL', 'EMAIL', 'WEBHOOK')),
  CHECK (status IN ('PENDING', 'DELIVERED', 'FAILED', 'SKIPPED', 'NOT_IMPLEMENTED'))
);

CREATE INDEX IF NOT EXISTS idx_alert_deliveries_alert
  ON alert_deliveries(alert_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_alert_deliveries_status
  ON alert_deliveries(status, channel, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_alert_deliveries_webhook_delivery
  ON alert_deliveries(webhook_delivery_id)
  WHERE webhook_delivery_id IS NOT NULL;
```

**用途**: 告警投递结果追踪。V1.1 中 Portal 通道记录为 `DELIVERED`，Email 通道作为配置预留记录为 `NOT_IMPLEMENTED`，Webhook 通道复用 `events(ALERT_TRIGGERED)` 与 `webhook_deliveries`，并通过 `webhook_delivery_id` 建立关联。

### 5.7 告警事件与审计

V1.1 不新增独立 `alert_audits` 专表；告警审计统一写入通用 `audit_logs`：

- `ALERT_CREATE` / `ALERT_MERGE`：由 worker / service 在创建或合并告警时写入，`actor_role='SYSTEM'`
- `ALERT_ACKNOWLEDGE`：由 `POST /v1/alerts/{alertId}:acknowledge` 写入，记录确认前后状态与 `actor_user_id`
- `ALERT_RULE_CONFIG_UPSERT` / `ALERT_RULE_CONFIG_PATCH`：由 `POST/PATCH /v1/alert-configs` 写入，记录配置变更前后快照

对应事件写入 `events`：新建告警通过 `emitEvent(ALERT_TRIGGERED)` 进入出站 Webhook 目录；合并、确认、规则配置变更写内部追踪事件 `ALERT_MERGED`、`ALERT_ACKNOWLEDGED`、`ALERT_RULE_CONFIG_CHANGED`，用于查询与审计追踪，配置变更不回写历史告警。

### 5.8 `config_parameters` — 配置中心参数

```sql
CREATE TABLE IF NOT EXISTS config_parameters (
  param_id bigserial PRIMARY KEY,
  param_key text NOT NULL,
  scope_type text NOT NULL DEFAULT 'GLOBAL',
  scope_id uuid,
  value text NOT NULL,
  value_type text NOT NULL DEFAULT 'string',
  version int NOT NULL DEFAULT 1,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT current_timestamp,
  updated_at timestamptz NOT NULL DEFAULT current_timestamp,
  UNIQUE(param_key, scope_type, scope_id, version)
);

CREATE INDEX IF NOT EXISTS idx_config_params_key
  ON config_parameters(param_key, scope_type, scope_id);
```

**用途**: 支持参数模板、动态热更新与版本回滚。

### 5.9 `api_availability_metrics` — API 可用性指标

```sql
CREATE TABLE IF NOT EXISTS api_availability_metrics (
  metric_id bigserial PRIMARY KEY,
  supplier_id uuid REFERENCES suppliers(id),
  api_group text NOT NULL,
  http_status int NOT NULL,
  response_ms int NOT NULL,
  ssl_handshake_ms int,
  collected_at timestamptz NOT NULL DEFAULT current_timestamp
);

CREATE INDEX IF NOT EXISTS idx_api_metrics_group_time
  ON api_availability_metrics(api_group, collected_at);
```

**用途**: 上游 API 可用性与性能监控。

### 5.10 `task_execution_events` — 任务执行事件

```sql
CREATE TABLE IF NOT EXISTS task_execution_events (
  event_id bigserial PRIMARY KEY,
  task_type text NOT NULL,
  business_line text,
  worker_group text,
  started_at timestamptz NOT NULL,
  finished_at timestamptz,
  duration_ms int,
  status text NOT NULL,
  metadata jsonb
);

CREATE INDEX IF NOT EXISTS idx_task_events_time
  ON task_execution_events(task_type, started_at);
```

**用途**: 分布式任务耗时监控与积压检测。

### 5.11 `cdr_file_sync` — CDR 文件到达监控

```sql
CREATE TABLE IF NOT EXISTS cdr_file_sync (
  sync_id bigserial PRIMARY KEY,
  supplier_id uuid REFERENCES suppliers(id),
  province text,
  network_node text,
  file_type text NOT NULL,
  expected_at timestamptz NOT NULL,
  arrived_at timestamptz,
  status text NOT NULL DEFAULT 'PENDING',
  metadata jsonb
);

CREATE INDEX IF NOT EXISTS idx_cdr_sync_time
  ON cdr_file_sync(file_type, expected_at);
```

**用途**: CDR 迟到检测与补采调度。

### 5.12 `policy_execute_log` — 控制策略执行日志

```sql
CREATE TABLE IF NOT EXISTS policy_execute_log (
  log_id bigserial PRIMARY KEY,
  policy_id uuid NOT NULL,
  policy_type text NOT NULL,
  sim_id uuid REFERENCES sim_cards(id),
  status text NOT NULL,
  failure_reason text,
  executed_at timestamptz NOT NULL DEFAULT current_timestamp,
  metadata jsonb
);

CREATE INDEX IF NOT EXISTS idx_policy_log_time
  ON policy_execute_log(policy_id, executed_at);
```

**用途**: 策略执行失败统计与自动冻结。

### 5.13 `quota_usage_snapshots` — 配额使用快照

```sql
CREATE TABLE IF NOT EXISTS quota_usage_snapshots (
  snapshot_id bigserial PRIMARY KEY,
  scope_type text NOT NULL,
  scope_id uuid NOT NULL,
  usage_percent numeric NOT NULL,
  remaining_mb numeric,
  estimated_exhausted_at timestamptz,
  collected_at timestamptz NOT NULL DEFAULT current_timestamp
);

CREATE INDEX IF NOT EXISTS idx_quota_snapshots_scope_time
  ON quota_usage_snapshots(scope_type, scope_id, collected_at);
```

**用途**: 配额余量监控与趋势计算。

### 5.14 `webhook_subscriptions` — Webhook 订阅配置

```sql
CREATE TABLE IF NOT EXISTS webhook_subscriptions (
  webhook_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reseller_id uuid REFERENCES tenants(tenant_id),
  enterprise_id uuid REFERENCES tenants(tenant_id),
  url text NOT NULL,
  secret text NOT NULL,       -- HMAC-SHA256 签名密钥
  event_types text[] NOT NULL, -- Scheme A: exactly one outbound event type per subscription
  enabled boolean NOT NULL DEFAULT true,
  description text,
  created_at timestamptz NOT NULL DEFAULT current_timestamp,
  updated_at timestamptz NOT NULL DEFAULT current_timestamp,
  CHECK (reseller_id IS NOT NULL OR enterprise_id IS NOT NULL)
);
```

**用途**: Webhook 投递配置（US11, FR-039），支持 HMAC-SHA256 签名。企业级订阅同时写入 **`reseller_id`**（父代理商）与 **`enterprise_id`**；仅代理商级订阅时 `enterprise_id` 为空。列名与 `jobs` / `events` 对齐（`customer_id` → `enterprise_id`，迁移 `20260808100001`）。

**唯一性（方案 A，迁移 `20260808120001` → `20260825120001`）**:
- 列 **`status`**: `ACTIVE` / `INACTIVE` / `DEPRECATED`
- 列 **`deprecated_at`**: deprecate 操作时间（迁移 `20260808130001`）；live 行为 null
- **`event_types`**: **必须恰好 1 个**元素（CHECK `cardinality(event_types) = 1`）；一条订阅 = 一类事件 = 一个 URL
- 部分唯一索引：同一 **`enterprise_id` + `event_types[1]`** 至多一条 `ACTIVE|INACTIVE`；reseller-level（`enterprise_id IS NULL`）同一 **`reseller_id` + `event_types[1]`** 至多一条
- **POST `:deprecate`** → `DEPRECATED` + `deprecated_at`（让出唯一位）；创建冲突 → **409 DUPLICATE**
- `enabled=true` ↔ `ACTIVE`；`enabled=false` 且未删 ↔ `INACTIVE`（仍占唯一位）
- **PATCH**：仅通过 `enabled` 切换 ACTIVE/INACTIVE（请求体无 `status`）；已 DEPRECATED → **409**；废弃用 `:deprecate`；可改 `eventType`（不得与同 scope 下另一 live 订阅冲突）
- **GET list**：默认返回 `ACTIVE` / `INACTIVE` / `DEPRECATED`；可用 `status` 查询参数收窄
- API 响应同时返回 **`eventType`**（单值）与 **`eventTypes`**（长度为 1 的兼容数组）

### 5.15 `webhook_deliveries` — Webhook 投递记录

```sql
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  delivery_id bigserial PRIMARY KEY,
  webhook_id uuid NOT NULL REFERENCES webhook_subscriptions(webhook_id),
  event_id uuid NOT NULL REFERENCES events(event_id),
  attempt int not null default 1,
  status text NOT NULL DEFAULT 'PENDING', -- PENDING, SENT, FAILED
  response_code int,
  response_body text,
  next_retry_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT current_timestamp
);

CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_status
  ON webhook_deliveries(status, next_retry_at);
```

**用途**: Webhook 投递追踪与重试（指数退避至少 3 次）。

### 5.16 `vendor_product_mappings` — 上游产品映射

**真源**：[clarifications/subscription-provisioning-upstream-mapping.md](./clarifications/subscription-provisioning-upstream-mapping.md)

**语义（Phase 28+ 收紧）**：

- **1 个 `PUBLISHED` Package ⇔ 至多 1 条映射**
- **`supplier_id` MUST** 与 Package → `carrier_service_modules.supplier_id` **一致**；**由服务端在 `POST …/packages/{id}:publish` 时推导写入**，**MUST NOT** 由映射 CRUD 客户端任意指定其它 supplier
- **标准写入路径**：Package **`:publish`** 请求体 `externalProductId`；独立 `POST /v1/vendor-product-mappings` 仅运维补录

```sql
CREATE TABLE IF NOT EXISTS vendor_product_mappings (
  mapping_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  package_id uuid NOT NULL REFERENCES packages(package_id),
  supplier_id uuid NOT NULL REFERENCES suppliers(id),
  external_product_id text NOT NULL,
  provisioning_parameters jsonb,
  created_at timestamptz NOT NULL DEFAULT current_timestamp,
  UNIQUE(package_id)
);
```

> **迁移说明**：自 `UNIQUE(package_id, supplier_id)` 收紧为 **`UNIQUE(package_id)`** 的迁移待实现（见 tasks.md）。存量环境在迁移前应保证每 Package 至多一条映射。

**用途**: CMP `packageId` ↔ 上游 `external_product_id`；订阅 **`SUBSCRIPTION_PROVISION` Job** 读取本表调用 SPI `changePlan`。

### 5.17 `provisioning_orders` — 开通同步订单

```sql
CREATE TABLE IF NOT EXISTS provisioning_orders (
  order_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id uuid NOT NULL REFERENCES subscriptions(subscription_id),
  supplier_id uuid NOT NULL REFERENCES suppliers(id),
  sim_id uuid NOT NULL REFERENCES sim_cards(id),
  action text NOT NULL,       -- 'ACTIVATE', 'SUSPEND', 'CHANGE_PLAN', 'TERMINATE'
  provisioning_status provisioning_status NOT NULL DEFAULT 'PROVISIONING_IN_PROGRESS',
  idempotency_key text NOT NULL UNIQUE,
  scheduled_at timestamptz,
  attempted_at timestamptz,
  completed_at timestamptz,
  retry_count int NOT NULL DEFAULT 0,
  error_detail text,
  metadata jsonb,
  created_at timestamptz NOT NULL DEFAULT current_timestamp
);

CREATE INDEX IF NOT EXISTS idx_provisioning_orders_status
  ON provisioning_orders(provisioning_status, scheduled_at);
```

**用途**: 开通同步状态管理（US8），支持即时/预约两种模式。

### 5.9 `reconciliation_runs` — 对账执行记录

```sql
CREATE TABLE IF NOT EXISTS reconciliation_runs (
  run_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_id uuid NOT NULL REFERENCES suppliers(id),
  run_date date NOT NULL,
  total_checked bigint NOT NULL DEFAULT 0,
  mismatches bigint NOT NULL DEFAULT 0,
  mismatch_details jsonb,
  status text NOT NULL DEFAULT 'RUNNING', -- RUNNING, COMPLETED, FAILED
  started_at timestamptz NOT NULL DEFAULT current_timestamp,
  finished_at timestamptz,
  UNIQUE(supplier_id, run_date)
);
```

**用途**: 每日 Reconciliation 任务记录（US8）。

## 6. 已有表字段扩展

> **说明**: Section 4.3 `sim_cards` 为 CMP.xlsx 目标模型。当前 API 运行时仍使用 `public.sims`（见迁移 `20260311100001_core_schema.sql`）。以下列出对**运行时表**及其他已有表的增量 DDL。

### 6.0 `sims` — IME Lock（运行时）

```sql
-- 20260516100001_sims_imei_lock_enabled.sql
ALTER TABLE public.sims
  ADD COLUMN IF NOT EXISTS imei_lock_enabled boolean NOT NULL DEFAULT false;

UPDATE public.sims
SET imei_lock_enabled = true
WHERE bound_imei IS NOT NULL AND btrim(bound_imei) <> '';
```

| 列 | API | 说明 |
|----|-----|------|
| `imei_lock_enabled` | `imeiLockEnabled` | IME Lock 开关 |
| `bound_imei` | `imei` | 15 位设备 IMEI；Lock 开启时必填 |

导入/创建时 `imeiLockEnabled` 与 `imei` 须成对（同开或同关）。

### 6.1 `bills` 新增字段

```sql
ALTER TABLE bills
  ADD COLUMN IF NOT EXISTS reseller_id uuid REFERENCES resellers(id),
  ADD COLUMN IF NOT EXISTS payment_ref text,
  ADD COLUMN IF NOT EXISTS overdue_at timestamptz;
```

**用途**: 补充代理商维度和逾期追踪字段。

### 6.2 `bill_line_items` 新增字段（L2 交叉分组支持）

```sql
ALTER TABLE bill_line_items
  ADD COLUMN IF NOT EXISTS department_id uuid REFERENCES departments(id),  -- L2 分组：部门维度
  ADD COLUMN IF NOT EXISTS package_id uuid,                                -- L2 分组：产品包维度
  ADD COLUMN IF NOT EXISTS group_subtotal numeric(12,2);                   -- L2 分组小计
```

**用途**: 支持 L2 交叉分组汇总层（`department_id × package_id`）。每条 L3 明细行同时记录 `department_id` 和 `package_id`，L2 汇总视图按此二维度 GROUP BY 生成（US6, FR-030）。

### 6.3 `jobs` 组织与幂等字段

历史迁移曾新增 `reseller_id` / `customer_id` / `idempotency_key` / `file_hash`。企业归属列已重命名为 **`enterprise_id`**（FK→`tenants.tenant_id`，ENTERPRISE；见迁移 `20260804100001_jobs_rename_customer_id_to_enterprise_id.sql`）。

```sql
ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS reseller_id uuid REFERENCES tenants(tenant_id),
  ADD COLUMN IF NOT EXISTS enterprise_id uuid REFERENCES tenants(tenant_id),
  ADD COLUMN IF NOT EXISTS idempotency_key text,
  ADD COLUMN IF NOT EXISTS file_hash text;
```

**用途**: 批量导入幂等（batchId/fileHash）和组织关联（代理商/企业维度）。

## 7. 索引策略

### 7.1 已有索引（迁移至新表名）

| 表 | 索引 | 列 |
|----|------|-----|
| sim_cards | idx_sim_cards_reseller_status | reseller_id, status |
| sim_cards | idx_sim_cards_customer | customer_id |
| sim_cards | idx_sim_cards_supplier | supplier_id |
| sim_state_history | idx_sim_state_history_sim_time | sim_id, start_time |
| esim_profiles | idx_esim_profiles_reseller_status | reseller_id, status |
| esim_profiles | idx_esim_profiles_customer | customer_id |
| esim_profiles | idx_esim_profiles_supplier | supplier_id |
| esim_profiles | idx_esim_profiles_smdp | smdp_system_id |
| esim_state_history | idx_esim_state_history_profile_time | esim_profile_id, start_time |
| events | idx_events_type_time | event_type, occurred_at |
| subscriptions | idx_subscriptions_sim_effective | sim_id, effective_at |
| usage_daily_summary | idx_usage_customer_day | customer_id, usage_day |
| rating_results | idx_rating_results_calc | calculation_id |
| rating_results | idx_rating_results_customer_day | customer_id, usage_day |

> **变更说明**: 已移除旧 `tenants` 表索引 (idx_tenants_parent, idx_tenants_type)，由独立表各自的索引取代。`sims` → `sim_cards` 索引已在建表 DDL 中定义。

### 7.2 建议新增索引

| 表 | 索引 | 列 | 用途 |
|----|------|-----|------|
| sim_cards | idx_sim_cards_iccid | iccid | 已有 UNIQUE 约束隐式索引 |
| sim_cards | idx_sim_cards_operator | operator_id | 运营商维度 SIM 查询 |
| customers | idx_customers_reseller | reseller_id | 代理商下属客户查询 |
| users | idx_users_reseller | reseller_id | 代理商用户查询 |
| users | idx_users_customer | customer_id | 客户用户查询 |
| bills | idx_bills_status_due | status, due_date | 逾期账单查询（Dunning） |
| bills | idx_bills_reseller | reseller_id | 代理商维度账单汇总 |
| subscriptions | idx_subscriptions_customer | customer_id, state | 客户活跃订阅查询 |
| usage_daily_summary | idx_usage_sim_day | sim_id, usage_day | 计费引擎 SIM 维度查询 |
| audit_logs | idx_audit_actor_time | actor_user_id, created_at | 操作者审计查询 |
| upstream_integrations | idx_upstream_supplier | supplier_id | 供应商集成查询 |

## 8. 分区策略

### 8.1 usage_daily_summary 分区

按月分区（PostgreSQL Declarative Partitioning）：

```sql
-- 转为分区表（新部署时）
CREATE TABLE usage_daily_summary_partitioned (
  LIKE usage_daily_summary INCLUDING ALL
) PARTITION BY RANGE (usage_day);

-- 按月创建分区
CREATE TABLE usage_daily_summary_2026_01 PARTITION OF usage_daily_summary_partitioned
  FOR VALUES FROM ('2026-01-01') TO ('2026-02-01');
CREATE TABLE usage_daily_summary_2026_02 PARTITION OF usage_daily_summary_partitioned
  FOR VALUES FROM ('2026-02-01') TO ('2026-03-01');
```

### 8.2 rating_results 分区

按 usage_day 月分区，与 usage_daily_summary 对齐。

### 8.3 归档策略

- **在线保留**: 6 个月
- **冷存储**: 移至归档表（`_archive` 后缀），保留 5 年
- **账单数据**: 永久保留

## 9. RLS 策略概要

已有 RLS 策略文件：
- `0004_rls_policies.sql` — 核心表 RLS
- `0008_bills_rls.sql` — 账单 RLS

新增表需补充 RLS 策略，确保：
- 代理商仅可访问自身及下属企业数据
- 企业仅可访问自身数据
- 部门用户仅可访问所属部门数据
- 系统管理员无数据隔离限制

## 10. 迁移计划

新增表和字段将通过以下迁移文件实现：

| 序号 | 迁移文件 | 内容 |
|------|---------|------|
| 0019 | add_new_enums.sql | 新增 ENUM: reseller_status, customer_status, operator_status, sim_form_factor, cdr_method, role_scope, user_status |
| 0020 | create_independent_org_tables.sql | suppliers, operators, upstream_integrations, resellers, customers 独立表（替代 tenants） |
| 0021 | create_rbac_tables.sql | permissions, roles, role_permissions RBAC 三表 + 预置数据 (7 角色, 38+ 权限) |
| 0022 | migrate_users_table.sql | users 表重构: 移除旧 FK, 添加 role_id/reseller_id/customer_id, 数据迁移 |
| 0023 | rename_sims_to_sim_cards.sql | sims → sim_cards 重命名 + 新增字段 (multi-IMSI, form_factor, IMEI lock, 四方归属链) |
| 0024 | add_reseller_branding.sql | reseller_branding 表 |
| 0025 | add_dunning_tables.sql | dunning_records + dunning_actions 表 |
| 0026 | add_alerts_table.sql | alerts 表 + alert_type ENUM |
| 0027 | add_webhook_tables.sql | webhook_subscriptions + webhook_deliveries 表 |
| 0028 | add_vendor_mappings.sql | vendor_product_mappings 表 |
| 0029 | add_provisioning_orders.sql | provisioning_orders 表 + provisioning_status ENUM |
| 0030 | add_reconciliation_runs.sql | reconciliation_runs 表 |
| 0031 | extend_bills_fields.sql | bills 新增 reseller_id/payment_ref/overdue_at + bill_line_items L2 分组字段 |
| 0032 | extend_jobs_fields.sql | jobs 新增 reseller_id/customer_id/idempotency_key/file_hash（customer_id 后由 20260804100001 重命名为 enterprise_id） |
| 0033 | update_fk_references.sql | 已有表 FK 引用更新 (enterprise_id → customers, sim_id → sim_cards, operator_id 等) |
| 0034 | add_new_indexes.sql | 新增索引（独立表 + RBAC + SIM 四方归属） |
| 0035 | update_rls_policies.sql | 基于独立表和 RBAC 重写 RLS 策略 |

> **重要**: 迁移 0020-0023 为破坏性迁移，需要数据迁移脚本将 `tenants` + `user_roles` 中的数据迁移到新独立表。建议在预发布环境充分验证后再执行。


