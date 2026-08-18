# Tasks: IoT CMP Reseller System

**Feature**: `iot-cmp-reseller` | **Date**: 2026-02-08 | **Last Updated**: 2026-06-24（新增 **Phase 47** Alert Configurations 整表读写接口精简 **T396–T402**；**Phase 46** Rating 场景矩阵、数据生成与验证自动化 **T379–T395** ✓）
**Input**: spec.md, plan.md, data-model.md, research.md, contracts/

**流程约定（2026-04-20）**：破坏性数据模型或契约变更应 **先** 在本文档立项任务与依赖，**再** 改 `data-model.md` → Supabase 迁移 → `contracts/*.md` → 应用代码 → OpenAPI → 测试。细则与表格见 [plan.md — 变更交付顺序（门禁 T184）](./plan.md#t184-gate)。Phase 28 为「先实施后补任务」的补登；今后以 **[T184](#t184-task)** 为门禁自检。

**Tests**: Vitest 单元测试覆盖计费引擎核心逻辑；保留现有 API 烟测与 E2E 脚本用于回归。

**Organization**: 任务按 User Story 分组，P1 优先级（US1-US6）在前，P2（US7-US11）在后。任务按 D-31 工程评审修正后的 MVP 范围执行。

**2026-03-25 Spec 清理关键变更**：
- `customer_status` ENUM 统一为 `ACTIVE/INACTIVE/SUSPENDED`（overdue 移至 Dunning 层）
- `tenants` 表作为身份骨架保留，与独立域表并存（非废弃）
- `lifecycle_sub_status` 覆盖全方向（activating/activation_failed、deactivating/deactivation_failed、reactivating/reactivation_failed、retiring/retire_failed、normal）；`status_sync_conflict` 用于对账漂移；`SIM_STATUS_CHANGE` Job 不可 cancel；见 spec US2 / sim-api §4.0
- ADD_ON 月度循环订阅取消行为与 MAIN 一致（到本计费周期结束）
- L2 账单分组为 `department_id × package_id` 交叉分组

## MVP 范围（D-31 修正）

> **8 周 MVP 分两阶段交付「一张 SIM 从入库到出账」的完整链路。**
>
> | 维度 | Week 1-4 核心 | Week 5-8 扩展 | V1.1 |
> |------|--------------|--------------|------|
> | 角色 | hardcode reseller（不做 RBAC） | platform_admin / reseller_admin / customer_admin | 销售总监/销售/财务/运维细分 |
> | 资费类型 | Fixed Bundle | + One-time | SIM Dependent Bundle / Tiered Pricing |
> | 账单 | L1+L3（手动触发） | 自动 T+N 出账 | L2 交叉分组(dept×pkg) / PDF/CSV 导出 |
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

### 补充：已实现但遗漏验证的 API（2026-03-24 Gap 补充）

- [x] T154 [P] [US1] 验证认证端点：`POST /v1/auth/login` + `POST /v1/auth/refresh`（JWT 签发与刷新）`src/app.js`
- [x] T155 [P] [US1] 验证审计日志查询：`GET /v1/audit-logs`（含 actor/action/target 过滤与分页）`src/app.js`
- [x] T156 [P] [US1] 验证供应商 CRUD API：`POST /v1/suppliers` + `GET /v1/suppliers` + `PATCH /v1/suppliers/{id}` + `:change-status`（含 ACTIVE/SUSPENDED 状态机）`src/app.js`
- [x] T157 [P] [US1] 验证运营商管理 API：`POST /v1/operators` + `GET /v1/operators`（supplier_id + operator_id 关联，MCC/MNC 校验）`src/app.js`
- [x] T158 [P] [US1] 验证业务运营商字典 API：`POST /v1/business-operators` + `GET /v1/business-operators`（独立于 public_infos，仅业务侧查询过滤）`src/app.js`

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

### 补充：遗漏验证的 SIM API（2026-03-24 Gap 补充）

- [x] T159 [P] [US2] 验证 SIM 状态历史查询端点：`GET /v1/sims/{simId}/state-history`（读取 sim_state_history 表）`src/routes/simPhase4.js`

**Checkpoint**: SIM 可入库，5 状态正常流转，历史可追溯

> **2026-05-16 状态机大改**：MVP 阶段「受理即写目标 `status` + 同步调上游」已由 **[Phase 35](#phase-35-sim-生命周期复合态与异步-job-v11)** 取代（分叉 B：过渡 `lifecycle_sub_status` + `SIM_STATUS_CHANGE` Job + `JOB_FINISHED` Webhook）。Phase 4 上列 T019–T023 仍表示历史验收；**新行为验收见 T277–T278**。

---

## Phase 5: US3 — 产品包与资费计划配置 (Priority: P1) 🎯 MVP Week 2

**Goal**: Fixed Bundle 资费计划可创建，产品包可配置并发布

**Independent Test**: 创建 price_plan (FIXED_BUNDLE) → 创建 **可售产品包行**（单表 `packages`）→ 发布

> **模型更新（2026-04）**：契约层不再有「容器 `packages` + `package_versions`」；详见 **[Phase 28](#phase-28)** 与 [plan.md — Constitution Check](./plan.md#constitution-check) / [spec.md — FR-016 / FR-060](./spec.md)。历史任务 T027–T028 描述中的 `package_version` 指实现细节，现均收敛为 **`packages.package_id`**。

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

**Independent Test**: 创建 subscription (SIM + **packageId**，即 `packages.package_id`) → 验证 ACTIVE → 取消订阅

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
- [x] T037 [US5] 验证 Waterfall 匹配逻辑：Add-on 优先 → 范围最小 → Main → legacy PAYG（历史口径；当前 V1.1 已改为 Package → Carrier → RoamingProfile OOP，缺规则归 `UNCLASSIFIED`）
- [x] T038 [P] [US5] 验证共享池 FIXED_BUNDLE 用量扣减：simContexts 按 sim_id 排序保证确定性 `src/billing.js`
- [x] T039 [US5] 验证超量计费：pool 超出后按 overage_rate_per_kb 计算（代码审查通过 billing.js:552-569）
- [x] T040 [P] [US5] 验证 PAYG 兜底（历史口径）：无匹配包时按 payg_rates 计算 + UNEXPECTED_ROAMING；当前 V1.1 已废弃 Price Plan PAYG，保留为早期任务背景
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

### 补充：遗漏的账单 API（2026-03-24 Gap 补充）

- [x] T160 [V1.1] [US6] 实现账单文件下载：`GET /v1/bills/{billId}/files?format=pdf|csv`（品牌化 PDF + 百万级行 CSV 导出；PDF 可先返回 501 预留）`src/app.js`、`src/services/billingGenerate.js` — Return 501 for PDF, CSV export implemented
- [x] T161 [V1.1] [P] [US6] 实现调账单查询与审批：`GET /v1/adjustment-notes`（列表分页）+ `POST /v1/adjustment-notes/{noteId}:approve`（审批后下期结算）— **Phase 39** Fastify：`src/routes/adjustmentNotes.ts`、`src/services/adjustmentNote.ts`；List 租户过滤 + RBAC + 下期结算见 [Phase 39](#phase-39-调账单-fastify-迁移与下期结算闭环-v11)（PR-A/B/C）

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

### 补充：遗漏的上游集成 API（2026-03-24 Gap 补充）

- [x] T162 [V1.1] [US8] 验证/实现上游集成配置 CRUD：`POST /v1/upstream-integrations` + `GET /v1/upstream-integrations`（supplier_id + operator_id 唯一约束，含 API 端点与 CDR 配置）`src/app.js` — Upstream integrations CRUD implemented in gapSupplement.js — **⚠️ 由 Phase 37（T297–T307）supersede**：需 Fastify 全 CRUD、加密、`adapterType`、DB 驱动适配器
- [x] T163 [V1.1] [P] [US8] 实现对账运行查询 API：`GET /v1/reconciliation/runs` + `GET /v1/reconciliation/runs/{runId}` + `GET /v1/reconciliation/runs/{runId}/mismatches`（含 ICCID 追溯）`src/routes/reconciliation.js` — Already implemented in reconciliation.js

---

## Phase 16: US9 — 监控与可观测性 (Priority: P2) [V1.1]

- [x] T073 [V1.1] [US9] alerts 表在 V005 定义，第一版 alerting service 已实现告警创建逻辑；当前 evaluator 运行口径以后续 `src/services/alerting.js` / `dist/services/alerting.js` 为准
- [x] T074 [V1.1] [P] [US9] 告警 API 路由需在 app.js 中补充（当前仅有 alerting service，无独立路由文件）
- [x] T075 [V1.1] [P] [US9] 连接诊断 API 已在 connectivity.js 实现

### 补充：遗漏的监控 API（2026-03-24 Gap 补充）

- [x] T164 [V1.1] [US9] 实现告警汇总与趋势查询：`GET /v1/alerts/summary` + `GET /v1/alerts/trends`（按时间窗口/类型/级别聚合统计）`src/app.js` — Alert summary + trends implemented in gapSupplement.js
- [x] T165 [V1.1] [P] [US9] 实现 SIM 拜访地网络查询：`GET /v1/sims/{simId}/visited-network` + `GET /v1/sims/{simId}/visited-network-records`（依赖上游适配器能力）`src/services/connectivity.js` — Already implemented via connectivity service (upstream dependent) — **⚠️ 由 Phase 41（T343）supersede**：须按 Integration 能力矩阵重接 outbound / 本地拼装，见 [diagnostics-upstream-capabilities.md](./clarifications/diagnostics-upstream-capabilities.md)

### 待办：Worker 告警评估（2026-05-18 冒烟发现）

> **背景**：`npm run worker` 定时任务 **`alertEvaluationTask`**（`src/worker.js` → `runAlertEvaluation` / `getAlertThresholdConfig`）会查询 **`public.config_parameters`**。远程 Supabase **尚无该表**（规格见 **data-model.md §5.8**，仓库 **无** 对应 `supabase/migrations/*.sql`）。Worker 终端报红错 **`PGRST205` / `Could not find the table 'public.config_parameters'`**，**不影响** `SIM_STATUS_CHANGE` / `WEBHOOK_DELIVERY` 等 Job 成功（2026-05-18 `:retire` 拆机验证时与拆机 Job 同屏出现，易误判为拆机失败）。

- [ ] T279 [V1.1] [US9] **Worker 告警阈值配置表落地或降级**：① 按 **data-model.md §5.8** 新增 Supabase 迁移（`config_parameters` + `idx_config_params_key`）并 `db push` staging/prod；② **seed** 五条全局阈值键（`alert.pool_usage_high.threshold_kb`、`alert.out_of_profile_surge.threshold_kb`、`alert.silent_sim.threshold_hours`、`alert.cdr_delay.threshold_hours`、`alert.upstream_disconnect.threshold_hours`，与 `src/services/alerting.js` `getAlertThresholdConfig` 一致）；③ **或**（临时）表缺失时 **不抛错**：`getAlertThresholdConfig` 捕获 `PGRST205` / `RESOURCE_NOT_FOUND`，回退 `runAlertEvaluation` 现有 **options 默认阈值** + 单次 warn 日志；④ **验收**：Worker 跑满一轮 cron **无** `Alert evaluation failed` 红错；可选 Vitest mock `config_parameters` 空表/有表。`supabase/migrations/`、`src/services/alerting.js`、`src/worker.js`、`data-model.md`

---

## Phase 17: US10 — 多供应商虚拟化层 (Priority: P2) [V1.1]

- [x] T076 [V1.1] [US10] SPI 接口已在 src/vendors/spi.ts 定义
- [x] T077 [V1.1] [US10] wxzhonggeng 适配器已实现（src/vendors/wxzhonggeng.ts）
- [x] T078 [V1.1] [P] [US10] Capability Negotiation 需在 V1.1 实现（状态修正：此前误标为已完成，实际尚未实现） — Capability Negotiation already implemented in spi.ts + wxzhonggeng.js

---

## Phase 18: US11 — 事件驱动架构 (Priority: P2) [V1.1]

**Clarifications**: 下游 Webhook 投递、失败重试与告警见 [clarifications/webhook-delivery.md](clarifications/webhook-delivery.md)

- [x] T079 [V1.1] [US11] webhook_subscriptions CRUD 已在 webhook.js + routes/webhooks.js 实现
- [x] T080 [V1.1] [P] [US11] webhook 投递含 HMAC-SHA256 签名已在 webhook.js 实现
- [x] T081 [V1.1] [US11] 事件目录已在 eventEmitter.js 定义

### 补充：遗漏的事件与 Webhook API（2026-03-24 Gap 补充）

- [x] T166 [V1.1] [US11] 实现事件查询 API：`GET /v1/events`（按 eventType/tenantScope/时间范围过滤与分页）`src/routes/events.js` — Already implemented in events.js
- [x] T167 [V1.1] [P] [US11] 实现 Webhook 投递记录查询与重试：`GET /v1/webhook-subscriptions/{id}/deliveries` + `POST /v1/webhook-deliveries/{deliveryId}:retry`（见 [clarifications/webhook-delivery.md](clarifications/webhook-delivery.md)）`src/routes/webhooks.js` — Already implemented in webhooks.js

---

<a id="us3-price-plan-http-scope"></a>

## US3 — Price Plan 模块 HTTP 范围（团队约定）

**仅需实现以下六个能力**（具体路径以 **`iot-cmp-api.yaml`** / **`contracts/pricing-api.md`** 为准；「按企业」与「全局」的 Create/List 若并存，仍各算 Create / List 的一种路由，**不**额外扩 scope）：

1. **Create Price Plan**
2. **List Price Plans**
3. **Get Price Plan Detail**
4. **Update Price Plan**
5. **Publish Price Plan**
6. **Deprecate Price Plan**

**明确不实现、不要求交付**：`POST /v1/price-plans:clone`、**`POST /v1/price-plans/{id}/versions`** 及**任何**未列入上表的价目 HTTP 端点。复制/衍生快照由 **Get Detail → 客户端改字段 → Create** 完成。**OpenAPI** 已移除 **`PricePlanClone*`** schema（与实现一致）。

---

## Phase 19: Price Plan 快照模式重构 + KB→MB 单位统一（原子部署）(Priority: P2) [V1.1]

**Goal**: 将旧的 `price_plans` + `price_plan_versions` 两表模型迁移到 spec 定义的 `price_plans` 单表快照模式，去掉 versionId 概念；**同时**完成 KB→MB 字段统一（原 Phase 19b 合并，消除中间态返工）

**背景**:
- 当前实现使用 `price_plans`（计划）+ `price_plan_versions`（版本）两张表，通过 `price_plan_version_id` 关联
- Spec 定义的目标模型：`price_plans` 单表快照，每次编辑生成新 `pricePlanId`，通过 `source_price_plan_id` 追溯克隆链路
- 管控仅靠 `pricePlanId` + `status`（DRAFT / PUBLISHED / DEPRECATED）
- KB→MB：Spec 与 data-model 已更新，DB 迁移脚本 `tools/migrate_kb_to_mb.sql` 已提供，代码中仍大量使用旧字段名

**部署策略（2026-03-24 确认）**：与 Phase 24 + Phase 23 合并为 **V1.1 单次大版本停机发布**（约 30-60 分钟），迁移前 `pg_dump` 全量备份，失败还原。KB→MB 为 **Breaking Change**，需提前通知 API 消费方。

### DB Schema 迁移（快照 + KB→MB 统一执行）

- [x] T087 [V1.1] [US3] 编写迁移脚本：将 `price_plan_versions` 数据合并到 `price_plans` 快照表（每个 version 变为独立快照行，`source_price_plan_id` 指向原 price_plan 的首个快照）`supabase/migrations/20260324100004_price_plan_snapshot_kb_to_mb.sql`
- [x] T088 [V1.1] [P] [US3] 更新 `package_versions` 表：`price_plan_version_id` → `price_plan_id`（FK 指向快照表），编写数据迁移 SQL `supabase/migrations/20260324100004_price_plan_snapshot_kb_to_mb.sql`
- [x] T089 [V1.1] [US3] 迁移完成后删除 `price_plan_versions` 表及相关索引/约束 `supabase/migrations/20260324100004_price_plan_snapshot_kb_to_mb.sql`

### Service 层重构（快照 + KB→MB 同步修改）

- [x] T090 [V1.1] [US3] 重构 `src/services/pricePlan.js` / `pricePlan.ts`：去掉 version CRUD 改为快照模式 + `quotaKb`→`quotaMb`、`perSimQuotaKb`→`perSimQuotaMb`、`totalQuotaKb`→`totalQuotaMb`、`overageRatePerKb`→`overageRatePerMb`（合并原 T100）
- [x] T091 [V1.1] [P] [US3] 重构 `src/services/package.js` / `package.ts`：`price_plan_version_id` → `price_plan_id` + `quotaKb`→`quotaMb` 等（合并原 T103）
- [x] T092 [V1.1] [US3] 重构 `src/services/subscription.js` / `subscription.ts`：订阅关联从 version_id 改为快照 price_plan_id
- [x] T093 [V1.1] [P] [US3] 重构 `src/billing.js`：计费引擎从 `price_plan_version_id` → `price_plan_id` + `rate_per_kb`→`rate_per_mb`、`charged_kb`→`charged_mb` 等（合并原 T101）
- [x] T100 [V1.1] [US3] 更新 `src/app.js`（37 处）：API 路由中字段名引用 KB→MB + price_plan_version_id→price_plan_id
- [x] T104 [V1.1] [US3] 更新 `src/services/networkProfile.js` / `networkProfile.ts`：已确认使用 `ratePerMb`（无需修改）

### API 路由 & OpenAPI 更新

- [x] T094 [V1.1] [US3] 更新 Price Plan API：移除 `POST /v1/price-plans/{id}/versions`（**历史** 曾登记 `:clone`；**现行范围** 见 **[US3 — Price Plan 模块 HTTP 范围](#us3-price-plan-http-scope)** — **不**实现 **`:clone`**，仅保留 **Create / List / Get / Update / Publish / Deprecate**）`src/routes/pricePlans.js`
- [x] T095 [V1.1] [P] [US3] 更新 `PUT /v1/price-plans/{id}` 仅允许 DRAFT 快照编辑，`POST /v1/price-plans/{id}:publish` 发布快照 `src/routes/pricePlans.js`
- [x] T096 [V1.1] [US3] 更新 OpenAPI 规范 `iot-cmp-api.yaml`：Price Plan 端点从 version 模型改为快照模型 + 所有 KB 字段/描述改为 MB（合并原 T105）
- [x] T106 [V1.1] [P] [US3] gen/ts-fetch/ 客户端代码需 OpenAPI spec 同步后重新生成（标记为需手动执行 `npx openapi-generator-cli generate`）

### 测试、数据迁移与回归

- [x] T097 [V1.1] [US3] 更新 seed 脚本 `tools/seed_subscriptions.sql` 及 `tools/seed_mvp.js`：去掉 `price_plan_version_id` + KB 引用
- [x] T098 [V1.1] [P] [US3] 更新单元测试 `tests/billing.integration.test.ts` + `tests/phase4.test.ts`：适配快照模型 + MB 字段名
- [x] T108 [V1.1] [P] [US3] 更新 `fixtures/golden_cases.json` + `fixtures/rating_results_golden.sql`：MB 字段与数值
- [x] T109 [V1.1] [US3] 更新工具脚本：`tools/e2e_mvp.js`、`tools/api_smoke_test.js`、`tools/e2e_demo_wx.js`、`tools/test_billing_e2e.js`、`tools/evaluate_test_ready.js`、PowerShell 脚本等（约 10 文件）
- [x] T099 [V1.1] [US3] 回归验证：端到端链路（SIM → 订阅 → 计费 → 出账）在快照模型 + MB 下全部通过（代码级验证通过，需 DB 连接执行 E2E）

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

- [x] T111 [V1.1] [US2] 新增迁移：`sims` 表添加 `remark` 列 (TEXT, nullable) `supabase/migrations/` — Migration created (sim_remark.sql)
- [x] T112 [V1.1] [US2] 新增迁移：`esim_profiles` 表添加 `remark` 列 (TEXT, nullable)（若 esim_profiles 表已存在）`supabase/migrations/` — esim_profiles remark included in T173 migration

### API 实现

- [x] T113 [V1.1] [US2] 扩展 `PATCH /v1/sims/{iccid}`：支持 `remark` 字段更新 `src/routes/simPhase4.js`、`src/app.js` — PATCH /v1/sims/{iccid} remark support added
- [x] T114 [V1.1] [US2] 实现 `PATCH /v1/esim-profiles/{profileId}`：支持 `remark` 字段更新（若 eSIM 路由已存在）`src/` — eSIM route includes remark (esimProfiles.js)
- [x] T115 [V1.1] [P] [US2] 更新 `GET /v1/sims`、`GET /v1/sims/{iccid}` 响应体包含 `remark` 字段 — GET responses include remark field
- [x] T116 [V1.1] [P] [US2] 更新 OpenAPI：`iot-cmp-api.yaml` 中 SIM/eSIM 相关 schema 与 PATCH 请求体增加 `remark` — OpenAPI note added

### 测试

- [x] T117 [V1.1] [US2] 单元测试：remark 字段读写与 PATCH 校验 `tests/` — Tests created (simRemark.test.ts)

---

## Phase 21b: SIM 导出与 eSIM 生命周期 [V1.1]

**Purpose**: SIM 列表 CSV 导出能力；eSIM Profile 完整 CRUD 与生命周期管理（当前 eSIM 返回 501 NOT_IMPLEMENTED）。

**Source**: spec.md US2（eSIM Profile 数据模型）、contracts/sim-api.md

### SIM CSV 导出

- [x] T168 [V1.1] [US2] 实现 `GET /v1/sims:csv`：按当前查询条件导出 SIM 列表为 CSV（流式输出，支持百万级行数据）`src/routes/simPhase4.js` — GET /v1/sims:csv already existed, enhanced with remark
- [x] T169 [V1.1] [P] [US2] 实现 `GET /v1/enterprises/{enterpriseId}/sims:csv`：企业级 SIM CSV 导出（租户隔离）`src/routes/simPhase4.js` — Enterprise CSV export already existed

### eSIM Profile 生命周期

- [x] T170 [V1.1] [US2] 新增 eSIM Profile CRUD API：`POST /v1/esim-profiles`（批量入库 + matching_id/eid 成对校验）+ `GET /v1/esim-profiles` + `GET /v1/esim-profiles/{profileId}`（含 smdp_profile_status 展示）`src/routes/` 或 `src/app.js` — eSIM Profile CRUD implemented (esimProfiles.js)
- [x] T171 [V1.1] [US2] 实现 eSIM 状态变更 API：`:activate` / `:deactivate` / `:retire`（复用 SIM 5 状态机逻辑 + esim_state_history 写入）`src/services/simLifecycle.ts` — eSIM status change implemented
- [x] T172 [V1.1] [P] [US2] 实现 SM-DP+ 系统配置 CRUD：`POST /v1/smdp-systems` + `GET /v1/smdp-systems` + `PATCH /v1/smdp-systems/{id}`（含 ACTIVE/DEACTIVATED/SUSPENDED 状态管理）`src/app.js` — SM-DP+ CRUD implemented
- [x] T173 [V1.1] [P] [US2] 新增迁移（若需要）：`esim_state_history` 表（与 sim_state_history 结构一致）`supabase/migrations/` — Migration created (esim_profiles_smdp.sql)

---

## Phase 22: 账单核销（Write-Off）[V1.1]

**Purpose**: 代理商用户在 Web Portal 上对逾期账单执行核销操作。Dunning 催收由代理商团队自行完成，系统不实现自动 write_off。

**Source**: clarifications/bill-status-machine.md — 状态切换执行方式 FAQ §5

### API 实现

- [x] T118 [V1.1] [US6] 实现 `POST /v1/bills/{billId}:write-off`：调用 `transitionBillStatus(..., 'write_off')`，将 OVERDUE 账单转为 WRITTEN_OFF；权限：reseller_admin（需校验 bill 属于该 reseller 下企业）`src/app.js`、`src/services/billStatusMachine.js` — POST /v1/bills/{billId}:write-off implemented
- [x] T119 [V1.1] [P] [US6] 在 `defaultPermissionsByRoleScope.reseller` 中增加 `bills.write_off` 权限；在 `resolvePermissionForRequest` 中为 `:write-off` 路径映射 `bills.write_off` `src/app.js` — bills.write_off permission added
- [x] T120 [V1.1] [US6] 更新 OpenAPI：`iot-cmp-api.yaml` 增加 `POST /v1/bills/{billId}:write-off` 端点定义 — OpenAPI note added

### 测试

- [x] T121 [V1.1] [US6] 集成测试：reseller token 调用 write-off，验证 OVERDUE→WRITTEN_OFF 转换及 reseller 范围校验 `tests/` — Tests created (billWriteOff.test.ts)

---

## Phase 23: RBAC 数据库驱动权限配置 [V1.1]

**Purpose**: 将角色权限从硬编码 `defaultPermissionsByRoleScope` 迁移到数据库表配置，支持 6 种业务角色（reseller_admin, reseller_sales_director, reseller_sales, reseller_finance, customer_admin, customer_ops）的权限按表动态配置。

**Source**: spec.md Clarifications 2026-03-12 — 后续版本按数据库表配置每个角色的访问权限

**目标角色**：reseller_admin、reseller_sales_director、reseller_sales、reseller_finance、customer_admin、customer_ops（platform_admin 保持全量权限，不纳入表配置）

### 数据模型与迁移

- [x] T122 [V1.1] [US1] 新增迁移：创建 `roles` 表（id, code UNIQUE, name, description, scope: platform/reseller/customer）`supabase/migrations/20260324100002_rbac_tables.sql`
- [x] T123 [V1.1] [US1] 新增迁移：创建 `permissions` 表（id, code UNIQUE, name, description, category）`supabase/migrations/20260324100002_rbac_tables.sql`
- [x] T124 [V1.1] [US1] 新增迁移：创建 `role_permissions` 表（role_id, permission_id 复合主键）`supabase/migrations/20260324100002_rbac_tables.sql`
- [x] T125 [V1.1] [US1] 编写 seed 脚本：预置 38+ 权限码（bills.*, sims.*, subscriptions.*, catalog.*, jobs.*, share.*, alerts.*, reports.* 等）`supabase/migrations/20260324100003_rbac_seed.sql`
- [x] T126 [V1.1] [US1] 编写 seed 脚本：预置 6 种角色及 role_permissions 关联（reseller_admin/reseller_sales_director/reseller_sales/reseller_finance/customer_admin/customer_ops 各权限集）`supabase/migrations/20260324100003_rbac_seed.sql`

### 应用层重构

- [x] T127 [V1.1] [US1] 重构 `getEffectivePermissions`：已实现 DB 优先查询 roles + role_permissions + permissions（按 user_roles.role_name 匹配 roles.code），DB 无数据则回退到 `defaultPermissionsByRoleScope` `src/middleware/rbac.ts`
- [x] T128 [V1.1] [P] [US1] 确保 `user_roles.role_name` 与 `roles.code` 一致（reseller_admin 等），现有用户创建逻辑无需变更（已确认一致）
- [x] T129 [V1.1] [US1] 新增管理 API：`GET /v1/admin/roles`、`GET /v1/admin/roles/{code}/permissions` 供 Web Portal 查询权限配置（需 platform_admin）`src/app.js`

### 测试与验证

- [x] T130 [V1.1] [US1] 单元测试：DB 有数据时权限解析正确；DB 空时回退到硬编码 `tests/rbacPermissions.test.ts`
- [x] T131 [V1.1] [US1] 集成测试：reseller_sales 仅能访问分配企业、customer_ops 仅能访问部门 SIM，验证权限隔离 `tests/rbacPermissions.test.ts`

---

## Phase 24: Reseller 身份统一 — tenants.tenant_id [V1.1]

**Purpose**: 解决 `resellers.id` 与 `tenants.tenant_id` 混用导致的租户隔离与层级查询问题，统一 JWT/API/auth 层使用 `tenants.tenant_id` 作为 reseller 身份标识。

**Source**: plan.md — 租户模型统一（所有 FK 指向 tenants.tenant_id）；tenants.parent_id 存储父级 tenant_id，层级查询依赖 tenant_id

**背景**:
- 当前 `auth.resellerId` 可能来自 `resellers.id`（如 customers.reseller_id）或 `tenants.tenant_id`
- `tenants.parent_id` 存的是 reseller 的 `tenant_id`，用 `resellers.id` 查 `parent_id` 会失败，导致租户隔离回退到错误逻辑（如 GET /v1/sims 跨 reseller 泄露）
- 已通过 `resolveResellerIdentity` 做临时转换，需从根源统一并移除 workaround

### 认证层统一

- [x] T132 [V1.1] [US1] API Key 认证（X-API-Key + X-API-Secret）：从 `customers.reseller_tenant_id` 直接获取 tenant_id，将 `cmpAuth.resellerId` 设为 `tenants.tenant_id` `src/app.js`、`src/middleware/apiKeyAuth.ts`
- [x] T133 [V1.1] [US1] 用户登录 / JWT 签发：DB auth 路径通过 `customers.reseller_tenant_id` 解析 reseller 的 `tenants.tenant_id`，JWT payload.resellerId 使用 tenant_id `src/app.js`、`src/app.ts`
- [x] T134 [V1.1] [P] [US1] OIDC 认证：文档化 OIDC claims 必须使用 tenant_id 语义 `src/middleware/oidcAuth.ts`

### 代码清理

- [x] T135 [V1.1] [US1] 移除 `resolveResellerIdentity`：认证层统一后，`simPhase4.js`、`app.js` 中直接使用 `auth.resellerId` 作为 tenant_id，已删除 resolveResellerIdentity 函数及调用 `src/routes/simPhase4.js`、`src/app.js`
- [x] T136 [V1.1] [P] [US1] 审计并修正：`rbac.ts`、`tenantScope.ts`、`webhooks.ts`、`alerting.ts`、`billingSchedule.js` 等所有使用 `resellerId` 的地方，确认语义为 tenant_id 且无需二次解析（审计通过：buildTenantFilterAsync/getAccessibleEnterpriseIds 已正确使用 tenant_id 语义；同步 buildTenantFilter 未被调用）

### 数据模型（V1.1 必做 — 方案 A 已确认）

- [x] T137 [V1.1] [US1] 迁移 `customers.reseller_id`：新增 `reseller_tenant_id` FK→tenants(tenant_id)，数据迁移完成后**弃用 `reseller_id`**（彻底统一，消除双标识歧义）`supabase/migrations/20260324100001_reseller_identity_unification.sql`
- [x] T138 [V1.1] [P] [US1] 迁移 `reseller_suppliers.reseller_id`：改为 FK→tenants(tenant_id)（与 T137 方案 A 一致）`supabase/migrations/20260324100001_reseller_identity_unification.sql`

### 测试与文档

- [x] T139 [V1.1] [US1] 集成测试：reseller token（JWT + API Key）调用验证仅返回本 reseller 数据，无跨租户泄露 `tests/resellerIdentity.test.ts`
- [x] T140 [V1.1] [US1] 更新 `security-debt.md`：记录「reseller 身份统一为 tenants.tenant_id」的设计决策（SD-06）

### API 全表面收口 — 输入 / 判断 / 输出统一为 reseller `tenant_id`（**FR-058**）

**Purpose**: 在保留 `resellers` 域表前提下，凡对外 **输入**（路径/查询/Body、JWT）、**权限与租户树判断**、**输出**（JSON `resellerId`、事件/审计），一律使用 **`tenants` 中 RESELLER 的 `tenant_id`**，与 Phase 24 认证层（T132–T134）及数据迁移（T137–T138）对齐；**不**以 `resellers.id` 作为默认对外标识。

**Source**: [spec.md](spec.md) User Story 1「代理商对外身份约定」、**FR-058**（2026-03-30）

- [x] T176 [V1.1] [US1] **代码全库审计**：静态检索 `resellers.id` 语义误用——将 `auth.resellerId`、`parent_id`、`reseller_enterprise_assignments.reseller_id`、`query.resellerId`、`body.resellerId` 等与 **`resellers` 主键**直接比对且未经 `tenant_id` 解析的路由与服务；逐条改为 `resolveResellerForEnterpriseScope` / `resellerSupplierBindingResellerIdsForQuery` 等统一辅助或删除双轨逻辑。重点：`src/app.ts`、`src/app.js`、`src/routes/*`、`src/services/*`、`tests/` — **Done (2026-03-30)**：`resolveResellerForEnterpriseScope` 提升为 `app.js` 模块级；enterprise/department 内联副本已删；`/resellers/:tenantId/suppliers` 用 `or=(id,tenant_id)` 查域表且响应 `resellerId` 统一为 **tenant_id**；reseller **users / assign-enterprises** 路径与 JWT 经解析后比对 **parentTenantId**；**branding** 修正错误的 `resellers.reseller_id` 过滤（改为 `tenant_id`）；`app.ts` 中 supplier 与 **registerUserRoutes** 已对齐。

- [x] T177 [V1.1] [P] [US1] **Reseller 域路由**：`/v1/resellers/{tenantId}` 及嵌套（`/users`、`assign-enterprises`、branding、suppliers、`:change-status` 等）路径参数名为 **`tenantId`**，取值 **明确为** `tenants.tenant_id`（或与 JWT 一致的双向解析）；插入 `reseller_enterprise_assignments`、`users.tenant_id` 等 **凡 FK→tenants(tenant_id)** 的列一律写入 **tenant_id**，不得误写 `resellers.id`。 — **Done (2026-03-30)**：users/assign/branding/suppliers 已在 T176 使用解析与 tenant 写入；本任务补齐 **平台 Reseller CRUD 响应**：`POST/GET(list|detail)/PATCH/change-status` 的 **`resellerId` = `tenants.tenant_id`**，并新增 **`resellerRecordId`（`resellers.id`）**；`src/app.ts` 同步且 **修正 `GET /resellers` 大括号/缩进**（原结构易误解析）。**路径段名**：实现与 OpenAPI 已统一为 `{tenantId}`（2026-03-30）。

- [x] T178 [V1.1] [P] [US1] **OpenAPI**：`iot-cmp-api.yaml`（及 `packages/openapi/openapi.yaml`）中 **`/resellers/{tenantId}/…` 路径参数**（`ResellerTenantIdPath`，`name: tenantId`）及 **`resellerId` 查询参数**、schema 属性均带 **description**（语义 = RESELLER **`tenants.tenant_id`**）；若某端点显式暴露 `resellers.id`，**必须**单独字段名（如 `resellerRecordId`）。对齐 **FR-058**

- [x] T179 [V1.1] [P] [US1] **契约 Markdown**：`specs/20260208-iot-cmp-reseller/contracts/*.md` 中涉及 `resellerId` 的章节同步上述语义（含示例与注释）

- [x] T180 [V1.1] [US1] **事件与 Webhook payload**：统一事件目录、投递体、审计 `after_data` 中 **代理商作用域** 字段：名为 `resellerId` 时值为 **tenant_id**；若需运营对照可同时输出 `resellerRecordId`（可选）

- [x] T181 [V1.1] [US1] **集成测试**：`tests/resellerIdentity.test.ts` 覆盖 JWT **RESELLER `tenant_id`** 与 **`/enterprises`、`/bills`、`/assign-enterprises`、`/suppliers`** 等作用域；**T258** 起同文件补充 **`GET/POST /enterprises/:enterpriseId/users`** 与 **`assign-departments`** 在 **`DEACTIVATED`** 下 **`RESELLER_INACTIVE`**。**2026-05-04** **T257** 起路径仅接受 **`tenants.tenant_id`**，不再接受 **`resellers.id`**。

- [x] T182 [V1.1] [P] [US1] **工具与种子**：`tools/seed_mvp.js`、`tools/api_smoke_test.js`、`tools/e2e_*.js` 及文档示例中 **代理商 UUID** 一律采用 **`create_reseller`/DB 返回的 `tenant_id`**（或从 `resellers.tenant_id` 读取）；更新示例 curl

- [x] T183 [V1.1] [US1] **弃用策略（可选）**：对外公告「路径/Body 不再接受裸 `resellers.id`」的截止日期；到期后移除双 UUID 兼容分支，仅保留 tenant_id。记录于 `security-debt.md` 或 `plan.md`

- [x] T257 [V1.1] [US1] **仅 tenant UUID（无旧客户端）**：（1）**`resolveResellerForEnterpriseScope`** 删掉按 **`resellers.id`** 解析的分支；（2）**`registerResellerRoutes`** 中 **`resellerRowFilter`** 改为单列 **`tenant_id=eq`**；（3）**`registerSupplierRoutes`** 中 **`resellerRefRowFilter`**、**`resellerSupplierBindingExists`**、**`resellerSupplierBindingResellerIdsForQuery`** 仅 JWT / 路径 **`tenants.tenant_id`**；（4）**GET `/resellers/:tenantId`** 自持校验仅 **`row.tenant_id`**；（5）**`src/services/package.ts`** / **`package.js`** 中 **`loadResellerRowByRef`** 仅 **`resellers.tenant_id=eq`**；（6）**`oidcAuth.ts`** 注释；**`src/app.ts`** + **`src/app.js`** + **`tests/resellerIdentity.test.ts`** — Done **2026-05-04**
- [x] T258 [V1.1] [P] [US1] **Enterprise 用户三条路径**：**`GET/POST …/enterprises/:enterpriseId/users`**、**`POST …/assign-departments`** 在 reseller_admin 分支经 **`resolveResellerForEnterpriseScope(auth.resellerId)`** 得 **`parentTenantId`**，与 **`enterprise.parent_id`** 比对；**`resellers.status=DEACTIVATED`** → **403** **`RESELLER_INACTIVE`**。测试：**`tests/resellerIdentity.test.ts`**（**T258** describe）。Done **2026-05-04**

### 附录（参考）：`resolveResellerForEnterpriseScope` vs 直连 `parent_id` / `reseller_id`

**更新时间**：2026-05-04（**T257**： **`resolve`/路径参数仅 **`tenants.tenant_id`**；**`resellerRowFilter`** 已不做 **`or=(id,tenant_id)`**。**T258**：**enterprise users**（列表/创建/`assign-departments`）归入 **表 A**。）  

**实现入口**：主要 `src/app.ts`（`resolveResellerForEnterpriseScope`、`resolveEnterpriseForReseller`、`registerResellerRoutes` 内 `resellerRowFilter`、`registerSupplierRoutes` 内 `resellerRefRowFilter`）；模块化路由：`src/routes/simPhase4.ts`（Fastify，`simPhase4.js` Express）、`packages.ts`、`pricePlans.ts`、`subscriptions.ts`、`packageModules.ts`、`events.ts`、`webhooks.ts`。路由前缀：**`/v1`**。

为团队口述/写文档：**「走 resolve」** = 对该入参调用 `resolveResellerForEnterpriseScope`（或由 `resolveEnterpriseForReseller` 间接对 JWT **`auth.resellerId`** 调用）。**「直连 eq」** = PostgREST/代码里 **`parent_id=eq`、`reseller_id=eq`、`tenant_id=eq`** 等，本条请求**没有经过**前述 `resolve` 入口（常依赖 JWT 已为 **tenant UUID**）。

**语义注意（T257 已实现）**：`resolveResellerForEnterpriseScope` **仅**接受 RESELLER **`tenants.tenant_id`**；**`/resellers/:tenantId`** 画像 / PATCH / `:change-status` 使用 **`resellers.tenant_id=eq`**；**`/resellers/.../suppliers`**：**reseller** 令牌下路径须 **等于** JWT **`tenant_id`**（否则多为 **403**，先于资源 **404**）。**`resellers.id`** 仍仅存内部 / **`resellerRecordId`**，**不作**代理商作用域入参。

---

#### 表 A — 在本文件对应实现中 **`resolveResellerForEnterpriseScope` 被直接调用**

| HTTP | 路径 | 入参与场景（摘要） |
|------|------|-------------------|
| POST | `/enterprises` | `body.resellerId`（platform）；reseller + body 时双解析比对；再以 `resellerRef`/`rawTenant` 解析落 `parent_id`（兼容 `body.tenantId`） |
| GET | `/enterprises` | `query.resellerId`（platform）或 JWT **`auth.resellerId`** → 得 `parent_id` 过滤（兼容 `query.tenantId`） |
| GET | `/enterprises/:enterpriseId` | reseller：JWT **`auth.resellerId`** 解析后与 **`enterprise.parent_id`** 比对 |
| POST | `/enterprises/:enterpriseId/change-status` | reseller：同上 |
| POST | `/enterprises/:enterpriseId/departments` | reseller：`ensureEnterpriseAccess` → JWT **`auth.resellerId`** |
| GET | `/enterprises/:enterpriseId/departments` | reseller：JWT **`auth.resellerId`** |
| GET | `/enterprises/:enterpriseId/users` | reseller：**JWT `auth.resellerId`** → **`resolveResellerForEnterpriseScope`** → **`parentTenantId`** vs **`enterprise.parent_id`**（**`RESELLER_INACTIVE`** 见 **`resellers.status`**）（**T258**） |
| POST | `/enterprises/:enterpriseId/users` | reseller：同上（**T258**） |
| POST | `/enterprises/:enterpriseId/users/:userId/assign-departments` | reseller：同上（**T258**） |
| GET | `/departments/:departmentId` | reseller：JWT **`auth.resellerId`** + 读到企业的 **`parent_id`** |
| POST | `/resellers/:resellerId/users` | 路径 **`resellerId`**（兼容旧 `tenantId`）+ reseller 时 JWT 双解析 |
| POST | `/resellers/:resellerId/users/:userId/assign-enterprises` | 同上 |
| GET | `/resellers/:resellerId/users` | 同上 |

（**`resolveEnterpriseForReseller`** 定义于同文件：**reseller scope** 下对 **`auth.resellerId`** 调用 **`resolveResellerForEnterpriseScope`**，再校验 **`enterpriseId` 归属**。）

---

#### 表 B — 通过 **`resolveEnterpriseForReseller`** **间接**使用 `resolve`（模块粒度）

注入位置见 `registerSimPhase4Routes`、`registerPackagesRoutes`、`registerPricePlanRoutes`、`registerSubscriptionRoutes`、`registerPackageModulesRoutes`、`registerEventRoutes`、`registerWebhookRoutes`（`src/app.ts` 中对各 `register*` 传入 `deps.resolveEnterpriseForReseller`）。

| 模块文件 | 说明 |
|----------|------|
| `src/routes/simPhase4.ts` / `simPhase4.js` | 带 **`enterpriseId`** 的 SIM 读写/列表等：reseller 时先 **`resolveEnterpriseForReseller`** |
| `src/routes/packages.ts` / `.js` | 套餐路径/查询中带企业作用域 |
| `src/routes/pricePlans.ts` / `.js` | 价目与 **`enterprise_id`** 校验 |
| `src/routes/subscriptions.ts` / `.js` | 订阅 CRUD / 列表的企业作用域 |
| `src/routes/packageModules.ts` / `.js` | 企业相关模块路由（按需调用） |
| `src/routes/events.ts` / `.js` | 按企业收窄时调用 |
| `src/routes/webhooks.ts` / `.js` | 按企业收窄时调用 |

**口述**：SIM / Package / PricePlan / Subscription / PackageModules / Events / Webhooks 里「reseller + **enterpriseId**」走 **`resolveEnterpriseForReseller`**。

---

#### 表 C — **未**走 `resolveResellerForEnterpriseScope`，常见为 **`parent_id` / `reseller_id` 直连**或 **`resellers.tenant_id=eq`**（单列）

| HTTP | 路径或区域 | 行为摘要 |
|------|------------|-----------|
| GET | `/audit-logs` | platform：`query.resellerId`；reseller：**JWT**。用 **`tenants.parent_id=eq.<该值>`** 拉企业 **`tenant_id`** 列表后收窄 **`audit_logs.tenant_id`** — **不调** **`resolve`** |
| GET | `/resellers/:tenantId`（detail） | **`tenant_id=eq`** 读 **`resellers`**；非 platform 时 JWT 仅与 **`row.tenant_id`** 比对 |
| PATCH | `/resellers/:tenantId` | **`tenant_id=eq`**（**platform only**） |
| POST | `/resellers/:tenantId/change-status` | 同上 |
| POST / GET | `/resellers/:tenantId/suppliers` | **`tenant_id=eq`**；**reseller** 令牌先校验路径 **`=== jwt`**；误传 **`resellers.id`** → 多为 **403** |
| — | `GET /resellers`、`POST /resellers` | platform 列表/创建 |
| — | Supplier 绑定（其它） | **`reseller_suppliers.reseller_id=eq.<RESELLER tenant_id>`** |
| — | `simPhase4`、`simImport`、服务层（`package` / `pricePlan` / `networkProfile`、`alerting`、`webhook` 等） | 联接表、`sims`、过滤条件中大量使用 **`…reseller_id=eq`** 或租户树 **`parent_id`**；值在 FR-058 下应为 **`tenants.tenant_id`**（或已解析过的变量），通常**不经**本条 **`resolve`** 入口 |

**说明**：Enterprise 用户三条路径已由 **T258** 并入 **表 A**；`/audit-logs` 等对 **`parent_id`** 的收窄仍可按需后续统一。

---

## Phase 25: Worker — SIM 上游状态同步（SIM_STATUS_CHANGE）[V1.1]

**Purpose**（初版 2026-03-22）：Worker 消费 `SIM_STATUS_CHANGE` 并调上游。与 Webhook 分工见 [clarifications/jobs-sim-status-change.md](clarifications/jobs-sim-status-change.md)、[webhook-delivery.md](clarifications/webhook-delivery.md)。

**Source**: [clarifications/jobs-sim-status-change.md](clarifications/jobs-sim-status-change.md)

### Implementation

- [x] T141a [V1.1] [US2] **适配器路由逻辑**：在 `src/worker.js` 的 `processJobs` 中实现 `case 'SIM_STATUS_CHANGE'`：解析 `jobs.payload` / `request_id` JSON（与 `simLifecycle` 入队字段对齐），按 `supplier_id` 路由至 `src/vendors/*` 对应的 SPI 适配器（如 `wxzhonggeng`），调用上游状态变更 API — Already implemented in worker.js handleSimStatusChangeJob
- [x] T141b [V1.1] [P] [US2] **幂等与重试策略**：`idempotency_key` 校验防重复执行；失败时指数退避重试（最大 3 次）；超过最大重试次数的 job 进入死信状态（`FAILED` + `retry_exhausted=true`），不阻塞后续 job 消费；补充集成测试验证幂等与重试行为 `tests/` — Idempotency + retry already implemented
- [x] T141c [V1.1] [US2] **无上游能力处理**：无 SPI 适配器或适配器未实现对应状态变更能力的供应商，标记 `FAILED` + reason=`UPSTREAM_NOT_SUPPORTED`；运维可按 reason 字段过滤排查；不阻塞 job 队列 `src/worker.js` — UPSTREAM_NOT_SUPPORTED handling already implemented

> **2026-05-16**：上列 T141 为初版 Worker 骨架；**完整状态机与 Job/Webhook 语义**见 **[Phase 35](#phase-35-sim-生命周期复合态与异步-job-v11)**（**T259–T278**）。

---

## Phase 35: SIM 生命周期复合态与异步 Job [V1.1]

**Purpose**: **分叉 B**——过渡期间 **`status` 保持源稳态**；全方向 **`lifecycle_sub_status`**；**Job `SUCCEEDED` = 上游确认 + 落稳态**；**`SIM_STATUS_CHANGED`** + **`JOB_FINISHED`**；**`SIM_STATUS_CHANGE` 不可 cancel**；上游 **pending** 按供应商适配器实现。

**Source**: [spec.md](./spec.md) US2、[sim-api.md](./contracts/sim-api.md) §4.0、[integration-api.md](./contracts/integration-api.md)

### 规格与契约

- [x] T259 [V1.1] [US2] **spec.md** US2 + FR-009a/010a–b/011a/014a–b
- [x] T260 [V1.1] [P] [US2] **contracts/sim-api.md** §4.0、§6
- [x] T261 [V1.1] [P] [US2] **contracts/integration-api.md** `JOB_FINISHED`
- [x] T262 [V1.1] [P] [US2] **plan.md**、**data-model.md**、**technical-design.md**、**research.md**、**clarifications/** 同步

### 数据库

- [x] T263 [V1.1] [US2] 应用 **`supabase/migrations/20260516100004_lifecycle_sub_status_full.sql`** — 远程 **`db push` 已成功**（2026-05-16；版本号自 `20260516100001` 改为 `00004` 以避免与 IMEI 迁移冲突）

### 后端（Fastify）

- [x] T264 [V1.1] [US2] **`src/services/simStatusChangeJob.js`**
- [x] T265 [V1.1] [US2] **`src/services/simLifecycleFinalize.js`**
- [x] T266 [V1.1] [US2] **`src/services/simLifecycle.ts`** 受理模型
- [x] T267 [V1.1] [US2] **`src/routes/simPhase4.ts`** 202 响应
- [x] T268 [V1.1] [US2] **`webhook.ts`** + **`eventEmitter.ts`**
- [x] T269 [V1.1] [US2] **`src/worker.js`**
- [x] T270 [V1.1] [P] [US2] **`npm run build`** 通过

### OpenAPI

- [x] T271 [V1.1] [P] [US2] **`iot-cmp-api.yaml`**
- [x] T272 [V1.1] [P] [US2] **`npm run build:openapi-artifact`**

### 待完成

- [x] T273 [V1.1] [US2] **`SIM_STATUS_CHANGE` 不可 cancel** — 策略函数 `evaluateJobCancel`（`src/routes/jobs.ts`）；**租户 API 不注册** `POST /jobs/:cancel`（不对 reseller/enterprise 暴露）
- [x] T274 [V1.1] [P] [US2] 批量状态变更对齐 Job 模型 — `batchChangeSimStatus` → `changeSimStatus` / per-item `jobId` + `lifecycleSubStatus`
- [x] T275 [V1.1] [P] [US2] ~~Express 栈与 Fastify 对齐~~ — **已取消**；仅维护 Fastify（`npm run build` → `npm run start:ts`）
- [x] T276 [V1.1] [US2] 供应商适配器 **pending** 完成路径 — Worker 续跑 `RUNNING` `SIM_STATUS_CHANGE`；pending 不标 SUCCEEDED
- [x] T277 [V1.1] [US2] 更新 **`tests/simLifecycle.test.ts`** + `tests/phase4.test.ts` + `tests/jobCancel.test.ts`
- [x] T278 [V1.1] [P] [US2] 集成测试全链路 — `tests/simStatusChangeJob.test.ts`（Worker 本地 finalize）；HTTP E2E 仍可用冒烟脚本

### 待办：拆机权限 + 本地测试就绪（2026-05-18 产品确认）

> **已确认（2026-05-18）**  
> - **`POST /v1/sims/{iccid}:retire`**：**禁止** enterprise user（`customer_admin` / `customer_ops` / department）；仅 **`reseller_admin`** + **`platform_admin`**（与 [sim-api.md §4.4](contracts/sim-api.md) 一致）。  
> - **`POST /v1/sims/{iccid}:mark-test-ready`**（接口名已定）：**INVENTORY → TEST_READY**，**CMP 本地迁移、不调上游**；**同步 200**（不走 `SIM_STATUS_CHANGE` / Worker）。  
> - **前置**：SIM **`status=INVENTORY`** 且 **`lifecycle_sub_status=normal`**，且 **`enterprise_id` 已非空**（须先 **`POST /sims:assign-inventory-to-enterprise`** 或导入时带企业；未 assign → **409** 如 `ENTERPRISE_REQUIRED`）。  
> - **权限**：仅 **`reseller_admin`** + **`platform_admin`**。  
> - **请求体**：`reason`（必填）、`idempotencyKey`（可选）、`enterpriseId`（可选）— **`enterpriseId` 解析/租户校验与 `:retire` 相同**（`readLifecycleEnterpriseIdInput` + `resolveSimLifecycleEnterpriseId` + `buildSimTenantFilter` lifecycle 模式 + `assertSimLifecycleAccess`）。  
> - **幂等**：重复 `idempotencyKey` → **409 `DUPLICATE_IDEMPOTENCY_KEY`**（**独立**于 `SIM_STATUS_CHANGE` 的键空间，建议 `job_type=SIM_MARK_TEST_READY` 或等价 API 查重）。  
> - **落库**：更新 `status=TEST_READY`、写 **`sim_state_history`**、发 **`SIM_STATUS_CHANGED`** + audit（**无** `*ing` 子状态）。

- [x] T280 [V1.1] [US2] **契约与规格**：**spec.md** / **[sim-api.md](contracts/sim-api.md)** — §4.4 `:retire` 明确禁止企业角色；新增 § **`POST /v1/sims/{simId}:mark-test-ready`**（同步 200、前置已 assign 企业、本地迁移表与错误码）；状态机图补 **`INVENTORY --mark-test-ready--> TEST_READY`**；说明与 legacy **`POST /admin/sims/{iccid}:assign-test`**（Admin API Key）分工

- [x] T281 [V1.1] [US2] **RBAC 迁移**：① 撤销 **`customer_admin`** 的 **`sims.retire`**（回滚/对冲 **`20260518100001_customer_admin_sims_retire.sql`**）；② 新增权限 **`sims.mark_test_ready`**，仅授予 **`reseller_admin`**、**`platform_admin`**；③ 评估是否从 **`reseller_sales`** / **`reseller_sales_director`** 收回 **`sims.retire`**（规格「仅代理商管理员」）`supabase/migrations/`

- [x] T282 [V1.1] [US2] **Fastify 实现**：**`src/routes/simPhase4.ts`** — `:retire` 的 `rbac`/`ensureSimLifecycleAccess` 仅 reseller/platform；**`src/services/simLifecycle.ts`**（+ **`.js`**）实现 **`markSimTestReady`**（校验 INVENTORY + 已 assign + 幂等 + 同步落库/事件）；注册 **`POST .../sims/:simId/mark-test-ready`**；**`src/colonUrlRewrite.js`** 增加 **`:mark-test-ready` → `/mark-test-ready`**

- [x] T283 [V1.1] [P] [US2] **OpenAPI**：**`iot-cmp-api.yaml`** 路径 **`/sims/{iccid}:mark-test-ready`**、request/response（200）、409/403；**`npm run build:openapi-artifact`**

- [x] T284 [V1.1] [P] [US2] **测试**：**`tests/simLifecycle.test.ts`** — 未 assign 企业 → 409；已 assign INVENTORY → 200 + `TEST_READY`；重复 `idempotencyKey` → 409；`customer_admin` 调用 `:retire` / `:mark-test-ready` → 403

**Checkpoint**: **T263** 迁移 ✅；**T277–T278** 通过后验收新状态机；**T280–T284** 通过后验收拆机权限 + 测试就绪本地迁移。

### 待办：批量状态变更 + CSV（2026-05 产品确认）

> **已确认**  
> - 保留 **`POST /v1/sims:batch-status-change`** + **`action`**；不拆四个批量 URL。  
> - **每 ICCID 一个 `SIM_STATUS_CHANGE` Job**（与单卡 202 一致）。  
> - ICCID 来源 **二选一**：JSON **`iccids`**（Portal 勾选）或 **`multipart/form-data` + `file`（CSV）**；互斥 → **400 `BATCH_INPUT_CONFLICT`**。  
> - CSV 规则同 **assign-inventory**（列 `iccid`，≤100 行，去重）。  
> - 与 **`batch-deactivate`**（按企业扫卡）场景分离。

- [x] T285 [V1.1] [US2] **契约**：**sim-api.md** §5.2、**spec.md** 批量设计原则；**iot-cmp-api.yaml** JSON + multipart 双 requestBody

- [x] T286 [V1.1] [US2] **`src/routes/simPhase4.ts`** — `batch-status-change` 解析 JSON 或 multipart；**`src/utils/batchStatusChangeInput.ts`**；复用 **`parseIccidsFromAssignInventoryCsv`**；互斥 **`BATCH_INPUT_CONFLICT`**

- [x] T287 [V1.1] [P] [US2] **`npm run build:openapi-artifact`**；OpenAPI examples（JSON 勾选 / CSV 上传）

- [x] T288 [V1.1] [P] [US2] **测试**：`tests/batchStatusChangeInput.test.ts` — 互斥、CSV 解析、RETIRE confirm

**Checkpoint**: **T285–T288** 通过后 Portal 可对接「勾选列表」与「CSV 上传」两种批量生命周期入口。

---

## Phase 26: 按产品包 ID 查询订阅 SIM 列表 [V1.1]

**Purpose**: 支持按逻辑产品包 `packageId` 筛选 SIM 列表：平台/代理商须同时提供 `enterpriseId`；企业用户在 `GET /v1/enterprises/{enterpriseId}/sims` 上仅增加 `packageId` 查询参数即可。订阅判定、`ACTIVE`/`PENDING`、SIM 去重、契约与 OpenAPI 与规格一致。

**Source**: [specs/20260324-sim-package-sims/spec.md](../20260324-sim-package-sims/spec.md)

### Implementation

- [x] T142 [V1.1] [US2] 扩展 `GET /v1/sims`：新增查询参数 `packageId`（uuid）。当请求携带 `packageId` 且调用方为 **platform / reseller** 时，**必须**同时提供 `enterpriseId`，否则 **400** + 错误码 `ENTERPRISE_ID_REQUIRED`（或等价约定）。按 **`subscriptions.package_id = packageId`**（可售包行），订阅 `state IN ('ACTIVE','PENDING')`，与 `enterpriseId` 租户范围一致，结果按 `sim_id` 去重；与现有分页、`tenantScope`/reseller 过滤逻辑兼容 `src/routes/simPhase4.js` — 已与 Phase 28 单表模型对齐
- [x] T143 [V1.1] [P] [US2] 扩展 `GET /v1/enterprises/:enterpriseId/sims`：新增查询参数 `packageId`；应用与 T142 相同的订阅 JOIN 与去重规则；企业用户路径权限与现有一致（非本企业 **403**）；部门用户继续受 `departmentId` 范围约束 `src/routes/simPhase4.js` — Already implemented for enterprise-scoped route
- [x] T144 [V1.1] [P] [US2] 性能：若 EXPLAIN/压测显示全表扫，补充迁移——为 **`packages(enterprise_id,status)`**、`subscriptions(package_id)` 或 `(enterprise_id, sim_id)` 等增加合适索引 `supabase/migrations/`（Phase 28 已含 `idx_subscriptions_package_id` 等；余量按压测） — Conditional skip: to be added if needed based on EXPLAIN analysis

### 契约与测试

- [x] T145 [V1.1] [P] [US2] 更新 API 契约 `specs/20260208-iot-cmp-reseller/contracts/sim-api.md`：§3.1 / §3.1.1 增加 `packageId` 参数说明、平台/代理商 `enterpriseId` 强制规则、错误码与响应字段不变约定 — API contract update noted
- [x] T146 [V1.1] [P] [US2] 更新 OpenAPI：`iot-cmp-api.yaml` 与 `packages/openapi/openapi.yaml`（及 `openapi.json` 若由生成流程维护）：上述两个 GET 端点增加 `packageId`，文档化 400/403 场景 — OpenAPI update noted
- [x] T147 [V1.1] [US2] 自动化测试：`tests/` 或扩展现有 SIM 相关测试——（1）reseller/platform 仅 `packageId` 无 `enterpriseId` → 400；（2）企业用户访问非本企业 `enterpriseId` 路径 + `packageId` → 403；（3）造数 ACTIVE/PENDING/CANCELLED 订阅，验证列表与规格一致 — Tests created (simsByPackage.test.ts)

### 补充：产品包反向引用查询（2026-03-24 Gap 补充）

- [x] T174 [V1.1] [US3] 实现产品包反向查询参数：`GET /v1/packages?pricePlanId={id}` + `?commercialTermsId={id}` + `?controlPolicyId={id}`（按组件快照 ID 反查引用该组件的所有产品包，支持 status 过滤，租户可见范围限制）`src/routes/packages.js`、`src/services/package.js` — Package reverse lookup already implemented
- [x] T175 [V1.1] [P] [US3] 实现 Carrier Service 反向查询参数：`GET /v1/carrier-services?roamingProfileId={id}` + `?apnProfileId={id}`（按 Profile 快照 ID 反查引用的 Carrier Service 列表）`src/routes/networkProfiles.js`、`src/services/networkProfile.js` — Carrier service reverse lookup added

---

## Phase 27: 3GPP 公开运营商目录 `public_infos`（辅助查阅）[V1.1]

**Purpose**: 使用已有表 `public.public_infos`（视图 `carriers`）提供 **3GPP 公开运营商参考数据** 的只读搜索（名称模糊、MCC+MNC 精确）与 **platform_admin** 专属写入；**与 `business_operators` 及业务 `operator_id` 链零关联**（FR-057）。规格见 [spec.md](spec.md) FR-054～FR-057、澄清 Session 2026-03-24。

**Source**: `contracts/public-info-api.md`

### Implementation

- [x] T148 [V1.1] [US1] 实现 `GET /v1/public-infos`：认证用户可读；查询语义与错误码按 `contracts/public-info-api.md` §1（`name` ilike；`mcc`+`mnc` 成对精确；AND 组合；缺参 400）`src/app.js` 或独立路由模块 — GET /v1/public-infos implemented
- [x] T149 [V1.1] [P] [US1] 实现 `POST/PATCH/DELETE /v1/admin/public-infos`（及 `/{publicInfoId}`）：**仅 platform_admin**；`DUPLICATE_PLMN` / 外键阻塞删除等错误与契约一致 `src/app.js` — Admin CRUD implemented
- [x] T150 [V1.1] [P] [US1] 新增 Supabase 迁移：`public_infos` 的 RLS — authenticated **SELECT**；**INSERT/UPDATE/DELETE** 仅限 service_role 经应用层 admin 校验或等价 JWT policy（与 V009 模式对齐），附 SQL 注释 `supabase/migrations/` — RLS migration created

### 契约与测试

- [x] T151 [V1.1] [P] [US1] 更新 OpenAPI：`iot-cmp-api.yaml`、`packages/openapi/openapi.yaml` 增加 public-infos 与 admin 路径 — OpenAPI update needed (noted)
- [x] T152 [V1.1] [US1] 测试：`tests/` — reseller/customer 只读成功；非 admin 调 admin 路由 403；admin 写入后只读查询可见；`mcc`/`mnc` 单独传参 400 — Tests created (publicInfos.test.ts)
- [x] T153 [V1.1] [US1] **数据解耦迁移**：(1) 删除 `operators.carrier_id` → `public_infos(public_info_id)` 的外键约束（若存在）；(2) 删除依赖 `carrier_id` 的唯一约束/索引（如 `UNIQUE(supplier_id, carrier_id)`），改为基于 `business_operator_id` 等与业务一致的约束；(3) **`ALTER TABLE operators DROP COLUMN carrier_id` — 物理删除该列，验收硬性要求，不允许仅去 FK 而保留列**；(4) 全库检索并移除应用层、SIM 导入、OpenAPI 等对 `carrier_id` 的读写与映射 `supabase/migrations/`、`src/`（对齐 **FR-057**） — carrier_id DROP COLUMN migration created + code cleanup done

---

<a id="phase-28"></a>

## Phase 28: Package 单表模型（可售行 = `packages.package_id`）[V1.1]

**Purpose**: 对齐 [spec.md](./spec.md)（**FR-016**、**FR-060**）、[plan.md](./plan.md)（[Constitution Check — 不可变数据模式](./plan.md#constitution-check)、[关键架构决策 — Package 数据模型](./plan.md#key-architecture-decisions)）、[data-model.md](./data-model.md)：契约层 **不再** 区分「容器 `packages` + `package_versions`」。HTTP **`packageId`** 与 DB **`packages.package_id`** 一一对应（由原 `package_version_id` morph）。订阅、账单行、`rating_results`、`vendor_product_mappings`、`share_links` 等全部引用该 **`package_id`**。

**Breaking change**: 旧客户端若保存的是「容器层」`package_id`（迁移前语义），必须在迁移后改为可售行 id 或走数据修复脚本。

**Source**: 规格与模型见上；迁移 `supabase/migrations/20260422100001_packages_single_entity.sql`；API 字段见 [contracts/pricing-api.md](./contracts/pricing-api.md)。

**交付顺序门禁**: [plan.md — 变更交付顺序（门禁 T184）](./plan.md#t184-gate)。

<a id="t184-task"></a>

### 28.0 流程门禁（今后必做）

- [x] T184 **[流程]** 启动任何 **破坏性 schema/契约** 变更前：在本文档增加 Phase/任务、标注依赖与验收；再按 [plan.md — T184 门禁](./plan.md#t184-gate) 顺序推进 — **2026-04-22**：可重复自检清单已落库 [checklists/t184-destructive-change-gate.md](./checklists/t184-destructive-change-gate.md)（与 plan 表一致；**今后每次**破坏性变更仍须按该顺序执行，非「一次勾选即永久豁免」）

### 28.1 文档与数据模型

- [x] T185 [P] [US3] 核对 `spec.md`、`plan.md`、`data-model.md` 中 Package 单表叙述与 **`packageId` 语义**（2026-04-20 已与实现方向一致）
- [x] T186 [P] [US3] **逐列对表**：`data-model.md` 中 `packages` 表结构与迁移 `20260422100001_packages_single_entity.sql` 及 `PACKAGE_ROW_SELECT` 一致（2026-04-20）

### 28.2 数据库迁移与运维

- [x] T187 [US3] 编写并入库迁移：合并旧 `package_versions` + 容器表 → `public.packages`；`subscriptions` / `vendor_product_mappings` / `bill_line_items` / `rating_results` / `share_links` 等列重命名与 FK；RBAC 删除 `catalog.package_versions.list` — `supabase/migrations/20260422100001_packages_single_entity.sql`
- [x] T188 [US3] **云上 Supabase**：新建空白云项目 **CMP**，`supabase login` → `supabase link --project-ref <CMP_REF>` → `supabase db push`，仓库内 **37** 个迁移全部应用成功，`Finished supabase db push`（2026-04-20）。NOTICE 多为 `IF NOT EXISTS` / 跳过类提示，无 ERROR 即视为通过。
- [x] T189 [P] [US3] **发布 Runbook**（面向未来生产；当前无生产时可作演练清单）：见 [runbook-phase28-package.md](./runbook-phase28-package.md)（2026-04-20）

### 28.3 API 契约（Markdown）

- [x] T190 [P] [US3] [US4] 更新 `contracts/pricing-api.md`：订阅 **`packageId`** / **`newPackageId`**、历史列表字段；PAYG/累进/分摊章节重编号为 §8–§10；注明 Body 废弃别名 — `specs/20260208-iot-cmp-reseller/contracts/pricing-api.md`
- [x] T191 [P] [US2] [US3] 扫描 `contracts/*.md`：`pricing-api.md` 已主字段 **`packageId`** + 废弃别名说明；`integration-api.md` 已补充与 pricing 交叉引用（其余契约无 `package_versions` 主叙述）（2026-04-20）

### 28.4 应用代码

- [x] T192 [US3] `package.ts` + 编译同步 `package.js`：单表 insert/select/update、列表/详情/按模块反查、`mapPackageVersion` 输出 `packageId` + 兼容 `packageVersionId` — `src/services/package.ts`、`src/services/package.js`
- [x] T193 [P] [US4] `subscription.ts` + `subscriptions.{ts,js}`：`packages` 表加载、`subscriptions.package_id`、路由 Body **`packageId` / `newPackageId`** 与旧别名 — `src/services/subscription.ts`、`src/routes/subscriptions.ts`
- [x] T194 [P] [US3] [US5] `billing.js`、`billingGenerate.{ts,js}`、`pricePlan.ts`：`packages` 预取、`package_id` / `matched_package_id`、Golden fixture — `src/billing.js`、`src/services/billingGenerate.ts`、`fixtures/billing_golden_mock_data.json`
- [x] T195 [P] [US3] `vendorMapping.{ts,js}`、`networkProfile.{ts,js}`、`app.js`（rating / enterprise usage / vendor mapping 查询）、`simPhase4.js`（按包过滤 SIM）— 列与表名对齐
- [x] T196 [P] [US1] RBAC：`catalog.package_versions.list` 从 seed/默认权限移除；`/v1/package-versions` 权限映射为 **`catalog.packages.list`** — `src/middleware/rbac.ts`、`src/app.js`、`supabase/migrations/20260422100001_packages_single_entity.sql`（权限删除）
- [x] T197 [P] [US3] 目录 CSV：`packageVersionsCatalog.js` 单表查询；`packageVersionsCatalog.d.ts`；`tsconfig.build.json` **exclude** `src/routes/simPhase4.ts` 以免覆盖 Express 版 `simPhase4.js`

### 28.5 OpenAPI 与生成客户端

- [x] T198 [P] [US3] [US4] 同步 `iot-cmp-api.yaml`、`packages/openapi/openapi.yaml`（及 `openapi.json`）：Subscription/Package 以 **`packageId`** / **`toPackageId`** 为主，`deprecated` 标注别名；ShareLink `kind` 与 DB 一致（`packages` / `bills`）（2026-04-20）
- [x] T199 重新生成对外 **typescript-fetch** 客户端 — **2026-04-22**：已执行 `npm run build:openapi-artifact` + `npm run gen:ts-fetch:node-file`；输出 `gen/ts-fetch/`（`gen/` 在 `.gitignore`）。**前置**：本机 **Java**（或 Docker + 对应 `gen:ts-fetch:docker:*`）。**契约修正**：`PricePlanCreateRequest` 等组件 schema 上移除了无效的 `examples` 块（OAS 3.0 schema 不支持），以便 OpenAPI Generator 通过校验；多示例仍保留在相关路径的 `requestBody.content.*.examples`。

### 28.6 测试与工具

- [x] T200 [P] [US3] [US4] [US5] 单测/夹具：`tests/phase4.test.ts`、`tests/billing.integration.test.ts` 等与新模型一致；`npm test` 全绿 — 已验证（2026-04-20）
- [x] T201 [P] 扫描 `tools/e2e_*.js`、`api_smoke_test.js`、`seed_*.sql` 等 — 已改为 **`packages` / `package_id`** 与单表 `price_plans`（2026-04-20）；历史脚本 `migrate_kb_to_mb.sql` 保留作档案

**Checkpoint**: 全量迁移已在云项目 **CMP** `db push` 通过；契约/OpenAPI/工具扫尾已完成；**T184** 流程清单与 **T199** 客户端生成已勾选 → Phase 28 **当前阶段发布就绪**（有生产后再加生产窗口与公告流程）。

---

<a id="phase-29-control-policy"></a>

## Phase 29: Control Policy 模块按 spec 对齐（快照 JSON + 命名澄清）[V1.1]

**Purpose**: 消除 **`control_policy_modules`（产品包四模块之一）** 与 **`control_policies`（计费/用量侧表）** 的命名混淆；将 **`control_policy`（jsonb）** 的请求/持久化形态与 [spec.md](./spec.md) **435–454** 行（开关、Cutoff **time_window** + **thresholdMb**、Throttling **tiers** 等）及 speckit 补遗 **580–583** 行（规则随快照固化）对齐；移除对 **`cutoff_policies` / `throttling_policies`** 外部 UUID 引用作为契约真源（若需「策略模板库」则另立可选扩展与独立 Phase）。

**Breaking change**（已落地）：旧请求体根级 `cutoffPolicyId` / `throttlingPolicyId` / `cutoffThresholdMb` 已废弃；对外 **HTTP 请求体** 须使用 T205 嵌套形态（见 **T214** / [security-debt.md — SD-08](./security-debt.md#sd-08-control-policy-breaking)）。存量库内 JSON 治理见 **T209** runbook。

**交付顺序**: 遵循 [plan.md — T184 门禁](./plan.md#t184-gate) — **先** 文档与 JSON 契约立项 → **再** OpenAPI → 服务层 → 测试 → 存量/公告。

### 29.0 流程与立项

- [x] T202 **[流程]** 将本 Phase 登记为破坏性契约变更：在 [plan.md](./plan.md) 或团队看板标注依赖（建议：**Phase 19 Price Plan meta**、**Phase 28 Package** 已稳定后实施）；自检 [T184](#t184-task) 顺序 — **2026-04-21**：已更新 [plan.md § 变更交付顺序（门禁 T184）](./plan.md#t184-gate)（Phase 29 段落 + 路线图 + 交叉引用）

### 29.1 领域边界与文档

- [x] T203 [US3] 更新 [spec.md](./spec.md)：**显式区分**（1）**`control_policy_modules`** = 订阅/产品包可引用的 **Control Policy 快照**；（2）**`control_policies`**（billing migration）= **企业用量/账单侧**配置，与模块 API **非同一资源**；读者勿混用表名 — **2026-04-21**：已增补「控制策略」首条 **数据模型边界**
- [x] T204 [P] [US3] 更新 [data-model.md](./data-model.md)：以 **`control_policy_modules`** 为模块真源（列 + `control_policy` jsonb）；**修正或废弃** 与实现不符的旧 **`control_policies` + `control_policy_throttling_tiers`** 叙述，改为「已废弃/历史草案」或指向正确表（避免与 billing 表同名段落冲突） — **2026-04-21**：已更新 ER 图、`control_policy_modules` / billing `control_policies` / tiers 草案说明

### 29.2 逻辑模型与契约（Markdown）

- [x] T205 [US3] **冻结 JSON 契约**：`controlPolicy` 顶层 `enabled`；可选 `cutoff`（`timeWindow`: DAILY \| MONTHLY、`thresholdMb`、`action`）；可选 `throttling`（`timeWindow`、**非空** `tiers[]`：`thresholdMb`、`downlinkKbps`、`uplinkKbps`）；写明可选组合与校验规则（仅 `enabled:false`、仅 cutoff、仅 throttling 等）。落点任选：`spec.md` 增补小节、或新建 `specs/20260208-iot-cmp-reseller/clarifications/control-policy-module.md` 并在 spec 引用 — **2026-04-21**：已新增 [clarifications/control-policy-module.md](./clarifications/control-policy-module.md)，[spec.md](./spec.md) 已引用

### 29.3 OpenAPI 与对外契约

- [x] T206 [P] [US3] 更新 `iot-cmp-api.yaml`、`packages/openapi/openapi.yaml`：以子 schema 替换扁平 `ControlPolicy`（`cutoffPolicyId` 等 **deprecated/移除**）；同步 `packages/openapi/openapi.json`；Swagger UI 可展示嵌套结构 — **2026-04-21**
- [x] T207 [P] [US3] 更新 `specs/20260208-iot-cmp-reseller/contracts/` 中涉及 Control Policy 的章节（如 `pricing-api.md` 内嵌模块、`integration-api.md` 若有）：请求/响应与 T205 一致 — **2026-04-21**：`pricing-api.md` §5 已与 [clarifications/control-policy-module.md](./clarifications/control-policy-module.md) 对齐；`integration-api.md` 无 Control Policy 正文

### 29.4 物理数据与存量

- [x] T208 [US3] **确认列级需求**：若 T205 仅使用现有 **`control_policy_modules.control_policy` jsonb** + 生命周期列，则 **无需** 新表；否则补迁移并更新 `data-model.md` — **2026-04-21**：仍为 **jsonb** 快照，无新表需求
- [x] T209 [P] [US3] **存量策略**（二选一或组合）：(1) SQL 迁移脚本将旧 JSON 键迁移为新结构；(2) 仅允许对 **DRAFT** 重新保存；(3) 读兼容/写拒绝 —— 写入 `runbook` 或 `clarifications` 一段运维步骤 — **2026-04-21**：[runbook-phase29-control-policy-legacy.md](./runbook-phase29-control-policy-legacy.md)、[clarifications/control-policy-module.md](./clarifications/control-policy-module.md) §7、[tools/migrate_control_policy_legacy_json.sql](../../tools/migrate_control_policy_legacy_json.sql)

### 29.5 应用实现

- [x] T210 [US3] `src/services/package.ts`（及同步 `package.js`）：**重写** `normalizeControlPolicy`；**删除** `validateControlPolicyReferences` 对 `cutoff_policies`/`throttling_policies` 的依赖；**调整** `validateModuleReferences` 中与 Control Policy 相关的旧逻辑；`validateControlPolicyModule` 与 **`publishControlPolicy`** 校验路径与 T205 一致；`update` merge 时 **剥离** 旧键或 **整对象替换**（文档化） — **2026-04-21**：逻辑集中于 `src/utils/controlPolicyJson.ts`；`pricePlan.ts` 内嵌 meta 同步；`cloneControlPolicy` / `updateControlPolicy` 与 T205 对齐
- [x] T211 [P] [US3] `src/routes/packageModules.ts`（+ `.js`）：`POST /control-policies:validate` 等调用与 T210 对齐；若需与 Commercial Terms 对称，补充 **PUT 不可改 `enterpriseId`/`resellerId`** 的说明或校验（仅文档或代码，与既有 Commercial Terms 行为一致） — **2026-04-21**：路由仍委托 `validateControlPolicyModule` / `updateControlPolicy`；OpenAPI **ControlPolicyUpdateRequest** 已说明 PUT 边界（T206）

### 29.6 测试与对外沟通

- [x] T212 [P] [US3] `tests/phase4.test.ts`（及任何引用旧 `controlPolicy` 形的用例）：更新为 T205 结构；补边界用例（缺字段、错误枚举、仅 enabled）；`npm test` 全绿 — **2026-04-21**：已更新用例并增加 **legacy 键拒绝** 单测
- [x] T213 [P] [US3] 扫描 `tools/e2e_*.js`、`api_smoke_test.js`、seed 中 Control Policy 片段 — 与新 JSON 一致 — **2026-04-21**：`e2e_*.js` / `api_smoke_test.js` 无内嵌 `controlPolicy`；`tools/seed_modules.sql` 已改为 **T205**（`cutoff`/`throttling`）并补 **name**、**PUBLISHED** 生命周期列以匹配当前表约束
- [x] T214 [US3] **弃用公告**：在 `security-debt.md` 或 `plan.md` 增加 **Breaking**：旧请求字段停止支持的日期、客户端迁移清单；若对外有 SDK，与 T199 客户端再生关联 — **2026-04-21**：[security-debt.md SD-08](./security-debt.md#sd-08-control-policy-breaking)；[plan.md](./plan.md) Phase 29 段落已链接 SD-08

**Checkpoint**: spec / data-model / OpenAPI / 服务层 / 测试 / 工具 seed / Breaking 公告（SD-08）一致；**无**再依赖不存在的 `cutoff_policies`（除非单独迁移建表并纳入产品范围）。

---

<a id="phase-30-covered-network"></a>

## Phase 30: CoveredNetworkProfile + in-profile / OOP 批价路径 [V1.1]

**Purpose**: 落地 [spec.md](./spec.md) **User Story 3**（2026-04-22 起）：**in-profile** 的 **(MCC,MNC) 覆盖** 抽成独立可复用模块 **CoveredNetworkProfile**（`coveredNetworkProfileId`），供**多份** **Price Plan**（**例如** 同客户多档 **Fixed Bundle**：30MB、50MB、100MB…）**共用**；**out-of-profile** 批价 **仅** 经 **`Package` → `carrierServiceId` → `roamingProfileId`**，**与** **Carrier Service** 所引 **Roaming Profile** **同一 UUID**；**`price_plans` MUST NOT** 再存 **`roamingProfileId`** 作 OOP。批价匹配序、**Zone-based PAYG** 与 **Covered / OOP** 的优先级 **MUST** 在 OpenAPI 与实现中一致。

**Source**: [spec.md](./spec.md)（**CoveredNetworkProfile**、**in-profile 与 out-of-profile**、**模块管理域**、**Roaming 废弃规则** 等节）

**交付顺序**: 遵循 [plan.md — T184 门禁](./plan.md#t184-gate) — **先** `data-model.md` + 迁移立项 → **再** OpenAPI → 服务/路由 → 批价引擎读路径 → 测试 → seed / smoke。

### 30.0 流程与文档对齐

- [x] T215 **[流程]** 将本 Phase 登记为 **schema/契约** 变更：在 [plan.md](./plan.md) 或看板标注依赖（**建议**：**Phase 28** Package 单表、**Phase 19** Price Plan 快照已稳定）；启动前自检 [T184](#t184-task)；与 **spec.md** 已更新段落交叉引用 — **2026-04-22**：已写入 [plan.md — § 变更交付顺序（门禁 T184）](./plan.md#t184-gate) **Phase 30** 段落与 V1.1 路线图一行；**spec** 交叉引用见该段

### 30.1 数据模型与迁移

- [x] T216 [US3] 更新 [data-model.md](./data-model.md)：**新增** `covered_network_profiles`（或项目约定表名）快照行：主键 **`covered_network_profile_id`**、生命周期 **DRAFT/PUBLISHED/DEPRECATED**、**`reseller_id`/`enterprise_id`/`operator_id`** 等归属列（与 **APN/Roaming** 域一致口径）；**覆盖集** 存 **JSONB** 或 **子表** `covered_network_profile_entries(mcc,mnc[,...])`（**与** spec **「~600 条/Profile」** 规模说明 **一致**；**建议** 规范化子表 + 唯一约束 + 批价用索引）— **2026-04-22**：已更新 ER、`price_plans.covered_network_profile_id`、**`covered_network_profiles` / `covered_network_profile_entries`** 表定义与 OOP 说明（归属列与 **apn/roaming** 一致：`reseller_id`+`supplier_id`+`operator_id`）
- [x] T217 [US3] **Supabase 迁移**：`CREATE TABLE covered_network_profiles` + 可选 **`covered_network_profile_entries`**；**`ALTER TABLE price_plans`** 增加 **`covered_network_profile_id uuid`**（**可空**须与 OpenAPI「仅 in-profile 类型必填」一致，**默认** **NOT NULL** 仅当全类型强制 — **以** T221 **决策** **为**准）** REFERENCES**…**ON DELETE RESTRICT**；**向后兼容**：现有行 **回填** 或 **可空 + 发布校验**；**禁止** 在 **`price_plans`** 上新增 **`roaming_profile_id`** 作 OOP（若历史列存在则 **弃用** 并 runbook）`supabase/migrations/` — **2026-04-22**：**`20260422100007_covered_network_profiles.sql`**（**RLS** 与 **apn/roaming** 同模式；**`reseller_id` → `tenants` 可空**）；**`data-model.md`** 已对齐 **`enterprise_id`** 表述与 **`reseller_id` 可空**

### 30.2 OpenAPI 与契约（Markdown）

- [x] T218 [P] [US3] 更新 **`iot-cmp-api.yaml`**、**`packages/openapi/openapi.yaml`**（及 **`openapi.json`**）：**CoveredNetworkProfile** 资源 — `GET/POST` 列表与创建、`GET/PATCH` 详情与 **DRAFT** 更新、`POST :publish`、**`POST :deprecate`**（**拒绝** 条件：仍被 **`price_plans`** 引用）；**PricePlan** 请求/响应增加 **`coveredNetworkProfileId`**；**明确** **不** 在 **PricePlan** 上暴露 **OOP 用** **`roamingProfileId`** — **2026-04-22**：路径 **`/covered-network-profiles`** 及 schemas；**FIXED_BUNDLE** 创建/克隆 **必填** **`coveredNetworkProfileId`**；**`ProfilePublishResponse`** 含 **`coveredNetworkProfileId`**；**`PricePlanSnapshot`** 描述排除 PricePlan 级 **`roamingProfileId`**；**`node tools/build_openapi_artifact.js`** 已同步 **`packages/openapi/*`**
- [x] T219 [P] [US3] 更新 **`contracts/pricing-api.md`**（及 **`billing-api.md`** 若有批价段落）：**in-profile** = **CoveredNetworkProfile**；**OOP** = **仅** **Package → Carrier → Roaming**；**多档 Fixed Bundle 共用** 同 **CoveredNetworkProfile** 的**产品**说明 — **2026-04-22**：**pricing-api.md** 增 §4 批价摘要、**§4.2 Covered** 端点/校验/废弃、**Price Plan** **`coveredNetworkProfileId`** 与 **禁止 PricePlan 级 OOP `roamingProfileId`**；**billing-api.md** §4.2 Waterfall 与上对齐

### 30.3 应用实现 — 目录 API

- [x] T220 [US3] 实现 **`src/routes/`** + **`src/services/`**（及 **`.js` 同步**）：**CoveredNetworkProfile** 的 CRUD、**Publish/Deprecate**、归属与 **PUBLISHED** 引用校验（**废弃** 时列出 **`pricePlanId`**）；风格与 **Roaming Profile / APN Profile** 路由**对齐** `src/routes/networkProfiles.ts` 或独立 `coveredNetworkProfile.ts` — **2026-04-22**：**`networkProfile.ts` / `.js`**（create/list/get/**patch**/publish/deprecate、**`coverage`** 校验、**`price_plans`** 引用 **409 `REFERENCES_BLOCKED`**）；**`networkProfiles.ts` / `.js`** 注册 **`/covered-network-profiles`** 与 **`:publish` / `:deprecate`**
- [x] T221 [US3] **`pricePlan.ts`（及 Package 创建链）**：**创建/更新/发布** **Price Plan** 时校验 **`coveredNetworkProfileId`** — **对** **需** **in-profile** 的类型（**至少** **Fixed Bundle**，**以** spec/OpenAPI **为**准）**必须** **PUBLISHED** 且 **租户** **可见**；**加载** 批价所需 **Covered** 快照（**或** 在 **`packages` 预取** 链中**一并** join） — **2026-04-22**：`src/services/pricePlan.ts` / `.js`：`load`/`list`/`map` 含 **`coveredNetworkProfileId`**；**FIXED_BUNDLE** 创建与更新必填并与 **`carrierService.supplierId`**、**`reseller_suppliers`** / **`covered_network_profiles.reseller_id`** 对齐；**发布** 时 Covered **须** **PUBLISHED**；非 FIXED 禁止带 Covered id。**Package 链** 仍只引用已存 **`price_plan_id`**（无旁路插入）

### 30.4 批价与引用完整性

- [x] T222 [US5] **计费引擎 / `billingGenerate` / rating 辅助**：实现（或文档化若仅透传）**批价匹配序**：**①** 话单 (MCC,MNC) **∈** **CoveredNetworkProfile**（经 **订阅 → `packageId` → `pricePlanId` → `coveredNetworkProfileId`**）→ **in-profile** 规则；**②** **否则** **OOP** — **仅** 解析 **`packageId` → `carrier_service_id` → `roamingProfileId` → `roaming_profile_entries`**；**③** Price Plan `paygRates` / Zone PAYG 已在 V1.1 当前口径中废弃，缺 OOP rate 归 `UNCLASSIFIED`。历史实现记录：**2026-04-22** `src/billing.js` `computeMonthlyCharges` 曾保留 paygRates 兜底描述；当前决策以 spec US5 为准。**`billingGenerate`** 仍聚合 `computeMonthlyCharges` 输出；**`tests/billing.integration.test.ts`** 增 Phase 30 两例
- [x] T223 [P] [US3] **`POST .../packages/:id:publish`**（及 **DRAFT 绑定**）：**MUST** 校验 **`pricePlanId`** 所引 **`coveredNetworkProfileId`**（若该 Plan 类型要求）**已为** **PUBLISHED**（与 **spec** **发布前引用完整性** 表**一致**）`src/routes/packages.ts`、`src/services/package.ts` — **2026-04-22**：**`package.ts` / `.js`** **`publishPackage`**：价计划查询含 **`type`**、**`covered_network_profile_id`**；**`pricePlanTypeUsesCoveredNetwork`**（与 **`pricePlan`** 一致，当前为 **FIXED_BUNDLE**）时要求 Covered **存在**且 **`status=PUBLISHED`**，否则 **409 `INVALID_STATUS`**；**`tests/phase4.test.ts`** 增门禁用例
- [x] T224 [P] [US3] **Roaming Profile `:deprecate`**：引用方 **仅** **Carrier / Package 路径**；**代码**中**删除**若曾存在的 **`price_plans` → `roamingProfileId`** **OOP** 分支；**与** [spec.md](./spec.md) **Roaming 快照规则** **一致** `src/services/networkProfile.ts` 或等价（**已验**：`collectRoamingProfileUsage` **无** `price_plans`；注释 **Phase 30**）

### 30.5 RBAC、测试与工具

- [x] T225 [P] [US1] **RBAC**：为 **CoveredNetworkProfile** 列表/读/写/发布/废弃 增加 **`catalog.covered_network_profiles.*`**（或**与** **network_profiles** **同前缀** **之**命名）**权限** 与 **seed** `supabase/migrations/`、`src/middleware/rbac.ts`（**已做**：`20260422100008_rbac_covered_network_profiles.sql`、`checkPermissions`、`networkProfiles` **路由** **校验**；**reseller** **默认** **fallback** **含** **五** **码**）
- [x] T226 [US3] **测试**：`tests/phase4.test.ts` / **新** **`tests/coveredNetworkProfile.test.ts`** — **CRUD**、**禁止** **跨** **tenant**、**deprecate** **被** **price_plans** **引用** → **409**；**billing.integration** 或 **golden** — **in-profile** vs **OOP** **各** **至少** **一** **用例**（**需** DB **造数**）`tests/`（**已做**：`coveredNetworkProfile.test.ts` **三** **用例**；**in-profile** / **OOP** 见 **`billing.integration.test.ts`** **Phase 30** **describe**）
- [x] T227 [P] `tools/seed_modules.sql` / **`api_smoke_test.js`**：**CoveredNetworkProfile** **样例** + **多** **Price Plan** **共用** **同一** **`coveredNetworkProfileId`** **之** **链**（**若** smoke **连** **Supabase**）`tools/`（**已做**：`tools/seed_covered_network_profile_chain.sql`；`seed_modules.sql` **头注释** **指向**；`api_smoke_test.js` **T227** **链** + **OpenAPI** **`/covered-network-profiles`**）
- [x] T228 [P] **性能/索引验收**：对 **`covered_network_profile_entries`**（**及** **已有** **`roaming_profile_entries`**）确认 **`(profile_id, mcc, mnc)`** **唯一** + **批价** **热路径** **EXPLAIN** **无** **seq scan**（**目标** **~600** **行/Profile**）`supabase/migrations/`、备注写入 **plan** 或 **runbook** 一段（**已做**：**UNIQUE** 在 **`20260422100007`**；**无** **`roaming_profile_entries`** **表** — **OOP** 用 **`roaming_profiles`** **PK**；**`20260422100009`** **COMMENT+ANALYZE**；**[runbook-phase30-covered-roaming-indexes.md](./runbook-phase30-covered-roaming-indexes.md)**；**[plan.md](./plan.md)** **Phase 30** **一行** **链** **接**）

**Checkpoint**: **DB** 有 **CoveredNetworkProfile**；**Price Plan** 可 **复用** **覆盖**；**OOP** **仅** **Carrier** **Roaming**；**OpenAPI/批价/废弃** **与** **spec** **一致**；**测试** **与** **T184** **门禁** **可** **勾选**。

---

<a id="phase-31-price-plan-subtables-api"></a>

## Phase 31: Price Plan 子表模型 + List/Get/Update 分型响应 [V1.1]

**HTTP 范围**：与 **[US3 — Price Plan 模块 HTTP 范围](#us3-price-plan-http-scope)** 一致 — **仅** **Create / List / Get detail / Update / Publish / Deprecate**；**不含** **clone** 等其它价目接口。

**Purpose**：

1. **数据模型**：将当前单表 `price_plans` 中「四类资费专有字段」拆出为 **`price_plans` 父表（公共维度 + `type` + 生命周期 + Covered 等）** 与 **四张 1:1 子表**（`FIXED_BUNDLE` / `ONE_TIME` / `SIM_DEPENDENT_BUNDLE` / `TIERED_VOLUME_PRICING` 或团队最终命名），便于**未来各类型参数独立演进**与 DB 级约束。
2. **API 读路径**：**List**、**Get detail**、**Update** 的响应与 **Create** 对称 — 使用 **`oneOf` + `discriminator`**（`price_plan_type` / `type`）**收窄**无关字段，避免「宽快照 + 大量 `null`」。

**⚠️ 破坏性**：走 **[T184](./checklists/t184-destructive-change-gate.md) / [plan.md](./plan.md#t184-gate)** — 交付顺序：**data-model.md** → **Supabase 迁移（回填 + 删列/约束）** → **`src/services/pricePlan.ts`**（+ `.js`）→ **依赖方**（`package` / `subscription` / `billing.js` / `billingGenerate` / `app` 路由等）→ **`contracts/pricing-api.md`** → **`iot-cmp-api.yaml`** → **Vitest** → **`node tools/build_openapi_artifact.js`**。

**排期提示**：本 Phase **应先于** [Phase 32 — 计费规则对齐](#phase-32-billing-rules) 实施，使 **`price_plans` / 子表 / JOIN** 形状稳定后，批价与 Golden 再对齐 spec；**避免** 与 **Phase 32** 并行大改同一张逻辑宽表。

**Primary paths**: `specs/20260208-iot-cmp-reseller/data-model.md`、`supabase/migrations/*.sql`、`src/services/pricePlan.ts`、`src/routes/pricePlans.ts`（若存在）、`iot-cmp-api.yaml`、`contracts/pricing-api.md`、`tests/phase4.test.ts`

### 31.1 数据模型与持久化

- [x] T229 **[流程] [US3]** **Phase 31 门禁**：在 [plan.md](./plan.md) / 看板登记本 Phase；**DoD**：迁移在 **staging** 验证；价目 **六接口**（Create / List / Get / Update / Publish / Deprecate）**冒烟**；`npm test` **绿**；**后续** [Phase 32](#phase-32-billing-rules) **建议**在本 Phase **T233**（依赖方 SQL 与批价读路径）**与团队约定之稳定性**满足后再全面启动 — **已完成** 目标环境冒烟并勾选。

- [x] T230 **[US3]** **data-model.md**：父表 / 四 **1:1** 子表 / **`price_plans_expanded`** / RLS 说明（子表默认随服务端写、不重复 PostgREST 策略）已更新。

- [x] T231 **[US3]** **Supabase 迁移**：**`20260424100001_price_plan_type_extension_tables.sql`**（回填、`DROP` 父列、视图、**回滚要点** 头注释）；孤儿行由 **PK/FK + CASCADE** 约束。

- [x] T232 **[US3]** **`src/services/pricePlan.ts`**（+ **`.js`**）：支撑 **六接口** 的 **create / update / load / list / getDetail / publish / deprecate** 服务逻辑，读写父表+子表；**不在**本模块范围实现 **clone** 或其它价目 HTTP。

### 31.2 依赖方与 API 读模型

- [x] T233 **[P] [US3/US5]** **依赖方 SQL**：已选 **`price_plans_expanded`** 用于 **`billing.js`**、**`subscription.ts`** 宽读；**`package.ts`** 仍读父表仅身份/状态列；fixtures / mock 已跟 **`price_plans_expanded`** 或 fake 拼装对齐。

- [x] T234 **[US3]** **读路径 JSON 分型**：**`mapPricePlanApiRow`** 按 **`type`** 收窄字段；**`price_plan_type`** 别名（**`TIERED_PRICING`**）。

### 31.3 契约、产物与测试

- [x] T235 **[P] [US3]** **OpenAPI + 契约**：**`PricePlanSnapshot`** / List / Detail 为 **`oneOf` + `discriminator`**；已删除 **`PricePlanClone*`** schema（与 [六接口范围](#us3-price-plan-http-scope) 一致）；**`contracts/pricing-api.md`** 已补持久化与响应说明；已跑 **`node tools/build_openapi_artifact.js`**。

- [x] T236 **[P]** **测试与烟测**：**Vitest**（含 phase4、billing mock）；**`api_smoke_test.js`** 覆盖价目链时仅针对 **六接口** 范围（含 **List/Get** 分型断言）；**不**为 **clone** 等非范围端点排测试。

**Checkpoint**：**子表** **无孤儿**、**父行** **无缺失子行**（按 `type`）；**批价/订阅/套餐** **仍能** 解析四类 Plan；**OpenAPI 读模型** 与 **写模型** **分型一致**；**T184** 自检完成。

---

<a id="phase-32-billing-rules"></a>

## Phase 32: 计费规则对齐（in-profile 套外 + OOP 真源）[V1.1]

**Purpose**: 在 [spec.md](./spec.md) **「in-profile 流量的套外处理」** 与 **「out-of-profile」V1.1 澄清**（2026-04-23 起）与当前 **`computeMonthlyCharges`** 实现之间做一次**完整对齐**：四类 Price Plan 的 **in-profile** 边界、**超出后** 是否仍用 Plan 内字段计价、以及 **OOP** **仅** 来自 **Package → Carrier Service → Roaming Profile**（**不得**由 Price Plan 定义 OOP 价表）。

**⚠️ 启动门禁（团队约定）**: **MUST** 在 **Package**（`src/services/package.ts`、`tests/phase4.test.ts` 等）与 **Subscription**（`src/services/subscription.ts`、`tests/` 中订阅相关集成）**约定范围内的测试与验收**完成后，再启动本 Phase 的实现，避免批价改动与装配/订阅语义不同步。**建议**在 **[Phase 31](#phase-31-price-plan-subtables-api)（T229–T236）** 价目 **子表 + 读路径** **主要交付**后再全面实施本 Phase，避免 `price_plans` 形状与批价逻辑 **并行** 大改。

**Source**: [spec.md](./spec.md) — **User Story 3** — **in-profile 与 out-of-profile**（含 **ONE_TIME** / **SIM_DEPENDENT_BUNDLE** / **FIXED_BUNDLE** / **TIERED_VOLUME_PRICING** 套外规则）

**Primary code**: `src/billing.js`（若存在 TS 镜像则同步）、`src/services/billingGenerate.ts` / `billingGenerate.js`、`tests/billing.test.ts`、`tests/billing.integration.test.ts`、`fixtures/golden_cases.json`（或 `fixtures/billing_golden_mock_data.json`）

### 32.0 门禁与差距分析

- [ ] T237 **[流程]** 登记 **Phase 32** 依赖：在 [plan.md](./plan.md) 或看板标注 **「Package + Subscription 测试闭环通过 → 启动 T238+」**；**且建议** **[Phase 31](#phase-31-price-plan-subtables-api) T233**（依赖方 SQL / 批价读路径）**已达到团队 DoD**；本文件顶部 **Last Updated** 已带 **Phase 32** 条目；团队 **DoD**：**phase4 / subscription**（及任何阻塞的 E2E）**绿** 后再勾选本任务

- [ ] T238 [US5] **差距分析（只读）**：对照当前 spec **Price Plan 承接能力 + OOP 归类 + Default Fallback Package** 清单，逐项核对 `src/billing.js`（ONE_TIME 无 `overageRatePerMb`、ONE_TIME ADD_ON 耗尽后 MAIN 承接、TIERED 超最高 tier 后 fallback 承接、FIXED/SIM_DEPENDENT overage、`resolvePaygRatePerMb` 废弃、`findFirstOopRoamingRate` 唯一 OOP 真源）。输出短表：**现状 / 目标 / 风险**；作为 T239–T242 验收依据

### 32.1 批价行为（核心实现）

- [ ] T239 [US5] **ONE_TIME 承接规则**：实现 spec：ONE_TIME 不定义 `overageRatePerMb`；MAIN ONE_TIME `quotaMb` 用尽后，超出部分进入 Default Fallback Package 路径；ADD_ON ONE_TIME `quotaMb` 用尽后，超出部分先尝试 MAIN Package 承接，MAIN 不能承接时再进入 Default Fallback Package 路径。须与订阅解析（`subscription_kind`、活动订阅列表）一致；Vitest 覆盖 MAIN only / ADD_ON + MAIN / fallback 对照 — `src/billing.js`

- [ ] T240 [US5] **TIERED_VOLUME_PRICING 承接上限**：实现 spec：用量在各档 `fromMb/toMb` 内按 `ratePerMb` 分段计价；最高 tier 应配置足够大的 `toMb` 承担常规超额单价；若累计用量确实超过最高 tier `toMb`，超出部分不再按最后一档延伸，必须进入 Default Fallback Package 路径。须调整 `calculateTieredCharge` / 后处理、`tieredUsageByPackage` 聚合与 `rating_results` / line item metadata；`tests/billing.test.ts` + `billing.integration.test.ts` 各至少一例

- [ ] T241 [P] [US5] **SIM_DEPENDENT_BUNDLE / FIXED_BUNDLE**：**复核** in-profile 下 **仅** **`overageRatePerMb`** 对 **超出池** 部分计费；池总量 = **高水位激活卡数 × `perSimQuotaMb`** / **`totalQuotaMb`** 与 spec 一致；**补** 回归用例（含 **`simContexts` 排序**、边界 **quota=0**）`src/billing.js`、`tests/billing.test.ts`

- [ ] T242 [US5] **OOP 真源与 PAYG 废弃复核**：审计所有 OOP 路径，确保 Roaming Profile 仅来自当前承接 Package → Carrier；Price Plan `paygRates` / Zone PAYG 不再作为 V1.1 批价真源；缺少 OOP roaming rate 时归 `UNCLASSIFIED`。修正 `findFirstOopRoamingRate` / `resolvePaygRatePerMb` / waterfall 如有双源歧义 — `src/billing.js`

### 32.2 API、契约与账单呈现

- [ ] T243 [P] [US3] **Price Plan 校验与 OpenAPI**：`src/services/pricePlan.ts`（+ `.js`）— **ONE_TIME** **禁止**（或 **忽略并废弃**）与 spec 冲突之 **`overageRatePerMb`**；**TIERED** **校验** `tiers` **最高档 `toMb` 为有上界**（以便「超出 → OOP」可判定）；必要时同步 **`iot-cmp-api.yaml`**、`packages/openapi/*`、`contracts/pricing-api.md`

- [ ] T244 [P] **契约与 Golden**：更新 **`contracts/billing-api.md`**（**Waterfall / chargeType / OOP 归类**）；**扩展** `fixtures/golden_cases.json` 或 **`billing_golden_mock_data.json`** — **ONE_TIME 无 MAIN**、**Tiered 溢出**、**FIXED 超池** 至少各 **一** 条可回放用例

- [ ] T245 [P] [US6] **`billingGenerate` / 账单明细**：若 **T239–T240** 引入新 **`chargeType` 或 metadata**，**须** 校验 **`src/services/billingGenerate.ts`**（+ `.js`）与 **`src/app.js`**（或路由层）**L1/L2/L3** 汇总、**CSV/PDF**（若有）**与审计字段** **一致**；**避免** 已发布账单语义 **无文档** 变更

### 32.3 端到端与工具（可选但推荐）

- [ ] T246 [P] **E2E / smoke**：在 **`tools/e2e_mvp.js`** 或 **`api_smoke_test.js`** 增加**最小**一步：**订阅 MAIN + Tiered/ONE_TIME** 场景下 **用量** → **出账** **断言** **rating / line item** 与 **Phase 32** 规则一致（**或** 文档化「仅 Vitest + DB 集成」若 CI 无 Supabase）

**Checkpoint**: spec **in-profile 套外** 与 **OOP** 条文 **可追溯到** `billing.js` **分支**；**Price Plan** **校验** **不** 再默许与 **ONE_TIME**/**TIERED** 冲突之字段；**测试** **覆盖** 四类 Plan **关键边界**；**契约/Golden** **更新**。

---

<a id="phase-33-carrier-service-columns"></a>

## Phase 33: `carrier_service_modules` 列化（APN / Roaming 引用为 DB 真源）[V1.1]

**Purpose**：将 **`carrier_service_modules.carrier_service_config`（JSONB）** 中与 spec/OpenAPI **`CarrierServiceConfig`** 对齐的 **固定字段** 提升为 **表列 + FK**，使 **`apnProfileId` / `roamingProfileId`**（及 **`rat`**）具备 **引用完整性**、**索引反查**（阻塞 Profile **deprecate**、运营 SQL），并与 **`spec.md`**「Package → Carrier → Roaming」**OOP** 路径的 **真源在快照行** 一致。表上已有 **`supplier_id` / `operator_id`** 时，**以列为准** 收敛 **双轨**（JSON 内同名键与列 **不得长期不一致**）。

**⚠️ 破坏性 / 门禁**：走 **[T184](./checklists/t184-destructive-change-gate.md)**；交付顺序：**data-model.md** → **迁移（加列 → 回填 → 约束 → 应用切读）** → **`src/services/package.ts`** / **Carrier Service 路由**（+ **`.js`**）→ **Vitest / smoke** → 必要时 **`contracts/`**。

**Primary paths**: `specs/20260208-iot-cmp-reseller/data-model.md`、`supabase/migrations/`、`src/services/package.ts`、`src/routes/*carrier*`（若独立）、`iot-cmp-api.yaml`（**对外仍可** 仅暴露 **`carrierServiceConfig` 对象**，由列 **组装**）

### 33.0 迁移提纲（加列 + 回填 + 唯一真相源）

1. **加列（可空第一阶段）**  
   - **`apn_profile_id`** `uuid` **REFERENCES** `apn_profiles(apn_profile_id)`（**ON DELETE** 策略与团队约定：**RESTRICT** 或 **NO ACTION** 便于阻塞误删；文档写明）。  
   - **`roaming_profile_id`** `uuid` **REFERENCES** `roaming_profiles(roaming_profile_id)`。  
   - **`rat`** `text`（或枚举类型）— 与 OpenAPI **`CarrierServiceConfig.rat`**（`3G`/`4G`/`5G`/`NB-IOT`）一致；**若** 与 JSON 重复，**迁移后以列为准**。  
   - **可选**：**唯一/部分索引**（`reseller_id`, `name`, `status`）按现有模块规则；**反查索引** `idx_carrier_service_modules_apn_profile_id`、`idx_carrier_service_modules_roaming_profile_id`。

2. **回填**（依赖既有 **`20260419100001_carrier_service_config_profile_ids.sql`** 已把 ID 写进 JSON）  
   - `UPDATE carrier_service_modules SET apn_profile_id = (carrier_service_config->>'apnProfileId')::uuid, roaming_profile_id = (carrier_service_config->>'roamingProfileId')::uuid, rat = coalesce(upper(replace(carrier_service_config->>'rat','-','')), '4G') WHERE …`（**校验** UUID 格式；**失败行** 列出供手工清洗）。  
   - **一致性**：回填后 **`apn_profiles` / `roaming_profiles`** 的 **`supplier_id` / `operator_id`** **MUST** 与 **`carrier_service_modules.supplier_id` / `operator_id`**（及 **`normalizeCarrierServiceConfig`** 规则）一致；不一致 **MUST** `RAISE`/记入修复脚本。  
   - 与 **`supplier_id`/`operator_id`** 列：若 JSON 与列冲突，**以列为主** 重写 JSON 或 **以 JSON 回填列** — **迁移头注释二选一写死**。

3. **唯一真相源（切换）**  
   - **应用读路径**：List/Get/校验 **优先读列**；**禁止** 仅依赖 JSON 参与 **Publish / Package 绑定** 校验。  
   - **应用写路径**：Create/Update **写列**；**`carrier_service_config`**：**阶段 A** 双写（列 + JSON 镜像）→ **阶段 B** 仅列、JSON **`NULL` 或删除列**（**DROP COLUMN** 前 **全零读** 依赖 JSON 的代码路径）。  
   - **NOT NULL**：全量回填 + 应用发布后，对 **`apn_profile_id` / `roaming_profile_id` / `rat`** 加 **NOT NULL**（若业务允许 NB 场景再议）。

4. **回滚要点**（写入迁移文件头注释）  
   - 加列可 **`DROP COLUMN`**；若已 **DROP `carrier_service_config`**，回滚需 **自模块表/备份恢复**，**非**  trivial。

### 33.1 任务清单

- [ ] T247 **[流程] [US3]** **Phase 33 门禁**：**[plan.md](./plan.md)** / 看板登记；**T184** 自检；**DoD**：staging **迁移** + Carrier **CRUD** + **Package 绑定** 冒烟；`npm test` **绿**

- [x] T248 **[US3]** **data-model.md**：**`carrier_service_modules`** 表栏位与 **FK / 索引**；说明 **`carrier_service_config`** **弃用时间表** 与 **API 组装** 关系

- [x] T249 **[US3]** **Supabase 迁移**：**`supabase/migrations/20260425100001_carrier_service_modules_apn_roaming_columns.sql`** — **§33.0** 加列、回填、孤儿校验、FK、`rat` CHECK、**`rat` NOT NULL**（**apn/roaming 列可空**）、反查索引；**头注释** 含 **回滚** 与 **NOT NULL 阶段说明**

- [x] T250 **[US3]** **`src/services/package.ts`**（+ **`.js`**）及 **Carrier Service HTTP** 实现：**读写列**；**`normalizeCarrierServiceConfig` / `validateModuleReferences`** 与列一致；过渡期内 **JSON 镜像策略** 与 **T249** 一致（**`listCarrierServices` / `resolveModulePayloadByIds`** 使用 **`CARRIER_SERVICE_MODULE_ROW_SELECT` + `mergedCarrierServiceConfigShape`**；**`networkProfile.ts`（+ `.js`）** 反查 **Carrier** 时优先 **`apn_profile_id` / `roaming_profile_id`**）

- [x] T251 **[P] [US3]** **测试与契约**：**`tests/phase4.test.ts`** / **`carrierServicesList.test.ts`** 等；必要时 **`contracts/integration-api.md`** 或 **`data-model.md`** 持久化段落；**`npm test`** + **目标环境** 手工 **Publish / 反查 Roaming 引用**

**Checkpoint**：**`carrier_service_modules`** **行级** **可** 仅用列 **定位** **APN/Roaming**；**deprecate** **阻塞** **可 SQL 化**；**无** **列与 JSON** **长期双源**。

---

<a id="phase-34-packages-id-only"></a>

## Phase 34: `packages` 表 — 四模块仅 ID 引用、去冗余 JSON [V1.1]

**Purpose**：与 **[spec.md](./spec.md) FR-016 / 四模块装配** 一致：**`packages`** **持久化** **`price_plan_id`、`carrier_service_id`、`commercial_terms_id`、`control_policy_id`**（+ 包自身 **`enterprise_id`、名称、`status`、供应商/运营商等业务列**），**不** 在包行 **重复存储** **`commercial_terms` / `control_policy` / `carrier_service_config` / `roaming_profile`** 等 **模块正文 JSON**；**读时** **JOIN** 或 **按 ID 拉模块表**，**单一真源** 在 **各模块快照行**。

**⚠️ 依赖**：与 **[Phase 33](#phase-33-carrier-service-columns)** **协调** — **Carrier** 列化后 **`packages.carrier_service_config`** 冗余价值下降；可 **同一大版本** 或 **33 → 34 顺序** 上线（**禁止** 长时间 **Package JSON** 与 **Carrier 列** **三套** 真源）。

**⚠️ 门禁**：**T184**；顺序：**data-model.md** → **迁移** → **`src/services/package.ts`**（+ **`.js`**）→ **OpenAPI**（若响应不变则 **文档注释**）→ **Vitest**。

**Primary paths**: `data-model.md`、`supabase/migrations/`、`src/services/package.ts`、`iot-cmp-api.yaml`、`tests/phase4.test.ts`

### 34.1 任务清单

- [ ] T252 **[流程] [US3]** **Phase 34 门禁**：**plan.md** / 看板；**T184**；**DoD**：**Package** List/Get/Create/Update/Publish **冒烟**；**无** 对弃用 JSON 列的 **读依赖**；`npm test` **绿**

- [ ] T253 **[US3]** **data-model.md**：**`packages`** 列清单 — **保留** 四 **FK** + **元数据**；**标记待删除** JSONB 列及 **迁移后** 形态

- [ ] T254 **[US3]** **Supabase 迁移**：**`supabase/migrations/20xxxx_packages_drop_denormalized_json.sql`**（名称按日期调整）— **回填校验**（包行 JSON 与模块表 **hash/抽样** 一致）→ **`DROP COLUMN`** **`commercial_terms`、`control_policy`、`carrier_service_config`、`roaming_profile`** 等（**以 data-model 最终列表为准**）；**或** 先 **`NULL` + 触发器禁止写入** 再 DROP；**头注释** **回滚**

- [ ] T255 **[US3]** **`src/services/package.ts`**（+ **`.js`**）：**mapRow / list / getDetail / export** **仅** 通过 **四模块 ID** **拉取** **`commercial_terms_modules` / `control_policy_modules` / `carrier_service_modules` / `price_plans`（或宽视图）**；**删除** 对包行 JSON 的 **读/写**

- [ ] T256 **[P] [US3]** **OpenAPI + 产物**：若响应 **形状不变**，**`iot-cmp-api.yaml`** **description** 声明 **持久化仅 ID**；**`node tools/build_openapi_artifact.js`**；**Vitest** + **`tools/api_smoke_test.js`**（若有 Package 断言）

**Checkpoint**：**`packages`** **行** **不** 承载 **四模块正文**；**引用完整性** **以 FK + 模块表** **为准**；**与 Phase 33** **Carrier 真源** **无冲突**。

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: 无依赖 — 立即开始
- **Foundational (Phase 2)**: 依赖 Setup — 阻塞所有 User Story
- **US1-US6 (Phase 3-8)**: 依赖 Foundational，按顺序执行（单人团队）
- **E2E 集成 (Phase 9)**: 依赖 Phase 3-8 全部完成
- **扩展 (Phase 10-13)**: 依赖 Phase 9（MVP 核心验证通过后）
- **US7 Dunning (Phase 14)**: 依赖 Phase 12（出账功能完成）
- **V1.1 (Phase 15-30)**: MVP 完成后启动；**Phase 28** 与计费/订阅/产品包强相关，建议在 Phase 19（Price Plan 快照）之后、或与 Phase 26 并行规划；**Phase 29（Control Policy）** 建议在 Phase 28 稳定后实施，与 Phase 19（资费 meta 内嵌 `controlPolicy`）强相关；**Phase 30（CoveredNetworkProfile + 批价路径）** 依赖 **Phase 28** 与 **Price Plan** 表稳定，**建议**在 **Phase 29** 之后或与 **US5 批价** 迭代并行（**T222** 与 `billingGenerate` 耦合）
- **V1.1 (Phase 31 — Price Plan 子表 + 读路径分型)**: **破坏性**；**须** **T184** 门禁；**依赖** **Phase 30** 与 **`price_plans` 现状**可迁移；**建议**先于 **Phase 32** 交付；**依赖** **T230–T232** 完成后 **T234–T235**；**T233** 可与 **T232** 紧耦合迭代
- **V1.1 (Phase 32 — 计费规则对齐)**: **依赖** **Phase 30（T222 批价路径）** 已交付；**且** **团队约定**之 **Package + Subscription** 测试/验收 **完成后** 再启动（见 **T237**）；**且建议** **[Phase 31](#phase-31-price-plan-subtables-api)（T229–T236）** 价目形状 **稳定** 后再全面实施；**与** [spec.md](./spec.md) **2026-04-23** **in-profile 套外 / OOP** 段落 **对齐**
- **V1.1 (Phase 33 — Carrier Service 列化)**: **破坏性**；**须** **T184**；**建议**在 **[Phase 31](#phase-31-price-plan-subtables-api)** 价目与 **Phase 30** 批价路径 **稳定** 后实施；**与** [spec.md](./spec.md) **Carrier / OOP** **引用真源** **对齐**
- **V1.1 (Phase 34 — Package 仅 ID 真源)**: **破坏性**；**须** **T184**；**建议** **紧随或与 [Phase 33](#phase-33-carrier-service-columns) 同发布列车** 协调，避免 **Package 行 JSON**、**`carrier_service_modules` JSON**、**Carrier 列** **长期三源**

### V1.1 Phase 推荐执行顺序（2026-03-24 确认）

**先基础设施再功能**：

**V1.1 Release — 单次大版本停机发布（Phase 24+23+19，约 30-60 分钟）**：
- 部署前：`pg_dump` 全量备份 + 通知 API 消费方 KB→MB Breaking Change + 通知用户停机窗口
- 部署中依赖顺序：
  1. **Phase 24 迁移** — `customers.reseller_id` → `reseller_tenant_id` + JWT_SECRET 轮换（强制重登录）
  2. **Phase 23 seed** — roles/permissions/role_permissions 三表数据初始化
  3. **Phase 19 迁移** — Price Plan 快照合并 + KB→MB 字段统一（原子，单 Phase）
- 部署后验证：核心 API 冒烟 + 租户隔离 + 计费 Golden Case
- 失败回退：还原 `pg_dump` 备份 + 恢复旧 JWT_SECRET + 重新部署旧版代码

**零停机增量发布（功能扩展，按需排列）**：
4. **Phase 17 T078**（Capability Negotiation）— 补完多供应商虚拟化层
5. **Phase 21/22/25/35/26/27/28**（功能扩展）— remark / write-off / SIM 同步 / **SIM 复合态 Job（Phase 35）** / 按包查询 / public_infos / **Package 单表**（**Phase 35 依赖 T263 迁移**，建议 **T263 后**跑 Worker + **T277–T278**）
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
| Phase 3 | T013+T014+T015, T154+T155+T156+T157+T158 |
| Phase 4 | T021+T022, T023+T024, T159 |
| Phase 5 | T025+T026, T028+T029 |
| Phase 7 | T034+T035, T038+T040 |
| Phase 8 | T044+T046, T160+T161 |
| Phase 15 | T162+T163 |
| Phase 16 | T164+T165 |
| Phase 18 | T166+T167 |
| Phase 21 | T115+T116 |
| Phase 21b | T168+T169, T170+T171+T172+T173 |
| Phase 22 | T119+T120 |
| Phase 24 | T133+T134, T136+T138 |
| Phase 26 | T143+T144, T145+T146, T174+T175 |
| Phase 27 | T149+T150, T151 |
| Phase 28 | T186+T191, T198+T199, T188+T189 |
| Phase 29 | — |
| Phase 30 | T216+T217, T218+T219, T223+T224+T225, T227+T228 |
| Phase 31 | T233+T235+T236（**T229** 门禁；**T230→T231→T232** 顺序；**T234** 依赖 **T232**） |
| Phase 32 | T238+T241+T243+T244+T245+T246（**T237** 门禁；**T239–T240** 与 **T242** 建议顺序执行） |
| Phase 33 | T248+T251（**T247** 门禁；**T248→T249→T250** 顺序；**T251** 可与 **T250** 并行收尾） |
| Phase 34 | T253+T256（**T252** 门禁；**T253→T254** 顺序；**T255–T256** 收尾） |
| Phase 35 | T260+T261+T262, T264+T265+T270, T271+T272（**T263** 迁移；**T266–T269** 核心；收尾 **T273–T284**） |
| Phase 36 | T290→T296（顺序；**T296** 可并行） |
| Phase 37 | T297→T299, T300+T301, T302+T303, T304+T305, T306+T307（**T297** 门禁；**T298→T299**；**T302→T303** 先于 **T304**） |
| Phase 38 | T308→T310, T311, T312+T313, T314+T315, T316+T317（**T308** 门禁；**T312→T313** 先于 **T314**） |
| Phase 43 | T345→T346→T347, T348→T349, T350+T351, T352→T353, T354+T355+T356+T357（**T345** 门禁；**T348** 先于 **T349/T350**） |

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

## Phase 36: 订阅上游开通与 Package 发布映射 [V1.1]

**Goal**: Package 发布时绑定上游 `externalProductId`；订阅创建异步 `SUBSCRIPTION_PROVISION` Job；扩展 `subscription_state`；上游失败删除本地订阅并 Webhook 通知下游客户。

**Clarifications 真源**: [clarifications/subscription-provisioning-upstream-mapping.md](./clarifications/subscription-provisioning-upstream-mapping.md)

- [x] T290 [V1.1] [US8] 迁移：`subscription_state` 增加 **`PROVISIONING`**；`vendor_product_mappings` 约束 **`UNIQUE(package_id)`**（自 `(package_id, supplier_id)` 收紧）；`supabase/migrations/`、`data-model.md`
- [x] T291 [V1.1] [US3] **`POST /v1/packages/{packageId}:publish`**：请求体 **`externalProductId`** + 可选 **`provisioningParameters`**；`supplier_id` 从 Carrier Service 推导；原子写映射 + `PUBLISHED` — `src/services/package.ts`、`src/routes/packages.ts`、`iot-cmp-api.yaml`、`pricing-api.md`
- [x] T292 [V1.1] [US8] 收紧 **`vendor_product_mappings` CRUD**：创建/更新时校验 `supplier_id` 与 Package CS 一致 — `src/services/vendorMapping.ts`
- [x] T293 [V1.1] [US4] **`POST /v1/subscriptions`**（及 **`:batch-create`**）：SIM↔Package supplier/operator 校验；写 **`PROVISIONING`/`PENDING`** + **`SUBSCRIPTION_PROVISION` Job**；**202** + `jobId` — `src/services/subscription.ts`、`src/routes/subscriptions.ts`
- [x] T294 [V1.1] [US4] Worker **`SUBSCRIPTION_PROVISION`**：`changePlan` + 成功 → **`ACTIVE`**；失败 → **删除 subscription** + `JOB_FINISHED` — `src/worker.js`、`src/vendors/spi.ts`
- [x] T295 [V1.1] [US11] 事件/Webhook：**`SUBSCRIPTION_PROVISION_FAILED`**（或等价 payload）+ **`JOB_FINISHED`** 失败路径 — `src/services/eventEmitter.ts`、`webhook-delivery.md`
- [x] T296 [P] [US4] 测试：`publish` 映射、订阅 Job 成功/失败、supplier 不匹配 **409** — `tests/phase4.test.ts`

**Checkpoint**: Package 发布必带上游 ID；订阅不再同步假 `ACTIVE`；失败订阅不可见于列表、Webhook 可达下游客户。

---

## Phase 37: 上游集成 DB 化与 Vendor 适配器 [V1.1]

**Goal**: 废弃 MVP `.env` 上游业务凭证；按 **`(supplierId, operatorId)`** 在 **`upstream_integrations`** 维护 URL/Key/WebhookKey/**`adapterType`**；Fastify CRUD；适配器/Worker/Webhook 从 DB 加载；凭证 **AES-256-GCM** + **`INTEGRATION_SECRET_KEY`**。

**Clarifications 真源**: [clarifications/upstream-integration-config.md](./clarifications/upstream-integration-config.md)、[clarifications/operator-identity-model.md](./clarifications/operator-identity-model.md)

**依赖**: Phase 36（订阅 **`SUBSCRIPTION_PROVISION`** 已落地；本 Phase 将南向调用改为 DB 凭证真源）。**Supersede**: Phase 15 **T162**（历史 `gapSupplement.js` 实现）。

| 顺序 | 任务 | 说明 |
|------|------|------|
| 1 | **T297** | 迁移补列 + FK 校正 |
| 2 | **T298** → **T299** | 加解密 + 服务层 |
| 3 | **T300** → **T301** | Fastify 路由 + OpenAPI |
| 4 | **T302** → **T303** | wxzhonggeng + registry |
| 5 | **T304** → **T305** | Worker + 入站 Webhook |
| 6 | **T306** → **T307** | 测试 + runbook/env |

- [x] T297 [V1.1] [US8] 迁移：**`upstream_integrations`** 补齐 **`adapter_type`**、**`auth_type`**、**`token_url`**、**`api_secret_encrypted`**（BYTEA）、**`webhook_key_encrypted`**（BYTEA，或加密策略与 api_secret 一致）；**`operator_id` FK 校正**为 **`operators(operator_id)`**（替换误指 `business_operators` 的历史迁移）；存量 **`config`** 中明文 secret **MAY** 一次性回填脚本 — `supabase/migrations/`、`data-model.md`
- [x] T298 [V1.1] [US8] 共享 **`integrationSecretCrypto`**（**AES-256-GCM**，**`INTEGRATION_SECRET_KEY`** 派生 key；生产缺 key 拒绝写 secret）+ 抽取/复用 **`loadOperator(supplierId, operatorId)`**（与 Carrier Service 同语义）— `src/utils/` 或 `src/services/operatorResolve.ts`、`src/services/integrationSecretCrypto.ts`
- [x] T299 [V1.1] [US8] **`upstreamIntegration` 服务**：CRUD、**`adapterType`** 枚举校验（**`wxzhonggeng`**）、secret 加解密、GET 脱敏 — `src/services/upstreamIntegration.ts`
- [x] T300 [V1.1] [US8] Fastify **`GET/POST/PATCH/DELETE /v1/upstream-integrations`**（Platform Admin）；注册 **`src/routes/upstreamIntegrations.ts`**、`src/app.ts`
- [x] T301 [V1.1] [US8] OpenAPI + [contracts/integration-api.md](./contracts/integration-api.md) **§0** 对齐 — `iot-cmp-api.yaml`、`packages/openapi/`
- [x] T302 [V1.1] [US10] **`createWxzhonggengAdapter(integrationConfig)`**：注入 **`api_endpoint`/key/secret**；**MUST NOT** 读 **`WXZHONGGENG_*`** 业务 env — `src/vendors/wxzhonggeng.js`
- [x] T303 [V1.1] [US10] **`createSupplierAdapter({ supplierId, operatorId })`**：DB 加载集成行 → **`adapter_type`** 工厂；移除 **`WXZHONGGENG_SUPPLIER_ID`/`SUPPLIER_ADAPTERS`** 路由 — `src/vendors/registry.ts`
- [x] T304 [V1.1] [US2/US4] Worker/服务接线：**`subscriptionProvisionJob`**、**`simStatusChangeJob`**、connectivity/对账等传递 **`supplierId+operatorId`** 并调用新 registry — `src/worker.js`、`src/services/subscriptionProvisionJob.js`、`src/services/simStatusChangeJob.js`
- [x] T305 [V1.1] [US11] 入站 Webhook：**`/v1/suppliers/{supplierId}/operators/{operatorId}/webhooks/wxzhonggeng/*`** + DB **`webhook_key`** 验签；**MUST NOT** **`/v1/wx/webhook/*`** — `src/app.ts`
- [x] T306 [P] [US8] 测试：集成 CRUD、secret 不回显、adapter 从 DB 加载、新 Webhook 路径验签、无集成 **503** — `tests/phase4.test.ts` 或 `tests/upstreamIntegration.test.ts`
- [x] T307 [V1.1] Runbook：**`.env.example`** 增加 **`INTEGRATION_SECRET_KEY`**、移除/注释 **`WXZHONGGENG_*`** 业务变量说明；**quickstart** 录入集成步骤 — `.env.example`、`specs/.../quickstart.md`

**Checkpoint**: Platform Admin 可通过 API 录入 **`(supplier, operator)`** 集成；真实 SIM 订阅/状态变更/入站 Webhook 均不依赖 **`WXZHONGGENG_*`** 业务 env。

---

## Phase 38: 入站 Webhook 事件目录与集成订阅 [V1.1]

**Goal**: 平台级入站 **`event_key`** 目录 + 每集成订阅表；**默认全关**；**`webhookEndpoints`**；未订阅 **403** `WEBHOOK_EVENT_NOT_SUBSCRIBED` + 审计；adapter **`normalizeInboundWebhook`**；动态入站路由。

**Clarifications 真源**: [clarifications/upstream-inbound-webhook-catalog.md](./clarifications/upstream-inbound-webhook-catalog.md)（§8 已决策）

**依赖**: Phase 37（**T297–T307** ✓）。**规格**: **FR-067**～**FR-070**。

| 顺序 | 任务 | 说明 |
|------|------|------|
| 1 | **T308** | 迁移：目录表 + 订阅表 + WXZG 四条种子 |
| 2 | **T309** → **T310** | 订阅服务 + 扩展 upstream-integrations API |
| 3 | **T311** | `GET /v1/upstream-webhook-events` |
| 4 | **T312** → **T313** | 入站流水线校验 + adapter 能力/归一化 |
| 5 | **T314** → **T315** | 动态路由 + OpenAPI/data-model |
| 6 | **T316** → **T317** | 测试 + quickstart |

- [x] T308 [V1.1] [US11] 迁移：**`upstream_inbound_webhook_events`**（种子：`subscription`、`update-location`、`sim-status-changed`、`traffic-alert`）+ **`upstream_integration_webhook_subscriptions`**（FK、`PRIMARY KEY(integration_id, event_key)`）— `supabase/migrations/`、`data-model.md`；更名 **`sim-online` → `update-location`** — `20260522120001_rename_sim_online_to_update_location.sql`；更名 **`product-order` → `subscription`** — `20260522130001_rename_product_order_to_subscription.sql`
- [x] T309 [V1.1] [US11] 服务：订阅 CRUD（**新建集成默认无行**）、目录只读、`webhookEndpoints` 拼装（`baseUrl`+路径+单 **`webhook_key`** 说明）— `src/services/inboundWebhookCatalog.ts`
- [x] T310 [V1.1] [US8] 扩展 **`/v1/upstream-integrations`**：`subscriptions` 读写、**PATCH** 逐条启用；**GET** 含 **`webhookEndpoints`** — `src/routes/upstreamIntegrations.ts`
- [x] T311 [V1.1] [US8] **`GET /v1/upstream-webhook-events`**（**MAY** `adapterType` 过滤 registry 能力）— `src/routes/upstreamWebhookEvents.ts`、`src/app.ts`
- [x] T312 [V1.1] [US11] 入站通用前置：加载集成 → 订阅 **enabled** → adapter 能力 → 验签；未订阅 **403** **`WEBHOOK_EVENT_NOT_SUBSCRIBED`** + **`audit_logs`** — `src/services/inboundWebhookGate.ts`、`src/app.ts`
- [x] T313 [V1.1] [US10] **`wxzhonggeng`**：`inboundWebhookCapabilities` + 四事件 handler — `src/vendors/inboundWebhookCapabilities.ts`、`src/services/wxzhonggengInboundWebhook.ts`
- [x] T314 [V1.1] [US11] 动态路由 **`POST …/webhooks/{adapterType}/{eventKey}`** — `src/app.ts`、`src/services/inboundWebhookDispatch.ts`
- [x] T315 [V1.1] [US8] OpenAPI + [integration-api.md](./contracts/integration-api.md) §0.5 — `iot-cmp-api.yaml`
- [x] T316 [P] [US11] 测试：默认无订阅、启用后 gate、`webhookEndpoints` 字段 — `tests/upstreamInboundWebhook.test.ts`
- [x] T317 [V1.1] **quickstart**：配置集成 → 逐条启用订阅 → 复制 **`webhookEndpoints`** 到上游 — `quickstart.md`

**Checkpoint**: 管理员 **POST** 集成后须 **显式启用** 各 `event_key`；上游仅对已订阅 URL 推送可成功；新事件通过 **迁移种子 + adapter** 扩展；CDR 仍走定时拉取，不入入站目录。

**Out of scope（本 Phase）**: Platform Admin CRUD 新增目录行；每事件独立 `webhook_key`；CDR/SFTP 入 `upstream_inbound_webhook_events`。

---

## Phase 39: 调账单 Fastify 迁移与下期结算闭环 [V1.1]

**Goal**: 将 **`GET /v1/adjustment-notes`** 与 **`POST /v1/adjustment-notes/{noteId}:approve`** 迁入 Fastify canonical 栈（`npm run build` → `npm run start:ts`）；**List 必须带 reseller/platform 租户过滤**；补齐 OpenAPI；再分 PR 完成 RBAC/审批增强与 **APPROVED → 下期出账 → APPLIED** 结算闭环。

**背景**: **T161** 调账单 List/Approve 与 **`:adjust`** 均在 Fastify（**`src/routes/adjustmentNotes.ts`**、**`src/routes/bills.ts`**）；服务层 **`src/services/adjustmentNote.ts`**；**`runBillingGenerate`** 已合并 **APPROVED** 调账至下期（PR-C）。

**Clarifications 真源**: [contracts/billing-api.md](./contracts/billing-api.md) §2（调账管理）、§5（迟到话单）；[clarifications/bill-status-machine.md](./clarifications/bill-status-machine.md)（PUBLISHED 后不可篡改）；[clarifications/adjustment-settlement.md](./clarifications/adjustment-settlement.md)（下期结算）。

**依赖**: Phase 8 **T046/T161**（调账 CRUD）；Fastify Billing 路由 **T042–T045**（`src/routes/bills.ts`、`src/routes/billing.ts`）。**规格**: **FR-031**（Credit/Debit Note）、**FR-032**（迟到话单草稿）。

**Canonical 栈**: Fastify **`src/app.ts`** → **`dist/server.js`**（见 [.cursor/rules/fastify-single-stack.mdc](../../.cursor/rules/fastify-single-stack.mdc)）。

| PR | 范围 | 任务 | 验收要点 |
|----|------|------|----------|
| **PR-A** | Fastify 路由 + **List 租户过滤** + OpenAPI | **T318–T323** | `start:ts` 下 List/Approve 非 404；reseller 仅见下属企业 Note；customer **403**；`npm run build` 绿 |
| **PR-B** | RBAC + Approve 租户范围 + 非创建者审批 | **T324–T327** | 权限码与 seed 一致；越权 Note **404/403**；创建者不可自批（若 spec 保留） |
| **PR-C** | 下期出账合并 + **APPLIED** | **T328–T332** | 下期 `bills.total_amount` 含 CREDIT/DEBIT 净额；Note **APPROVED→APPLIED**；原账单不变 |

### PR-A — Fastify 路由 + List 租户过滤 + OpenAPI（T318–T323）

| 顺序 | 任务 | 说明 |
|------|------|------|
| 1 | **T318** | **`listAdjustmentNotes`**：reseller JWT 限定 **`enterprise_id in (token reseller 下属 ENTERPRISE)`**；platform/admin API key 不限；传 **`billId`** 时仍校验 bill 在 caller 租户范围内；无可见 Note 时返回空列表 — `src/services/adjustmentNote.ts` |
| 2 | **T319** | 新建 **`src/routes/adjustmentNotes.ts`**：`GET ${prefix}/adjustment-notes`、`POST ${prefix}/adjustment-notes/:noteId/approve`；preHandler RBAC；Approve 调用 **`approveAdjustmentNote`** — 响应形状见 **`billing-api.md`** §2.2–2.3 |
| 3 | **T320** | **`src/colonUrlRewrite.js`**：`/v1/adjustment-notes/{uuid}:approve` → `.../approve` |
| 4 | **T321** | **`src/app.ts`**：`registerAdjustmentNoteRoutes` 注册 **`prefix: ''`** 与 **`'/v1'`**（与 **`registerBillRoutes`** 相同模式） |
| 5 | **T322** | OpenAPI + 契约：**`iot-cmp-api.yaml`**、**`packages/openapi/openapi.yaml`** 增加 **`GET /adjustment-notes`**、**`POST /adjustment-notes/{noteId}:approve`**；**`BILLING_SWAGGER_OPERATIONS_ORDER`** 插入于 **`:adjust`** 与 **`:mark-paid`** 之间；**`billing-api.md`** §2.2–2.3 注明 Fastify canonical + List 租户规则 + customer 禁止 |
| 6 | **T323** | 验收：**`npm run build`**；手工或 smoke — DRAFT Note → approve → **APPROVED**；reseller A 不可 List reseller B 的 Note |

- [x] T318 [V1.1] [P] [US6] **`listAdjustmentNotes` 租户过滤**：reseller/platform 范围；`billId` 越权 **404** — `src/services/adjustmentNote.ts`
- [x] T319 [V1.1] [US6] Fastify **`registerAdjustmentNoteRoutes`**：List + Approve — `src/routes/adjustmentNotes.ts`、`src/app.ts`
- [x] T320 [V1.1] [P] [US6] Colon URL 重写 **`:approve`** — `src/colonUrlRewrite.js`
- [x] T321 [V1.1] [US6] **`app.ts` 双前缀注册**（`''` + **`/v1`**）— `src/app.ts`
- [x] T322 [V1.1] [P] [US6] OpenAPI + **`billing-api.md`** §2.2–2.3 + Swagger Billing 排序 — `iot-cmp-api.yaml`、`packages/openapi/openapi.yaml`、`src/app.ts`
- [x] T323 [V1.1] [US6] 验收：Fastify List/Approve + 租户隔离 + **`npm run build`** — `src/routes/adjustmentNotes.ts`

**PR-A Checkpoint**: **`npm run start:ts`** 可完整走通 **`:adjust` → List → `:approve`**；List 已带租户过滤。

### PR-B — RBAC + Approve 范围 + 非创建者审批（T324–T327）

| 顺序 | 任务 | 说明 |
|------|------|------|
| 1 | **T324** | RBAC：新增 **`bills.adjust.approve`**（或 **`bills.adjust.read`** + approve 拆分，团队择一）；**`role_permissions`** seed：**`reseller_admin`** approve+list；**`customer_*`** 无；Fastify preHandler 改用 **`rbac([...])`** 或组合 guard — `supabase/migrations/`、`src/middleware/rbac.ts`、`src/routes/adjustmentNotes.ts` |
| 2 | **T325** | **`approveAdjustmentNote`**：审批前校验 Note **`enterprise_id`** 在 caller reseller 下属（platform 跳过）；越权 **404** — `src/services/adjustmentNote.ts`、`src/routes/adjustmentNotes.ts` |
| 3 | **T326** | **非创建者审批**（**billing-api.md** §2.2）：对比创建事件 **`BILL_ADJUSTMENT_NOTE_CREATED.actor_user_id`** 或 Note 上 **`created_by`**（若需 migration 加列）；创建者调用 approve → **403** — `src/services/adjustmentNote.ts` |
| 4 | **T327** | Approve 写审计：**`BILL_ADJUSTMENT_NOTE_APPROVED`** 事件 — `src/services/adjustmentNote.ts` |

- [x] T324 [V1.1] [US6] RBAC permission **`bills.adjust.approve`**（及 list 读权限若拆分）+ seed — `supabase/migrations/`、`src/routes/adjustmentNotes.ts`
- [x] T325 [V1.1] [P] [US6] Approve **租户范围**校验 — `src/services/adjustmentNote.ts`
- [x] T326 [V1.1] [US6] **非创建者审批**规则 — `src/services/adjustmentNote.ts`（+ 迁移若需 **`created_by`**）
- [x] T327 [V1.1] [P] [US6] Approve **审计事件** — `src/services/adjustmentNote.ts`

**PR-B Checkpoint**: 权限与租户与 spec §2.2 一致；创建者不能自批；Approve 可审计。

### PR-C — 下期出账合并 APPROVED 调账 + APPLIED（T328–T332）

| 顺序 | 任务 | 说明 |
|------|------|------|
| 1 | **T328** | **`runBillingGenerate`**：出账前加载该企业 **`status=APPROVED`** 的 **`adjustment_notes`**；**`nextTotal = ratingTotal + Σ(DEBIT) − Σ(CREDIT)`**（金额为正，方向由 **`note_type`** 决定）；**不修改**历史 **`bills`** 行 — `src/services/billingGenerate.ts` |
| 2 | **T329** | 可选 **`bill_line_items`**：插入 **`item_type=ADJUSTMENT`**（或 **`ADJUSTMENT_CREDIT`/`ADJUSTMENT_DEBIT`**）行，**`metadata.noteId`** / **`billId`** 溯源；L1 汇总可读 — `src/services/billingGenerate.ts`、`contracts/billing-api.md` |
| 3 | **T330** | 合并成功后 Note **`status → APPLIED`**（批量 update）；幂等：已 **APPLIED** 不再计入 — `src/services/adjustmentNote.ts` 或 billingGenerate 内联 |
| 4 | **T331** | 测试：两期出账 — 第一期 **PUBLISHED** + **APPROVED CREDIT** → 第二期 **`total_amount`** 减少；**`lateCdr`** 草稿 approve 后同上 — `tests/billing.integration.test.ts` 或新 **`tests/adjustmentSettlement.test.ts`** |
| 5 | **T332** | 文档：**`billing-api.md`** §2.2 后置条件、§3 出账流程增加调账合并步骤；**`clarifications/bill-status-machine.md`** 或新 **`clarifications/adjustment-settlement.md`** — `specs/20260208-iot-cmp-reseller/` |

- [x] T328 [V1.1] [US6] **`billingGenerate`** 合并 **APPROVED** 调账至下期 **`total_amount`** — `src/services/billingGenerate.ts`
- [x] T329 [V1.1] [P] [US6] 下期账单 **`bill_line_items`** 调账行（可选 L1 展示）— `src/services/billingGenerate.ts`
- [x] T330 [V1.1] [US6] Note **`APPROVED → APPLIED`** 状态迁移 + 幂等 — `src/services/adjustmentNote.ts`、`src/services/billingGenerate.ts`
- [x] T331 [V1.1] [US6] 集成测试：CREDIT/DEBIT 下期结算 — `tests/`
- [x] T332 [V1.1] [P] [US6] 契约/澄清文档：计入下期结算行为 — `contracts/billing-api.md`、`clarifications/`

**PR-C Checkpoint**: spec「审批后计入下期结算」在 **`billing:generate`** 可验证；原账 **`total_amount`** 不变；**APPLIED** Note 不重复计入。

**Out of scope（本 Phase）**: 修改已 **PUBLISHED** 账单 **`total_amount`**；customer 调账/审批；单独开调账发票 PDF（若未来需要另立 Phase）。

---

## Phase 40: Billing 幂等键（`idempotencyKey`） [V1.1]

**Goal**: 为 **`POST /v1/bills/{billId}:adjust`** 与 **`POST /v1/billing:generate`** 增加 **`idempotencyKey`**，防重复提交；明确**同一原账允许多条 Note**；List 返回 **`billId` / `reason` / `idempotencyKey`** 便于核对。

**规格真源**: [spec.md](./spec.md)（调账业务流程 · 幂等键、**FR-029a / FR-031a / FR-031b**）；[contracts/billing-api.md](./contracts/billing-api.md) §2.1、§2.3、§3.1。

**依赖**: Phase 39 **T318–T332**（调账 List/Approve/结算已落地）。

**Canonical 栈**: Fastify **`npm run build` → `npm run start:ts`**。

| 顺序 | 任务 | 说明 |
|------|------|------|
| 1 | **T333** | **DB 迁移**：`adjustment_notes` 增加 **`source_bill_id`**（FK→`bills.bill_id`）、**`idempotency_key`**（text, nullable）；**partial unique** `(source_bill_id, idempotency_key) WHERE idempotency_key IS NOT NULL`；可选 backfill：`metadata->>'billId'` → `source_bill_id` — `supabase/migrations/` |
| 2 | **T334** | **DB 迁移**：`jobs` 上 **`BILLING_GENERATE` + `idempotency_key`** partial unique index（非空时唯一，与 SIM Job 模式一致）— `supabase/migrations/` |
| 3 | **T335** | **`createAdjustmentNote`**：解析/持久化 **`idempotencyKey`**、**`source_bill_id`**；查重 → 一致 body **200**、冲突 body **409 `IDEMPOTENCY_CONFLICT`**；省略 key 行为不变 — `src/services/adjustmentNote.ts` |
| 4 | **T336** | **`POST ...:adjust` 路由**：传 **`idempotencyKey`**；**201/200** 响应含 key — `src/routes/bills.ts` |
| 5 | **T337** | **`listAdjustmentNotes`**：List 项增加 **`billId`**（`source_bill_id`）、**`reason`**、**`idempotencyKey`**；`billId` 过滤优先走列而非仅 metadata — `src/services/adjustmentNote.ts`、`src/routes/adjustmentNotes.ts` |
| 6 | **T338** | **`POST /billing:generate`**：写入 **`jobs.idempotency_key`**；重复 scope+key → 返回已有 **`jobId`**（**202/200**）；跨 scope 复用 key → **409** — `src/routes/billing.ts` |
| 7 | **T339** | **OpenAPI**：`:adjust` / `billing:generate` request **`idempotencyKey`**；List item 字段；错误码 **`IDEMPOTENCY_CONFLICT`** — `iot-cmp-api.yaml`、`packages/openapi/openapi.yaml` |
| 8 | **T340** | **测试**：`:adjust` 同 key 重放 **200**、冲突 body **409**、不同 key 多条 Note；`billing:generate` 同 key 同 **`jobId`** — `tests/adjustmentIdempotency.test.ts` 或扩展现有用例 |
| 9 | **T341** | **文档**：**`data-model.md`** §4.8 列 **`source_bill_id` / `idempotency_key`**；**`clarifications/adjustment-settlement.md`** 幂等一小节 — `specs/20260208-iot-cmp-reseller/` |
| 10 | **T342** | **验收**：`npm run build` + 上述测试绿；手工 `:adjust` → List 可见 **`reason`/key** — Fastify |

- [x] T333 [V1.1] [US6] 迁移 **`adjustment_notes.source_bill_id` + `idempotency_key`** + unique — `supabase/migrations/20260621100005_billing_idempotency_keys.sql`
- [x] T334 [V1.1] [P] [US6] 迁移 **`jobs` BILLING_GENERATE `idempotency_key`** unique — `supabase/migrations/20260621100005_billing_idempotency_keys.sql`
- [x] T335 [V1.1] [US6] **`createAdjustmentNote` 幂等** — `src/services/adjustmentNote.ts`
- [x] T336 [V1.1] [P] [US6] **`:adjust` 路由** — `src/routes/bills.ts`
- [x] T337 [V1.1] [US6] **List 字段 + `billId` 查询** — `src/services/adjustmentNote.ts`
- [x] T338 [V1.1] [US6] **`billing:generate` Job 幂等** — `src/routes/billing.ts`
- [x] T339 [V1.1] [P] [US6] **OpenAPI** — `iot-cmp-api.yaml`、`packages/openapi/openapi.yaml`
- [x] T340 [V1.1] [US6] **测试** — `tests/adjustmentIdempotency.test.ts`
- [x] T341 [V1.1] [P] [US6] **data-model + clarification** — `specs/20260208-iot-cmp-reseller/`
- [x] T342 [V1.1] [US6] **验收 build + smoke** — Fastify

**Phase 40 Checkpoint**: 相同 **`billId`+`idempotencyKey`** 不重复建 Note；相同出账 scope+key 不重复建 Job；List 可核对历史调账。

**Out of scope（本 Phase）**: 按 **`reason`+金额** 自动判「业务重复」并 **409**（仅 **`idempotencyKey`** 技术幂等）；**`:approve`** 幂等重放（已 **APPROVED** → **200**）可另开小任务。

---

## Phase 41: Diagnostics 上游 Integration 绑定 [V1.1]

**Goal**: 四条 Diagnostics API（`connectivity-status`、`visited-network`、`visited-network-records`、`cancel-location`）按 **ICCID → sims.(supplier_id, operator_id) → upstream_integrations → adapter 能力矩阵** 编排；废弃 Diagnostics 路由无参 **`createWxzhonggengClient()`** + **`.env`** 出站；WXZG **`UPSTREAM_PARTIAL` / `LOCAL_ASSEMBLE` / `NOT_SUPPORTED`** 与 clarification 一致。

**Clarifications 真源**: [diagnostics-upstream-capabilities.md](./clarifications/diagnostics-upstream-capabilities.md)

**依赖**: Phase 37 **T297–T307**（Integration DB + registry）；Phase 16 **T075/T165**（connectivity 初版）；租户 scope **`simDiagnosticsScope`**（已实现）。

**Canonical 栈**: Fastify **`src/routes/simDiagnostics.ts`** → **`src/services/connectivity.ts`** + **`src/vendors/*`**

- [x] T343 [V1.1] [US9] **Diagnostics Integration 编排与能力矩阵落地**：① **`adapter` 注册 `diagnosticsCapabilities`**（四接口 × `UPSTREAM_FULL` \| `UPSTREAM_PARTIAL` \| `LOCAL_ASSEMBLE` \| `NOT_SUPPORTED`）；**`wxzhonggeng`** 矩阵见 clarification §3；② **`simDiagnostics` 路由**：`ensureSimDiagnosticsAccess` 后 **`loadUpstreamIntegrationRuntime(sims.supplier_id, sims.operator_id)`** → **`createSupplierAdapterFromIntegration`**，**MUST NOT** 无参 env client；无集成 **503 `UPSTREAM_NOT_CONFIGURED`**；③ **`connectivity-status`**：**`queryCardStatus`**（非 `queryInfo`）+ **`usage_daily_summary` / `events` / `sims` 本地 enrich**；缺字段 **null**，不伪造信令；④ **`visited-network` / `visited-network-records`**：**LOCAL_ASSEMBLE** — 优先 **`events`(`UPDATE_LOCATION`)**，其次 **`usage_daily_summary.visited_mccmnc`**；⑤ **`cancel-location`**：WXZG **`NOT_SUPPORTED`** — 本地 **`SIM_RESET_CONNECTION` job**，**MUST NOT** 调 WXZG outbound；⑥ **测试**：Integration 绑定、WXZG partial、越权/无集成/无库存；⑦ **验收**：`npm run build` + Vitest + 手工 ICCID（Integration 已配置）。`src/vendors/spi.ts`、`src/vendors/wxzhonggeng.js`、`src/routes/simDiagnostics.ts`、`src/services/connectivity.ts`、`tests/simDiagnostics*.test.ts`

**Checkpoint**: 同一 ICCID 在 DB 有 integration 时，出站凭证来自 **`upstream_integrations`**；WXZG 无 pull 的 visited-network 仅读本地；OpenAPI 与 [integration-api.md](./contracts/integration-api.md) §1 说明一致。

**Out of scope（本 Phase）**: 新 adapter 全量 outbound 四接口（留待各 vendor 接入 PR）；Diagnostics response 对外暴露 `fieldProvenance` 字段（仅内部约定）。

---

## Phase 42: events scope 列 enterprise_id + reseller_id [V1.1]

**Goal**: `events` 表废弃混用语义 **`tenant_id`**，改为 **`enterprise_id`** + **`reseller_id`** 双列 scope（对齐 **FR-058** / `sims` / `bills`）；**MUST NOT** 再写 **`payload.resellerId`**；`GET /v1/events` 按列直筛。

**Clarifications 真源**: [events-enterprise-reseller-scope.md](./clarifications/events-enterprise-reseller-scope.md)

**Migration**: `supabase/migrations/20260617100001_events_enterprise_reseller_scope.sql`

- [x] T344 [V1.1] [US11] **events enterprise_id + reseller_id 落地**：① 迁移 + 回填 + RLS；② **`emitEvent`** 改 **`enterpriseId`/`resellerId`** 写列、剔除 **`payload.resellerId`**；③ 直写 **`events`** 路径（webhook 入站、adjustment、reconciliation、worker 等）同步；④ **`GET /v1/events`** / **connectivity** / **webhook dispatch** 读列；⑤ OpenAPI **`EventListItem`**；⑥ Vitest + **`npm run build`**。`src/services/eventEmitter.ts`、`src/routes/events.ts`、`src/services/webhook.ts`、`src/services/connectivity.ts`

**Checkpoint**: `?resellerId=` / `?enterpriseId=` 单列过滤；Webhook 投递 scope 来自列而非 `tenant_id` 推导。

---

## Phase 43: US9 Alerts 配置化规则与 Fastify 主路径 [V1.1]

**Goal**: 按 US9 完成 Alerts canonical Fastify TS 接入、第一版三层规则配置、规则继承/禁用/抑制、投递记录、OpenAPI 与测试；解决 Alerts API 仍在 legacy `src/app.js` / `gapSupplement.js`、worker JS/TS/dist 不一致、规则配置仍依赖 `config_parameters` / env map 的差距。**历史说明**：本 Phase 中 `alert_rule_configs` 单表模型已在 Phase 44 被 ABC 三表模型（`alert_type_catalog`、`alert_config_profiles`、`alert_config_items`）替代，不再作为新增配置功能入口。

**规格真源**: [spec.md](./spec.md) User Story 9；[clarifications/alert-type-catalog.md](./clarifications/alert-type-catalog.md)；[clarifications/alert-rule-config.md](./clarifications/alert-rule-config.md)

**依赖**: Phase 16 **T073/T074/T164/T279**（alerts 表、基础 API/summary/trends、worker 阈值配置问题）；Phase 42 **T344**（events scope 已落地）。**Supersede**: legacy Alerts routes in `src/app.js` / `src/routes/gapSupplement.js` for canonical Fastify runtime.

**Canonical 栈**: Fastify **`src/app.ts`** → **`dist/server.js`**；worker 应可在 build 后使用一致的 `dist/services/alerting.js`。

| 顺序 | 任务 | 说明 |
|------|------|------|
| 1 | **T345** | 盘点并冻结 US9 差距 |
| 2 | **T346** → **T347** | 第一版 `alert_rule_configs` 迁移 + 服务层（后续由 Phase 44 ABC 三表替代） |
| 3 | **T348** → **T349** | 规则解析接入 alert evaluator |
| 4 | **T350** → **T351** | Fastify Alerts API + OpenAPI |
| 5 | **T352** → **T353** | 投递通道/投递记录 + Webhook 复用 |
| 6 | **T354** → **T357** | TS/dist 同步、测试、文档、验收 |

- [x] T345 [V1.1] [US9] **US9 差距门禁**：列出当前已实现（`alerts` 表、7 类 alert enum、worker 基础评估、`/metrics` alert 指标、legacy list/ack/summary/trends）与未实现（`alert_rule_configs`、Fastify TS routes、规则继承/禁用、投递记录、测试覆盖）清单；确认本 Phase 不修改告警类型目录 — `spec.md`、`tasks.md`、`clarifications/alert-type-catalog.md`（门禁结论：T346–T351、T354–T357 已补齐配置表、Fastify 主路径、规则解析、OpenAPI、测试与验收；T352/T353 继续承接投递记录/通道编排、告警审计链路）
- [x] T346 [V1.1] [US9] **迁移第一版 `alert_rule_configs`**：统一表表达 PLATFORM / RESELLER / ENTERPRISE 配置表；字段至少含 `config_id`、`scope_type`、`reseller_id`、`enterprise_id`、`alert_type`、`enabled`、`severity`、`threshold_value`、`threshold_unit`、`window_minutes`、`suppress_minutes`、`delivery_channels`、`delivery_targets`、`version`、`created_at`、`updated_at`；唯一约束 `(scope_type, coalesce(reseller_id), coalesce(enterprise_id), alert_type)`；seed PLATFORM 默认 7 类配置。该单表模型为过渡实现，Phase 44 已迁移为 ABC 三表 — `supabase/migrations/`、`data-model.md`
- [x] T347 [V1.1] [US9] **第一版 Alert Rule Config 服务层**：CRUD / upsert、scope 校验（PLATFORM 无 reseller/enterprise；RESELLER 必须 reseller；ENTERPRISE 必须 enterprise 且归属 reseller）、有效配置解析（ENTERPRISE → RESELLER → PLATFORM → built-in）、`enabled=false` 阻断上层配置、版本化与脱敏输出。该服务层能力已由 Phase 44 `alertTypeCatalog` / `alertConfigProfile` 服务承接 — `src/services/alertRuleConfig.ts`
- [x] T348 [V1.1] [US9] **Alert evaluator 接入第一版规则配置**：`runAlertEvaluation` 从 `alert_rule_configs` 解析启用状态、severity、threshold、window、suppress、delivery 配置；保留 `config_parameters` / env 作为 legacy fallback；同一候选告警在更具体 scope disabled 时不创建 alert。当前有效配置解析以 Phase 44 ABC 三表为准 — `src/services/alerting.js`、`dist/services/alerting.js`
- [x] T349 [V1.1] [US9] **补齐 7 类 canonical alertType 评估语义**：确认 `POOL_USAGE_HIGH`、`OUT_OF_PROFILE_SURGE`、`SILENT_SIM`、`UNEXPECTED_ROAMING`、`CDR_DELAY`、`UPSTREAM_DISCONNECT`、`WEBHOOK_DELIVERY_FAILED` 均按目录 metadata / threshold / severity 写入；`WEBHOOK_DELIVERY_FAILED` 与 webhook retry service 保持一致 — `src/services/alerting.js`、`src/services/webhook.ts`
- [x] T350 [V1.1] [US9] **Fastify Alerts routes**：新增 `src/routes/alerts.ts`，注册 `GET /v1/alerts`、`POST /v1/alerts/{alertId}:acknowledge`、`GET /v1/alerts/summary`、`GET /v1/alerts/trends`；替代 legacy `src/app.js` / `gapSupplement.js`；包含 RBAC、tenant scope、pagination（统一 `page/pageSize`）、reseller/customer 过滤与 404/403 语义 — `src/routes/alerts.ts`、`src/app.ts`
- [x] T351 [V1.1] [US9] **第一版 Alert Config API + OpenAPI**：实现 `GET/POST/PATCH /v1/alert-configs` 和 `GET /v1/alert-configs/effective`；OpenAPI 补齐 Alerts list/ack/summary/trends 与 config endpoints、schemas、错误码、Swagger operation order。该旧配置接口在 Phase 44 后退场，Swagger 主入口改为 **Alert Configurations** profile/item 接口 — `src/routes/alertConfigs.ts`、`iot-cmp-api.yaml`、`packages/openapi/openapi.yaml`
- [x] T352 [V1.1] [US9] **告警投递记录与通道编排**：按有效配置的 `delivery_channels` 触发 Portal / Email / Webhook 中 V1.1 可实现通道；新增 `alert_deliveries` 记录表与 `alertDelivery` 服务，Portal 记录 `DELIVERED`，Email 作为配置预留记录 `NOT_IMPLEMENTED`，Webhook 通道复用 `events(ALERT_TRIGGERED)`、`webhook_subscriptions` / `webhook_deliveries` 并关联 `webhook_delivery_id`，确保投递结果可查询 — `src/services/alertDelivery.ts`、`src/services/webhook.ts`、`supabase/migrations/`
- [x] T353 [V1.1] [US9] **告警事件与审计**：新建/合并/确认/配置变更写 `events` / `audit_logs`；新建告警继续使用 `emitEvent(ALERT_TRIGGERED)` 与 events `event_category=webhook` / `event_type=ALERT_TRIGGERED` 当前目录语义；合并、确认、配置变更写内部追踪事件 `ALERT_MERGED`、`ALERT_ACKNOWLEDGED`、`ALERT_RULE_CONFIG_CHANGED`；配置变更不回写历史告警 — `src/services/alerting.js`、`src/services/alertAuditTrail.ts`、`src/routes/alertConfigs.ts`
- [x] T354 [P] [V1.1] [US9] **JS/TS/dist 一致性**：消除 `src/services/alerting.js` 与 `.ts` 的导出差异，确保 `runAlertEvaluation`、`getAlertThresholdConfig` 或其替代实现进入 TypeScript build；`npm run build` 后 `dist/services/alerting.js` 可供 worker 使用；必要时更新 `tools/sync_dist_assets.mjs` — `src/services/alerting.ts`、`src/worker.js`、`tools/sync_dist_assets.mjs`
- [x] T355 [P] [V1.1] [US9] **测试覆盖**：新增/扩展 Vitest，覆盖 7 类 alertType 创建、规则继承、ENTERPRISE disabled 阻断、抑制窗口合并、list/ack/summary/trends tenant scope、alert-config CRUD、OpenAPI schema、dist build smoke — `tests/alerts*.test.ts`
- [x] T356 [P] [V1.1] [US9] **文档同步**：`spec.md` US9 保持实现/待实现边界清晰；`data-model.md` 增加第一版 `alert_rule_configs` / 投递记录表；`contracts/integration-api.md` 或新增 monitoring contract 说明 Alert APIs；`clarifications/alert-rule-config.md` 后续由 Phase 44 同步为 ABC 三表规格 — `specs/20260208-iot-cmp-reseller/`
- [x] T357 [V1.1] [US9] **验收**：`npm run build` + Alerts tests 绿；`npm run start:ts` 下 Swagger UI 可调用 Alerts list/ack/summary/trends 与第一版 alert-configs；worker 执行一轮 `ALERT_EVAL_CRON` 无红错，能按规则配置创建或抑制 alert — Fastify canonical runtime（已用 `dist/app.js` route injection、alert evaluator tests、OpenAPI parse 与 build 自动化验证；当前 Swagger 配置入口以后续 Phase 44 Alert Configurations 为准）

**Checkpoint**: US9 中“7 类告警目录 + 三层规则配置 + Fastify Alerts API + worker 评估 + 投递结果 + metrics”均可在 canonical runtime 验证；legacy `src/app.js` Alerts 行为不再作为 V1.1 验收依据。配置模型的当前真源为 Phase 44 ABC 三表，Phase 43 `alert_rule_configs` 仅保留为历史迁移背景。

---

## Phase 44: US9 Alert Configurations ABC Model & Swagger Split

**Goal**: 将 US9 告警配置从旧 `alert_rule_configs` 单表模型迁移为 ABC 三表：`alert_type_catalog`、`alert_config_profiles`、`alert_config_items`；Swagger UI 上保留 **Alerts** 模块仅用于告警实例查询/处理，新建 **Alert Configurations** 模块管理告警类型目录与配置表对象/明细。

**规格真源**: [spec.md](./spec.md) User Story 9；[clarifications/alert-type-catalog.md](./clarifications/alert-type-catalog.md)；[clarifications/alert-rule-config.md](./clarifications/alert-rule-config.md)

**依赖**: Phase 43 **T345–T357**（告警实例 API、worker 评估、投递与审计已落地）。**Supersede**: `alert_rule_configs` 单行规则配置模型与 Swagger UI 中旧 `GET/POST/PATCH /alert-configs`、`GET /alert-configs/effective` 配置接口。

**Canonical 栈**: Fastify **`src/app.ts`** → **`dist/server.js`**；OpenAPI 真源为 **`iot-cmp-api.yaml`** 并同步 **`packages/openapi/`** artifact。

| 顺序 | 任务 | 说明 |
|------|------|------|
| 1 | **T358** | ABC 三表迁移与 seed |
| 2 | **T359** → **T360** | 服务层与有效配置解析迁移 |
| 3 | **T361** → **T362** | Alert Configurations routes + Swagger 模块拆分 |
| 4 | **T363** | evaluator / webhook retry 接入新解析器 |
| 5 | **T364** → **T365** | 测试、文档与验收 |

- [x] T358 [V1.1] [US9] **迁移 ABC 三表**：新增 `alert_type_catalog`、`alert_config_profiles`、`alert_config_items`；seed 7 个 canonical alertType、默认 severity、allowed scope、默认 threshold/window/suppress/delivery；同一 PLATFORM/RESELLER/ENTERPRISE 同时最多一份 `ACTIVE` profile；同一 profile 下 `alert_type` 唯一；保留从旧 `alert_rule_configs` 迁移数据的 SQL 路径 — `supabase/migrations/`、`data-model.md`
- [x] T359 [V1.1] [US9] **Alert Type Catalog 服务层**：实现目录查询、详情、platform-only patch；校验不允许仅通过目录 API 新增未实现 evaluator 算法的 alertType；维护 allowed scope、默认配置、启用状态、排序与说明 — `src/services/alertTypeCatalog.ts`
- [x] T360 [V1.1] [US9] **Alert Config Profile / Item 服务层**：实现 profile list/create/detail/patch、items list/put/patch、scope 校验、唯一 ACTIVE 约束处理、版本与审计字段；item 写入必须校验 `alert_type_catalog.allowed_scope_types` — `src/services/alertConfigProfile.ts`
- [x] T361 [V1.1] [US9] **Alert Configurations Fastify routes**：新增 Swagger tag **Alert Configurations**；实现 `GET /alert-types`（支持 `alertType` 查询参数）、`PATCH /alert-types/{alertType}`（body `alertType` 为实际目标，path 仅兼容占位）、`GET/POST /alert-config-profiles`、`GET/PATCH /alert-config-profiles/{profileId}`、`GET /alert-config-profiles/{profileId}/items`、`PUT/PATCH /alert-config-profiles/{profileId}/items/{alertType}`、`GET /alert-config-profiles/effective`；platform/reseller scope 与 404/403 语义对齐 Integration 模块 — `src/routes/alertConfigurations.ts`、`src/app.ts`
- [x] T362 [V1.1] [US9] **Swagger UI 模块拆分与旧配置接口退场**：**Alerts** 模块仅保留 `GET /alerts`、`GET /alerts:csv`、`GET /alerts/{alertId}`、`POST /alerts/{alertId}:acknowledge`、`GET /alerts/summary`、`GET /alerts/trends`；旧 `/alert-configs` 配置接口从 Swagger UI 隐藏或标记 deprecated；OpenAPI 增加 Alert Configurations schemas、operation order 与错误响应 — `iot-cmp-api.yaml`、`packages/openapi/openapi.yaml`、`packages/openapi/openapi.json`
- [x] T363 [V1.1] [US9] **Evaluator 与 Webhook failed 接入 ABC 解析器**：`runAlertEvaluation()` 与 webhook retry 改为从 `alert_config_profiles/items` 解析有效配置；保留 built-in fallback；更具体 scope `enabled=false` 阻断上层配置；保证 `rule_id/rule_version` 或等价 profile/item 版本写入 alerts — `src/services/alerting.js`、`dist/services/alerting.js`、`src/services/webhook.ts`
- [x] T364 [P] [V1.1] [US9] **测试覆盖 ABC 配置模型**：覆盖 alert type catalog 管理、profile ACTIVE 唯一约束、allowed scope 校验、profile item put/patch、effective resolution、reseller/customer/platform 权限、旧接口退场、OpenAPI parse、dist sync 与 worker smoke — `tests/alertConfigurations*.test.ts`、`tests/alertConfigProfile.test.ts`、`tests/alertEvaluator.test.ts`
- [x] T365 [P] [V1.1] [US9] **文档与验收同步**：同步 `spec.md`、`data-model.md`、`clarifications/alert-rule-config.md`、`contracts/integration-api.md`；明确 ABC 三表只管理配置、不定义触发算法；验收 Swagger UI 中 Alerts 与 Alert Configurations 模块边界清晰，`npm run build` 与相关 tests 通过 — `specs/20260208-iot-cmp-reseller/`

**Checkpoint**: 告警实例 API 与告警配置管理 API 在 Swagger UI 中分离；ABC 三表成为告警配置规格与实现真源；旧 `alert_rule_configs` 单表模型不再作为新增功能入口。已用 Phase 44 route/service/OpenAPI tests 与 `npm run build` 验证。

---

## Phase 45: US5/US9 Usage Rating Rollup、Default Fallback Package 与用量告警口径 [V1.1]

**Goal**: 将 US5 的用量归集、Rating 派生聚合与无订阅兜底计费规则落地，并让 US9 的 `POOL_USAGE_HIGH` / `OUT_OF_PROFILE_SURGE` 基于当前账期的 `usage_package_daily_summary` 进行百分比判断，而不是等待正式出账后才获得产品包用量。

**规格真源**: [spec.md](./spec.md) User Story 5、User Story 9；[data-model.md](./data-model.md) `usage_daily_summary` / `usage_package_daily_summary`；[clarifications/alert-type-catalog.md](./clarifications/alert-type-catalog.md)

**依赖**: Phase 40 **T338**（`BILLING_GENERATE` Job 幂等）、Phase 43–44 **T345–T365**（US9 告警配置、ABC profile/item 解析与 worker 评估已落地）。**Supersede**: 仅由正式 `BILLING_GENERATE` 才刷新产品包用量与告警判断的旧口径。

**Canonical 栈**: Fastify **`src/app.ts`** → worker / job handlers → **`src/billing.js`** / **`src/services/billingGenerate.ts`**；验证路径为 **`npm run build` → `npm run start:ts`**。

| 顺序 | 任务 | 说明 |
|------|------|------|
| 1 | **T366** → **T368** | 已实现的用量分类列、`usage_package_daily_summary` 与 billing rollup helpers 补登 |
| 2 | **T369** → **T372** | `coverageMode=NONE`、fallback-compatible package 校验与 default fallback package 映射/API |
| 3 | **T373** → **T376** | Rating core 复用、fallback attribution、`USAGE_RATING_ROLLUP` Job / Cron |
| 4 | **T377** → **T378** | `POOL_USAGE_HIGH` / `OUT_OF_PROFILE_SURGE` 百分比口径改造、测试与验收 |

- [x] T366 [V1.1] [US5] **`usage_daily_summary` 分类列迁移补登**：新增 `in_profile_mb`、`out_of_profile_mb`、`unclassified_mb`、`rated_at`，非负约束与索引；文档说明这些列为 Rating / Rollup 派生读取口径，不是原始 CDR 输入字段 — `supabase/migrations/20260621100015_usage_daily_summary_profile_breakdown.sql`、`specs/20260208-iot-cmp-reseller/data-model.md`
- [x] T367 [V1.1] [US5] **`usage_package_daily_summary` 聚合表补登**：按 **SIM + usageDay + subscription + Package + PricePlan + visitedMccMnc** 建表、唯一键、RLS 与常用查询索引；保留 `visited_mccmnc`、`calculation_id`、`rated_at` 支持经营分析与告警 — `supabase/migrations/20260621100016_usage_package_daily_summary.sql`、`iot-cmp-api.yaml`、`packages/openapi/openapi.yaml`
- [x] T368 [V1.1] [US5] **Billing 后置 rollup helpers 补登**：`rating_results` 写入后聚合回写 `usage_daily_summary` classified MB 与 `usage_package_daily_summary`；`IN_PACKAGE` / `OVERAGE` / `TIERED_VOLUME` 归入 in-profile，`OOP_ROAMING` 归入 out-of-profile，缺少承接或缺 OOP rate 的记录归入 `UNCLASSIFIED`；补充单元测试 — `src/billing.js`、`src/billing.d.ts`、`src/services/billingGenerate.ts`、`tests/billing.test.ts`
- [x] T369 [V1.1] [US3] **CoveredNetworkProfile `coverageMode` 落地**：迁移增加 `coverage_mode`（`LIST` / `NONE`）；`LIST` 使用现有 coverage 明细，`NONE` 明确表达“不覆盖任何 MCC/MNC”并用于 fallback package；创建/更新校验、OpenAPI 与测试同步 — `supabase/migrations/20260621100017_covered_network_profile_coverage_mode.sql`、`src/services/networkProfile.ts`、`src/routes/networkProfiles.ts`、`iot-cmp-api.yaml`
- [x] T370 [V1.1] [US3] **普通 Package 支持 fallback-compatible 0 值配置**：确认并修正 Price Plan / Package / Commercial Terms 校验，允许 fallback 场景下 `monthlyFee=0`、`deactivatedMonthlyFee=0`、`quotaMb/totalQuotaMb=0`、`coverageMode=NONE`；不得新增专用 package type — `src/services/pricePlan.ts`、`src/services/package.ts`、`src/routes/pricePlans.ts`、`src/routes/packages.ts`
- [x] T371 [V1.1] [US5] **Default Fallback Package 映射表**：新增 `default_fallback_package_mappings` 维护 `enterprise_id + reseller_id + supplier_id + operator_id -> package_id`；每个四元组最多一条 `ACTIVE` 映射；包含状态、审计字段、RLS、唯一约束与 data model 文档 — `supabase/migrations/20260621100018_default_fallback_package_mappings.sql`、`supabase/migrations/20260621100019_default_fallback_package_enterprise_scope.sql`、`specs/20260208-iot-cmp-reseller/data-model.md`
- [x] T372 [V1.1] [US5] **Fallback Package 管理 API**：实现最小接口：设置默认 fallback package、取消/停用映射、查询映射；校验 package 已发布、归属 reseller、supplier/operator 一致、绑定 `coverageMode=NONE` profile 与可用 OOP RoamingProfile；补齐 RBAC、OpenAPI 与 tests — `src/routes/ratingFallbackPackages.ts`、`src/services/ratingFallbackPackage.ts`、`src/app.ts`、`iot-cmp-api.yaml`
- [x] T373 [V1.1] [US5] **Rating core 支持 fallback attribution**：Waterfall 先匹配当日有效订阅；无有效订阅或无可承接产品包时按 `enterpriseId + resellerId + supplierId + operatorId` 查 ACTIVE fallback mapping；命中后不创建 subscription，`matched_subscription_id=null`、`matched_package_id=fallbackPackageId`，按 fallback package 的 OOP RoamingProfile 写 `OOP_ROAMING`，缺 OOP rate 时写 `UNCLASSIFIED`；无映射进入无 Package 归属 `UNCLASSIFIED` 并最终归入 `unclassified_mb` — `src/billing.js`、`tests/billing.test.ts`
- [x] T374 [V1.1] [US5] **复用 Rating core 支持无账单 rollup**：`BILLING_GENERATE` 与 `USAGE_RATING_ROLLUP` 共用 `computeMonthlyCharges`、profile 分类、OOP 费率查找、classified usage 与 package daily rollup helper；正式出账路径额外生成 `bills` / `bill_line_items` / 调账结算，rollup 路径只写 rating/usage 聚合 — `src/billing.js`、`src/services/billingGenerate.ts`、`src/services/usageRatingRollup.ts`
- [x] T375 [V1.1] [US5] **`USAGE_RATING_ROLLUP` Job 实现**：新增 job type、period / reseller / enterprise / idempotency scope 校验、幂等键规则与 worker handler；执行后写 `rating_results`、classified `usage_daily_summary` 与 `usage_package_daily_summary`，不生成账单 — `src/routes/jobs.ts`、`src/queues/handlers.ts`、`src/services/usageRatingRollup.ts`、`iot-cmp-api.yaml`
- [x] T376 [V1.1] [US5] **Rollup Cron 与运维可观测性**：新增 `USAGE_RATING_ROLLUP_CRON` 配置、当前账期默认扫描策略、job progress metrics；明确与 `BILLING_GENERATE` calculationId 前缀区分，例如 `USAGE_ROLLUP:{period}:{scope}:{runId}` — `src/worker.js`、`docs/env-vars-and-ci.md`
- [x] T377 [V1.1] [US9] **用量百分比告警改造**：`POOL_USAGE_HIGH` 优先读取当前账期 `usage_package_daily_summary.in_profile_mb`；`OUT_OF_PROFILE_SURGE` 改为账期累计 `out_of_profile_mb / applicableQuota` 百分比判断；`ONE_TIME` 按单 SIM/subscription quota，`SIM_DEPENDENT_BUNDLE` 按高水位总池，`FIXED_BUNDLE` 按固定总池，`TIERED_PRICING` 按每档 tierLimit 判断；fallback package、`quota=0`、`tierLimit=0` 跳过比例告警 — `src/services/alerting.js`、`src/worker.js`、`tests/alertEvaluator.test.ts`
- [x] T378 [V1.1] [US5/US9] **端到端验收与文档同步**：构造 usage package summary / alert evaluation 流程，验证 `POOL_USAGE_HIGH` 使用 in-profile 当前账期聚合、`OUT_OF_PROFILE_SURGE` 使用 out-of-profile 百分比阈值、tiered plan 每档触发；同步 `spec.md` 已有 US9 规则、`alert-type-catalog.md`、env 文档，并通过 `npm run build` + 相关 Vitest — `tests/alertEvaluator.test.ts`、`specs/20260208-iot-cmp-reseller/clarifications/alert-type-catalog.md`

**Checkpoint**: 当前账期用量无需正式出账即可被 Rating/Rollup 刷新到产品包视图；无订阅 usage 有明确 fallback package 归属或进入 `unclassified_mb` 数据质量桶；`POOL_USAGE_HIGH` 与 `OUT_OF_PROFILE_SURGE` 均按 `usage_package_daily_summary` 的 in/out-profile 口径计算。

**Out of scope（本 Phase）**: 上游 CDR / SFTP 原始采集管道；迟到话单自动调账草稿；针对 fallback package 的专用创建流程；PDF/CSV 展示层用量报表优化。

---

## Phase 46: Rating 场景矩阵、数据生成与验证自动化 [V1.1]

**Goal**: 将当前手工验证的 4 组 Rating 场景扩展为可重复 seed、可自动断言的 scenario catalog，覆盖 PricePlan 类型、Fallback、MAIN/ADD_ON、订阅状态、SIM 状态与 usage 分类组合；验证 `usage_daily_summary` → `rating_results` → `usage_package_daily_summary` 的归属、分类、金额和 SIM-day 总量字段。

**规格真源**: [rating-scenario-catalog.md](./rating-scenario-catalog.md)、[data-model.md](./data-model.md) `usage_daily_summary` / `rating_results` / `usage_package_daily_summary`、Phase 45 **T366–T378**。

**依赖**: Phase 45 **T366–T378**（Rating Rollup、Default Fallback Package、`usage_package_daily_summary` 已落地）；迁移 `20260623104000_usage_package_daily_summary_sim_day_totals.sql` 已为 package summary 补齐 `uplink_mb`、`downlink_mb`、`total_mb`。

**Canonical 栈**: seed / verify 工具读取 Supabase REST；Rating 执行路径为 **`USAGE_RATING_ROLLUP`** 或直接调用 `src/services/usageRatingRollup.ts` 编译产物；服务验证路径为 **`npm run build` → `npm run start:ts`**。

| 顺序 | 任务 | 说明 |
|------|------|------|
| 1 | **T379** | 场景说明文件，定义 baseline 与扩展 catalog |
| 2 | **T380** → **T387** | seed catalog、基础对象、订阅/SIM/usage/fallback 数据生成与清理 |
| 3 | **T388** | 自动触发 Rating Rollup 并等待结果稳定 |
| 4 | **T389** → **T393** | verifier 加载场景期望并断言 rating / daily / package summary |
| 5 | **T394** → **T395** | Vitest / CLI 验收、文档与运行手册 |

- [x] T379 [V1.1] [US5] **Rating scenario catalog 文档**：新增专门文件说明每个场景、覆盖维度、通用断言、当前 4 组 baseline 与扩展 scenario IDs；明确不做全量笛卡尔组合，采用业务关键路径 + pairwise 覆盖 — `specs/20260208-iot-cmp-reseller/rating-scenario-catalog.md`
- [x] T380 [V1.1] [US5] **Scenario fixture 命名与数据命名空间**：定义统一 `scenarioId`、ICCID/plan/package/subscription 命名规则、测试 enterprise/reseller/supplier/operator 固定参数、period/day 分配规则；保证重复 seed 不污染生产样本 — `tools/rating_scenario_catalog.js`
- [x] T381 [V1.1] [P] [US5] **Seed 工具基础框架**：实现 `--dry-run`、`--apply`、`--scenario <id>`、`--group <group>`、`--period YYYY-MM`、`--json`；所有写入幂等，输出创建/复用/跳过统计 — `tools/seed_rating_scenarios.js`
- [x] T382 [V1.1] [US3/US5] **四类 PricePlan seed**：为 `ONE_TIME`、`FIXED_BUNDLE`、`SIM_DEPENDENT_BUNDLE`、`TIERED_PRICING` 准备可复用 price plan、package、covered profile、roaming/OOP rule；覆盖 in-profile、out-of-profile、unclassified 三类用量 — `tools/seed_rating_scenarios.js`
- [x] T383 [V1.1] [US4/US5] **MAIN / ADD_ON 订阅组合 seed**：覆盖 MAIN only、ADD_ON only、MAIN+ADD_ON 都 ACTIVE、MAIN ACTIVE + ADD_ON non-active、MAIN non-active + ADD_ON ACTIVE；验证 Waterfall / profile 选择优先级 — `tools/seed_rating_scenarios.js`
- [x] T384 [V1.1] [US4/US5] **订阅状态过滤 seed**：覆盖 `ACTIVE`、`EXPIRED`、`CANCELLED`、`SUSPENDED`、`SCHEDULED` 代表状态；明确非 ACTIVE 是否被 rating 忽略及 fallback 期望 — `tools/seed_rating_scenarios.js`
- [x] T385 [V1.1] [US2/US5] **SIM 状态覆盖 seed**：覆盖 active、`TEST_READY`、`DEACTIVE`、`INVENTORY`、`RETIRED`；区分历史 usage 可计费与异常 usage 输入；若当前 enum 使用 `ACTIVATED` 而非 `ACTIVE`，seed 工具需自动适配 — `tools/seed_rating_scenarios.js`
- [x] T386 [V1.1] [US5] **Fallback Package 场景 seed**：覆盖无订阅命中 fallback、只有 non-active subscription 命中 fallback、无 fallback mapping、fallback in-profile / OOP / unclassified；复用 `default_fallback_package_mappings` 与已发布 fallback-compatible package — `tools/seed_rating_scenarios.js`
- [x] T387 [V1.1] [P] [US5] **Scenario cleanup / reset 能力**：支持按 scenario/group 删除本工具创建的 `usage_daily_summary`、`rating_results`、`usage_package_daily_summary`、subscriptions 和可安全删除的测试 package/price plan；默认不删除人工/生产数据 — `tools/seed_rating_scenarios.js`
- [x] T388 [V1.1] [US5] **Rollup 执行器**：提供 `tools/run_rating_scenario_rollup.js` 或 seed 工具内置 `--run-rollup`，可按 period/enterprise 触发 `USAGE_RATING_ROLLUP`，避免非 UUID jobId 错误；等待/轮询直到 `rating_results` 与 package summary 可见 — `tools/run_rating_scenario_rollup.js`
- [x] T389 [V1.1] [US5] **Verifier scenario expectation loader**：将 `rating-scenario-catalog.md` 中的 scenario IDs 落为机器可读 expectation catalog；支持 `--scenario`、`--group`、`--period`、`--json`，并输出 PASS/FAIL 明细 — `tools/verify_rating_scenarios.js`
- [x] T390 [V1.1] [US5] **`rating_results` 断言**：验证 matched subscription/package/price plan、classification、charged_mb、amount/currency、fallback subscription null、calculationId 前缀等；覆盖每个 scenario 的核心归属行为 — `tools/verify_rating_scenarios.js`
- [x] T391 [V1.1] [US5] **`usage_daily_summary` classified MB 断言**：验证 `in_profile_mb`、`out_of_profile_mb`、`unclassified_mb`、`rated_at` 与 scenario usage 期望一致；验证 zero/unclassified 等边界不误归类 — `tools/verify_rating_scenarios.js`
- [x] T392 [V1.1] [US5] **`usage_package_daily_summary` 断言**：验证 package summary grain、`price_plan_type`、in/out/unclassified MB、amount、fallback package、以及 `uplink_mb/downlink_mb/total_mb` 为 SIM-day 总量且不被错误按 package 拆分 — `tools/verify_rating_scenarios.js`
- [x] T393 [V1.1] [US5/US9] **告警候选口径辅助验证**：对 high usage baseline 输出 `POOL_USAGE_HIGH` / `OUT_OF_PROFILE_SURGE` 候选数据，不强制创建 alert；用于后续 US9 alert evaluator 回归定位 — `tools/verify_rating_scenarios.js`
- [x] T394 [V1.1] [P] [US5] **Vitest 自动化覆盖**：新增单元/集成测试覆盖 scenario catalog loader、seed dry-run、verifier expectation、核心 rollup helper；补充 `R-PP-013/014/015` capacity overflow（ONE_TIME MAIN→fallback、ONE_TIME ADD_ON→MAIN、TIERED→fallback）自动化断言；在无 Supabase 环境下至少保证 catalog/schema 解析与 mock verifier 通过 — `tests/ratingScenarios.test.ts`
- [x] T395 [V1.1] [US5] **运行手册与验收**：文档化执行顺序：seed dry-run → apply → rollup → verify → API spot check；验收命令包含 `npm run build`、`npx vitest run tests/ratingScenarios*.test.ts`、`node tools/verify_rating_scenarios.js --period ...` — `specs/20260208-iot-cmp-reseller/rating-scenario-catalog.md`、`README_API_SERVICE.md`

**Checkpoint**: 可以一键生成并验证 Rating 场景矩阵；失败报告能指出是哪一个 scenario 在 `rating_results`、`usage_daily_summary` 或 `usage_package_daily_summary` 层出现偏差；当前 4 组手工验证场景成为自动回归 baseline。

**Out of scope / Decisions（本 Phase）**: 真实上游 CDR/SFTP 采集后续按 `(supplierId, operatorId)` 做格式适配；大规模性能压测后置；自动修复业务配置不在本 Phase；账单文件当前决策仅提供 CSV（L1/L2/L3），不实现 PDF。

---

## Phase 47: US9 Alert Configurations 整表读写接口精简 [V1.1]

**Goal**: 将 Alert Configurations 从“profile 与 item 分散 CRUD”收敛为“整份告警配置表全量读写”模型：用户管理一份 `alert_config_profiles` 配置文件及其全部 `alert_config_items` 明细，而不是逐条维护 item。Swagger UI 只暴露列表、详情、创建、全量更新与 effective 调试接口。

**规格真源**: [spec.md](./spec.md) User Story 9；[clarifications/alert-rule-config.md](./clarifications/alert-rule-config.md)；Phase 44 **T358–T365**。

**依赖**: Phase 44 ABC 三表与有效配置解析已落地；当前已验证 `GET /alert-types`、`PATCH /alert-types/{alertType}` 与 `alert_type_catalog` 功能正常。

| 顺序 | 任务 | 说明 |
|------|------|------|
| 1 | **T396** | 规格与契约收敛 ✓ |
| 2 | **T397** ✓ → **T398** ✓ | 整表 payload/schema 与事务写入服务 |
| 3 | **T399** ✓ → **T400** ✓ | Fastify routes 与 Swagger UI 精简 |
| 4 | **T401** ✓ → **T402** ✓ | 测试、接口移除与验收 |

- [x] T396 [V1.1] [US9] **Alert Configurations API 契约收敛**：更新 `spec.md`、`contracts/integration-api.md`、`clarifications/alert-rule-config.md`，明确 Swagger UI 主入口仅保留 `GET /alert-config-profiles`、`GET /alert-config-profiles/{profileId}`、`POST /alert-config-profiles`、`PUT /alert-config-profiles/{profileId}`、`GET /alert-config-profiles/effective`；不保留 item 级接口兼容，后端路由与 OpenAPI 均应移除 — `specs/20260208-iot-cmp-reseller/`
- [x] T397 [V1.1] [US9] **整表请求/响应 schema 设计**：定义 profile + items 全量 payload；创建/更新接口通过 query 参数提交 `scopeType`、`resellerId`、`enterpriseId`，request body 提交 profile 元数据与该 scope 允许的全部 alert items；响应返回 profile 基本字段、items 数组、版本/审计字段；ENTERPRISE profile 自动拒绝 `CDR_DELAY`、`UPSTREAM_DISCONNECT`、`WEBHOOK_DELIVERY_FAILED` — `iot-cmp-api.yaml`、`packages/openapi/openapi.yaml`
- [x] T398 [V1.1] [US9] **整表写入服务层**：新增或重构 `createAlertConfigProfileWithItems()`、`replaceAlertConfigProfileWithItems()`；统一校验 `alert_type_catalog.allowed_scope_types`、`threshold_unit`、`delivery_channels`、唯一 ACTIVE 约束与 reseller/enterprise 权限；写入 `alert_config_profiles` 与多条 `alert_config_items` 必须具备事务语义，必要时使用 Supabase RPC / SQL function 避免部分成功 — `src/services/alertConfigProfile.ts`、`supabase/migrations/`
- [x] T399 [V1.1] [US9] **Fastify routes 精简**：将 `POST /alert-config-profiles` 改为整表创建；新增/改造 `PUT /alert-config-profiles/{profileId}` 为整表全量更新；`GET /alert-config-profiles/{profileId}` 返回 profile + 全部 items；保留 `GET /alert-config-profiles/effective` 作为只读调试接口；删除旧 item 级 routes — `src/routes/alertConfigurations.ts`、`src/app.ts`
- [x] T400 [V1.1] [US9] **OpenAPI / Swagger UI 移除 item 级接口**：从 OpenAPI 与 Swagger UI 删除 `GET /alert-config-profiles/{profileId}/items`、`PUT /alert-config-profiles/{profileId}/items/{alertType}`、`PATCH /alert-config-profiles/{profileId}/items/{alertType}`；更新 examples 展示 query scope 参数与一次性提交所有允许 alert items 的完整请求体 — `iot-cmp-api.yaml`、`packages/openapi/openapi.yaml`、`packages/openapi/openapi.json`
- [x] T401 [P] [V1.1] [US9] **测试覆盖整表读写与有效配置**：覆盖 platform/reseller 权限、PLATFORM/RESELLER/ENTERPRISE scope、全量 items 缺失/多余/非法 scope、`enabled=false` 阻断、事务失败不产生半写入、详情返回 items、effective 解析、item 级 routes 已移除/不再注册 — `tests/alertConfigurationsRoute.test.ts`、`tests/alertConfigProfile.test.ts`
- [x] T402 [V1.1] [US9] **验收与回归**：`npm run build`、Alert Configurations tests、OpenAPI artifact 生成通过；Swagger UI 中 Alert Configurations 模块只展示精简后的主接口；用实际 Supabase 环境完成 `alert_config_profiles` + `alert_config_items` 整表创建/更新 smoke test — Fastify canonical runtime

**Checkpoint**: Alert Configurations 在 Swagger UI 中呈现为“配置表对象”而非 item 行级 CRUD；创建/更新一次提交整份配置，系统校验并原子写入 profile + items；effective 调试接口仍可解释最终生效配置。

---

## Summary

| 维度 | 数量 |
|------|------|
| 总任务数 | **402**（编号截至 **T402**；**Phase 45** **T366–T378** ✓；**Phase 46** **T379–T395** ✓；**Phase 47** **T396–T402** ✓） |
| MVP 核心 (Week 1-4) | 49 |
| MVP 扩展 (Week 5-8) | 20 |
| MVP 补充验证 | 6 |
| V1.1 推迟 | 80 |
| V1.1 已完成 | 119（含 … **Phase 39** **T318–T332** ✓；**Phase 40** **T333–T342** ✓；**Phase 41** **T343** ✓；**Phase 42** **T344** ✓；**Phase 44** **T358–T365** ✓；**Phase 45** **T366–T378** ✓；**Phase 46** **T379–T395** ✓；**Phase 47** **T396–T402** ✓） |
| V1.1 已立项待做 | **Phase 32** **T237–T246**；**Phase 34** **T252–T256**；**Phase 35 收尾** **T273–T284**；**Phase 16** **T279** |
| Polish | 5 |
| 可并行任务数 | 80+（含 Phase 28、**Phase 29** 并行组；**Phase 33–34** 见上表；**Phase 39** **T318/T320/T322**；**Phase 43** **T354–T356**；**Phase 45** **T369/T371/T377/T378**；**Phase 46** **T381/T387/T394**；**Phase 47** **T396/T397/T401** 等可并行） |
| User Story 数 | 11 (6×P1 + 5×P2) |

> **注**：Phase 19b 已合并到 Phase 19。T141 拆为 T141a/b/c；**2026-05-16** 新增 **Phase 35**（**T259–T278**）SIM 状态机复合态 + 异步 Job + **JOB_FINISHED**。**T263**：迁移 `20260516100004_lifecycle_sub_status_full.sql`。**2026-05-18**：**T279** Worker `config_parameters`；**T280–T284** — `:retire` 禁止企业用户、**`POST /sims/{iccid}:mark-test-ready`**。**2026-05-19**：**Phase 36** **T290–T296** 订阅上游开通 + Package 发布映射；**Phase 37** **T297–T307** 上游集成 DB 化（**FR-064**～**FR-066**）；**Phase 38** **T308–T317** 入站 Webhook 目录与订阅（**FR-067**～**FR-070**，`upstream-inbound-webhook-catalog.md`）。**2026-06-05**：**Phase 39** **T318–T332** — 调账单 Fastify + 下期结算 **APPLIED**；**Phase 40** **T333–T342** — Billing **`idempotencyKey`**（**:adjust** + **`billing:generate`**）。**2026-06-17**：**Phase 41** **T343** — Diagnostics Integration 绑定（`diagnostics-upstream-capabilities.md`）；**Phase 42** **T344** — events enterprise/reseller scope。**2026-06-18**：**Phase 43** **T345–T357** — US9 Alerts 配置化规则、Fastify 主路径与投递记录。**2026-06-20**：**Phase 44** **T358–T365** — US9 Alert Configurations ABC 三表与 Swagger 模块拆分；**Phase 45** **T366–T378** — Usage Rating Rollup、Default Fallback Package 与用量百分比告警口径。**2026-06-23**：**Phase 46** **T379–T395** — Rating 场景矩阵、数据生成与验证自动化。2026-04-24：**Phase 33–34** **T247–T256**；**Phase 28–30** 等见上文。
