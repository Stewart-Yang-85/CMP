# Data Model: IoT CMP Reseller System

**Feature**: `iot-cmp-reseller` | **Date**: 2026-02-08 | **Spec**: [spec.md](./spec.md)

## 1. 概述

本文档定义 IoT CMP Reseller System 的完整数据模型，包括已有表结构、新增表/字段，以及各实体间的关系。数据库采用 **Supabase（PostgreSQL 15+）**，已有 18 个迁移文件定义了核心 Schema。

## 2. ENUM 类型

### 2.1 已有 ENUM（12 种）

| ENUM | 值 | 用途 |
|------|-----|------|
| `sim_status` | INVENTORY, TEST_READY, ACTIVATED, DEACTIVATED, RETIRED | SIM 生命周期 |
| `subscription_state` | PENDING, ACTIVE, CANCELLED, EXPIRED | 订阅状态 |
| `job_status` | QUEUED, RUNNING, SUCCEEDED, FAILED, CANCELLED | 异步任务状态 |
| `bill_status` | GENERATED, PUBLISHED, PAID, OVERDUE, WRITTEN_OFF | 账单状态 |
| `service_type` | DATA, VOICE, SMS | 电信业务类型 |
| `billing_cycle_type` | CALENDAR_MONTH, CUSTOM_RANGE | 计费周期类型 |
| `first_cycle_proration` | NONE, DAILY_PRORATION | 首期分摊 |
| `price_plan_type` | ONE_TIME, SIM_DEPENDENT_BUNDLE, FIXED_BUNDLE, TIERED_VOLUME_PRICING | 资费计划类型 |
| `note_type` | CREDIT, DEBIT | 调账单类型 |
| `note_status` | DRAFT, APPROVED, APPLIED, CANCELLED | 调账单状态 |
| `subscription_kind` | MAIN, ADD_ON | 订阅种类 |
| `user_status` | ACTIVE, INACTIVE, LOCKED | 用户状态 |

> **变更说明**: `tenant_type` 和 `enterprise_status` ENUM 已移除，由独立表各自的 status 字段取代。

### 2.2 新增 ENUM（CMP.xlsx 对齐）

| ENUM | 值 | 用途 |
|------|-----|------|
| `reseller_status` | active, deactivated, suspended | 代理商状态 |
| `customer_status` | active, overdue, terminated | 客户（企业）状态 |
| `operator_status` | active, deprecated, error | 运营商状态（含废弃工作流） |
| `sim_form_factor` | consumer_removable, industrial_removable, consumer_embedded, industrial_embedded | SIM 卡形态 |
| `cdr_method` | sftp, api | CDR 话单拉取方式 |
| `role_scope` | platform, reseller, customer | 角色适用范围 |
| `dunning_status` | NORMAL, OVERDUE_WARNING, SUSPENDED, SERVICE_INTERRUPTED | 信控状态 |
| `provisioning_status` | PROVISIONING_IN_PROGRESS, ACTIVE, PROVISIONING_FAILED, SCHEDULED_ON_SUPPLIER, SCHEDULED_LOCALLY | 开通同步状态 |
| `alert_type` | POOL_USAGE_HIGH, OUT_OF_PROFILE_SURGE, SILENT_SIM, UNEXPECTED_ROAMING, CDR_DELAY, UPSTREAM_DISCONNECT | 告警类型 |
| `smdp_status` | active, deactivated, suspended | SM-DP+ 系统状态 |
| `smdp_environment` | test, production | SM-DP+ 系统环境 |
| `esim_form_factor` | esim_profile, other | eSIM 形态 |
| `smdp_profile_status` | created, downloaded, enabled, disabled, deleted | SM-DP+ Profile 远程状态 |

## 3. 实体关系图（ER Summary）

```
── 组织层 ──────────────────────────────────────────────────────

suppliers ──1:N──┐                      operators
    │            ▼                          │
    │   upstream_integrations ◄──N:1────────┘
    │     (supplier_id + operator_id UNIQUE)
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
    │                  ├──1:N──> price_plans ──1:N──> price_plan_versions
    │                  │
    │                  ├──1:N──> packages ──1:N──> package_versions
    │                  │                              │
    │                  │                    (price_plan_version_id)
    │                  │
    │                  ├──1:N──> subscriptions
    │                  │              │
    │                  │         (sim_id, package_version_id)
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

#### `operators` — 运营商（替代旧 `carriers`）

| 列 | 类型 | 约束 | 说明 |
|----|------|------|------|
| id | uuid | PK, default gen_random_uuid() | 运营商 ID |
| name | text | NOT NULL | 运营商名称 |
| mcc | char(3) | NOT NULL | 移动国家代码 |
| mnc | varchar(3) | NOT NULL | 移动网络代码 |
| apn_default | text | — | 默认 APN |
| roaming_profile_id | uuid | — | 漫游配置 ID |
| status | operator_status | NOT NULL, default 'active' | active / deprecated / error |
| replaced_by_id | uuid | FK→operators(id), nullable | 废弃后的替代运营商 |
| deprecation_reason | text | — | 废弃原因 |
| created_by | uuid | — | 创建者 |
| created_at | timestamptz | NOT NULL, default now() | 创建时间 |
| updated_at | timestamptz | NOT NULL, default now() | 更新时间 |
| | | UNIQUE(mcc, mnc) | E.212 唯一约束 |

> **废弃工作流**: status=deprecated 的运营商不可用于新 SIM 分配，已有 SIM 保持服务。replaced_by_id 指向接替运营商。

#### `upstream_integrations` — 上游集成配置（替代旧 `supplier_carriers`）

| 列 | 类型 | 约束 | 说明 |
|----|------|------|------|
| id | uuid | PK, default gen_random_uuid() | 集成 ID |
| supplier_id | uuid | NOT NULL, FK→suppliers | 供应商 |
| operator_id | uuid | NOT NULL, FK→operators | 运营商 |
| api_endpoint | text | — | API 端点 |
| api_key | text | — | API Key |
| api_secret_encrypted | bytea | — | API Secret（加密存储） |
| cdr_enabled | boolean | NOT NULL, default false | 是否启用 CDR |
| cdr_method | cdr_method | — | CDR 拉取方式 sftp / api |
| cdr_endpoint | text | — | CDR 端点 |
| cdr_username | text | — | CDR 用户名 |
| cdr_password_encrypted | bytea | — | CDR 密码（加密存储） |
| cdr_path | text | — | CDR 文件路径 |
| cdr_file_pattern | text | — | CDR 文件名模式 |
| enabled | boolean | NOT NULL, default true | 是否启用 |
| created_by | uuid | — | 创建者 |
| created_at | timestamptz | NOT NULL, default now() | 创建时间 |
| updated_at | timestamptz | NOT NULL, default now() | 更新时间 |
| | | UNIQUE(supplier_id, operator_id) | 供应商-运营商唯一 |

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
| status | customer_status | NOT NULL, default 'active' | active / overdue / terminated |
| api_key | text | UNIQUE, nullable | M2M API Key（企业自助接入） |
| api_secret_hash | bytea | — | API Secret 哈希（bcrypt/scrypt） |
| webhook_url | text | — | 事件回调 URL |
| auto_suspend_enabled | boolean | NOT NULL, default true | 是否允许自动信控 |
| created_by | uuid | — | 创建者 |
| created_at | timestamptz | NOT NULL, default now() | 创建时间 |
| updated_at | timestamptz | NOT NULL, default now() | 更新时间 |
| | | UNIQUE(reseller_id, name) | 同代理商客户名称唯一 |

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

#### `events`
| 列 | 类型 | 约束 | 说明 |
|----|------|------|------|
| event_id | uuid | PK, default gen_random_uuid() | 事件 ID |
| event_type | text | NOT NULL | 事件类型 |
| occurred_at | timestamptz | NOT NULL | 发生时间 |
| reseller_id | uuid | FK→resellers, nullable | 代理商范围 |
| customer_id | uuid | FK→customers, nullable | 客户范围 |
| actor_user_id | uuid | — | 操作者 |
| request_id | text | — | 请求 ID |
| job_id | uuid | — | 关联 Job |
| payload | jsonb | NOT NULL | 事件负载 |

**索引**: `idx_events_type_time(event_type, occurred_at)`

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
| payload | jsonb | — | 任务负载（0016 新增） |
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
| status | sim_status | NOT NULL, default 'INVENTORY' | SIM 状态 |
| primary_product_package_id | uuid | FK→packages, nullable | 当前主套餐产品包 |
| total_data_usage_kb | bigint | NOT NULL, default 0 | 累计数据用量 (KB) |
| imei | varchar(15) | — | 绑定 IMEI |
| imei_lock_enabled | boolean | NOT NULL, default false | 是否启用 IMEI 锁定 |
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

#### `price_plans`
| 列 | 类型 | 约束 | 说明 |
|----|------|------|------|
| price_plan_id | uuid | PK, default gen_random_uuid() | 资费计划 ID |
| customer_id | uuid | NOT NULL, FK→customers | 企业 |
| name | text | NOT NULL | 名称 |
| type | price_plan_type | NOT NULL | 类型 |
| service_type | service_type | NOT NULL, default 'DATA' | 业务类型 |
| currency | text | NOT NULL | 币种 |
| billing_cycle_type | billing_cycle_type | NOT NULL, default 'CALENDAR_MONTH' | 计费周期 |
| first_cycle_proration | first_cycle_proration | NOT NULL, default 'NONE' | 首期分摊 |
| created_at | timestamptz | NOT NULL, default now() | 创建时间 |

#### `price_plan_versions`
| 列 | 类型 | 约束 | 说明 |
|----|------|------|------|
| price_plan_version_id | uuid | PK, default gen_random_uuid() | 版本 ID |
| price_plan_id | uuid | NOT NULL, FK→price_plans | 资费计划 |
| version | int | NOT NULL | 版本号 |
| effective_from | timestamptz | — | 生效时间 |
| monthly_fee | numeric(12,2) | NOT NULL, default 0 | 月租费 |
| deactivated_monthly_fee | numeric(12,2) | NOT NULL, default 0 | 停机保号费 |
| one_time_fee | numeric(12,2) | — | 一次性费用 |
| quota_kb | bigint | — | 配额 (KB) |
| validity_days | int | — | 有效期 (天) |
| per_sim_quota_kb | bigint | — | 每 SIM 配额 |
| total_quota_kb | bigint | — | 总池配额 |
| overage_rate_per_kb | numeric(18,8) | — | 套外单价 |
| tiers | jsonb | — | 阶梯费率 |
| payg_rates | jsonb | — | PAYG 费率 |
| created_at | timestamptz | NOT NULL, default now() | 创建时间 |
| | | UNIQUE(price_plan_id, version) | 版本唯一 |

**`tiers` JSONB 结构**:
```json
[
  { "thresholdKb": 1048576, "ratePerKb": 0.01 },
  { "thresholdKb": 5242880, "ratePerKb": 0.008 },
  { "thresholdKb": null, "ratePerKb": 0.005 }
]
```

**`payg_rates` JSONB 结构**:
```json
[
  {
    "zoneCode": "ZONE_EU",
    "countries": ["208-01", "262-*", "234-*"],
    "ratePerKb": 0.005
  },
  {
    "zoneCode": "ZONE_REST",
    "countries": ["*"],
    "ratePerKb": 0.02
  }
]
```

#### `packages`
| 列 | 类型 | 约束 | 说明 |
|----|------|------|------|
| package_id | uuid | PK, default gen_random_uuid() | 产品包 ID |
| customer_id | uuid | NOT NULL, FK→customers | 企业 |
| name | text | NOT NULL | 名称 |
| created_at | timestamptz | NOT NULL, default now() | 创建时间 |

#### `package_versions`
| 列 | 类型 | 约束 | 说明 |
|----|------|------|------|
| package_version_id | uuid | PK, default gen_random_uuid() | 版本 ID |
| package_id | uuid | NOT NULL, FK→packages | 产品包 |
| version | int | NOT NULL | 版本号 |
| status | text | NOT NULL, default 'DRAFT' | 状态 |
| effective_from | timestamptz | — | 生效时间 |
| supplier_id | uuid | NOT NULL, FK→suppliers | 供应商 |
| operator_id | uuid | NOT NULL, FK→operators | 运营商 |
| service_type | service_type | NOT NULL, default 'DATA' | 业务类型 |
| apn | text | — | APN |
| roaming_profile | jsonb | — | 漫游配置 |
| throttling_policy | jsonb | — | 限速策略 |
| control_policy | jsonb | — | 控制策略 |
| commercial_terms | jsonb | — | 商业条款 |
| price_plan_version_id | uuid | NOT NULL, FK→price_plan_versions | 资费版本 |
| created_at | timestamptz | NOT NULL, default now() | 创建时间 |
| | | UNIQUE(package_id, version) | 版本唯一 |

#### `cutoff_policies`
| 列 | 类型 | 约束 | 说明 |
|----|------|------|------|
| cutoff_policy_id | uuid | PK, default gen_random_uuid() | 达量断网策略 ID |
| customer_id | uuid | NOT NULL, FK→customers | 企业 |
| name | text | NOT NULL | 名称 |
| time_window | text | NOT NULL | DAILY / MONTHLY |
| threshold_mb | integer | NOT NULL | 达量阈值（MB） |
| action | text | NOT NULL, default 'DEACTIVATED' | 动作 |
| enabled | boolean | NOT NULL, default true | 是否启用 |
| created_at | timestamptz | NOT NULL, default now() | 创建时间 |
| updated_at | timestamptz | NOT NULL, default now() | 更新时间 |
| | | UNIQUE(customer_id, name) | 企业内唯一 |

#### `throttling_policies`
| 列 | 类型 | 约束 | 说明 |
|----|------|------|------|
| throttling_policy_id | uuid | PK, default gen_random_uuid() | 达量限速策略 ID |
| customer_id | uuid | NOT NULL, FK→customers | 企业 |
| name | text | NOT NULL | 名称 |
| time_window | text | NOT NULL | DAILY / MONTHLY |
| enabled | boolean | NOT NULL, default true | 是否启用 |
| created_at | timestamptz | NOT NULL, default now() | 创建时间 |
| updated_at | timestamptz | NOT NULL, default now() | 更新时间 |
| | | UNIQUE(customer_id, name) | 企业内唯一 |

#### `throttling_policy_tiers`
| 列 | 类型 | 约束 | 说明 |
|----|------|------|------|
| tier_id | bigserial | PK | 分层 ID |
| throttling_policy_id | uuid | NOT NULL, FK→throttling_policies | 策略 ID |
| threshold_mb | integer | NOT NULL | 达量阈值（MB） |
| downlink_kbps | integer | NOT NULL | 下行限速 Kbps |
| uplink_kbps | integer | NOT NULL | 上行限速 Kbps |
| created_at | timestamptz | NOT NULL, default now() | 创建时间 |
| | | UNIQUE(throttling_policy_id, threshold_mb) | 阈值唯一 |

**`control_policy` JSONB 结构**:
```json
{
  "enabled": true,
  "cutoffPolicyId": "uuid",
  "throttlingPolicyId": "uuid"
}
```

**`commercial_terms` JSONB 结构**:
```json
{
  "testPeriodDays": 30,
  "testQuotaKb": 10240,
  "testExpiryCondition": "PERIOD_OR_QUOTA",
  "testExpiryAction": "ACTIVATED",
  "commitmentPeriodMonths": 12
}
```

### 4.5 订阅

#### `subscriptions`
| 列 | 类型 | 约束 | 说明 |
|----|------|------|------|
| subscription_id | uuid | PK, default gen_random_uuid() | 订阅 ID |
| customer_id | uuid | NOT NULL, FK→customers | 企业 |
| sim_id | uuid | NOT NULL, FK→sim_cards | SIM |
| subscription_kind | subscription_kind | NOT NULL, default 'MAIN' | 主/叠加 |
| package_version_id | uuid | NOT NULL, FK→package_versions | 产品包版本 |
| state | subscription_state | NOT NULL, default 'ACTIVE' | 状态 |
| effective_at | timestamptz | NOT NULL | 生效时间 |
| expires_at | timestamptz | — | 到期时间 |
| cancelled_at | timestamptz | — | 取消时间 |
| first_subscribed_at | timestamptz | — | 首次订阅时间 |
| commitment_end_at | timestamptz | — | 承诺期结束 |
| created_at | timestamptz | NOT NULL, default now() | 创建时间 |

**索引**: `idx_subscriptions_sim_effective(sim_id, effective_at)`

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
| customer_id | uuid | FK→customers | 企业 |
| sim_id | uuid | FK→sim_cards | SIM |
| iccid | text | NOT NULL | ICCID |
| usage_day | date | NOT NULL | 用量日期 |
| visited_mccmnc | text | NOT NULL | 到访 MCC+MNC |
| uplink_kb | bigint | NOT NULL, default 0 | 上行 KB |
| downlink_kb | bigint | NOT NULL, default 0 | 下行 KB |
| total_kb | bigint | NOT NULL, default 0 | 总流量 KB |
| apn | text | — | APN |
| rat | text | — | 接入技术 |
| input_ref | text | — | 来源引用 |
| created_at | timestamptz | NOT NULL, default now() | 创建时间 |
| updated_at | timestamptz | NOT NULL, default now() | 更新时间 |
| | | UNIQUE(iccid, usage_day, visited_mccmnc) | 幂等唯一 |

**索引**: `idx_usage_customer_day(customer_id, usage_day)`

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
| created_at | timestamptz | NOT NULL, default now() | 创建时间 |
| | | UNIQUE(customer_id, period_start, period_end) | 账期唯一 |

#### `bill_line_items`
| 列 | 类型 | 约束 | 说明 |
|----|------|------|------|
| line_item_id | bigserial | PK | 行项 ID |
| bill_id | uuid | NOT NULL, FK→bills | 账单 |
| item_type | text | NOT NULL | 项目类型 |
| sim_id | uuid | — | SIM |
| package_version_id | uuid | — | 产品包版本 |
| amount | numeric(12,2) | NOT NULL | 金额 |
| metadata | jsonb | — | 元数据 |
| created_at | timestamptz | NOT NULL, default now() | 创建时间 |

### 4.8 调账

#### `adjustment_notes`
| 列 | 类型 | 约束 | 说明 |
|----|------|------|------|
| note_id | uuid | PK, default gen_random_uuid() | 调账单 ID |
| customer_id | uuid | NOT NULL, FK→customers | 企业 |
| note_type | note_type | NOT NULL | 类型 |
| status | note_status | NOT NULL, default 'DRAFT' | 状态 |
| currency | text | NOT NULL | 币种 |
| total_amount | numeric(12,2) | NOT NULL, default 0 | 总金额 |
| reason | text | — | 原因 |
| input_ref | text | — | 来源引用 |
| calculation_id | text | — | 计算 ID |
| created_at | timestamptz | NOT NULL, default now() | 创建时间 |

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
| matched_package_version_id | uuid | FK→package_versions | 匹配产品包版本 |
| matched_price_plan_version_id | uuid | FK→price_plan_versions | 匹配资费版本 |
| classification | text | NOT NULL | 分类 |
| charged_kb | bigint | — | 计费流量 |
| rate_per_kb | numeric(18,8) | — | 单价 |
| amount | numeric(12,2) | NOT NULL, default 0 | 金额 |
| currency | text | — | 币种 |
| created_at | timestamptz | NOT NULL, default now() | 创建时间 |

**索引**: `idx_rating_results_calc(calculation_id)`, `idx_rating_results_customer_day(customer_id, usage_day)`

### 4.10 分享链接

#### `share_links`
| 列 | 类型 | 约束 | 说明 |
|----|------|------|------|
| code | text | PK, CHECK(~'^[A-Za-z0-9]{8}$') | 分享码 |
| kind | text | NOT NULL, CHECK(in packages/packageVersions/bills) | 分享类型 |
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

### 5.5 `alert_rules` — 告警规则

```sql
CREATE TABLE IF NOT EXISTS alert_rules (
  rule_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_key text NOT NULL UNIQUE,
  rule_name text NOT NULL,
  rule_type text NOT NULL,
  severity alert_severity NOT NULL,
  threshold numeric,
  duration_minutes int,
  window_minutes int,
  suppress_minutes int NOT NULL DEFAULT 5,
  merge_minutes int NOT NULL DEFAULT 5,
  enabled boolean NOT NULL DEFAULT true,
  scope_type text NOT NULL DEFAULT 'GLOBAL',
  scope_id uuid,
  rule_params jsonb,
  route_policy jsonb,
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT current_timestamp,
  updated_at timestamptz NOT NULL DEFAULT current_timestamp
);

CREATE INDEX IF NOT EXISTS idx_alert_rules_scope
  ON alert_rules(scope_type, scope_id, enabled);
```

**用途**: 规则引擎统一维护阈值、窗口、路由与升级策略。

### 5.6 `alert_notifications` — 告警推送记录

```sql
CREATE TABLE IF NOT EXISTS alert_notifications (
  notification_id bigserial PRIMARY KEY,
  alert_id uuid NOT NULL REFERENCES alerts(alert_id),
  channel text NOT NULL,
  target text,
  status text NOT NULL DEFAULT 'PENDING',
  attempt int NOT NULL DEFAULT 0,
  last_error text,
  next_retry_at timestamptz,
  delivered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT current_timestamp
);

CREATE INDEX IF NOT EXISTS idx_alert_notifications_status
  ON alert_notifications(status, next_retry_at);
```

**用途**: 多通道推送投递与重试追踪。

### 5.7 `alert_audits` — 告警审计

```sql
CREATE TABLE IF NOT EXISTS alert_audits (
  audit_id bigserial PRIMARY KEY,
  alert_id uuid NOT NULL REFERENCES alerts(alert_id),
  action text NOT NULL,
  actor_id uuid REFERENCES users(id),
  actor_role text,
  note text,
  created_at timestamptz NOT NULL DEFAULT current_timestamp
);
```

**用途**: 告警认领、冻结策略、手工重试等审计轨迹。

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
  reseller_id uuid REFERENCES resellers(id),
  customer_id uuid REFERENCES customers(id),
  url text NOT NULL,
  secret text NOT NULL,       -- HMAC-SHA256 签名密钥
  event_types text[] NOT NULL, -- 订阅的事件类型列表
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT current_timestamp,
  updated_at timestamptz NOT NULL DEFAULT current_timestamp,
  CHECK (reseller_id IS NOT NULL OR customer_id IS NOT NULL)
);
```

**用途**: Webhook 投递配置（US11, FR-039），支持 HMAC-SHA256 签名。

### 5.15 `webhook_deliveries` — Webhook 投递记录

```sql
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  delivery_id bigserial PRIMARY KEY,
  webhook_id uuid NOT NULL REFERENCES webhook_subscriptions(webhook_id),
  event_id uuid NOT NULL REFERENCES events(event_id),
  attempt int NOT NULL DEFAULT 1,
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

```sql
CREATE TABLE IF NOT EXISTS vendor_product_mappings (
  mapping_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  package_version_id uuid NOT NULL REFERENCES package_versions(package_version_id),
  supplier_id uuid NOT NULL REFERENCES suppliers(id),
  external_product_id text NOT NULL,
  provisioning_parameters jsonb,
  created_at timestamptz NOT NULL DEFAULT current_timestamp,
  UNIQUE(package_version_id, supplier_id)
);
```

**用途**: 内部产品包与上游供应商产品的映射关系（US8）。

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

> **说明**: Section 4.3 `sim_cards` 表定义已包含所有 CMP.xlsx 对齐字段（multi-IMSI、form_factor、IMEI lock、四方归属链等），无需额外 ALTER。以下仅列出其他已有表需要扩展的字段。

### 6.1 `bills` 新增字段

```sql
ALTER TABLE bills
  ADD COLUMN IF NOT EXISTS reseller_id uuid REFERENCES resellers(id),
  ADD COLUMN IF NOT EXISTS payment_ref text,
  ADD COLUMN IF NOT EXISTS overdue_at timestamptz;
```

**用途**: 补充代理商维度和逾期追踪字段。

### 6.2 `bill_line_items` 新增字段（L2 分组支持）

```sql
ALTER TABLE bill_line_items
  ADD COLUMN IF NOT EXISTS group_key text,       -- 分组键：department_id / package_id
  ADD COLUMN IF NOT EXISTS group_type text,      -- 'DEPARTMENT' / 'PACKAGE'
  ADD COLUMN IF NOT EXISTS group_subtotal numeric(12,2);
```

**用途**: 支持 L2 分组汇总层（US6, FR-030）。

### 6.3 `jobs` 新增字段

```sql
ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS reseller_id uuid REFERENCES resellers(id),
  ADD COLUMN IF NOT EXISTS customer_id uuid REFERENCES customers(id),
  ADD COLUMN IF NOT EXISTS idempotency_key text,
  ADD COLUMN IF NOT EXISTS file_hash text;
```

**用途**: 批量导入幂等（batchId/fileHash）和组织关联（代理商/客户维度）。

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
| 0032 | extend_jobs_fields.sql | jobs 新增 reseller_id/customer_id/idempotency_key/file_hash |
| 0033 | update_fk_references.sql | 已有表 FK 引用更新 (enterprise_id → customers, sim_id → sim_cards, operator_id 等) |
| 0034 | add_new_indexes.sql | 新增索引（独立表 + RBAC + SIM 四方归属） |
| 0035 | update_rls_policies.sql | 基于独立表和 RBAC 重写 RLS 策略 |

> **重要**: 迁移 0020-0023 为破坏性迁移，需要数据迁移脚本将 `tenants` + `user_roles` 中的数据迁移到新独立表。建议在预发布环境充分验证后再执行。
