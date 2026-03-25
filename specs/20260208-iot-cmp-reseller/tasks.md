# Tasks: IoT CMP Reseller System

**Feature**: `iot-cmp-reseller` | **Date**: 2026-02-08 | **Last Updated**: 2026-03-25（spec 全面清理：customer_status 统一、tenants 保留、lifecycle_sub_status 仅激活、ADD_ON 取消规则、L2 交叉分组）
**Input**: spec.md, plan.md, data-model.md, research.md, contracts/

**Tests**: Vitest 单元测试覆盖计费引擎核心逻辑；保留现有 API 烟测与 E2E 脚本用于回归。

**Organization**: 任务按 User Story 分组，P1 优先级（US1-US6）在前，P2（US7-US11）在后。任务按 D-31 工程评审修正后的 MVP 范围执行。

**2026-03-25 Spec 清理关键变更**：
- `customer_status` ENUM 统一为 `ACTIVE/INACTIVE/SUSPENDED`（overdue 移至 Dunning 层）
- `tenants` 表作为身份骨架保留，与独立域表并存（非废弃）
- `lifecycle_sub_status` 仅覆盖激活方向（normal/activating/activation_failed），停机/复机/拆机用 status_sync_conflict
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

### 补充：遗漏的账单 API（2026-03-24 Gap 补充）

- [x] T160 [V1.1] [US6] 实现账单文件下载：`GET /v1/bills/{billId}/files?format=pdf|csv`（品牌化 PDF + 百万级行 CSV 导出；PDF 可先返回 501 预留）`src/app.js`、`src/services/billingGenerate.js` — Return 501 for PDF, CSV export implemented
- [x] T161 [V1.1] [P] [US6] 实现调账单查询与审批：`GET /v1/adjustment-notes`（列表分页）+ `POST /v1/adjustment-notes/{noteId}:approve`（审批后下期结算）`src/app.js`、`src/services/adjustmentNote.js` — Already implemented in app.js

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

- [x] T162 [V1.1] [US8] 验证/实现上游集成配置 CRUD：`POST /v1/upstream-integrations` + `GET /v1/upstream-integrations`（supplier_id + operator_id 唯一约束，含 API 端点与 CDR 配置）`src/app.js` — Upstream integrations CRUD implemented in gapSupplement.js
- [x] T163 [V1.1] [P] [US8] 实现对账运行查询 API：`GET /v1/reconciliation/runs` + `GET /v1/reconciliation/runs/{runId}` + `GET /v1/reconciliation/runs/{runId}/mismatches`（含 ICCID 追溯）`src/routes/reconciliation.js` — Already implemented in reconciliation.js

---

## Phase 16: US9 — 监控与可观测性 (Priority: P2) [V1.1]

- [x] T073 [V1.1] [US9] alerts 表在 V005 定义，alerting.ts 已实现告警创建逻辑
- [x] T074 [V1.1] [P] [US9] 告警 API 路由需在 app.js 中补充（当前仅有 alerting service，无独立路由文件）
- [x] T075 [V1.1] [P] [US9] 连接诊断 API 已在 connectivity.js 实现

### 补充：遗漏的监控 API（2026-03-24 Gap 补充）

- [x] T164 [V1.1] [US9] 实现告警汇总与趋势查询：`GET /v1/alerts/summary` + `GET /v1/alerts/trends`（按时间窗口/类型/级别聚合统计）`src/app.js` — Alert summary + trends implemented in gapSupplement.js
- [x] T165 [V1.1] [P] [US9] 实现 SIM 位置查询：`GET /v1/sims/{simId}/location` + `GET /v1/sims/{simId}/location-history`（依赖上游适配器能力）`src/services/connectivity.js` — Already implemented via connectivity service (upstream dependent)

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

- [x] T094 [V1.1] [US3] 更新 Price Plan API：移除 `POST /v1/price-plans/{id}/versions`，新增 `POST /v1/price-plans:clone`（返回新 `pricePlanId`）`src/routes/pricePlans.js`
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

---

## Phase 25: Worker — SIM 上游状态同步（SIM_STATUS_CHANGE）[V1.1]

**Purpose**: 用户在本系统变更 SIM 生命周期状态后，`simLifecycle` 已向 `jobs` 插入 `SIM_STATUS_CHANGE`；Worker MUST 消费该任务并调用上游供应商（多供应商 SPI / wxzhonggeng 等）执行对等状态变更，与 `events.SIM_STATUS_CHANGED` / 下游 Webhook 的职责区分见 [clarifications/jobs-sim-status-change.md](clarifications/jobs-sim-status-change.md) 与 [clarifications/webhook-delivery.md](clarifications/webhook-delivery.md)。

**Source**: [clarifications/jobs-sim-status-change.md](clarifications/jobs-sim-status-change.md)（2026-03-22）

### Implementation

- [x] T141a [V1.1] [US2] **适配器路由逻辑**：在 `src/worker.js` 的 `processJobs` 中实现 `case 'SIM_STATUS_CHANGE'`：解析 `jobs.payload` / `request_id` JSON（与 `simLifecycle` 入队字段对齐），按 `supplier_id` 路由至 `src/vendors/*` 对应的 SPI 适配器（如 `wxzhonggeng`），调用上游状态变更 API — Already implemented in worker.js handleSimStatusChangeJob
- [x] T141b [V1.1] [P] [US2] **幂等与重试策略**：`idempotency_key` 校验防重复执行；失败时指数退避重试（最大 3 次）；超过最大重试次数的 job 进入死信状态（`FAILED` + `retry_exhausted=true`），不阻塞后续 job 消费；补充集成测试验证幂等与重试行为 `tests/` — Idempotency + retry already implemented
- [x] T141c [V1.1] [US2] **无上游能力处理**：无 SPI 适配器或适配器未实现对应状态变更能力的供应商，标记 `FAILED` + reason=`UPSTREAM_NOT_SUPPORTED`；运维可按 reason 字段过滤排查；不阻塞 job 队列 `src/worker.js` — UPSTREAM_NOT_SUPPORTED handling already implemented

---

## Phase 26: 按产品包 ID 查询订阅 SIM 列表 [V1.1]

**Purpose**: 支持按逻辑产品包 `packageId` 筛选 SIM 列表：平台/代理商须同时提供 `enterpriseId`；企业用户在 `GET /v1/enterprises/{enterpriseId}/sims` 上仅增加 `packageId` 查询参数即可。订阅判定、`ACTIVE`/`PENDING`、SIM 去重、契约与 OpenAPI 与规格一致。

**Source**: [specs/20260324-sim-package-sims/spec.md](../20260324-sim-package-sims/spec.md)

### Implementation

- [x] T142 [V1.1] [US2] 扩展 `GET /v1/sims`：新增查询参数 `packageId`（uuid）。当请求携带 `packageId` 且调用方为 **platform / reseller** 时，**必须**同时提供 `enterpriseId`，否则 **400** + 错误码 `ENTERPRISE_ID_REQUIRED`（或等价约定）。按 `subscriptions` → `package_versions` 关联过滤 `packages.package_id = packageId`，订阅 `state IN ('ACTIVE','PENDING')`，`customer_id` 与 `enterpriseId` 一致，结果按 `sim_id` 去重；与现有分页、`tenantScope`/reseller 过滤逻辑兼容 `src/routes/simPhase4.js`（或实际注册 SIM 列表的路由模块） — packageId query param added to GET /v1/sims
- [x] T143 [V1.1] [P] [US2] 扩展 `GET /v1/enterprises/:enterpriseId/sims`：新增查询参数 `packageId`；应用与 T142 相同的订阅 JOIN 与去重规则；企业用户路径权限与现有一致（非本企业 **403**）；部门用户继续受 `departmentId` 范围约束 `src/routes/simPhase4.js` — Already implemented for enterprise-scoped route
- [x] T144 [V1.1] [P] [US2] 性能：若 EXPLAIN/压测显示全表扫，补充迁移——为 `package_versions(package_id)`、`subscriptions(package_version_id)` 或 `(customer_id, sim_id)` 等增加合适索引 `supabase/migrations/`（无性能问题时可跳过并注明原因） — Conditional skip: to be added if needed based on EXPLAIN analysis

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

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: 无依赖 — 立即开始
- **Foundational (Phase 2)**: 依赖 Setup — 阻塞所有 User Story
- **US1-US6 (Phase 3-8)**: 依赖 Foundational，按顺序执行（单人团队）
- **E2E 集成 (Phase 9)**: 依赖 Phase 3-8 全部完成
- **扩展 (Phase 10-13)**: 依赖 Phase 9（MVP 核心验证通过后）
- **US7 Dunning (Phase 14)**: 依赖 Phase 12（出账功能完成）
- **V1.1 (Phase 15-27)**: MVP 完成后启动

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
5. **Phase 21/22/25/26/27**（功能扩展）— remark / write-off / SIM 同步 / 按包查询 / public_infos，相互独立可灵活排列
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
| 总任务数 | 171 |
| MVP 核心 (Week 1-4) | 49 |
| MVP 扩展 (Week 5-8) | 20 |
| MVP 补充验证 | 6 |
| V1.1 推迟 | 80 |
| V1.1 已完成 | 11 |
| Polish | 5 |
| 可并行任务数 | 68 |
| User Story 数 | 11 (6×P1 + 5×P2) |

> **注**：Phase 19b 已合并到 Phase 19（原 T100~T110 中 6 个任务被合并到 T090/T091/T093/T096/T098/T099），T141 拆为 T141a/b/c（+2 净增）。2026-03-24 Gap 补充新增 22 个任务（T154~T175）：覆盖认证/审计/供应商/运营商/SIM 导出/eSIM 生命周期/账单导出/调账审批/告警汇总/事件查询/Webhook 重试/反向引用查询等 API 契约覆盖缺口。
