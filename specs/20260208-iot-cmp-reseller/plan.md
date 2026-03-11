---
description: "Implementation plan for IoT CMP Reseller System"
scripts:
  node: node .ttadk/plugins/ttadk/core/resources/scripts/update-agent-context.js __AGENT__
---

# Implementation Plan: IoT CMP Reseller System

**Feature**: `iot-cmp-reseller` | **Date**: 2026-02-08 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/20260208-iot-cmp-reseller/spec.md`
**Last Updated**: 2026-03-11 (专家工程评审后修正)

## Summary

IoT CMP Reseller System 是一个面向代理商运营与企业自助的物联网连接管理平台。系统实现"供应商 → 代理商 → 企业"三级租户层级，集成上游供应商 CMP，提供 SIM 全生命周期管理、4 种资费计划类型（One-time / SIM Dependent Bundle / Fixed Bundle / Tiered Volume Pricing）、高水位月租费计算、Waterfall Logic 用量匹配、自动出账与信控催收等核心计费能力；企业状态仅由代理商管理员手工控制，Dunning 不自动变更企业状态。状态规范化采用 Reseller: ACTIVE/DEACTIVATED/SUSPENDED，Supplier: ACTIVE/SUSPENDED，并记录上游 SIM 状态与映射规则。

**技术方案**：基于现有 Supabase（PostgreSQL）+ Vercel Serverless 架构演进。现有代码库已包含 64 个 API 端点、9 个域级数据库迁移文件（V001-V009）、完整的计费引擎和供应商适配器（wxzhonggeng）。

**架构评审修正要点（D-31）**：

1. **租户模型统一**：tenants 表保留为统一 ID 层（所有 FK 指向 tenants.tenant_id），独立 resellers/customers 表通过 `tenant_id UNIQUE FK` 桥接。创建操作通过 PostgreSQL 事务性函数（`create_reseller`/`create_customer`）保证原子性。`sync_customer_status_to_tenant()` 触发器自动同步 customer_status → enterprise_status。
2. **多租户隔离双层策略**：应用层（`rbac.ts` 的 `buildTenantFilterAsync()`）为主要隔离机制；数据库层 RLS（V009）为 defense-in-depth。Service role 绕过 RLS 是正确行为。
3. **计费引擎重构**：消除 N+1 查询（per-SIM 3 次 → 批量 `sim_id=in.()` 并行查询），pool 用量按 sim_id 排序保证确定性，新增幂等检查。
4. **精度统一**：所有金额计算使用 `roundAmount()`（ROUND_HALF_UP, precision=2），禁止 `.toFixed(2)`。
5. **MVP 范围拆分**：Week 1-4 核心（SIM+Fixed Bundle+手动出账），Week 5-8 扩展（RBAC+One-time+自动出账+批量导入）。

## Technical Context

**Language/Version**: TypeScript (Node.js LTS) — 渐进迁移，.js 为当前运行版本，.ts 为类型增强目标
**Primary Dependencies**: Fastify, dotenv, swagger-ui-dist, @supabase/supabase-js
**Storage**: Supabase (PostgreSQL 15+) — 30+ 表，9 个域级迁移文件（V001-V009），21+ 个 ENUM 类型
**Testing**: Vitest 单元测试 + API smoke tests + E2E demos + Golden Case validation
**Target Platform**: Vercel (Serverless Functions) + Supabase Cloud
**Project Type**: web (API backend，MVP 阶段不含前端 Portal)
**Performance Goals**: 10 万 SIM, 500 万 CDR/日, 峰值 1000 TPS, P95 < 300ms
**Constraints**: 可用性 99.9%, RPO < 5 min, RTO < 30 min, MVP 8 周
**Scale/Scope**: 首期 10 万 SIM → 未来 100 万; 64 个已有 API 端点

**当前适用技术栈清单**：
- 语言与运行时：Node.js + TypeScript（渐进迁移，.js 和 .ts 共存）
- Web/API 框架：Express（当前 app.js）/ Fastify（目标 app.ts），MVP 阶段以 .js 运行
- 定时与任务：Vercel Cron + Queue（Job Handler 分批处理，单次 ≤10s）
- 数据库与数据访问：Supabase REST（service_role 绕过 RLS）+ PostgreSQL 函数（事务性操作）
- 多租户隔离：应用层 `buildTenantFilterAsync()` 为主 + RLS defense-in-depth
- 计费精度：`roundAmount()` (ROUND_HALF_UP, precision=2)，禁止 `.toFixed(2)`
- OpenAPI：swagger-ui-dist + iot-cmp-api.yaml
- 部署平台：Vercel Serverless + Supabase Cloud
- 测试：Vitest 单元测试、API 烟测与 E2E 脚本

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

已存在 `.specify/memory/constitution.md` — 逐项验证：

| 章程原则 | 状态 | 验证说明 |
|----------|------|---------|
| I. 权威数据源与一致性 | PASS | SIM 状态以本地 sims 表为权威，上游同步通过 reconciliation_runs 对账；计费以 rating_results 为权威 |
| II. 租户隔离与最小权限 | PASS (D-31修正) | V008 触发器 + V009 RLS + rbac.ts `buildTenantFilterAsync()` 三层保障；原 RLS `using(true)` 已修复 |
| III. 状态机与生命周期不可违背 | PASS | simLifecycle.ts 实现 5 状态机，allowedFrom Set 校验；eSIM 操作返回 501 |
| IV. 审计与可追溯性 | PASS | audit_logs 表 + events 表覆盖关键操作；rating_results 含 calculation_id 追溯链 |
| V. 上游集成可靠性与幂等 | PASS | supabaseRest.js 含重试+熔断器；SIM 导入幂等 (batchId/fileHash)；计费幂等 (enterprise+period UNIQUE) |

## Project Structure

### Documentation (this feature)

```
specs/20260208-iot-cmp-reseller/
├── plan.md              # 本文件（实施计划）
├── research.md          # Phase 0: 技术研究与差距分析
├── data-model.md        # Phase 1: 数据模型设计
├── quickstart.md        # Phase 1: 开发快速上手指南
├── technical-design.md  # 技术设计文档
├── waterfall-algorithm.md # Waterfall 算法文档
├── security-debt.md     # 安全债务记录
├── frontend-portal-blueprint.md # [V1.1] 前端 Portal 蓝图
├── contracts/           # Phase 1: API 契约定义
│   ├── tenant-api.md    # 租户与权限 API 契约
│   ├── sim-api.md       # SIM 生命周期 API 契约
│   ├── pricing-api.md   # 产品包与资费 API 契约
│   ├── billing-api.md   # 计费与出账 API 契约
│   └── integration-api.md # 集成与事件 API 契约
├── checklists/          # 质量检查清单
│   └── requirements.md  # 需求完整性检查
└── tasks.md             # Phase 2: 实施任务（由 /adk:tasks 生成）
```

### Source Code (repository root)

```
src/
├── app.js               # Express 主应用（当前运行版本，13180 行）
├── app.ts               # Fastify 主应用（迁移目标，5265 行）
├── server.js            # HTTP 服务器入口
├── billing.js           # 计费引擎（批量查询 + 幂等 + roundAmount 导出）
├── billing.d.ts         # 计费引擎类型声明
├── worker.js            # 异步任务处理器（4 个 cron job）
├── supabaseRest.js      # Supabase REST 客户端（重试 + 熔断器）
├── middleware/
│   └── rbac.ts          # RBAC 鉴权 + 租户隔离过滤器
├── services/            # 业务逻辑层（.js + .ts 双栈）
│   ├── simLifecycle.ts  # SIM 状态机
│   ├── subscription.ts  # 订阅管理
│   ├── dunning.ts       # 信控催收（使用 roundAmount）
│   ├── package.ts       # 产品包管理
│   ├── pricePlan.ts     # 资费计划管理
│   ├── billingGenerate.ts # 出账生成
│   ├── reconciliation.ts # 对账
│   └── ...
├── routes/              # 路由层（.js + .ts 双栈）
└── vendors/
    └── wxzhonggeng.ts   # 微众耕供应商适配器

supabase/
└── migrations/          # 9 个域级迁移文件（从 50 个合并）
    ├── 20260311100001_core_schema.sql          # V001: 核心表结构 + ENUMs
    ├── 20260311100002_billing_golden_tests.sql # V002: 计费黄金测试用例
    ├── 20260311100003_tenant_reseller.sql      # V003: resellers/customers 独立表
    ├── 20260311100004_sim_connectivity.sql     # V004: 网络 profile + operators
    ├── 20260311100005_billing_integration.sql  # V005: dunning/alerts/webhooks/billing config
    ├── 20260311100006_package_modules.sql      # V006: 产品包模块表
    ├── 20260311100007_rls_policies.sql         # V007: RLS 基础策略
    ├── 20260311100008_tenant_model_unification.sql # V008: 租户模型统一（触发器+函数+视图）
    └── 20260311100009_rls_tenant_isolation.sql # V009: RLS 租户隔离策略

tools/                   # 测试/工具脚本
├── api_smoke_test.js    # API 烟测
├── e2e_demo.js          # 端到端演示
├── e2e_demo_wx.js       # 微众耕 E2E 演示
├── test_billing_e2e.js  # 计费 E2E 测试
└── import_wx_sims.js    # SIM 导入工具

gen/ts-fetch/            # 生成的 TypeScript Fetch 客户端
fixtures/                # 测试数据（golden cases, vendor product IDs）
iot-cmp-api.yaml         # OpenAPI 3.0.3 规范
golden_cases.json        # 机器可读计费黄金用例
```

**Structure Decision**: 采用现有的单体应用结构（Single project），所有源代码在 `src/` 下。当前 .js 和 .ts 共存（渐进迁移），`server.js → app.js` 为实际运行路径。MVP 阶段保持单体架构以降低复杂性，商用阶段按 DDD 域拆分为微服务。

## Architecture Decisions (D-31 修正)

| 编号 | 决策 | 理由 | 替代方案及淘汰原因 |
|------|------|------|-------------------|
| AD-1 | 保留 tenants 表为统一 ID 层，通过触发器同步 | 所有 FK 已指向 tenants.tenant_id，改为直接 FK 到 resellers/customers 代价过大 | 方案 A（删除 tenants 表）：需迁移所有 FK，风险太高 |
| AD-2 | 应用层租户过滤为主，RLS 为辅 | service_role 绕过 RLS，应用层 `buildTenantFilterAsync()` 是唯一可靠隔离点 | 纯 RLS 方案：service_role 无法受 RLS 约束 |
| AD-3 | 计费引擎批量查询 + sim_id 排序 | 消除 N+1（10万 SIM = 30万次 HTTP），排序保证 pool 用量确定性 | per-SIM 查询：Vercel 超时不可接受 |
| AD-4 | roundAmount() 统一精度 | ROUND_HALF_UP + BILLING_PRECISION=2 全局一致 | .toFixed(2)：行为不一致（银行家舍入问题） |
| AD-5 | MVP 拆分为核心 4 周 + 扩展 4 周 | 原 8 周范围实际需 12 周，拆分后核心链路 4 周可验证 | 不拆分：无法按时交付 |
| AD-6 | 前端 Portal 推迟到 V1.1 | MVP 用 Swagger UI + Postman 验证 API；如需操作界面用 Retool | 含前端 MVP：工期不可控 |

## Complexity Tracking

| 关注点 | 当前状态 | 风险等级 | 缓解措施 |
|--------|---------|---------|---------|
| .js/.ts 双栈共存 | 稳定运行，类型检查部分通过 | 中 | MVP 不做迁移，只保证新增代码用 TS |
| 计费引擎复杂度 | 749 行 JS，4 种资费类型 | 高 | Golden Case 回归 + roundAmount 统一 |
| 多租户隔离完整性 | 应用层+RLS 双层 | 中 | 每个路由必须调用 buildTenantFilterAsync |
| Vercel Serverless 超时 | 10s (Free) / 300s (Pro) | 高 | 批量操作走 Queue，计费分批处理 |
| 租户模型一致性 | 触发器+事务函数保障 | 低 | V008 迁移已验证 |
