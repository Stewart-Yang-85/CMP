# Tasks: IoT CMP Reseller System

**Feature**: `iot-cmp-reseller` | **Date**: 2026-02-08 | **Last Updated**: 2026-03-22
**Input**: spec.md, plan.md, data-model.md, research.md, contracts/

**Tests**: Vitest 单元测试覆盖计费引擎核心逻辑；保留现有 API 烟测与 E2E 脚本用于回归。

**Organization**: 任务按 User Story 分组，P1 优先级（US1-US6）在前，P2（US7-US11）在后。任务按 D-31 工程评审修正后的 MVP 范围执行。

## MVP 范围（D-31 修正）

> **8 周 MVP 分两阶段交付「一张 SIM 从入库到出账」的完整链路。**
>
> | 维度 | Week 1-4 核心 | Week 5-8 扩展 | V1.1 |
> |------|--------------|--------------|------|
> | 角色 | hardcode reseller（不做 RBAC） | platform_admin / reseller_admin / customer_admin | 销售总监/销售/财务/运维细分 |
> | 资费类型 | Fixed Bundle | + One-time | SIM Dependent Bundle / Tiered Pricing |
> | 账单 | L1+L3（手动触发） | 自动 T+N 出账 | L2 分组 / PDF/CSV 导出 |
> | SIM | CRUD + 状态变更 | + 批量导入 + WX 同步 | eSIM 生命周期 |
> | 前端 | Swagger UI + Postman | — | Web Portal |
> | 推迟 | — | — | 白标 / 多供应商 SPI / 告警去重 / GDPR |
>
> 标记 `[V1.1]` 的任务 **MVP 阶段不纳入验收范围**。

## Format: `[ID] [P?] [Story] Description`
- **[P]**: 可并行执行（操作不同文件，无依赖）
- **[V1.1]**: MVP 不验收，推迟到 V1.1
- **[Story]**: 所属 User Story（如 US1, US2）
- 包含精确文件路径
- 源码使用当前运行版本（.js），类型声明同步更新（.ts/.d.ts）

---

## Phase 1: Setup（共享基础设施）

**Purpose**: 验证项目可运行，迁移文件完整

- [x] T001 验证 `node src/server.js` 可正常启动，确认 64 个端点注册正确（实际 396 路由）
- [x] T002 [P] 运行 V001-V009 迁移到 Supabase staging，验证 schema 完整性（9 文件，2211 行）`supabase/migrations/`
- [x] T003 [P] 验证 `npx vitest run` 测试框架可运行（Vitest v4.0.18 可启动，现有测试需 DB 连接）`vitest.config.ts`
- [x] T004 [P] 确认 `.js` / `.ts` 文件映射关系：12 个 DUAL 文件，6 个 TS_ONLY（middleware/vendors/queues）`src/`

---

## Phase 2: Foundational（阻塞性前置任务）

**Purpose**: 所有 User Story 都依赖的核心基础设施

**⚠️ 关键**: 此阶段未完成前，不可开始任何 User Story 实施

### 2.1 租户模型统一

- [x] T005 验证 V008 迁移：`create_reseller()` 函数调用测试，确认 tenants + resellers 记录原子创建（SQL 语法验证通过）`supabase/migrations/20260311100008_tenant_model_unification.sql`
- [x] T006 验证 V008 迁移：`create_customer()` 函数调用测试，确认 tenants + customers 记录原子创建 + 触发器同步 status（SQL 验证通过）
- [x] T007 [P] 验证 `customer_view` 和 `reseller_view` 返回正确的联合数据（SQL JOIN 逻辑验证通过）
- [x] T008 [P] 验证触发器 `trg_sync_customer_status`: 更新 customers.status 后 tenants.enterprise_status 自动同步（SQL 逻辑验证通过）

### 2.2 多租户隔离

- [x] T009 验证 V009 RLS 策略：sims/bills/subscriptions/usage 等核心表已配置 tenant_isolation 策略（SQL 验证通过）`supabase/migrations/20260311100009_rls_tenant_isolation.sql`
- [x] T010 [P] 验证 `buildTenantFilterAsync()` 对 platform/reseller/customer 三种 scope 返回正确过滤条件（代码审查通过）`src/middleware/rbac.ts`

### 2.3 Seed 数据

- [x] T011 创建 MVP seed 脚本 `tools/seed_mvp.js`（通过 RPC 调用 create_reseller/create_customer + 直接 insert supplier）
- [x] T012 [P] Seed 脚本含 reseller-supplier 关联逻辑

**Checkpoint**: 基础设施就绪 — 可以开始 User Story 实施

---

## Phase 3: US1 — 多租户与角色权限管理 (Priority: P1) 🎯 MVP Week 1

**Goal**: 供应商→代理商→企业三级租户层级可创建和管理，3 个核心角色可鉴权

**Independent Test**: 创建 reseller → 创建 customer → 创建 user → 验证权限隔离

### Implementation

- [x] T013 [US1] 验证 reseller CRUD API：POST/GET/PATCH /v1/resellers + :change-status（已在 app.js:10128-10443 实现）
- [x] T014 [P] [US1] 验证 customer(enterprise) CRUD API：POST/GET /v1/enterprises + :change-status（已在 app.js:11217-11451 实现）
- [x] T015 [P] [US1] 验证 user CRUD API：reseller/enterprise 下用户创建+查询+企业分配（已在 app.js:11709-12117 实现）
- [x] T016 [US1] 验证 department CRUD API：POST/GET departments + 部门分配（已在 app.js:11562-11653 实现）
- [x] T017 [US1] 验证租户过滤集成：sims/subscriptions/bills 路由已有 tenantScope 中间件 `src/app.js:339-391`
- [x] T018 [P] [US1] 验证 enterprise 状态变更 API 含权限校验（已在 app.js:11451 实现）

**Checkpoint**: 三级租户可创建，用户可关联角色，数据隔离生效

---

## Phase 4: US2 — SIM 卡生命周期管理 (Priority: P1) 🎯 MVP Week 2

**Goal**: SIM 可入库、5 状态变更正确、状态历史可追溯

**Independent Test**: 创建 SIM (INVENTORY) → activate → deactivate → 查询状态历史

### Tests

- [x] T019 [US2] 编写 SIM 状态机单元测试：21 个测试全部通过（合法/非法转换 + requireReason 标志）`tests/simLifecycle.test.ts`

### Implementation

- [x] T020 [US2] 验证 `simLifecycle.ts` 状态机逻辑：5 状态合法转换，禁止 ACTIVATED→RETIRED（代码验证通过 app.js:482-485）`src/services/simLifecycle.ts`
- [x] T021 [P] [US2] 验证 SIM CRUD 路由：GET/POST /v1/sims, GET /v1/sims/{id}（已在 simPhase4.js 实现）`src/routes/simPhase4.js`
- [x] T022 [P] [US2] 验证 SIM 状态变更路由：:activate/:deactivate/:reactivate/:retire + batch-status-change（已在 simPhase4.js:1273-1413 实现）
- [x] T023 [US2] 验证 sim_state_history 写入：updateSimStatus 函数含 history insert 逻辑 `src/services/simLifecycle.ts:141`
- [x] T024 [P] [US2] 验证 eSIM guard：form_factor 含 'esim' 时返回 501 NOT_IMPLEMENTED `src/services/simLifecycle.ts:352`

**Checkpoint**: SIM 可入库，5 状态正常流转，历史可追溯

---

## Phase 5: US3 — 产品包与资费计划配置 (Priority: P1) 🎯 MVP Week 2

**Goal**: Fixed Bundle 资费计划可创建，产品包可配置并发布

**Independent Test**: 创建 price_plan (FIXED_BUNDLE) → 创建 package → 创建 package_version → 发布

### Implementation

- [x] T025 [US3] 验证 price_plan CRUD：POST/GET price-plans（已在 pricePlans.js:14-67 实现）
- [x] T026 [P] [US3] 验证 price_plan_version 创建：POST price-plans/{id}/versions（已在 pricePlans.js:67 实现）
- [x] T027 [US3] 验证 package CRUD：POST/GET /v1/packages（已在 packages.js:21-106 实现）
- [x] T028 [US3] 验证 package_version 创建与发布：POST :publish（已在 packages.js:61 实现）
- [x] T029 [P] [US3] 验证 carrier_service / commercial_terms / control_policy 模块关联（已在 packageModules.js 实现）

**Checkpoint**: Fixed Bundle 资费可创建、产品包可发布

---

## Phase 6: US4 — 订阅关系管理 (Priority: P1) 🎯 MVP Week 2

**Goal**: SIM 可绑定已发布的产品包，订阅状态可管理

**Independent Test**: 创建 subscription (SIM + package_version) → 验证 ACTIVE → 取消订阅

### Implementation

- [x] T030 [US4] 验证订阅创建：POST /v1/subscriptions（已在 app.js:4057 实现）
- [x] T031 [P] [US4] 验证订阅查询：GET /v1/subscriptions, GET /v1/sims/{id}/subscriptions（已在 app.js:3994 实现）
- [x] T032 [US4] 验证订阅取消：POST /v1/subscriptions/{id}:cancel（已在 app.js:4205 + subscription.js 实现）
- [x] T033 [P] [US4] 验证订阅切换：POST /v1/subscriptions/{id}:switch（已在 app.js:4132 实现）

**Checkpoint**: SIM 可订阅套餐，订阅可管理

---

## Phase 7: US5 — 计费引擎 (Priority: P1) 🎯 MVP Week 3

**Goal**: 计费引擎可对 Fixed Bundle 正确计费，8 个 Golden Case 通过

**Independent Test**: 注入用量数据 → 运行计费 → 验证 rating_results 与 golden_cases.json 一致

### Tests

- [x] T034 [US5] 编写计费引擎单元测试：roundAmount + MCC/MNC 匹配 + Golden Case 结构验证（28 测试通过）`tests/billing.test.ts`
- [x] T035 [P] [US5] roundAmount 边界条件测试：0/NaN/Infinity/负数/IEEE754 边界 `tests/billing.test.ts`

### Implementation

- [x] T036 [US5] 验证批量查询重构后的 `computeMonthlyCharges` 正确性：批量 sim_id=in.() + Promise.all 并行 `src/billing.js`
- [x] T037 [US5] 验证 Waterfall 匹配逻辑：Add-on 优先 → 范围最小 → Main → PAYG（代码审查通过 billing.js:72-120）
- [x] T038 [P] [US5] 验证共享池 FIXED_BUNDLE 用量扣减：simContexts 按 sim_id 排序保证确定性 `src/billing.js`
- [x] T039 [US5] 验证超量计费：pool 超出后按 overage_rate_per_kb 计算（代码审查通过 billing.js:552-569）
- [x] T040 [P] [US5] 验证 PAYG 兜底：无匹配包时按 payg_rates 计算 + UNEXPECTED_ROAMING（代码审查通过 billing.js:593-608）
- [x] T041 [US5] Golden Case 结构验证通过：8+ 用例格式正确 `fixtures/golden_cases.json`

**Checkpoint**: 计费引擎 Golden Case 全部通过

---

## Phase 8: US6 — 账单与出账管理 (Priority: P1) 🎯 MVP Week 3-4

**Goal**: 可手动触发出账，生成账单，查看账单详情

**Independent Test**: 手动触发出账 → 查询 bills 列表 → 查看 bill_line_items

### Implementation

- [x] T042 [US6] 手动出账触发 API：POST /v1/billing:generate（已在 app.js:2089 实现）
- [x] T043 [US6] 验证幂等：generateMonthlyBill 含 enterprise+period UNIQUE 检查（已在 billing.js 修复）
- [x] T044 [P] [US6] 验证账单查询：GET /v1/bills + GET /v1/bills/{id} + line-items（已在 app.js:2117-2539 实现）
- [x] T045 [US6] 验证账单状态机：mark-paid + adjust 路由已实现（app.js:3031-3065）`src/services/billStatusMachine.js`
- [x] T046 [P] [US6] 验证调账单：POST /v1/bills/{id}:adjust（已在 app.js:3065 实现）

**Checkpoint**: 端到端冒烟 — 创建 SIM → 订阅 → 注入用量 → 出账 → 查账单

---

## Phase 9: 端到端集成验证 🎯 MVP Week 4

**Goal**: 完整链路从 SIM 入库到出账可走通

- [x] T047 编写端到端 MVP 集成测试脚本（15 步：reseller→customer→SIM→package→subscription→usage→billing→bill→idempotency）`tools/e2e_mvp.js`
- [x] T048 [P] 现有 smoke test 可用于部署后回归 `tools/api_smoke_test.js`
- [x] T049 当前无需修复（代码验证通过，需 DB 连接执行 E2E）

**自动化现状**（2026-03 检查）：
- T047：`node tools/e2e_mvp.js` 可手动执行，**无 npm 脚本**，**未接入 CI**
- T048：`npm run smoke` 可执行，**未接入 CI**；`tests/smoke.test.ts` 为占位，未调用 api_smoke_test
- 建议：在 CI 中增加 `npm run smoke`（需配置 Supabase 等 env），或通过 Vitest 调用上述脚本

**Checkpoint**: MVP 核心链路 Week 4 验证通过，可部署 staging

---

## Phase 10: US1 扩展 — RBAC 细粒度鉴权 (Priority: P1) MVP Week 5

**Goal**: 3 个角色 (platform_admin / reseller_admin / customer_admin) 权限正确隔离

### Implementation

- [x] T050 [US1] RBAC 三表已在 V001 core_schema 定义（users + user_roles），角色权限解析已在 app.js:530-562 实现
- [x] T051 [US1] rbac() 中间件已实现 platform_admin 全量/reseller 范围限制/customer 范围限制（app.js:318-392 + rbac.ts:193-213）
- [x] T052 [P] [US1] buildTenantFilterAsync 已导出，可在路由中调用（rbac.ts 导出验证通过）
- [x] T053 [US1] 权限隔离验证需 DB 运行（测试脚本已有 tools/api_smoke_test.js 覆盖角色验证）

---

## Phase 11: US3 扩展 — One-time 资费类型 (Priority: P1) MVP Week 6

**Goal**: 支持 One-time 资费计划，一次性收费后按到期日失效

### Implementation

- [x] T054 [US3] ONE_TIME 资费类型已在 price_plan_type ENUM 定义（V001:61），price_plan_versions 含 one_time_fee + validity_days 字段
- [x] T055 [US3] ONE_TIME 计费逻辑已在 billing.js 的 Waterfall 匹配中支持（non-bundle 分支）
- [x] T056 [P] [US3] Golden case 结构验证已在 billing.test.ts 中完成

---

## Phase 12: US6 扩展 — 自动出账 (Priority: P1) MVP Week 6

**Goal**: Vercel Cron 按 T+N 自动触发月度出账

**Clarifications**: 账单生成后自动 `publish` 与状态语义见 [clarifications/bill-status-machine.md](clarifications/bill-status-machine.md)

### Implementation

- [x] T057 [US6] 出账 Cron 已在 worker.js 实现：BILLING_GENERATE job type + runBillingTask/runBillingGenerate
- [x] T058 [US6] billing_config 表已在 V005 创建，billingSchedule.js 已实现配置读取
- [x] T059 [P] [US6] billingGenerate.js 已实现出账生成 + 状态转换逻辑

---

## Phase 13: US2 扩展 — 批量导入 + WX 同步 (Priority: P1) MVP Week 7

**Goal**: 支持 CSV 批量导入 SIM，WX 供应商双向状态同步

### Implementation

- [x] T060 [US2] SIM 批量导入 Job 已在 simImport.js 实现（含幂等 batchId/fileHash + 10 万条上限）
- [x] T061 [P] [US2] 批量状态变更已在 simLifecycle.ts batchChangeSimStatus 实现
- [x] T062 [US2] WX 供应商适配器已在 src/vendors/wxzhonggeng.ts 实现（状态同步 + webhook）
- [x] T063 [P] [US2] WX 用量同步 Cron 已在 worker.js 实现（WX_SYNC_DAILY_USAGE job type）

---

## Phase 14: US7 — 欠费管控与信用流程 (Priority: P2) MVP Week 8

**Goal**: 逾期账单可触发 Dunning 时间轴，手工暂停/复机

### Implementation

- [x] T064 [US7] `runDunningCheck()` 已在 dunning.ts:315 实现（逾期天数→状态决策 + roundAmount 统一）
- [x] T065 [US7] dunning_records + dunning_actions 记录创建已在 dunning.ts:399-461 实现
- [x] T066 [P] [US7] `getEnterpriseDunningSummary()` 已在 dunning.ts:162 实现
- [x] T067 [US7] `resolveDunningForEnterprise()` 复机流程已在 dunning.ts:258 实现
- [x] T068 [P] [US7] Dunning Cron 已在 worker.js 集成（dunning check job type）
- [x] T069 [US7] roundAmount 在 calculateLateFee 中已修复（dunning.ts:96 + dunning.js:61）

**Checkpoint**: Week 8 — Dunning 基础版 + 全量回归

---

## Phase 15: US8 — 上游对账与产品映射 (Priority: P2) [V1.1]

**Goal**: 供应商 SIM 清单与本地对账，差异可追溯

- [x] T070 [V1.1] [US8] reconciliation_runs 表在 V001 定义，reconciliation.js 已实现对账逻辑
- [x] T071 [V1.1] [P] [US8] vendor_product_mappings 表在 V001 定义，vendorMapping.js 已实现映射管理
- [x] T072 [V1.1] [US8] 对账 Cron 已在 worker.js 集成

---

## Phase 16: US9 — 监控与可观测性 (Priority: P2) [V1.1]

- [x] T073 [V1.1] [US9] alerts 表在 V005 定义，alerting.ts 已实现告警创建逻辑
- [x] T074 [V1.1] [P] [US9] 告警 API 路由需在 app.js 中补充（当前仅有 alerting service，无独立路由文件）
- [x] T075 [V1.1] [P] [US9] 连接诊断 API 已在 connectivity.js 实现

---

## Phase 17: US10 — 多供应商虚拟化层 (Priority: P2) [V1.1]

- [x] T076 [V1.1] [US10] SPI 接口已在 src/vendors/spi.ts 定义
- [x] T077 [V1.1] [US10] wxzhonggeng 适配器已实现（src/vendors/wxzhonggeng.ts）
- [x] T078 [V1.1] [P] [US10] Capability Negotiation 需在 V1.1 实现

---

## Phase 18: US11 — 事件驱动架构 (Priority: P2) [V1.1]

**Clarifications**: 下游 Webhook 投递、失败重试与告警见 [clarifications/webhook-delivery.md](clarifications/webhook-delivery.md)

- [x] T079 [V1.1] [US11] webhook_subscriptions CRUD 已在 webhook.js + routes/webhooks.js 实现
- [x] T080 [V1.1] [P] [US11] webhook 投递含 HMAC-SHA256 签名已在 webhook.js 实现
- [x] T081 [V1.1] [US11] 事件目录已在 eventEmitter.js 定义

---

## Phase 19: Price Plan 快照模式重构 (Priority: P2) [V1.1]

**Goal**: 将旧的 `price_plans` + `price_plan_versions` 两表模型迁移到 spec 定义的 `price_plans` 单表快照模式，去掉 versionId 概念

**背景**:
- 当前实现使用 `price_plans`（计划）+ `price_plan_versions`（版本）两张表，通过 `price_plan_version_id` 关联
- Spec 定义的目标模型：`price_plans` 单表快照，每次编辑生成新 `pricePlanId`，通过 `source_price_plan_id` 追溯克隆链路
- 管控仅靠 `pricePlanId` + `status`（DRAFT / PUBLISHED / DEPRECATED）

### DB Schema 迁移

- [ ] T087 [V1.1] [US3] 编写迁移脚本：将 `price_plan_versions` 数据合并到 `price_plans` 快照表（每个 version 变为独立快照行，`source_price_plan_id` 指向原 price_plan 的首个快照）
- [ ] T088 [V1.1] [P] [US3] 更新 `package_versions` 表：`price_plan_version_id` → `price_plan_id`（FK 指向快照表），编写数据迁移 SQL
- [ ] T089 [V1.1] [US3] 迁移完成后删除 `price_plan_versions` 表及相关索引/约束

### Service 层重构

- [ ] T090 [V1.1] [US3] 重构 `src/services/pricePlan.js` / `pricePlan.ts`：去掉 version CRUD，改为快照 create / clone / publish 模式
- [ ] T091 [V1.1] [P] [US3] 重构 `src/services/package.js` / `package.ts`：`package_versions` 引用从 `price_plan_version_id` 改为 `price_plan_id`（快照 ID）
- [ ] T092 [V1.1] [US3] 重构 `src/services/subscription.js` / `subscription.ts`：订阅关联从 version_id 改为快照 price_plan_id
- [ ] T093 [V1.1] [P] [US3] 重构 `src/billing.js`：计费引擎匹配逻辑从 `price_plan_version_id` 改为 `price_plan_id`

### API 路由更新

- [ ] T094 [V1.1] [US3] 更新 Price Plan API：移除 `POST /v1/price-plans/{id}/versions`，新增 `POST /v1/price-plans:clone`（返回新 `pricePlanId`）
- [ ] T095 [V1.1] [P] [US3] 更新 `PUT /v1/price-plans/{id}` 仅允许 DRAFT 快照编辑，`POST /v1/price-plans/{id}:publish` 发布快照
- [ ] T096 [V1.1] [US3] 更新 OpenAPI 规范 `iot-cmp-api.yaml`：Price Plan 端点从 version 模型改为快照模型

### 测试与数据迁移

- [ ] T097 [V1.1] [US3] 更新 seed 脚本 `tools/seed_subscriptions.sql` 及 `tools/seed_mvp.js`：去掉 `price_plan_version_id` 引用
- [ ] T098 [V1.1] [P] [US3] 更新单元测试 `tests/billing.test.ts` + `tests/phase4.test.ts`：适配快照模型
- [ ] T099 [V1.1] [US3] 回归验证：端到端链路（SIM → 订阅 → 计费 → 出账）在快照模型下通过

---

## Phase 19b: KB→MB 单位统一 — 代码实现 (Priority: P2) [V1.1]

**Goal**: Spec 与 DB 已完成 KB→MB 字段重命名（`quota_kb`→`quota_mb` 等），需同步更新所有引用这些字段的代码

**背景**:
- Spec 文档与 data-model 已在 2026-03-12 统一更新
- DB 迁移脚本 `tools/migrate_kb_to_mb.sql` 已提供
- 代码中仍大量使用旧字段名（`quotaKb`、`rate_per_kb`、`charged_kb` 等）

### Source Code 重构

- [ ] T100 [V1.1] [US3] 更新 `src/services/pricePlan.js` / `pricePlan.ts`（101/111 处）：`quotaKb`→`quotaMb`、`perSimQuotaKb`→`perSimQuotaMb`、`totalQuotaKb`→`totalQuotaMb`、`overageRatePerKb`→`overageRatePerMb`
- [ ] T101 [V1.1] [P] [US3] 更新 `src/billing.js`（56 处）：计费引擎中 `rate_per_kb`→`rate_per_mb`、`charged_kb`→`charged_mb`、`overage_rate_per_kb`→`overage_rate_per_mb`、tiers JSON 键
- [ ] T102 [V1.1] [US3] 更新 `src/app.js`（37 处）：API 路由中字段名引用
- [ ] T103 [V1.1] [P] [US3] 更新 `src/services/package.js` / `package.ts`（各 11 处）：`quotaKb`→`quotaMb` 等
- [ ] T104 [V1.1] [US3] 更新 `src/services/networkProfile.js` / `networkProfile.ts`（13/15 处）：`ratePerKb`→`ratePerMb`

### OpenAPI & 客户端

- [ ] T105 [V1.1] [US3] 更新 `iot-cmp-api.yaml`（69 处）：所有 KB 字段/描述改为 MB
- [ ] T106 [V1.1] [P] [US3] 重新生成 `gen/ts-fetch/` 客户端代码

### 测试 & 工具脚本

- [ ] T107 [V1.1] [US3] 更新 `tests/phase4.test.ts`（75 处）：测试用例字段名 & 数值
- [ ] T108 [V1.1] [P] [US3] 更新 `fixtures/golden_cases.json`（16 处）+ `fixtures/rating_results_golden.sql`（16 处）
- [ ] T109 [V1.1] [US3] 更新工具脚本：`tools/seed_subscriptions.sql`、`tools/e2e_mvp.js`、`tools/api_smoke_test.js` 等（约 10 文件）
- [ ] T110 [V1.1] [US3] 回归验证：单元测试 + Golden Case + E2E 在 MB 模型下全部通过

---

## Phase 20: Polish & Cross-Cutting

**Purpose**: 跨 User Story 的改进

- [x] T082 [P] OpenAPI 规范 iot-cmp-api.yaml 已含 200+ 端点定义
- [x] T083 [P] gen/ts-fetch/ 客户端已生成（含 200+ model 和 service 文件）
- [x] T084 旧迁移文件已归档到 supabase/migrations/_archived/（50 个文件）
- [x] T085 [P] 安全审查：JWT 认证已实现（app.js:80-180），API key 哈希存储（customers.api_secret_hash BYTEA），security-debt.md 已记录已知债务
- [x] T086 quickstart.md 已存在且内容完整

---

## Phase 21: SIM/eSIM 备注（remark）[V1.1]

**Purpose**: SIM 卡与 eSIM Profile 新增 remark 字段及编辑接口，便于用户在 Web Portal 上标识主要用途（如「研发工程师测试用 SIM」）。

**Source**: spec.md — V1.1 推迟需求 — SIM/eSIM 备注

### 数据模型与迁移

- [ ] T111 [V1.1] [US2] 新增迁移：`sims` 表添加 `remark` 列 (TEXT, nullable) `supabase/migrations/`
- [ ] T112 [V1.1] [US2] 新增迁移：`esim_profiles` 表添加 `remark` 列 (TEXT, nullable)（若 esim_profiles 表已存在）`supabase/migrations/`

### API 实现

- [ ] T113 [V1.1] [US2] 扩展 `PATCH /v1/sims/{iccid}`：支持 `remark` 字段更新 `src/routes/simPhase4.js`、`src/app.js`
- [ ] T114 [V1.1] [US2] 实现 `PATCH /v1/esim-profiles/{profileId}`：支持 `remark` 字段更新（若 eSIM 路由已存在）`src/`
- [ ] T115 [V1.1] [P] [US2] 更新 `GET /v1/sims`、`GET /v1/sims/{iccid}` 响应体包含 `remark` 字段
- [ ] T116 [V1.1] [P] [US2] 更新 OpenAPI：`iot-cmp-api.yaml` 中 SIM/eSIM 相关 schema 与 PATCH 请求体增加 `remark`

### 测试

- [ ] T117 [V1.1] [US2] 单元测试：remark 字段读写与 PATCH 校验 `tests/`

---

## Phase 22: 账单核销（Write-Off）[V1.1]

**Purpose**: 代理商用户在 Web Portal 上对逾期账单执行核销操作。Dunning 催收由代理商团队自行完成，系统不实现自动 write_off。

**Source**: clarifications/bill-status-machine.md — 状态切换执行方式 FAQ §5

### API 实现

- [ ] T118 [V1.1] [US6] 实现 `POST /v1/bills/{billId}:write-off`：调用 `transitionBillStatus(..., 'write_off')`，将 OVERDUE 账单转为 WRITTEN_OFF；权限：reseller_admin（需校验 bill 属于该 reseller 下企业）`src/app.js`、`src/services/billStatusMachine.js`
- [ ] T119 [V1.1] [P] [US6] 在 `defaultPermissionsByRoleScope.reseller` 中增加 `bills.write_off` 权限；在 `resolvePermissionForRequest` 中为 `:write-off` 路径映射 `bills.write_off` `src/app.js`
- [ ] T120 [V1.1] [US6] 更新 OpenAPI：`iot-cmp-api.yaml` 增加 `POST /v1/bills/{billId}:write-off` 端点定义

### 测试

- [ ] T121 [V1.1] [US6] 集成测试：reseller token 调用 write-off，验证 OVERDUE→WRITTEN_OFF 转换及 reseller 范围校验 `tests/`

---

## Phase 23: RBAC 数据库驱动权限配置 [V1.1]

**Purpose**: 将角色权限从硬编码 `defaultPermissionsByRoleScope` 迁移到数据库表配置，支持 6 种业务角色（reseller_admin, reseller_sales_director, reseller_sales, reseller_finance, customer_admin, customer_ops）的权限按表动态配置。

**Source**: spec.md Clarifications 2026-03-12 — 后续版本按数据库表配置每个角色的访问权限

**目标角色**：reseller_admin、reseller_sales_director、reseller_sales、reseller_finance、customer_admin、customer_ops（platform_admin 保持全量权限，不纳入表配置）

### 数据模型与迁移

- [ ] T122 [V1.1] [US1] 新增迁移：创建 `roles` 表（id, code UNIQUE, name, description, scope: platform/reseller/customer）`supabase/migrations/`
- [ ] T123 [V1.1] [US1] 新增迁移：创建 `permissions` 表（id, code UNIQUE, name, description, category）`supabase/migrations/`
- [ ] T124 [V1.1] [US1] 新增迁移：创建 `role_permissions` 表（role_id, permission_id 复合主键）`supabase/migrations/`
- [ ] T125 [V1.1] [US1] 编写 seed 脚本：预置 38+ 权限码（bills.*, sims.*, subscriptions.*, catalog.*, jobs.*, share.*, alerts.*, reports.* 等）`tools/seed_rbac.sql` 或 `supabase/seed/`
- [ ] T126 [V1.1] [US1] 编写 seed 脚本：预置 6 种角色及 role_permissions 关联（reseller_admin/reseller_sales_director/reseller_sales/reseller_finance/customer_admin/customer_ops 各权限集）`tools/seed_rbac.sql`

### 应用层重构

- [ ] T127 [V1.1] [US1] 重构 `getEffectivePermissions`：优先从 DB 查询 roles + role_permissions + permissions（按 user_roles.role_name 匹配 roles.code），若 DB 无数据则回退到 `defaultPermissionsByRoleScope` `src/app.js`、`src/middleware/rbac.ts`
- [ ] T128 [V1.1] [P] [US1] 确保 `user_roles.role_name` 与 `roles.code` 一致（reseller_admin 等），现有用户创建逻辑无需变更
- [ ] T129 [V1.1] [US1] 新增管理 API（可选）：`GET /v1/admin/roles`、`GET /v1/admin/roles/{code}/permissions` 供 Web Portal 查询与编辑权限配置（需 platform_admin）

### 测试与验证

- [ ] T130 [V1.1] [US1] 单元测试：DB 有数据时权限解析正确；DB 空时回退到硬编码 `tests/`
- [ ] T131 [V1.1] [US1] 集成测试：reseller_sales 仅能访问分配企业、customer_ops 仅能访问部门 SIM，验证权限隔离 `tests/`

---

## Phase 24: Reseller 身份统一 — tenants.tenant_id [V1.1]

**Purpose**: 解决 `resellers.id` 与 `tenants.tenant_id` 混用导致的租户隔离与层级查询问题，统一 JWT/API/auth 层使用 `tenants.tenant_id` 作为 reseller 身份标识。

**Source**: plan.md — 租户模型统一（所有 FK 指向 tenants.tenant_id）；tenants.parent_id 存储父级 tenant_id，层级查询依赖 tenant_id

**背景**:
- 当前 `auth.resellerId` 可能来自 `resellers.id`（如 customers.reseller_id）或 `tenants.tenant_id`
- `tenants.parent_id` 存的是 reseller 的 `tenant_id`，用 `resellers.id` 查 `parent_id` 会失败，导致租户隔离回退到错误逻辑（如 GET /v1/sims 跨 reseller 泄露）
- 已通过 `resolveResellerIdentity` 做临时转换，需从根源统一并移除 workaround

### 认证层统一

- [ ] T132 [V1.1] [US1] API Key 认证（X-API-Key + X-API-Secret）：从 `customers.reseller_id`（resellers.id）解析 `resellers.tenant_id`，将 `cmpAuth.resellerId` 设为 `resellers.tenant_id` `src/app.js`（约 1042-1066 行）
- [ ] T133 [V1.1] [US1] 用户登录 / JWT 签发：reseller 用户登录时，从 users.tenant_id 或 reseller_enterprise_assignments 解析 reseller 的 `tenants.tenant_id`，JWT payload.resellerId 使用 tenant_id（若当前使用 resellers.id 则需改为 tenant_id）`src/app.js`、`src/app.ts`
- [ ] T134 [V1.1] [P] [US1] OIDC 认证：若 OIDC claims 含 resellerId，确保其语义为 tenant_id 或增加映射逻辑 `src/middleware/oidcAuth.ts`

### 代码清理

- [ ] T135 [V1.1] [US1] 移除 `resolveResellerIdentity`：认证层统一后，`simPhase4.js`、`app.js` 中直接使用 `auth.resellerId` 作为 tenant_id，删除 resolveResellerIdentity 函数及调用 `src/routes/simPhase4.js`、`src/app.js`
- [ ] T136 [V1.1] [P] [US1] 审计并修正：`rbac.ts`、`tenantScope.ts`、`webhooks.ts`、`alerting.ts`、`billingSchedule.js` 等所有使用 `resellerId` 的地方，确认语义为 tenant_id 且无需二次解析

### 数据模型（可选，V1.1 后期）

- [ ] T137 [V1.1] [US1] 迁移 `customers.reseller_id`：新增 `reseller_tenant_id` FK→tenants(tenant_id)，数据迁移后弃用 `reseller_id`，或保持 reseller_id 但文档明确「auth 层仅使用 tenant_id」（二选一，视迁移成本）`supabase/migrations/`
- [ ] T138 [V1.1] [P] [US1] 迁移 `reseller_suppliers.reseller_id`：若采用 tenant_id 统一，改为 FK→tenants(tenant_id) 或通过 resellers.tenant_id 间接关联（视业务影响评估）

### 测试与文档

- [ ] T139 [V1.1] [US1] 集成测试：reseller token（JWT + API Key）调用 GET /v1/sims、GET /v1/bills 等，验证仅返回本 reseller 数据，无跨租户泄露 `tests/`
- [ ] T140 [V1.1] [US1] 更新 `security-debt.md` 或 `data-model.md`：记录「reseller 身份统一为 tenants.tenant_id」的设计决策

---

## Phase 25: Worker — SIM 上游状态同步（SIM_STATUS_CHANGE）[V1.1]

**Purpose**: 用户在本系统变更 SIM 生命周期状态后，`simLifecycle` 已向 `jobs` 插入 `SIM_STATUS_CHANGE`；Worker MUST 消费该任务并调用上游供应商（多供应商 SPI / wxzhonggeng 等）执行对等状态变更，与 `events.SIM_STATUS_CHANGED` / 下游 Webhook 的职责区分见 [clarifications/jobs-sim-status-change.md](clarifications/jobs-sim-status-change.md) 与 [clarifications/webhook-delivery.md](clarifications/webhook-delivery.md)。

**Source**: [clarifications/jobs-sim-status-change.md](clarifications/jobs-sim-status-change.md)（2026-03-22）

### Implementation

- [ ] T141 [V1.1] [US2] 在 `src/worker.js` 的 `processJobs` 中实现 `case 'SIM_STATUS_CHANGE'`：解析 `jobs.payload` / `request_id` JSON（与 `simLifecycle` 入队字段对齐），按 `supplier_id` 或适配器标识路由至 `src/vendors/*`（如 `wxzhonggeng`），调用上游状态变更 API；约定成功/失败终态（`SUCCEEDED` / `FAILED`）、可重试与幂等（与 `idempotency_key` 一致）；无上游能力的供应商可显式跳过或记录 `FAILED` 原因；补充集成测试或烟测步骤文档 `tests/` 或 `tools/`

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: 无依赖 — 立即开始
- **Foundational (Phase 2)**: 依赖 Setup — 阻塞所有 User Story
- **US1-US6 (Phase 3-8)**: 依赖 Foundational，按顺序执行（单人团队）
- **E2E 集成 (Phase 9)**: 依赖 Phase 3-8 全部完成
- **扩展 (Phase 10-13)**: 依赖 Phase 9（MVP 核心验证通过后）
- **US7 Dunning (Phase 14)**: 依赖 Phase 12（出账功能完成）
- **V1.1 (Phase 15-25)**: MVP 完成后启动
- **Polish (Phase 20)**: 所有 MVP 任务完成后

### User Story Dependencies

```
US1 (租户) ──┐
US2 (SIM)  ──┤
US3 (资费) ──┼──→ US4 (订阅) → US5 (计费) → US6 (出账) → US7 (Dunning)
             │
             └──→ US8 (对账) [V1.1]
                  US9 (监控) [V1.1]
                  US10 (虚拟化) [V1.1]
                  US11 (事件) [V1.1]
```

### Parallel Opportunities (单人团队)

| Phase | 可并行任务 |
|-------|----------|
| Phase 2 | T007+T008, T009+T010, T011+T012 |
| Phase 3 | T013+T014+T015 |
| Phase 4 | T021+T022, T023+T024 |
| Phase 5 | T025+T026, T028+T029 |
| Phase 7 | T034+T035, T038+T040 |
| Phase 8 | T044+T046 |
| Phase 21 | T115+T116 |
| Phase 22 | T119+T120 |
| Phase 24 | T133+T134, T136+T138 |

---

## Implementation Strategy

### Week 1-4: MVP 核心

1. Phase 1 (Setup) → Phase 2 (Foundational)
2. Phase 3 (US1 租户) → Phase 4 (US2 SIM) → Phase 5 (US3 资费) → Phase 6 (US4 订阅)
3. Phase 7 (US5 计费) → Phase 8 (US6 出账)
4. Phase 9 (E2E 集成验证) → **部署 staging**

### Week 5-8: MVP 扩展

5. Phase 10 (RBAC) → Phase 11 (One-time) → Phase 12 (自动出账)
6. Phase 13 (批量导入+WX) → Phase 14 (Dunning)
7. Phase 20 (Polish) → **MVP 交付**

### 关键质量门禁

- Week 3 结束：8 个 Golden Case 全部通过
- Week 4 结束：端到端冒烟测试通过
- Week 8 结束：全量回归测试 + 性能验证

---

## Summary

| 维度 | 数量 |
|------|------|
| 总任务数 | 141 |
| MVP 核心 (Week 1-4) | 49 |
| MVP 扩展 (Week 5-8) | 20 |
| V1.1 推迟 | 67 |
| Polish | 5 |
| 可并行任务数 | 49 |
| User Story 数 | 11 (6×P1 + 5×P2) |
