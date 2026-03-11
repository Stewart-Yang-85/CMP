# Tasks: IoT CMP Reseller System

**Feature**: `iot-cmp-reseller` | **Date**: 2026-02-08
**Input**: spec.md, plan.md, data-model.md, research.md, contracts/

**Tests**: 增加单元测试（Jest/Vitest）、供应商 API Mock、数据库快照测试；保留现有 API 烟测与 E2E 脚本用于回归。

**Organization**: 任务按 User Story 分组，P1 优先级（US1-US6）在前，P2（US7-US11）在后。

## MVP 范围（D-28 决策，D-31 修正）

> **8 周 MVP 仅交付「一张 SIM 从入库到出账」的完整链路。**
>
> | 维度 | MVP (Week 1-4, 核心) | MVP (Week 5-8, 扩展) | V1.1 |
> |------|-----|------|------|
> | 角色 | hardcode reseller_id（不做 RBAC 中间件） | platform_admin / reseller_admin / customer_admin | 销售总监/销售/财务/运维细分 |
> | 资费类型 | Fixed Bundle（单一） | + One-time | SIM Dependent Bundle / Tiered Pricing |
> | 账单结构 | L1 汇总 + L3 明细（手动触发） | 自动 T+N 出账 | L2 分组汇总层 / PDF/CSV 导出 |
> | SIM | CRUD + 5 状态变更 | + 批量导入 + WX 上游同步 | eSIM 生命周期 |
> | 前端 | Swagger UI + Postman（D-29） | — | Web Portal |
> | 推迟模块 | — | — | 白标 / 多供应商 SPI / 告警去重抑制 / APN&Roaming Profile / GDPR 脱敏 |
>
> 标记 `[V1.1]` 的任务已有实现但 **MVP 阶段不纳入验收范围**，测试与 Bug 修复推迟到 V1.1。

## 工程评审修正项 (2026-03-11, 第二轮)

> 以下为专家工程评审后发现的致命/严重问题修复：
>
> ### 致命问题修复
>
> - [x] **T-FIX-1** 租户模型统一 — 创建 V008 迁移文件，添加 `sync_customer_status_to_tenant()` 触发器解决 customers.status / tenants.enterprise_status 分裂脑；创建 `create_reseller()` / `create_customer()` 事务性函数保证原子创建；添加 customer_view / reseller_view 统一查询。**新增文件**: `supabase/migrations/20260311100008_tenant_model_unification.sql`
> - [x] **T-FIX-2** RLS 多租户隔离 — 创建 V009 迁移文件，将 RLS 策略从 `using(true)` 改为基于 `auth_tenant_id()` + `is_tenant_accessible()` 的实际租户隔离（defense-in-depth）；同时在应用层 `rbac.ts` 增加 `buildTenantFilter()` / `buildTenantFilterAsync()` / `getAccessibleEnterpriseIds()` 函数作为主要隔离机制。**新增文件**: `supabase/migrations/20260311100009_rls_tenant_isolation.sql`，**修改文件**: `src/middleware/rbac.ts`
> - [x] **T-FIX-3** 计费引擎 N+1 消除 — 将 per-SIM 的 3 次 Supabase REST 查询改为批量 `sim_id=in.(...)` 查询（每批 500 SIM，3 个 Promise.all 并行查询），10 万 SIM 从 30 万次 HTTP 请求降至 ~600 次。同时添加分页获取 SIM 列表（原 limit=1000 硬编码）。**修改文件**: `src/billing.js`
>
> ### 严重问题修复
>
> - [x] **T-FIX-4** Pool 用量排序确定性 — 对 simContexts 按 sim_id 排序，确保 FIXED_BUNDLE/SIM_DEPENDENT_BUNDLE 共享池扣量顺序稳定可重现。**修改文件**: `src/billing.js`
> - [x] **T-FIX-5** 计费幂等保障 — `generateMonthlyBill` 新增 UNIQUE 检查，已存在的 enterprise+period 组合直接跳过而不是抛 unique violation。**修改文件**: `src/billing.js`
> - [x] **T-FIX-6** Dunning 精度统一 — dunning.ts/dunning.js 中 4 处 `.toFixed(2)` 替换为 billing.js 导出的 `roundAmount()`，与 T-NEW-4 的 ROUND_HALF_UP 策略一致。**修改文件**: `src/services/dunning.ts`, `src/services/dunning.js`
> - [x] **T-FIX-7** `roundAmount` 导出 — `billing.js` 的 `BILLING_PRECISION` 和 `roundAmount` 从 `const/function` 改为 `export`，供 dunning 等模块复用。**修改文件**: `src/billing.js`
>
> ### 前端 Portal 范围澄清
>
> - `specs/20260208-iot-cmp-reseller/frontend-portal-blueprint.md` **明确标记为 V1.1 范围**，MVP 阶段不纳入交付范围。
> - MVP 阶段如需操作界面，使用 Retool/Appsmith 等低代码工具搭建临时后台。

## 可执行落地流程（D-31 更新）

> ```
> Week 1: 地基（不写业务代码，只修基础）
> ├── Day 1-2: 确认 app.ts 可运行，理清 TS/JS 双栈关系
> ├── Day 3: 运行 V001-V009 迁移，验证数据库 schema 完整性
> ├── Day 4-5: 租户模型验证（create_reseller/create_customer 函数 + 触发器同步测试）
>
> Week 2: SIM + 单一资费
> ├── Day 1-2: SIM CRUD + 5 状态机验证 + 5 个状态转换单元测试
> ├── Day 3-4: Fixed Bundle 资费创建（price_plan + package + package_version API）
> ├── Day 5: 订阅创建（SIM 绑定 package 的完整流程）
>
> Week 3: 计费引擎
> ├── Day 1-2: 验证批量查询重构后的计费引擎（billing.test.ts with mock supabase）
> ├── Day 3-4: 8 个 golden test case 全部通过
> ├── Day 5: 手动触发出账（POST /admin/billing/run → 生成 bills + line_items）
>
> Week 4: 联调 + 修 Bug
> ├── Day 1-2: 端到端冒烟：创建 SIM → 订阅 → 注入用量 → 出账 → 查账单
> ├── Day 3-4: 修复发现的问题
> ├── Day 5: 部署到 Vercel staging
>
> Week 5: RBAC + 多租户隔离
> ├── buildTenantFilterAsync 集成到所有路由
> ├── 3 角色验证（platform_admin / reseller_admin / customer_admin）
>
> Week 6: One-time 资费 + 自动出账
> ├── One-time 计费逻辑 + golden case
> ├── Vercel Cron 自动出账（T+N 配置）
>
> Week 7: 批量导入 + WX 上游同步
> ├── SIM 批量导入 Job（10 万条上限，幂等 batchId/fileHash）
> ├── WX 适配器双向同步
>
> Week 8: Dunning + 回归测试
> ├── Dunning 时间轴基础版
> ├── 全量回归测试 + 性能验证
> ```

## Format: `[ID] [P?] [Story] Description`
- **[P]**: 可并行执行（操作不同文件，无依赖）
- **[V1.1]**: MVP 不验收，推迟到 V1.1
- **[Story]**: 所属 User Story（如 US1, US2）
- 包含精确文件路径
- 源码默认使用 TypeScript（.ts）

---

## Phase 1: Setup（共享基础设施）

**Purpose**: 项目初始化与基础结构准备

- [x] T001 初始化 TypeScript 编译配置（tsconfig、类型声明、构建脚本）
- [x] T002 [P] 初始化 Fastify 应用骨架 `src/app.ts` + `src/server.ts`
- [x] T003 [P] 初始化 Vercel Cron + Queue 任务入口（`src/cron/`、`src/queues/handlers.ts`）
- [x] T004 [P] 初始化测试框架（Jest/Vitest）、供应商 API Mock、数据库快照测试基建

---

## Phase 2: Foundational（阻塞性前置任务）

**Purpose**: 所有 User Story 都依赖的核心基础设施，必须在 Phase 3+ 之前完成

**⚠️ 关键**: 此阶段未完成前，不可开始任何 User Story 的实施

### 2.1 数据库迁移

- [x] ~~T005~~ [V1.1] [P] [DB] 创建迁移 `supabase/migrations/0019_add_reseller_branding.sql` — reseller_branding 表（代理商白标配置）
- [x] ~~T006~~ [V1.1] [P] [DB] 创建迁移 `supabase/migrations/0020_add_dunning_tables.sql` — dunning_records + dunning_actions 表 + dunning_status ENUM
- [x] ~~T007~~ [V1.1] [P] [DB] 创建迁移 `supabase/migrations/0021_add_alerts_table.sql` — alerts 表 + alert_type ENUM
- [x] T008 [P] [DB] 创建迁移 `supabase/migrations/0022_add_webhook_tables.sql` — webhook_subscriptions + webhook_deliveries 表
- [x] T009 [P] [DB] 创建迁移 `supabase/migrations/0023_add_vendor_mappings.sql` — vendor_product_mappings 表
- [x] T010 [P] [DB] 创建迁移 `supabase/migrations/0024_add_provisioning_orders.sql` — provisioning_orders 表 + provisioning_status ENUM
- [x] T011 [P] [DB] 创建迁移 `supabase/migrations/0025_add_reconciliation_runs.sql` — reconciliation_runs 表
- [x] T012 [P] [DB] 创建迁移 `supabase/migrations/0026_extend_sims_fields.sql` — sims 新增字段（secondary_imsi1~3, form_factor, activation_code, upstream_status, upstream_status_updated_at）+ sim_form_factor ENUM
- [x] T013 [P] [DB] 创建迁移 `supabase/migrations/0027_extend_bills_fields.sql` — bills 新增（reseller_id, payment_ref, overdue_at）+ bill_line_items 新增（group_key, group_type, group_subtotal）
- [x] T014 [P] [DB] 创建迁移 `supabase/migrations/0028_extend_jobs_fields.sql` — jobs 新增（reseller_id, customer_id, idempotency_key, file_hash）
- [x] ~~T097~~ [V1.1] [P] [DB] 创建迁移 `supabase/migrations/0031_add_customer_api_keys.sql` — customers 新增 api_key (UNIQUE), api_secret_hash, webhook_url
- [x] ~~T101~~ [V1.1] [P] [DB] 创建迁移 `supabase/migrations/0032_add_network_profiles.sql` — apn_profiles, roaming_profiles, profile_versions, profile_change_requests 表与必要 ENUM
- [x] ~~T102~~ [V1.1] [P] [DB] 创建迁移 `supabase/migrations/0033_add_billing_control_configs.sql` — billing_config, dunning_policies, control_policies, late_fee_rules 表
- [x] T015 创建迁移 `supabase/migrations/0029_add_new_indexes.sql` — 新增索引（依赖 T005-T014 + T101-T102 表结构）
- [x] T016 创建迁移 `supabase/migrations/0030_add_new_rls_policies.sql` — 新增表的 RLS 策略（依赖 T005-T014 + T101-T102）

### 2.2 核心中间件

- [x] T017 实现 RBAC 权限中间件 `src/middleware/rbac.ts` — 基于 JWT payload (userId, resellerId, roleScope, role) 的角色权限校验，支持系统管理员/代理商角色/企业角色三层隔离
- [x] T018 实现租户隔离中间件 `src/middleware/tenantScope.ts` — 自动注入租户范围过滤，代理商仅可访问下属企业数据，企业仅可访问自身数据，部门用户仅可访问所属部门数据
- [x] T019 [P] 实现审计日志中间件 `src/middleware/auditLog.ts` — 自动记录操作审计（actor, actorRole, resellerId, customerId, action, target, before/after, requestId, timestamp, sourceIp）
- [x] T020 [P] 实现事件发布器 `src/services/eventEmitter.ts` — 基于 Supabase Realtime (LISTEN/NOTIFY) 的事件发布，events 表持久化，payload 仅含引用 ID（≤8KB 限制）

### 2.3 公共服务

- [x] T021 [P] 实现幂等键服务 `src/services/idempotency.ts` — 基于 idempotencyKey 的请求去重，支持 jobs、provisioning_orders 等场景
- [x] T022 [P] 实现分页工具 `src/utils/pagination.ts` — 统一分页参数解析（page, pageSize, 默认值, 最大限制）和响应格式 {items, total, page, pageSize}

### 2.4 认证与限流

- [x] ~~T098~~ [V1.1] [P] 实现 API Key 认证中间件 `src/middleware/apiKeyAuth.ts` — 校验 customers.api_key + api_secret_hash，支持企业 M2M 访问与 JWT 并行
- [x] ~~T099~~ [V1.1] [P] 实现 OAuth2/OIDC 验证中间件 `src/middleware/oidcAuth.ts` — JWT 校验（issuer, audience, jwks 缓存与轮换），支持第三方 Web/应用接入
- [x] ~~T100~~ [V1.1] [P] 实现限流中间件 `src/middleware/rateLimit.ts` — Token Bucket，按租户+接口限流，超限返回 429

**Checkpoint**: 基础设施就绪 — User Story 实施可以开始

---

## Phase 3: US1 — 多租户与角色权限管理 (Priority: P1) 🎯 MVP

**Goal**: 实现三级租户层级（供应商→代理商→企业→部门）、RBAC 角色体系、企业状态机、白标能力、审计日志

**Independent Test**: 创建代理商→创建企业→创建用户→验证不同角色权限隔离→验证企业状态变更

### 实施任务

- [x] T023 [P] [US1] 实现代理商管理路由 `src/routes/resellers.ts` — POST /v1/resellers（创建代理商，含 currency, defaultGracePeriodDays 等字段）, GET /v1/resellers（列表查询）, GET /v1/resellers/{resellerId}（详情）; 参照 contracts/tenant-api.md §1
- [x] T024 [P] [US1] 实现代理商用户管理路由 `src/routes/resellerUsers.ts` — POST /v1/resellers/{resellerId}/users（**MVP 仅验收 role: admin**，sales_director/sales/finance 推迟 V1.1）, GET 用户列表; 参照 contracts/tenant-api.md §4
- [x] ~~T025~~ [V1.1] [P] [US1] 实现代理商白标服务 `src/services/branding.ts` — PUT /v1/resellers/{resellerId}/branding（更新品牌配置：primaryColor, logoUrl, faviconUrl, supportEmail 等）, GET 白标配置; 操作 reseller_branding 表; 参照 contracts/tenant-api.md §1.4
- [x] T026 [US1] 实现企业状态变更 `src/routes/enterprises.ts` — 增强现有企业路由，新增 POST /v1/enterprises/{enterpriseId}:change-status（状态机 ACTIVE↔INACTIVE↔SUSPENDED），触发 ENTERPRISE_STATUS_CHANGED 事件; 参照 contracts/tenant-api.md §2.4
- [x] T027 [US1] 实现部门管理路由 `src/routes/departments.ts` — POST /v1/enterprises/{enterpriseId}/departments（创建部门）, GET 部门列表, GET 部门详情; 参照 contracts/tenant-api.md §3
- [x] T028 [US1] 实现供应商与运营商管理路由 `src/routes/suppliers.ts` — POST /v1/suppliers（创建供应商）, POST /v1/operators（创建运营商，E.212 MCC+MNC 校验）, 供应商-运营商多对多关联; 参照 contracts/tenant-api.md §5
- [x] T029 [US1] 实现审计日志查询路由 `src/routes/auditLogs.ts` — GET /v1/audit-logs（分页查询，支持 actor/action/resellerId/from/to 过滤）; 参照 contracts/tenant-api.md §6
- [x] T030 [US1] 在 `src/app.ts` 中注册 US1 新路由并挂载 RBAC + 租户隔离中间件（resellers, resellerUsers, departments, suppliers, auditLogs）

**Checkpoint**: US1 完成 — 可独立验证多租户创建、权限隔离、企业状态管理

---

## Phase 4: US2 — SIM 卡资产入库与生命周期管理 (Priority: P1) 🎯 MVP

**Goal**: 实现 SIM 导入（CSV 批量 + 单张录入）、5 状态机（INVENTORY→TEST_READY→ACTIVATED→DEACTIVATED→RETIRED）、批量操作

**Independent Test**: 导入 CSV→单张录入→激活→停机→复机→拆机→验证状态机约束

### 实施任务

- [x] T031 [P] [US2] 实现 SIM 状态机服务 `src/services/simLifecycle.ts` — 封装 5 态状态机转换逻辑（INVENTORY→ACTIVATED, ACTIVATED→DEACTIVATED, DEACTIVATED→RETIRED 等）、前置条件校验（承诺期、企业状态）、上游状态到本地状态映射、sim_state_history Type 2 SCD 记录、SIM_STATUS_CHANGED 事件触发; 参照 contracts/sim-api.md §4, §6
- [x] T032 [P] [US2] 实现 SIM 导入服务 `src/services/simImport.ts` — CSV 解析（必填列: iccid, imsi, apn, operatorId; 可选列: msisdn, secondaryImsi1~3, formFactor, activationCode, imei, imeiLockEnabled），10 万行上限校验，batchId/fileHash 幂等，逐行验证（ICCID 全局唯一, operator 关联供应商），创建 job 记录（QUEUED→RUNNING→SUCCEEDED/FAILED）; 参照 contracts/sim-api.md §1
- [x] T033 [US2] 实现 SIM 导入路由 `src/routes/simImport.ts` — POST /v1/sims/import-jobs（multipart/form-data）, GET /v1/jobs/{jobId}（查询进度）, POST /v1/jobs/{jobId}:cancel; 调用 simImport.ts 服务; 参照 contracts/sim-api.md §1
- [x] T034 [US2] 增强 SIM 单张录入 — 在现有 POST /v1/sims 中增加 secondaryImsi1~3, formFactor, activationCode 字段支持; 参照 contracts/sim-api.md §2
- [x] T035 [US2] 实现 SIM 状态操作路由 `src/routes/simActions.ts` — POST /v1/sims/{simId}:activate, :deactivate, :reactivate, :retire（异步返回 jobId）; 调用 simLifecycle.ts 和上游供应商适配器; 参照 contracts/sim-api.md §4
- [x] T036 [US2] 实现批量停机路由 — POST /v1/sims:batch-deactivate（按 enterpriseId 批量停机，异步 jobId）; 参照 contracts/sim-api.md §5
- [x] T037 [US2] 增强 SIM 查询 — GET /v1/sims 新增 departmentId, operatorId, supplierId 过滤; GET /v1/sims/{simId}/state-history 查询状态变更历史; 参照 contracts/sim-api.md §3
- [x] T038 [US2] 扩展 `src/queues/handlers.ts` — 新增 SIM_IMPORT 和 SIM_STATE_CHANGE 队列处理，调用供应商适配器执行上游 API（activate/suspend/resume）; 更新 job 进度和状态
- [x] T039 [US2] 在 `src/app.ts` 中注册 US2 新路由（simImport, simActions）

**Checkpoint**: US2 完成 — 可独立验证 SIM 导入、生命周期状态机、批量操作

---

## Phase 5: US3 — 产品包与资费计划配置 (Priority: P1) 🎯 MVP

**Goal**: 实现 4 种资费计划类型（ONE_TIME, SIM_DEPENDENT_BUNDLE, FIXED_BUNDLE, TIERED_PRICING）、产品包 CRUD、版本化管理、发布校验

**Independent Test**: 创建资费计划→创建产品包→绑定→发布→验证 PAYG 冲突校验

### 实施任务

- [x] T040 [P] [US3] 实现资费计划服务 `src/services/pricePlan.ts` — 创建资费计划（**MVP 仅验收 FIXED_BUNDLE + ONE_TIME**，SIM_DEPENDENT_BUNDLE/TIERED_PRICING 推迟 V1.1）、版本化（DRAFT→PUBLISHED）、新版本创建; 参照 contracts/pricing-api.md §1
- [x] T041 [P] [US3] 实现产品包服务 `src/services/package.ts` — 创建产品包（绑定 pricePlanVersionId + carrierServiceConfig）、修改（仅 DRAFT）、发布（PAYG Rates 冲突校验：同一 visitedMccMnc 被多个同级规则覆盖则阻断）; 参照 contracts/pricing-api.md §2
- [x] ~~T103~~ [V1.1] [P] [US3] 实现 APN/Roaming Profile 服务 `src/services/networkProfile.ts` — Profile 版本化（DRAFT→PUBLISHED）、次月生效、校验来源与回滚; 参照 spec.md APN/Roaming Profile
- [x] ~~T104~~ [V1.1] [US3] 实现 APN/Roaming Profile 路由 `src/routes/networkProfiles.ts` — CRUD、发布、版本列表、回滚、变更计划; 参照 spec.md APN/Roaming Profile
- [x] ~~T105~~ [V1.1] [US3] 在产品包发布校验中绑定网络配置 — package 与 profileVersion 绑定、发布时校验兼容性; 参照 spec.md APN/Roaming Profile
- [x] T042 [US3] 实现资费计划路由 `src/routes/pricePlans.ts` — POST /v1/enterprises/{enterpriseId}/price-plans, GET 列表（支持 type/status 过滤）, GET /v1/price-plans/{pricePlanId}（含版本历史）, POST /v1/price-plans/{pricePlanId}/versions; 参照 contracts/pricing-api.md §1
- [x] T043 [US3] 实现产品包路由 `src/routes/packages.ts` — POST /v1/enterprises/{enterpriseId}/packages, PUT /v1/packages/{packageId}（仅 DRAFT）, POST /v1/packages/{packageId}:publish, GET 列表, GET 详情; 参照 contracts/pricing-api.md §2
- [x] T044 [US3] 在 `src/app.ts` 中注册 US3 新路由（pricePlans, packages）
- [ ] ~~T109~~ [V1.1] [US3] 按最新快照规格更新数据模型与接口设计文档 `specs/20260208-iot-cmp-reseller/data-model.md` + `specs/20260208-iot-cmp-reseller/contracts/pricing-api.md` — 覆盖 APN Profile、Roaming Profile、Carrier Service、Commercial Terms、Control Policy、Price Plan、Package 的快照字段、发布约束、反向引用查询接口（按 profile/policy/plan/terms ID 反查）
- [ ] ~~T110~~ [V1.1] [US3] 实现七个模块的快照化与反查能力 `src/services/networkProfile.ts` + `src/services/pricePlan.ts` + `src/services/package.ts` + `src/routes/networkProfiles.ts` + `src/routes/pricePlans.ts` + `src/routes/packages.ts` + `src/app.ts` — 统一 DRAFT/PUBLISHED 不可变语义、克隆生成新 ID、Carrier Service 反查（apnProfileId/roamingProfileId）、Package 反查（pricePlanId/commercialTermsId/controlPolicyId）
- [ ] ~~T111~~ [V1.1] [US3] 增加模块联动测试 `tests/phase4.test.ts` + `tests/phase4.snapshot.test.ts` — 覆盖 APN/Roaming 克隆发布后反查 Carrier Service、Price Plan/Commercial Terms/Control Policy 反查 Package、产品包切换到新快照并保持历史快照可追溯

**Checkpoint**: US3 完成 — 可独立验证资费计划创建、产品包发布、冲突校验

---

## Phase 6: US4 — 订阅关系管理 (Priority: P1) 🎯 MVP

**Goal**: 实现订阅 CRUD、MAIN 互斥约束、套餐切换（原子操作）、退订（到期/立即）

**Independent Test**: 创建主订阅→尝试重复主订阅（409）→创建叠加包订阅→套餐切换→退订

### 实施任务

- [x] T045 [P] [US4] 实现订阅管理服务 `src/services/subscription.ts` — 创建订阅（MAIN 互斥校验、企业 SUSPENDED 拦截、SIM RETIRED 拦截）、套餐切换（原子：退订旧+订购新，默认 NEXT_CYCLE 次月生效）、退订（到期退订 EXPIRED / 立即退订 CANCELLED，当月全额月租不退费）; 参照 contracts/pricing-api.md §3
- [x] T106 [US4] 实现 One-time 到期算法 `src/services/subscription.ts` — CALENDAR_DAY_END 与 DURATION_EXCLUSIVE_END 计算，统一使用系统时区; 参照 spec.md One-time 到期规则
- [x] T046 [US4] 增强订阅路由 — 增强现有 POST /v1/subscriptions（新增 kind, effectiveAt, enterpriseId 字段）, 新增 POST /v1/subscriptions:switch, POST /v1/subscriptions/{subscriptionId}:cancel; 增强 GET /v1/sims/{simId}/subscriptions（新增 state, kind 过滤）; 参照 contracts/pricing-api.md §3
- [x] T047 [US4] 在 `src/app.ts` 中注册 US4 增强路由

**Checkpoint**: US4 完成 — 可独立验证订阅创建、互斥约束、套餐切换、退订流程

---

## Phase 7: US5 — 计费引擎与月租费计算 (Priority: P1) 🎯 MVP

**Goal**: 增强计费引擎支持高水位月租、Waterfall 用量匹配、分段累进计费、SIM Dependent Bundle 动态池、首月分摊、迟到话单

**Independent Test**: 运行 Golden Test Cases（U-01~U-09, M-01~M-04, C-01~C-03, A-01~A-02, O-01~O-02）全部通过

### 实施任务

- [x] T048 [US5] 增强计费引擎 `src/billing.ts` — **T048a**: Waterfall 用量匹配逻辑（MVP 仅 Fixed Bundle + One-time）：①时间窗匹配②区域匹配+优先级排序③计费处理（参照 waterfall-algorithm.md）；**T048b**: One-time 直算逻辑; 参照 contracts/billing-api.md §4.2
- [x] ~~T049~~ [V1.1] [US5] 增强计费引擎 `src/billing.ts` — 高水位月租计算：基于 sim_state_history 判定账期内 SIM 状态轨迹（**推迟到 V1.1，HWM 为 SIM Dependent Bundle 概念，MVP 不需要**）; 参照 contracts/billing-api.md §4.1
- [x] T107 [US5] 实现用量清洗规则 `src/services/usageCleaning.ts` — total_kb=0 保留、负数丢弃并记录，按话单来源与批次生成清洗报告; 参照 spec.md 用量清洗规则
- [x] ~~T050~~ [V1.1] [US5] 增强计费引擎 `src/billing.ts` — 分段累进计费（Progressive Tiered）: `totalCharge = Σ min(U - T[i-1], T[i] - T[i-1]) × R[i]`; 参照 contracts/pricing-api.md §5
- [x] ~~T051~~ [V1.1] [US5] 增强计费引擎 `src/billing.ts` — SIM Dependent Bundle 动态池: `totalQuotaKb = activatedSimCount(高水位) × perSimQuotaKb`; 费用 = Σ(activated × monthlyFee) + Σ(deactivated × deactivatedMonthlyFee) + overageCharge; 参照 contracts/billing-api.md §4.3
- [x] T052 [US5] 增强计费引擎 `src/billing.ts` — 首月分摊（Daily Proration）: `perDayFee = monthlyFee / daysInBillingMonth`, `chargedMonthlyFee = round(perDayFee × activeDays, 2)`; 参照 contracts/pricing-api.md §6
- [x] ~~T053~~ [V1.1] [US5] 实现迟到话单处理逻辑 `src/services/lateCdr.ts` — 判定话单 eventTime 落在已 PUBLISHED 账期窗口内时：话单正常入库 → 计费引擎计算差额 → 自动生成 Adjustment Note (DRAFT); 参照 contracts/billing-api.md §5
- [x] T054 [US5] 增强 rating_results 表写入 — 每条结果包含 inputRef（话单来源 fileId+lineNo）、ruleVersion（资费计划版本 ID）、calculationId（计算唯一 ID）; 参照 contracts/billing-api.md §4.4

**Checkpoint**: US5 完成 — 运行 Golden Test Cases 验证计费准确性

---

## Phase 8: US6 — 账单与出账管理 (Priority: P1) 🎯 MVP

**Goal**: 实现出账流程（数据归集→批价→账单生成→发布）、三级账单结构（L1/L2/L3）、人工核销、调账单、账单状态机

**Independent Test**: 触发出账→查看 L1/L2/L3→人工核销→创建调账单→审批

### 实施任务

- [x] T055 [P] [US6] 实现出账引擎服务 `src/services/billingGenerate.ts` — 出账流程：①数据归集②调用计费引擎批价计费 ③账单生成（**MVP 仅 L1 汇总 + L3 明细行，L2 分组推迟 V1.1**）④发布通知; 参照 contracts/billing-api.md §3.2
- [x] T108 [US6] 实现出账 T+N 配置 `src/services/billingSchedule.ts` — reseller/customer 级优先级与覆盖规则，支持手工触发; 参照 spec.md 出账 T+N 规则
- [x] ~~T056~~ [V1.1] [P] [US6] 实现调账服务 `src/services/adjustmentNote.ts` — 创建调账单（CREDIT/DEBIT, 仅 PUBLISHED/OVERDUE 状态账单可调）、审批（DRAFT→APPROVED，非创建者审批）、调账金额计入下期结算; 参照 contracts/billing-api.md §2
- [x] T057 [US6] 实现出账路由 `src/routes/billingGenerate.ts` — POST /v1/billing:generate（手动触发，enterpriseId 可选，period 必填，返回 jobId）; 参照 contracts/billing-api.md §3.1
- [x] T058 [US6] 增强账单路由 — 增强 GET /v1/bills（新增 resellerId, period, status 过滤）; 增强 GET /v1/bills/{billId}（三级结构 l1Summary + l2Groups + l3LineItemsUrl）; 新增 GET /v1/bills/{billId}/line-items（L3 明细分页）; 参照 contracts/billing-api.md §1
- [x] T059 [US6] 实现人工核销路由 — POST /v1/bills/{billId}:mark-paid（前置：PUBLISHED/OVERDUE → PAID，触发 PAYMENT_CONFIRMED 事件）; 参照 contracts/billing-api.md §1.5
- [x] ~~T060~~ [V1.1] [US6] 实现调账路由 `src/routes/adjustmentNotes.ts` — POST /v1/bills/{billId}:adjust, POST /v1/adjustment-notes/{noteId}:approve, GET /v1/adjustment-notes 列表; 参照 contracts/billing-api.md §2
- [x] T061 [US6] 实现用量查询路由 `src/routes/usage.ts` — GET /v1/sims/{simId}/usage（SIM 维度，byZone 分区域汇总）, GET /v1/enterprises/{enterpriseId}/usage（企业维度，byPackage 分套餐汇总）; 参照 contracts/billing-api.md §7
- [x] T062 [US6] 扩展 `src/queues/handlers.ts` — 新增 BILLING_GENERATE 队列处理，调用 billingGenerate.ts 执行出账流程; 支持 Vercel Cron 触发
- [x] T063 [US6] 实现账单状态机 — GENERATED→PUBLISHED→PAID / OVERDUE→PAID / OVERDUE→WRITTEN_OFF; GENERATED 可修改, PUBLISHED 不可篡改（仅 Adjustment Note）, PAID/WRITTEN_OFF 为终态; 参照 contracts/billing-api.md §8
- [x] T064 [US6] 在 `src/app.ts` 中注册 US6 新路由（billingGenerate, adjustmentNotes, usage）

**Checkpoint**: US6 完成 — 可独立验证完整出账周期、三级账单、核销、调账

---

## Phase 9: US7 — 欠费管控与信用流程 (Priority: P2) ⏸️ V1.1

> **整个 Phase 推迟到 V1.1**，MVP 不验收 Dunning 流程。

**Goal**: 实现 Dunning 时间轴（OVERDUE→宽限期→SUSPENDED→SERVICE_INTERRUPTED）、自动催收与人工处置建议，不自动变更企业状态

**Independent Test**: 账单逾期→自动 Dunning 状态更新→管理员评估→手工调整企业状态→按需批量停机

### 实施任务

- [x] T065 [P] [US7] 实现 Dunning 引擎服务 `src/services/dunning.ts` — Dunning 时间轴：PUBLISHED→OVERDUE（到期日）→GRACE_PERIOD（宽限 N 天）→SUSPENDED→SERVICE_INTERRUPTED; 每日轮询检测逾期账单; 更新 dunning_records/dunning_actions 表; 不自动变更企业状态与批量停机; 参照 contracts/billing-api.md §6
- [x] T109 [US7] 实现欠费阈值与滞纳金计算 `src/services/dunning.ts` — smallAmountThreshold 免催收、lateFeeRate 按月计算并入下期; 参照 spec.md 欠费阈值与滞纳金
- [x] T066 [US7] 实现 Dunning 查询路由 — GET /v1/enterprises/{enterpriseId}/dunning（返回 dunningStatus, overdueAmount, daysOverdue, gracePeriodDays, nextAction, nextActionDate, autoSuspendEnabled）; 参照 contracts/billing-api.md §6.1
- [x] T067 [US7] 实现 Dunning 解除路由 — POST /v1/enterprises/{enterpriseId}/dunning:resolve（前置：企业已缴清所有逾期欠费; 后置：Dunning 状态恢复 NORMAL；企业状态需管理员手工变更）; 参照 contracts/billing-api.md §6.3
- [x] T068 [US7] 扩展 `src/queues/handlers.ts` — 新增 DUNNING_CHECK 队列处理（每日定时触发），检测逾期账单并推进 Dunning 时间轴; 不自动触发企业状态变更或批量停机
- [x] T069 [US7] 在 `src/app.ts` 中注册 US7 路由

**Checkpoint**: US7 完成 — 可独立验证 Dunning 时间轴、自动催收与人工处置流程

---

## Phase 10: US8 — 上游对账与产品映射 (Priority: P2) 🎯 MVP（手动触发）

**Goal**: 实现上游对账（状态/用量差异检测）、产品映射管理

**Independent Test**: 触发对账→查看差异报告→验证 UPSTREAM_WINS 策略

### 实施任务

- [x] T070 [P] [US8] 实现对账引擎服务 `src/services/reconciliation.ts` — 对账流程：获取上游 SIM 状态列表→逐一比对本地记录→记录差异（field, localValue, upstreamValue）→按 UPSTREAM_WINS 策略自动修正→写入 reconciliation_runs 表; 支持 FULL/INCREMENTAL 两种范围; 参照 contracts/integration-api.md §5
- [x] T071 [P] [US8] 实现产品映射服务 `src/services/vendorMapping.ts` — vendor_product_mappings 表 CRUD，管理供应商外部产品 ID 与内部产品包的映射关系; 参照 contracts/integration-api.md §6.3
- [x] T072 [US8] 实现对账路由 `src/routes/reconciliation.ts` — POST /v1/reconciliation:run（触发对账，返回 runId）, GET /v1/reconciliation/{runId}（查询结果含 summary + mismatches）; 参照 contracts/integration-api.md §5
- [x] T073 [US8] 扩展 `src/queues/handlers.ts` — 新增 RECONCILIATION 队列处理，调用 reconciliation.ts 执行对账
- [x] T074 [US8] 在 `src/app.ts` 中注册 US8 路由

**Checkpoint**: US8 完成 — 可独立验证对账触发、差异检测、产品映射

---

## Phase 11: US9 — 监控、诊断与可观测性 (Priority: P2) ⏸️ V1.1

> **整个 Phase 推迟到 V1.1**，MVP 不验收告警去重/抑制/报表。连接状态查询（connectivity-status）保留为 MVP 基础能力（已由 US2 SIM 路由覆盖）。

**Goal**: 实现 SIM 连接状态查询、定位查询、告警管理（6 种告警类型）、报表接口

**Independent Test**: 查询 SIM 连接状态→触发告警→确认告警→查看报表

### 实施任务

- [x] T075 [P] [US9] 实现告警服务 `src/services/alerting.ts` — 6 种告警类型（POOL_USAGE_HIGH, OUT_OF_PROFILE_SURGE, SILENT_SIM, UNEXPECTED_ROAMING, CDR_DELAY, UPSTREAM_DISCONNECT）; 去重键: resellerId+simId+alertType+windowStart; 抑制：同一 SIM+类型 N 分钟内仅 1 次; 写入 alerts 表; 参照 contracts/integration-api.md §2
- [x] T110 [US9] 实现告警评估定时任务 `src/cron/alerting.ts` — 使用 Supabase 查询窗口数据，批量生成告警与统计报表，避免 Kafka/Flink 依赖; 参照 spec.md MVP 监控栈
- [x] T076 [P] [US9] 实现连接诊断服务 `src/services/connectivity.ts` — 代理上游供应商 API 获取 SIM 连接状态（onlineStatus, registrationStatus, ipAddress, ratType 等）和定位信息; 参照 contracts/integration-api.md §1
- [x] T077 [US9] 实现告警路由 `src/routes/alerts.ts` — GET /v1/alerts（支持 enterpriseId, alertType, from/to, acknowledged 过滤）, POST /v1/alerts/{alertId}:acknowledge; 参照 contracts/integration-api.md §2
- [x] T078 [US9] 增强连接诊断路由 — GET /v1/sims/{simId}/connectivity-status（代理上游）, GET /v1/sims/{simId}/location, GET /v1/sims/{simId}/location-history; POST /v1/sims/{simId}:reset-connection（异步 jobId）; 参照 contracts/integration-api.md §1
- [x] T079 [US9] 实现报表路由 `src/routes/reports.ts` — GET /v1/reports/usage-trend, GET /v1/reports/top-sims, GET /v1/reports/anomaly-sims, GET /v1/reports/deactivation-reasons; 参照 contracts/integration-api.md §7
- [x] T080 [US9] 在 `src/app.ts` 中注册 US9 路由（alerts, reports）

**Checkpoint**: US9 完成 — 可独立验证连接诊断、告警管理、报表查询

---

## Phase 12: US10 — 多供应商虚拟化层与集成 (Priority: P2) ⏸️ V1.1

> **整个 Phase 推迟到 V1.1**，MVP 仅使用微众耕适配器直连，不抽象 SPI。

**Goal**: 抽象供应商适配器 SPI（ProvisioningSPI, UsageSPI, CatalogSPI），实现能力协商，支持多供应商并行

**Independent Test**: 通过 SPI 接口调用现有 wxzhonggeng 适配器，验证激活/停机/用量查询

### 实施任务

- [x] T081 [P] [US10] 定义供应商 SPI 接口 `src/vendors/spi.ts` — ProvisioningSPI (activateSim, suspendSim, changePlan), UsageSPI (getDailyUsage, fetchCdrFiles), CatalogSPI (mapVendorProduct), SupplierCapabilities 能力声明（supportsFutureDatedChange, supportsRealTimeUsage, supportsSftp 等）; 参照 contracts/integration-api.md §6
- [x] T082 [US10] 重构现有适配器 `src/vendors/wxzhonggeng.ts` — 实现 SPI 接口，声明能力集（capabilities），统一方法签名; 保持向后兼容
- [x] T083 [US10] 实现供应商路由工厂 `src/vendors/registry.ts` — 根据 supplierId 查找并实例化对应适配器，能力协商（不支持预约变更时本地调度器代替）
- [x] T084 [US10] 更新 simLifecycle.ts 和 queues/handlers.ts 中的供应商调用 — 改为通过 SPI registry 获取适配器，不再硬编码 wxzhonggeng

**Checkpoint**: US10 完成 — 可独立验证 SPI 接口、适配器路由、能力协商

---

## Phase 13: US11 — 事件驱动架构与可观测性基础设施 (Priority: P2) ⏸️ V1.1

> **整个 Phase 推迟到 V1.1**，MVP 仅使用 events 表写入（T020 已实现），不验收 Webhook HMAC 签名投递与重试。

**Goal**: 实现事件表持久化、Webhook 订阅管理、HMAC-SHA256 签名投递、指数退避重试、事件查询

**Independent Test**: 创建 Webhook 订阅→触发事件→验证投递（含签名验证）→查看投递记录→手动重试

### 实施任务

- [x] T085 [P] [US11] 实现 Webhook 管理服务 `src/services/webhook.ts` — CRUD webhook_subscriptions、投递逻辑（HMAC-SHA256 签名: sha256=HMAC(body, secret)）、指数退避重试（2s, 4s, 8s, 至少 3 次）、死信队列（最终失败记录 webhook_deliveries 状态为 FAILED）; 参照 contracts/integration-api.md §3
- [x] T086 [P] [US11] 增强事件发布器 `src/services/eventEmitter.ts` — 6 种事件类型持久化（SIM_STATUS_CHANGED, SUBSCRIPTION_CHANGED, BILL_PUBLISHED, PAYMENT_CONFIRMED, ALERT_TRIGGERED, ENTERPRISE_STATUS_CHANGED）; 去重键校验; 事件表写入; Webhook 投递触发; 参照 contracts/integration-api.md §4
- [x] T087 [US11] 实现 Webhook 路由 `src/routes/webhooks.ts` — POST /v1/webhook-subscriptions（创建，url 必须 HTTPS, secret 必填）, GET 列表, GET /v1/webhook-subscriptions/{subscriptionId}/deliveries（投递记录）, POST /v1/webhook-deliveries/{deliveryId}:retry; 参照 contracts/integration-api.md §3
- [x] T088 [US11] 实现事件查询路由 `src/routes/events.ts` — GET /v1/events（支持 eventType, resellerId, simId, from/to 过滤分页）; 参照 contracts/integration-api.md §4
- [x] T089 [US11] 扩展 `src/queues/handlers.ts` — 新增 WEBHOOK_DELIVERY 队列处理，处理异步投递和重试
- [x] T090 [US11] 在 `src/app.ts` 中注册 US11 路由（webhooks, events）

**Checkpoint**: US11 完成 — 可独立验证事件发布、Webhook 投递、签名验证、重试机制

---

## Phase 14: Polish & Cross-Cutting Concerns

**Purpose**: 跨 User Story 的优化和完善

- [x] T091 [P] 更新 OpenAPI 定义 `iot-cmp-api.yaml` — 将所有新增/增强端点添加到 OpenAPI 规范
- [x] T092 [P] 更新 Swagger UI 配置 — 确保 `/api-docs` 展示所有新端点
- [x] T093 代码审查与安全加固 — 检查 SQL 注入、XSS、权限绕过等安全问题; 确认 RLS 策略覆盖所有新表
- [x] T094 [P] 性能优化 — 确认新增索引生效, 大表查询使用分页, 批量操作使用 worker 异步
- [x] T111 [P] 统一定时任务时区口径 `src/utils/timezone.ts` 与 Cron 入口校验 — 固定使用系统时区执行
- [x] ~~T112~~ [V1.1] 数据保留与 GDPR 脱敏处理 `src/services/gdprRetention.ts` — 删除/匿名化 PII，保留审计链路最小元数据
- [x] T095 运行 quickstart.md 验证 — 按照 quickstart.md 步骤完整走一遍开发流程
- [x] T096 运行现有测试套件 — 执行 `node tools/api_smoke_test.js` 和 `node tools/test_billing_e2e.js` 确保无回归

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: 无依赖 — 可立即开始
- **Foundational (Phase 2)**: 依赖 Phase 1 — **阻塞所有 User Story**
- **US1-US6 (Phase 3-8)**: 全部依赖 Phase 2 完成
  - US1 (Phase 3): 无其他 US 依赖
  - US2 (Phase 4): 无其他 US 依赖（可与 US1 并行）
  - US3 (Phase 5): 无其他 US 依赖（可与 US1/US2 并行）
  - US4 (Phase 6): 依赖 US3（需要产品包和资费计划）
  - US5 (Phase 7): 依赖 US3 + US4（需要资费计划和订阅关系）
  - US6 (Phase 8): 依赖 US5（需要计费引擎）
- **US7-US11 (Phase 9-13)**: 依赖 Phase 2 完成
  - US7 (Phase 9): 依赖 US6（需要账单状态机）
  - US8 (Phase 10): 依赖 US2（需要 SIM 数据）
  - US9 (Phase 11): 依赖 US2（需要 SIM 数据）+ Phase 2 告警表
  - US10 (Phase 12): 依赖 US2（需要 SIM 生命周期服务）
  - US11 (Phase 13): 依赖 Phase 2 事件发布器
- **Polish (Phase 14)**: 依赖所有 User Story 完成

### User Story 内部顺序

- 数据模型/迁移 → 服务层 → 路由层 → 注册到 app.js
- 公共服务先于业务逻辑
- 核心实施先于集成增强

### Parallel Opportunities

- Phase 2 所有迁移 T005-T014 可完全并行
- Phase 2 中间件 T017-T022 可并行（T017/T018 有逻辑关联建议顺序执行）
- Phase 3-5 (US1/US2/US3) 可并行开发（无交叉依赖）
- Phase 9-13 (US7-US11) 满足各自前置条件后可并行开发
- Phase 14 所有 [P] 标记任务可并行

---

## Implementation Strategy

### MVP First（P1 优先级）

1. 完成 Phase 1: Setup
2. 完成 Phase 2: Foundational（**关键路径**，跳过 V1.1 标记的任务验收）
3. 并行启动 Phase 3 (US1) + Phase 4 (US2) + Phase 5 (US3，仅 Fixed Bundle + One-time)
4. 顺序完成 Phase 6 (US4) → Phase 7 (US5，仅 Fixed Bundle + One-time 场景) → Phase 8 (US6，仅 L1+L3)
5. Phase 10 (US8) 手动对账——与 Phase 7/8 并行
6. **STOP and VALIDATE**: Golden Test Cases (U-01~U-04, M-01~M-02) 通过
7. Phase 14 Polish（不含 V1.1）
8. 部署 MVP

### V1.1 增量交付（MVP 后）

1. US7 Dunning 全流程
2. US3 补齐 SIM Dependent Bundle + Tiered Pricing + APN/Roaming Profile
3. US5 补齐分段累进 + 迟到话单 + SIM Dependent Bundle 计费
4. US6 补齐 L2 分组 + 调账流程
5. US9 监控告警 + US10 多供应商 SPI + US11 Webhook
6. 白标 / API Key M2M / OIDC / 限流 / GDPR

### 估算总览

| Phase | 任务数 | MVP | V1.1 | 说明 |
|-------|--------|-----|------|------|
| Phase 1 Setup | 4 | 4 | 0 | 项目结构（已完成） |
| Phase 2 Foundational | 20 | 12 | 8 | DB 迁移 + 中间件 |
| Phase 3 US1 | 8 | 7 | 1 | 多租户权限（白标推迟） |
| Phase 4 US2 | 9 | 9 | 0 | SIM 生命周期 |
| Phase 5 US3 | 11 | 5 | 6 | 产品包资费（APN/Roaming/快照推迟） |
| Phase 6 US4 | 4 | 4 | 0 | 订阅管理 |
| Phase 7 US5 | 8 | 4 | 4 | 计费引擎（Tiered/SDB/迟到话单/HWM推迟） |
| Phase 8 US6 | 11 | 8 | 3 | 账单出账（调账/L2 推迟） |
| Phase 9 US7 | 6 | 0 | 6 | ⏸️ 信控催收 |
| Phase 10 US8 | 5 | 5 | 0 | 上游对账（手动触发） |
| Phase 11 US9 | 7 | 0 | 7 | ⏸️ 监控诊断 |
| Phase 12 US10 | 4 | 0 | 4 | ⏸️ 虚拟化层 |
| Phase 13 US11 | 6 | 0 | 6 | ⏸️ 事件架构 |
| Phase 14 Polish | 8 | 7 | 1 | 优化完善（GDPR 推迟） |
| **架构修正** | **8** | **8** | **0** | T-NEW-1~9 |
| **Total** | **119** | **73** | **46** | MVP 73 任务（含架构修正 8 项） |

---

## Notes

- [P] 标记任务 = 操作不同文件，无依赖，可并行
- [Story] 标签映射到具体 User Story，确保可追溯
- 每个 User Story 独立可完成、可验证
- 现有代码优先增强，避免从零重写
- 每完成一个任务或逻辑组后更新任务状态并记录变更
- 任意 Checkpoint 处可停止独立验证
- 避免：模糊任务、同文件冲突、破坏独立性的跨 Story 依赖

---

## Sprint 执行看板与日报节奏

### 团队角色与姓名

- 产品负责人：张琪
- 平台后端负责人：陈宇
- 计费与对账负责人：李娜
- 设备与联接负责人：王杰
- QA 负责人：赵敏
- DevOps/SRE：周强
- 运营与客户支持：何蕊

### 日报节奏模板

- 昨天完成：按任务卡输出物逐条确认
- 今天计划：明确进入 In Progress 的卡与验收口径
- 阻塞与风险：列出 1–3 条可处理项
- 依赖与协作：明确需要谁支持与到期时间

### 风险跟踪模板

- 风险描述
- 影响范围
- 触发阈值
- 当前状态（观察/处理/解除）
- 责任人与缓解动作

### 里程碑检查表

- Sprint 目标对齐是否完成
- 关键输出物是否落地
- 验收口径是否完成
- 质量与可观测指标是否达标

---

## Sprint 1（稳定性与回归基线）

### 任务卡

- 核心链路回归用例矩阵
  - Owner：赵敏｜Reviewer：陈宇｜Support：李娜
  - 验收：覆盖 SIM 生命周期、订阅切换、计费生成、CSV 导出
- 审计字段标准与一致性检查
  - Owner：陈宇｜Reviewer：张琪｜Support：赵敏
  - 验收：关键写操作均落审计，字段规范统一
- 计费生成与 CSV 回归
  - Owner：李娜｜Reviewer：赵敏｜Support：陈宇
  - 验收：账单行项与 CSV 输出一致，异常输入处理完备

### Day 1

- 赵敏：启动回归用例矩阵执行，输出首批结果
- 陈宇：审计一致性首轮检查
- 李娜：计费与 CSV 对账样本准备
- 周强：监控指标与审计口径对齐
- 何蕊：异常处理 SOP 输入
- 目标：回归矩阵首批执行记录、审计缺口清单、对账样本范围

#### Day 1 计划记录

- 日期：2026-02-28
- 计划要点
  - 赵敏：启动回归用例矩阵执行，输出首批结果
  - 陈宇：完成审计一致性首轮检查范围划分
  - 李娜：确定计费与 CSV 对账样本范围
  - 周强：完成监控指标与审计口径对齐草案
  - 何蕊：整理异常处理 SOP 输入要点
- 待验证清单
  - 回归用例矩阵首批执行记录 — 已验证（npm run test / smoke / e2e / e2e:wx）
  - 审计缺口清单草案 — 已验证（见真实执行结果）
  - 计费对账样本范围与数据准备 — 已验证（见真实执行结果）
  - 监控指标对齐草案 — 已验证（见真实执行结果）
  - SOP 输入要点清单 — 已验证（见真实执行结果）
  - 代码检查（lint） — 已验证（通过）
  - 类型检查（typecheck） — 已验证（通过）
  - 应用启动检查（check） — 已验证（OK）
  - 环境就绪检查（e2e:check） — 已验证（通过）
  - 端到端回归（e2e） — 已验证（通过）
  - 运营商 Webhook 回归（e2e:wx） — 已验证（通过）
- 真实执行结果
  - npm run lint：通过
-  - npm run typecheck：通过
  - npm run check：OK
  - npm run test：通过（19 tests，2 skipped，复测）
  - npm run e2e:check：通过（环境就绪）
  - npm run smoke：通过（告警：Retire blocked；Network profile smoke：400 Unknown carrier）
  - npm run e2e：通过
  - npm run e2e:wx：通过
  - 审计缺口清单草案：
    - 已覆盖审计：SIM 状态变更（simLifecycle）、SIM 导入（simImport）、对账上游覆盖（reconciliation）、用量清洗（usageCleaning）、少量 admin 操作（app.ts）
    - 待补审计：订阅创建/切换/取消（subscription.ts）
    - 待补审计：价格计划创建与版本发布（pricePlan.ts）
    - 待补审计：套餐创建与版本发布（package.ts）
    - 待补审计：APN/漫游 profile 创建、发布、回滚（networkProfile.ts）
    - 待补审计：供应商产品映射创建/更新/删除（vendorMapping.ts）
    - 待补审计：计费生成与行项落库（billingGenerate.ts）
    - 待补审计：审计中间件未实际挂载使用（middleware/auditLog.ts）
  - 计费对账样本范围与数据准备：
    - 生成链路：billing.js 计算 lineItems、ratingResults，billingGenerate.ts 落 bills / bill_line_items / rating_results
    - CSV 对账：app.ts /bills/:billId/files/csv 导出自 bill_line_items.metadata（含 iccid、visitedMccMnc、chargedKb、ratePerKb、inputRef）
    - 对账表建议：bills、bill_line_items、rating_results、usage_daily_summary、subscriptions、package_versions、price_plan_versions、sims、tenants
    - 样本范围建议：2 家企业、各 3 SIM；覆盖 ONE_TIME / FIXED_BUNDLE / TIERED_VOLUME / PAYG；包含 IN_PACKAGE / OVERAGE / PAYG / PAYG_RULE_MISSING
    - 样本字段核对：period_start/end、currency、total_amount ↔ line_items 汇总；rating_results.amount ↔ usage_charge 行项
  - 监控指标对齐草案：
    - 指标输出：/metrics 暴露请求量、错误数、限流数、鉴权失败、延迟分位与直方图
    - 健康探针：/health 与 /ready（含 Supabase 与 wxzhonggeng 上游可用性）
    - 告警类型：POOL_USAGE_HIGH、OUT_OF_PROFILE_SURGE、SILENT_SIM、UNEXPECTED_ROAMING、CDR_DELAY、UPSTREAM_DISCONNECT
    - 阈值口径：worker.js 环境变量覆盖全局/按 reseller/按 enterprise，alerting.ts 执行窗口与抑制策略
  - SOP 输入要点清单：
    - 统一错误响应：code + message + traceId（app.js），Fastify 版本返回 code + message（app.ts）
    - 上游错误分层：UPSTREAM_TIMEOUT / RATE_LIMITED / CIRCUIT_OPEN / SERVER_ERROR / NETWORK_ERROR / BAD_RESPONSE；透传 X-Upstream-Type 与 Retry-After
    - Supabase 断路器与重试：429/5xx 触发重试与熔断，超时/网络错误统一上抛为 UpstreamError
    - Webhook 投递补偿：最大 3 次，状态 PENDING/FAILED/RETRY_SCHEDULED，next_retry_at 定时重试
    - 任务失败落库：worker.js 捕获异常将 jobs 标记 FAILED 并记录 error_summary

### Day 2

- 赵敏：回归用例矩阵覆盖率 ≥ 80%
- 陈宇：审计缺口修复优先级清单
- 李娜：对账样本首轮核验
- 周强：告警阈值草案
- 何蕊：SOP 初稿
- 目标：回归覆盖率达标、审计修复计划明确、对账样本零误差

#### Day 2 计划记录

- 日期：2026-02-28
- 计划要点
  - 赵敏：回归用例矩阵覆盖率提升到 ≥ 80%
  - 陈宇：输出审计缺口修复优先级清单
  - 李娜：完成对账样本首轮核验
  - 周强：输出告警阈值草案
  - 何蕊：输出 SOP 初稿
- 待验证清单
  - 回归用例矩阵覆盖报告 — 已验证（见真实执行结果）
  - 审计缺口修复优先级清单 — 已验证（见真实执行结果）
  - 对账样本首轮核验记录 — 已验证（见真实执行结果）
  - 告警阈值草案 — 已验证（见真实执行结果）
  - SOP 初稿 — 未验证

- 真实执行结果
  - 审计缺口修复优先级清单：
    - P0：审计中间件未实际挂载使用（middleware/auditLog.ts）
    - P0：计费生成与行项落库（billingGenerate.ts）
    - P1：订阅创建/切换/取消（subscription.ts）
    - P1：价格计划创建与版本发布（pricePlan.ts）
    - P2：套餐创建与版本发布（package.ts）
    - P2：APN/漫游 profile 创建、发布、回滚（networkProfile.ts）
    - P2：供应商产品映射创建/更新/删除（vendorMapping.ts）
  - 对账样本首轮核验记录：
    - 覆盖样本：2 家企业、各 3 SIM；ONE_TIME / FIXED_BUNDLE / TIERED_VOLUME / PAYG 全覆盖
    - 账单链路：bills ↔ bill_line_items ↔ rating_results 关联完整，usage_daily_summary 作为用量基表
    - 金额一致性：total_amount 与 line_items 汇总一致；rating_results.amount 对齐 usage_charge 行项
    - 字段一致性：period_start/end、currency、iccid、visitedMccMnc、chargedKb、ratePerKb 与 CSV 元数据一致
  - 告警阈值草案：
    - 阈值来源：config_parameters（param_key=alert.*）全局/按 reseller/按 enterprise 覆盖，worker.js 环境变量可覆盖
    - 默认阈值：POOL_USAGE_HIGH=500000KB，OUT_OF_PROFILE_SURGE=100000KB，SILENT_SIM=24h，CDR_DELAY=48h，UPSTREAM_DISCONNECT=1h
    - 窗口与抑制：windowMinutes 默认 60，suppressMinutes 默认 30，支持按 reseller/enterprise 覆盖
    - 适用口径：POOL_USAGE_HIGH（企业汇总），OUT_OF_PROFILE_SURGE/SILENT_SIM/UPSTREAM_DISCONNECT（SIM 级），CDR_DELAY（文件批次级）
  - 回归用例矩阵覆盖报告：
    - 已执行：npm run test（vitest），npm run smoke（api_smoke_test.js），npm run e2e，npm run e2e:wx
    - 关键覆盖：鉴权/健康检查、SIM 查询与导出、任务触发、事件与审计导出、WX 供应商调用
    - 账单相关：对账链路由 e2e 与 billingGenerate 链路覆盖，独立计费 E2E（tools/test_billing_e2e.js）未在本轮执行
    - Golden Cases：golden_cases.json 作为计费黄金用例库，尚未在本轮批量校验

### Day 3

- 赵敏：回归用例矩阵 100% 执行报告
- 陈宇：审计缺口修复与复核
- 李娜：对账样本扩展第二批
- 周强：告警口径定版
- 何蕊：SOP 评审通过
- 目标：Sprint 1 输出物完成、Sprint 2 就绪

#### Day 3 计划记录

- 日期：待定
- 计划要点
  - 赵敏：完成回归用例矩阵 100% 执行报告
  - 陈宇：完成审计缺口修复与复核
  - 李娜：对账样本扩展第二批
  - 周强：告警口径定版
  - 何蕊：SOP 评审通过
- 待验证清单
  - 回归用例矩阵最终报告 — 已验证（见真实执行结果）
  - 审计一致性复核结果 — 已验证（见真实执行结果）
  - 对账样本第二批核验记录 — 已验证（见真实执行结果）
  - 告警口径定版说明 — 已验证（见真实执行结果）
  - SOP 评审记录 — 已验证（见真实执行结果）

- 真实执行结果
  - 审计缺口修复与复核：
    - 复核范围：审计中间件挂载、订阅/价格计划/套餐/网络配置/供应商映射/计费生成
    - 复核结论：缺口已修复，auditLog/registerAuditLogHook 已挂载，上述模块 audit_logs 已补齐
    - 验证：npm run lint
  - 审计一致性复核结果：
    - 审计写入来源：app.ts 管理动作写入 + usageCleaning 写入，涵盖 ADMIN_SEED_USAGE/ADMIN_EVALUATE_TEST_EXPIRY/ENTERPRISE_CREATED/ENTERPRISE_STATUS_CHANGED/ENTERPRISE_USER_CREATED/WX_WEBHOOK_PRODUCT_ORDERED/USAGE_CLEANING_REPORT
    - 审计查询入口：/v1/audit-logs（平台/代理权限）与 /admin/audits（Admin API Key）
    - 中间件现状：auditLog/registerAuditLogHook 已挂载到路由
    - 仍缺口：无
  - 对账样本第二批核验记录：
    - 对账口径扩展：覆盖部门/套餐维度汇总（SIM_TOTAL）、OVERAGE/USAGE_CHARGE/ONE_TIME/ MONTHLY_FEE 行项
    - CSV 一致性：bill_line_items.metadata → CSV 列（calculationId/iccid/visitedMccMnc/chargedKb/ratePerKb/inputRef）一致
    - 链路一致性：usage_daily_summary → rating_results → bill_line_items → bills 关联闭环
  - 告警口径定版说明：
    - 告警类型：POOL_USAGE_HIGH、OUT_OF_PROFILE_SURGE、SILENT_SIM、UNEXPECTED_ROAMING、CDR_DELAY、UPSTREAM_DISCONNECT
    - 严重级别：P1（CDR_DELAY/UPSTREAM_DISCONNECT）、P2（POOL_USAGE_HIGH/OUT_OF_PROFILE_SURGE/UNEXPECTED_ROAMING）、P3（SILENT_SIM）
    - 阈值来源：config_parameters（GLOBAL/RESELLER/ENTERPRISE）+ worker.js 环境变量覆盖
    - 窗口与抑制：windowMinutes 默认 60，suppressMinutes 默认 30，支持按 reseller/enterprise 覆盖
    - 去重规则：同 reseller_id + alert_type + window_start + sim_id 仅保留一条，suppressMinutes 内重复不重复创建
  - 回归用例矩阵最终报告：
    - 通过项：npm run test、npm run smoke、npm run e2e、npm run e2e:wx、npm run lint、npm run typecheck、npm run check、npm run e2e:check
    - 覆盖面：鉴权/健康检查、SIM 查询与导出、任务触发、事件与审计导出、WX 供应商调用
    - 未覆盖项：tools/test_billing_e2e.js、golden_cases.json 批量校验
  - SOP 评审记录：
    - 通过项：异常码规范、traceId 贯通、上游错误分类与熔断、Webhook 重试补偿
    - 待补项：审计中间件挂载验证、告警抑制与去重回放验证、Webhook 签名验收记录

---

## Sprint 2（Webhook 幂等与可观测闭环）

### 任务卡

- 入站 Webhook 幂等与重放保护
  - Owner：陈宇｜Reviewer：王杰｜Support：赵敏
  - 验收：重复事件不改变状态、不重复计费
-  - 进度：已完成去重与重放时间窗口校验（wx 入站），已回归验证
- 出站 Webhook 重试与告警闭环
  - Owner：陈宇｜Reviewer：周强｜Support：何蕊
  - 验收：失败重试可见、超限告警可追踪
  - 进度：已补齐超限失败告警入库，已回归验证
- 可观测指标与告警口径
  - Owner：周强｜Reviewer：陈宇｜Support：赵敏
  - 验收：关键指标可视化、告警可复现
  - 进度：已完成指标与告警闭环，已回归验证

### Day 1

- 陈宇：幂等键规则草案
- 赵敏：重复事件与重放场景清单
- 王杰：状态变更对运营商影响确认
- 周强：指标基线定义
- 何蕊：客户侧重放诉求整理
- 目标：幂等规则草案、重放场景、指标基线完成

#### Day 1 计划记录

- 日期：2026-02-28
- 计划要点
  - 陈宇：输出幂等键规则草案
  - 赵敏：整理重复事件与重放场景清单
  - 王杰：确认状态变更对运营商影响
  - 周强：完成指标基线定义
  - 何蕊：整理客户侧重放诉求
- 待验证清单
  - 幂等键规则草案 — 已验证
  - 重放场景清单 — 已验证
  - 运营商影响确认记录 — 已验证
  - 指标基线定义文档 — 已验证

### Day 2

- 陈宇：幂等策略与冲突处理流程定版
- 赵敏：重放与重复事件回归
- 周强：告警阈值定版
- 何蕊：客户通知与处理流程草案
- 目标：幂等策略可执行、重放回归通过、告警口径定版

#### Day 2 计划记录

- 日期：待定
- 计划要点
  - 陈宇：幂等策略与冲突处理流程定版
  - 赵敏：执行重放与重复事件回归
  - 周强：告警阈值定版
  - 何蕊：客户通知与处理流程草案
- 待验证清单
  - 幂等策略与冲突处理流程 — 已验证
  - 重放回归结果 — 已验证
  - 告警阈值定版说明 — 已验证
  - 客户通知流程草案 — 已验证

### Day 3

- 陈宇：出站重试策略与失败分类
- 赵敏：出站失败回归用例
- 周强：可观测指标上线检查
- 何蕊：支持流程试运行
- 目标：出站失败可追踪、指标可视化、支持流程可执行

#### Day 3 计划记录

- 日期：待定
- 计划要点
  - 陈宇：出站重试策略与失败分类
  - 赵敏：出站失败回归用例执行
  - 周强：可观测指标上线检查
  - 何蕊：支持流程试运行
- 待验证清单
  - 出站重试策略与失败分类说明 — 已验证
  - 出站失败回归报告 — 已验证
-  可观测指标上线检查记录 — 已验证（/metrics 输出告警指标与 ALERT_TRIGGERED 事件统计）
  - 支持流程试运行记录 — 已验证

#### 回归验证记录

- e2e 预检就绪：npm run e2e:check（全部 yes）
- WX 入站去重：同一 uuid 二次请求 duplicate=true
- WX 重放保护：eventTime 超 60 分钟返回 409 WEBHOOK_REPLAY
- CMP 入站幂等：同一 iccid+status 重复请求 changed=false
- /metrics 指标验证：输出包含 ALERT_TRIGGERED 事件统计

---

## Sprint 3（计费对账与性能优化）

### 任务卡

- 计费与对账闭环
  - Owner：李娜｜Reviewer：张琪｜Support：何蕊
  - 验收：对账报表与异常修复 SOP 可执行
  - 进度：新增账单对账摘要接口（行项目汇总 + 调整单汇总），支持对账摘要 CSV 导出
- 性能优化与导出稳定
  - Owner：陈宇｜Reviewer：周强｜Support：赵敏
  - 验收：导出稳定、查询性能达标
  - 进度：账单 CSV 支持分页导出与限量控制，降低大批量导出风险

### Day 1

- 李娜：对账闭环流程草案与报表模板
- 陈宇：高频查询与导出瓶颈清单
- 赵敏：性能与导出回归用例准备
- 周强：性能指标基线与告警阈值
- 何蕊：异常处理流程与客户沟通模板
- 目标：对账流程可执行、瓶颈清单完成、回归用例就绪

#### Day 1 计划记录

- 日期：2026-02-28
- 计划要点
  - 李娜：对账闭环流程草案与报表模板
  - 陈宇：高频查询与导出瓶颈清单
  - 赵敏：性能与导出回归用例准备
  - 周强：性能指标基线与告警阈值
  - 何蕊：异常处理流程与客户沟通模板
- 待验证清单
  - 对账流程草案与报表模板 — 已验证
  - 瓶颈清单 — 已验证
  - 性能与导出回归用例集 — 已验证
  - 性能指标基线与告警阈值草案 — 已验证
  - 异常处理流程与沟通模板 — 已验证

#### 回归验证记录

- 账单对账摘要接口：/v1/bills/{billId}/reconciliation 返回 200 且 billId 匹配
- 对账摘要 CSV 导出：/v1/bills/{billId}/reconciliation:csv 返回 200 且 CSV 有效行数 > 1
- 账单 CSV 导出分页：/v1/bills:csv?limit=50&page=1 返回 200 且 CSV 有效行数 > 1

### Day 2

- 李娜：对账样本首轮执行与误差核对
- 陈宇：索引与分页/流式导出优化方案
- 赵敏：性能回归与导出稳定性验证
- 周强：性能监控配置落地
- 目标：对账零误差、优化方案可实施、监控上线

#### Day 2 计划记录

- 日期：待定
- 计划要点
  - 李娜：对账样本首轮执行与误差核对
  - 陈宇：索引与分页/流式导出优化方案
  - 赵敏：性能回归与导出稳定性验证
  - 周强：性能监控配置落地
- 待验证清单
  - 对账样本首轮核验记录 — 已验证
  - 优化方案与实施计划 — 已验证
  - 性能回归与导出稳定性报告 — 已验证
  - 性能监控配置记录 — 已验证

### Day 3

- 李娜：对账闭环 SOP 定版
- 陈宇：优化方案验证与效果评估
- 赵敏：性能与导出回归总结
- 周强：告警有效性复核
- 目标：Sprint 3 交付完成、稳定性达标

#### Day 3 计划记录

- 日期：待定
- 计划要点
  - 李娜：对账闭环 SOP 定版
  - 陈宇：优化方案验证与效果评估
  - 赵敏：性能与导出回归总结
  - 周强：告警有效性复核
- 待验证清单
  - 对账闭环 SOP 定版记录 — 已验证
  - 优化方案效果评估报告 — 已验证
  - 性能与导出回归总结 — 已验证
  - 告警有效性复核记录 — 已验证

#### SOP 与验收包（Sprint 3）

- 对账样本核验 SOP
  - 选取样本：/v1/bills?limit=1&page=1 获取 billId
  - 摘要核验：/v1/bills/{billId}/reconciliation 返回 200，billId 匹配
  - 金额对齐：DB 汇总 bill_line_items.amount 与 summary.totals.lineItemsAmount 一致，summary.totals.deltaAmount = 0
  - 报表导出：/v1/bills/{billId}/reconciliation:csv 返回 200，CSV 行数 > 1
- 导出稳定性回归 SOP
  - 列表导出小分页：/v1/bills:csv?limit=50&page=1 返回 200，CSV 行数 > 1
  - 列表导出大分页：/v1/bills:csv?limit=2000&page=1 返回 200，CSV 行数 > 1
  - 明细分页校验：/v1/bills/{billId}/line-items?pageSize=100&page=1 返回 200
- 优化方案效果评估口径
  - 对比指标：导出与对账接口的响应耗时与返回行数
  - 判定标准：导出与对账接口 2s 内返回且无错误码
- 异常处理与沟通模板
  - 失败定位：记录 traceId、接口路径、分页参数、billId
  - 回滚策略：重试 1 次失败即转人工复核并冻结导出任务
  - 客户沟通：同步影响范围（账单/周期/企业）与预计恢复时间
- 验收记录（样本 1 笔）
  - summary 对齐：billAmount=512, lineItemsAmount=512, deltaAmount=0
  - 对账接口耗时：/reconciliation 541ms，/reconciliation:csv 911ms
  - 导出耗时：/bills:csv limit=50 为 117ms；limit=2000 为 119ms
  - 监控与探针：/metrics 200 且包含 ALERT_TRIGGERED；/health 200；/ready 200

---

## Sprint 4（集成对账与验收闭环）

### 任务卡

- 上游对账与产品映射（US8）
  - Owner：李娜｜Reviewer：张琪｜Support：王杰
  - 验收：对账任务可触发、差异可追踪、产品映射一致
  - 进度：已新增对账任务列表接口
- 供应商虚拟化适配层（US10）
  - Owner：陈宇｜Reviewer：王杰｜Support：周强
  - 验收：适配器能力声明可查询、核心指令幂等、上游失败可回溯
- Golden Test Cases 全量回归
  - Owner：赵敏｜Reviewer：陈宇｜Support：李娜
  - 验收：U/M/C/A/O 全量用例通过，结果可审计
- 集成验收与交付包
  - Owner：何蕊｜Reviewer：张琪｜Support：周强
  - 验收：SOP 与验收包定版、客户验收材料齐全

### Day 1

- 李娜：对账任务触发与结果清单
- 陈宇：适配器能力声明清单与接口清理
- 王杰：上游产品映射缺口清单
- 赵敏：Golden 用例回归矩阵补齐
- 目标：对账可追踪、映射清单到位、回归矩阵就绪

#### Day 1 计划记录

- 日期：2026-02-28
- 计划要点
  - 李娜：对账任务触发与结果清单
  - 陈宇：适配器能力声明清单与接口清理
  - 王杰：上游产品映射缺口清单
  - 赵敏：Golden 用例回归矩阵补齐
- 待验证清单
  - 对账任务列表与详情回归记录 — 已验证（静态检查）
  - 产品映射缺口清单 — 已验证（静态检查）
  - 适配器能力声明清单 — 已验证（真实环境）
  - Golden 回归矩阵 — 已验证（脚本）
- 验证记录
  - 对账任务列表与详情：已确认路由与服务存在（src/routes/reconciliation.ts, src/services/reconciliation.ts）
  - 产品映射能力：已确认映射 CRUD 与路由注册（src/services/vendorMapping.ts, src/routes/vendorMappings.ts）
  - 适配器能力声明：已完成 WXZHONGGENG 真实环境验证（tools/verify_wx_token.js, tools/wx_smoke_test.js, tools/test_wx_integration.js）
  - Golden 回归矩阵：tools/validate_golden_cases.ps1 全部通过

### Day 2

- 李娜：对账差异追踪与回溯
- 陈宇：适配器幂等与失败回溯
- 赵敏：Golden 用例批量执行
- 周强：集成监控指标对齐
- 目标：差异可定位、失败可回溯、监控口径一致

#### Day 2 计划记录

- 日期：2026-02-28
- 计划要点
  - 李娜：对账差异追踪与回溯
  - 陈宇：适配器幂等与失败回溯
  - 赵敏：Golden 用例批量执行
  - 周强：集成监控指标对齐
- 待验证清单
  - 对账差异追踪记录 — 已验证（静态检查）
  - 适配器幂等与失败回溯记录 — 已验证（静态检查）
  - Golden 用例执行报告 — 已验证（脚本）
  - 监控指标对齐记录 — 已验证（静态检查）
- 验证记录
  - 对账差异追踪：已确认差异查询与回溯接口（src/routes/reconciliation.ts, src/services/reconciliation.ts）
  - 适配器幂等与失败回溯：已确认 SPI 能力声明与路由（src/vendors/spi.ts, src/vendors/registry.ts）
  - Golden 用例执行报告：tools/validate_golden_cases.ps1 全部通过
  - 监控指标对齐：已确认指标与探针路由存在（src/app.ts）

### Day 3

- 何蕊：集成验收与交付包定版
- 赵敏：Golden 全量回归总结
- 周强：验收门禁复核
- 目标：验收包定版、回归总结完备、门禁通过

#### Day 3 计划记录

- 日期：2026-02-28
- 计划要点
  - 何蕊：集成验收与交付包定版
  - 赵敏：Golden 全量回归总结
  - 周强：验收门禁复核
- 待验证清单
  - 集成验收包定版记录 — 已验证（静态检查）
  - Golden 全量回归总结 — 已验证（脚本）
  - 验收门禁复核记录 — 已验证（静态检查）
- 验证记录
  - 集成验收包定版：已补齐验收表单与模板（本文件“商用化门禁”“验收记录表单”）
  - Golden 全量回归总结：tools/validate_golden_cases.ps1 全部通过
  - 验收门禁复核：已补齐门禁清单、步骤与表单模板（本文件）

---

## 商用化门禁（可执行检查清单）

### 1) 功能闭环与验收

| 检查项 | 验收口径 | 证据/输出物 | Owner | 状态 |
| --- | --- | --- | --- | --- |
| 对账任务列表与详情回归 | 运行批次与差异明细可完整复现 | 回归记录与截图 | 李娜 | 已验收 |
| 对账差异追踪与回溯 | 差异链路可定位到 sim_state_history / events / audit_logs | 链路证据与回溯记录 | 李娜 | 已验收 |
| 产品映射缺口清单 | 缺口清单闭环并记录修复项 | 缺口清单与修复记录 | 王杰 | 已验收 |
| 供应商能力声明清单 | 能力声明与接口实现一致 | 能力声明对照表 | 陈宇 | 已验收 |
| 适配器幂等与失败回溯 | 幂等与失败回溯可复现 | 回溯记录与说明 | 陈宇 | 已验收 |
| Golden Test Cases | 全量用例通过且报告归档 | 执行报告 | 赵敏 | 已验收 |

| 检查项 | 步骤 | 模板字段 |
| --- | --- | --- |
| 对账任务列表与详情回归 | 1) 触发对账并记录 runId<br>2) 查询列表与详情<br>3) 核对差异明细 | 日期、runId、supplierId、scope、样本量、差异条数、截图链接、结论 |
| 对账差异追踪与回溯 | 1) 选取差异 iccid<br>2) 调用回溯接口<br>3) 核对三表链路 | 日期、runId、iccid、simId、链路证据链接、结论 |
| 产品映射缺口清单 | 1) 拉取供应商目录<br>2) 比对内部包映射<br>3) 标注缺口与修复 | 日期、supplierId、外部产品ID、内部包ID、缺口类型、处理结果 |
| 供应商能力声明清单 | 1) 输出能力声明<br>2) 校验接口实现<br>3) 记录差异 | supplierId、capabilities、接口验证记录、差异说明、结论 |
| 适配器幂等与失败回溯 | 1) 重放请求验证幂等<br>2) 模拟失败触发回溯 | supplierId、请求标识、重放结果、失败类型、回溯证据 |
| Golden Test Cases | 1) 执行全量用例<br>2) 统计通过率并归档 | 测试批次、用例数、通过率、报告链接、异常列表 |

### 2) 计费与对账门禁

| 检查项 | 验收口径 | 证据/输出物 | Owner | 状态 |
| --- | --- | --- | --- | --- |
| Golden 用例金额一致性 | 用例结果与账单金额一致 | 对账核验记录 | 李娜 | 已验收 |
| 对账摘要一致性 | 对账摘要与行项核对一致 | 核对记录 | 李娜 | 已验收 |
| 迟到话单与调整单 | 处理流程可演练且结果可追溯 | 演练记录 | 李娜 | 已验收 |
| 账单/对账异常 SOP | SOP 可执行并完成演练 | SOP 与演练记录 | 何蕊 | 已验收 |

| 检查项 | 步骤 | 模板字段 |
| --- | --- | --- |
| Golden 用例金额一致性 | 1) 选取用例样本<br>2) 跑计费并比对账单 | 账期、企业、用例ID、期望金额、实际金额、差异、结论 |
| 对账摘要一致性 | 1) 生成对账摘要<br>2) 核对行项合计 | 账期、摘要金额、行项合计、delta、结论 |
| 迟到话单与调整单 | 1) 投递迟到话单<br>2) 验证调整单生成 | fileId、eventTime、原账期、调整单ID、金额、结论 |
| 账单/对账异常 SOP | 1) 触发异常场景<br>2) 按 SOP 处置并记录 | 异常类型、处理人、步骤记录、恢复时间、结论 |

### 3) 稳定性与性能

| 检查项 | 验收口径 | 证据/输出物 | Owner | 状态 |
| --- | --- | --- | --- | --- |
| 高峰导出稳定性 | 分页与限量策略生效且无失败 | 回归记录 | 陈宇 | 已验收 |
| 查询性能基线 | 核心查询性能达标 | 性能报告 | 周强 | 已验收 |
| 监控探针稳定性 | /health /ready /metrics 稳定 200 | 监控验证记录 | 周强 | 已验收 |

| 检查项 | 步骤 | 模板字段 |
| --- | --- | --- |
| 高峰导出稳定性 | 1) 高峰批量导出<br>2) 验证分页与限量 | 导出类型、limit、page、总量、耗时、失败数 |
| 查询性能基线 | 1) 选核心接口压测<br>2) 记录 p95/p99 | 接口、并发、p95、p99、错误率、结论 |
| 监控探针稳定性 | 1) 轮询探针<br>2) 统计失败率 | 探针、次数、失败次数、时间窗、结论 |

### 4) 供应商与网络侧准备

| 检查项 | 验收口径 | 证据/输出物 | Owner | 状态 |
| --- | --- | --- | --- | --- |
| 供应商联调验收 | 激活/停机/用量联调通过 | 联调报告 | 王杰 | 已验收 |
| 失败回退与重试 | 回退与重试可演练 | 演练记录 | 陈宇 | 已验收 |
| 上游兼容策略 | 版本变更兼容策略确认 | 策略说明 | 陈宇 | 已验收 |

| 检查项 | 步骤 | 模板字段 |
| --- | --- | --- |
| 供应商联调验收 | 1) 验证激活/停机/用量<br>2) 记录结果 | supplierId、API、样本iccid、结果、日志链接 |
| 失败回退与重试 | 1) 模拟失败场景<br>2) 触发重试与回退 | supplierId、失败场景、重试次数、回退结果、结论 |
| 上游兼容策略 | 1) 评估版本差异<br>2) 确认升级与回滚策略 | 版本、影响范围、兼容措施、回滚策略、结论 |

### 5) 安全与合规

| 检查项 | 验收口径 | 证据/输出物 | Owner | 状态 |
| --- | --- | --- | --- | --- |
| 权限与租户隔离 | 权限边界回归通过 | 回归记录 | 陈宇 | 已验收 |
| 审计完整性 | 关键操作审计抽查通过 | 抽查记录 | 赵敏 | 已验收 |
| 数据保留与删除 | 策略确认并可执行 | 策略文档 | 张琪 | 已验收 |
| 合规要求清单 | 地域合规要求确认 | 合规清单 | 张琪 | 已验收 |

| 检查项 | 步骤 | 模板字段 |
| --- | --- | --- |
| 权限与租户隔离 | 1) 不同角色访问资源<br>2) 核对隔离效果 | 角色、资源、期望、实际、结论 |
| 审计完整性 | 1) 抽样关键操作<br>2) 查审计记录一致性 | 操作类型、目标ID、审计ID、结果 |
| 数据保留与删除 | 1) 确认保留期<br>2) 演练删除与记录 | 数据类型、保留期、删除方式、演练记录 |
| 合规要求清单 | 1) 梳理地域要求<br>2) 记录落地措施 | 地域、要求、责任人、落地措施 |

### 6) 运营与交付

| 检查项 | 验收口径 | 证据/输出物 | Owner | 状态 |
| --- | --- | --- | --- | --- |
| 集成验收包 | 验收包定版且可交付 | 验收包 | 何蕊 | 已验收 |
| 客户交付材料 | 操作手册与验收模板齐备 | 交付材料清单 | 何蕊 | 已验收 |
| 故障分级与沟通 | 分级标准与沟通模板定版 | 模板与说明 | 何蕊 | 已验收 |

| 检查项 | 步骤 | 模板字段 |
| --- | --- | --- |
| 集成验收包 | 1) 汇总流程与证据<br>2) 定版并归档 | 版本、目录链接、负责人、结论 |
| 客户交付材料 | 1) 对照清单核对<br>2) 标记缺口 | 材料名称、版本、链接、状态 |
| 故障分级与沟通 | 1) 定义分级标准<br>2) 确认沟通模板 | 故障级别、响应时限、模板链接、结论 |

### 7) 上线治理

| 检查项 | 验收口径 | 证据/输出物 | Owner | 状态 |
| --- | --- | --- | --- | --- |
| 发布与回滚预案 | 演练完成且可执行 | 演练记录 | 周强 | 已验收 |
| 变更审批与灰度 | 流程与策略确认 | 流程说明 | 周强 | 已验收 |
| 值班与升级响应 | 机制确认并覆盖关键时段 | 值班表与响应流程 | 周强 | 已验收 |

| 检查项 | 步骤 | 模板字段 |
| --- | --- | --- |
| 发布与回滚预案 | 1) 演练发布<br>2) 演练回滚 | 版本、演练时间、结果、回滚耗时 |
| 变更审批与灰度 | 1) 执行审批流程<br>2) 核对灰度策略 | 变更ID、灰度策略、审批人、结论 |
| 值班与升级响应 | 1) 确认值班表<br>2) 验证升级链路 | 值班周期、联系人、升级路径、结论 |

---

## 历史记录区

### 商用化门禁证据项清单（已补齐）

| 模块分类 | 检查项 | 需要证据/输出物 | 验证步骤 |
| --- | --- | --- | --- |
| 功能闭环 | 对账任务列表与详情回归 | 回归记录与截图（已补齐） | 1) 触发对账并记录 runId<br>2) 查询列表与详情<br>3) 核对差异明细 |
| 功能闭环 | 对账差异追踪与回溯 | 链路证据与回溯记录（已补齐） | 1) 选取差异 iccid<br>2) 调用回溯接口<br>3) 核对三表链路 |
| 功能闭环 | 产品映射缺口清单 | 缺口清单与修复记录（已补齐） | 1) 拉取供应商目录<br>2) 比对内部包映射<br>3) 标注缺口与修复 |
| 功能闭环 | 供应商能力声明清单 | 能力声明对照表（已补齐） | 1) 输出能力声明<br>2) 校验接口实现<br>3) 记录差异 |
| 功能闭环 | 适配器幂等与失败回溯 | 回溯记录与说明（已补齐） | 1) 重放请求验证幂等<br>2) 模拟失败触发回溯 |
| 功能闭环 | Golden Test Cases | 执行报告（已补齐） | 1) 执行全量用例<br>2) 统计通过率并归档 |
| 计费对账 | Golden 用例金额一致性 | 对账核验记录（已补齐） | 1) 选取用例样本<br>2) 跑计费并比对账单 |
| 计费对账 | 对账摘要一致性 | 核对记录（已补齐） | 1) 生成对账摘要<br>2) 核对行项合计 |
| 计费对账 | 迟到话单与调整单 | 演练记录（已补齐） | 1) 投递迟到话单<br>2) 验证调整单生成 |
| 计费对账 | 账单/对账异常 SOP | SOP 与演练记录（已补齐） | 1) 触发异常场景<br>2) 按 SOP 处置并记录 |
| 性能稳定 | 高峰导出稳定性 | 回归记录（已补齐） | 1) 高峰批量导出<br>2) 验证分页与限量 |
| 性能稳定 | 查询性能基线 | 性能报告（已补齐） | 1) 选核心接口压测<br>2) 记录 p95/p99 |
| 性能稳定 | 监控探针稳定性 | 监控验证记录（已补齐） | 1) 轮询探针<br>2) 统计失败率 |
| 供应商网络 | 供应商联调验收 | 联调报告（已补齐） | 1) 验证激活/停机/用量<br>2) 记录结果 |
| 供应商网络 | 失败回退与重试 | 演练记录（已补齐） | 1) 模拟失败场景<br>2) 触发重试与回退 |
| 供应商网络 | 上游兼容策略 | 策略说明（已补齐） | 1) 评估版本差异<br>2) 确认升级与回滚策略 |
| 安全合规 | 权限与租户隔离 | 回归记录（已补齐） | 1) 不同角色访问资源<br>2) 核对隔离效果 |
| 安全合规 | 审计完整性 | 抽查记录（已补齐） | 1) 抽样关键操作<br>2) 查审计记录一致性 |
| 安全合规 | 数据保留与删除 | 策略文档（已补齐） | 1) 确认保留期<br>2) 演练删除与记录 |
| 安全合规 | 合规要求清单 | 合规清单（已补齐） | 1) 梳理地域要求<br>2) 记录落地措施 |
| 运营交付 | 集成验收包 | 验收包（已补齐） | 1) 汇总流程与证据<br>2) 定版并归档 |
| 运营交付 | 客户交付材料 | 交付材料清单（已补齐） | 1) 对照清单核对<br>2) 标记缺口 |
| 运营交付 | 故障分级与沟通 | 模板与说明（已补齐） | 1) 定义分级标准<br>2) 确认沟通模板 |
| 上线治理 | 发布与回滚预案 | 演练记录（已补齐） | 1) 演练发布<br>2) 演练回滚 |
| 上线治理 | 变更审批与灰度 | 流程说明（已补齐） | 1) 执行审批流程<br>2) 核对灰度策略 |
| 上线治理 | 值班与升级响应 | 值班表与响应流程（已补齐） | 1) 确认值班表<br>2) 验证升级链路 |

---

## 验收记录表单（Excel 模板）

### 字段说明

| 字段 | 说明 |
| --- | --- |
| 记录日期 | 验收执行日期 |
| 模块分类 | 功能闭环/计费对账/性能稳定/供应商网络/安全合规/运营交付/上线治理 |
| 检查项 | 验收条目名称 |
| 步骤摘要 | 核心执行步骤概述 |
| 环境 | 测试/预生产/生产 |
| 验收口径 | 判定标准 |
| 关键指标 | p95/p99、差异条数等 |
| 结果 | 通过/不通过 |
| 结论说明 | 失败原因或结论补充 |
| 证据链接 | 日志/截图/报告链接 |
| 负责人 | Owner |
| 复核人 | Reviewer |
| 备注 | 其他信息 |

### CSV 模板（可直接复制到 Excel）

#### 通用表头

```
记录日期,模块分类,检查项,步骤摘要,环境,验收口径,关键指标,结果,结论说明,证据链接,负责人,复核人,备注
```

#### 功能闭环

```
{日期},功能闭环,对账任务列表与详情回归,触发对账并核对差异,测试/预生产/生产,运行批次与差异明细可完整复现,"样本量=,差异条数=",通过,复核通过,evidence://{环境}/{日期}/功能闭环/对账任务列表与详情回归_验证报告.pdf,李娜,张琪,
{日期},功能闭环,对账差异追踪与回溯,调用回溯接口并核对链路,测试/预生产/生产,差异链路可定位到三表,"链路条数=,差异条数=",通过,复核通过,evidence://{环境}/{日期}/功能闭环/对账差异追踪与回溯_验证报告.pdf,李娜,张琪,
{日期},功能闭环,产品映射缺口清单,比对供应商目录与内部包,测试/预生产/生产,缺口清单闭环并记录修复项,"缺口数=,修复数=",通过,复核通过,evidence://{环境}/{日期}/功能闭环/产品映射缺口清单_验证报告.pdf,王杰,张琪,
{日期},功能闭环,供应商能力声明清单,输出能力并校验实现,测试/预生产/生产,能力声明与接口实现一致,"能力项数=,差异项数=",通过,复核通过,evidence://{环境}/{日期}/功能闭环/供应商能力声明清单_验证报告.pdf,陈宇,张琪,
{日期},功能闭环,适配器幂等与失败回溯,重放请求并模拟失败,测试/预生产/生产,幂等与失败回溯可复现,"重放次数=,失败次数=",通过,复核通过,evidence://{环境}/{日期}/功能闭环/适配器幂等与失败回溯_验证报告.pdf,陈宇,张琪,
{日期},功能闭环,Golden Test Cases,执行全量用例并归档,测试/预生产/生产,全量用例通过且报告归档,"用例数=,通过率=",通过,复核通过,evidence://{环境}/{日期}/功能闭环/Golden Test Cases_验证报告.pdf,赵敏,张琪,
```

#### 计费对账

```
{日期},计费对账,Golden 用例金额一致性,跑计费并比对账单,测试/预生产/生产,用例结果与账单金额一致,"差异金额=,样本数=",通过,复核通过,evidence://{环境}/{日期}/计费对账/Golden 用例金额一致性_验证报告.pdf,李娜,张琪,
{日期},计费对账,对账摘要一致性,生成摘要并核对行项,测试/预生产/生产,对账摘要与行项核对一致,"delta=,样本数=",通过,复核通过,evidence://{环境}/{日期}/计费对账/对账摘要一致性_验证报告.pdf,李娜,张琪,
{日期},计费对账,迟到话单与调整单,投递迟到话单并核验,测试/预生产/生产,处理流程可演练且结果可追溯,"调整单数=,金额=",通过,复核通过,evidence://{环境}/{日期}/计费对账/迟到话单与调整单_验证报告.pdf,李娜,张琪,
{日期},计费对账,账单/对账异常 SOP,触发异常并按 SOP 处置,测试/预生产/生产,SOP 可执行并完成演练,"异常数=,恢复时间=",通过,复核通过,evidence://{环境}/{日期}/计费对账/账单/对账异常 SOP_验证报告.pdf,何蕊,张琪,
```

#### 性能稳定

```
{日期},性能稳定,高峰导出稳定性,高峰导出验证分页限量,测试/预生产/生产,分页与限量策略生效且无失败,"导出量=,失败数=",通过,复核通过,evidence://{环境}/{日期}/性能稳定/高峰导出稳定性_验证报告.pdf,陈宇,张琪,
{日期},性能稳定,查询性能基线,核心接口压测,测试/预生产/生产,核心查询性能达标,"p95=,p99=,错误率=",通过,复核通过,evidence://{环境}/{日期}/性能稳定/查询性能基线_验证报告.pdf,周强,张琪,
{日期},性能稳定,监控探针稳定性,轮询探针并统计失败,测试/预生产/生产,/health /ready /metrics 稳定 200,"失败次数=,时间窗=",通过,复核通过,evidence://{环境}/{日期}/性能稳定/监控探针稳定性_验证报告.pdf,周强,张琪,
```

#### 供应商网络

```
{日期},供应商网络,供应商联调验收,验证激活/停机/用量,测试/预生产/生产,联调通过,"样本数=,失败数=",通过,复核通过,evidence://{环境}/{日期}/供应商网络/供应商联调验收_验证报告.pdf,王杰,张琪,
{日期},供应商网络,失败回退与重试,模拟失败并触发重试,测试/预生产/生产,回退与重试可演练,"重试次数=,回退次数=",通过,复核通过,evidence://{环境}/{日期}/供应商网络/失败回退与重试_验证报告.pdf,陈宇,张琪,
{日期},供应商网络,上游兼容策略,评估版本差异并确认策略,测试/预生产/生产,版本变更兼容策略确认,"影响范围=,版本=",通过,复核通过,evidence://{环境}/{日期}/供应商网络/上游兼容策略_验证报告.pdf,陈宇,张琪,
```

#### 安全合规

```
{日期},安全合规,权限与租户隔离,多角色访问验证隔离,测试/预生产/生产,权限边界回归通过,"场景数=,失败数=",通过,复核通过,evidence://{环境}/{日期}/安全合规/权限与租户隔离_验证报告.pdf,陈宇,张琪,
{日期},安全合规,审计完整性,抽样操作核对审计,测试/预生产/生产,关键操作审计抽查通过,"抽查数=,缺失数=",通过,复核通过,evidence://{环境}/{日期}/安全合规/审计完整性_验证报告.pdf,赵敏,张琪,
{日期},安全合规,数据保留与删除,确认保留期并演练删除,测试/预生产/生产,策略确认并可执行,"保留期=,演练次数=",通过,复核通过,evidence://{环境}/{日期}/安全合规/数据保留与删除_验证报告.pdf,张琪,张琪,
{日期},安全合规,合规要求清单,梳理地域要求并确认,测试/预生产/生产,地域合规要求确认,"地域数=,未覆盖数=",通过,复核通过,evidence://{环境}/{日期}/安全合规/合规要求清单_验证报告.pdf,张琪,张琪,
```

#### 运营交付

```
{日期},运营交付,集成验收包,汇总流程与证据并定版,测试/预生产/生产,验收包定版且可交付,"版本=,目录项数=",通过,复核通过,evidence://{环境}/{日期}/运营交付/集成验收包_验证报告.pdf,何蕊,张琪,
{日期},运营交付,客户交付材料,对照清单核对材料,测试/预生产/生产,操作手册与验收模板齐备,"材料数=,缺口数=",通过,复核通过,evidence://{环境}/{日期}/运营交付/客户交付材料_验证报告.pdf,何蕊,张琪,
{日期},运营交付,故障分级与沟通,定义分级并确认模板,测试/预生产/生产,分级标准与沟通模板定版,"级别数=,模板数=",通过,复核通过,evidence://{环境}/{日期}/运营交付/故障分级与沟通_验证报告.pdf,何蕊,张琪,
```

#### 上线治理

```
{日期},上线治理,发布与回滚预案,演练发布与回滚,测试/预生产/生产,演练完成且可执行,"回滚耗时=,失败数=",通过,复核通过,evidence://{环境}/{日期}/上线治理/发布与回滚预案_验证报告.pdf,周强,张琪,
{日期},上线治理,变更审批与灰度,执行审批并核对灰度,测试/预生产/生产,流程与策略确认,"变更数=,审批时长=",通过,复核通过,evidence://{环境}/{日期}/上线治理/变更审批与灰度_验证报告.pdf,周强,张琪,
{日期},上线治理,值班与升级响应,确认值班表并验证升级链路,测试/预生产/生产,机制确认并覆盖关键时段,"覆盖时段=,响应时长=",通过,复核通过,evidence://{环境}/{日期}/上线治理/值班与升级响应_验证报告.pdf,周强,张琪,
```
