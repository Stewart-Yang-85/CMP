---
description: "Implementation plan for IoT CMP Reseller System"
scripts:
  node: node .ttadk/plugins/ttadk/core/resources/scripts/update-agent-context.js __AGENT__
---

# Implementation Plan: IoT CMP Reseller System

**Feature**: `iot-cmp-reseller` | **Date**: 2026-02-08 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/20260208-iot-cmp-reseller/spec.md`

## Summary

IoT CMP Reseller System 是一个面向代理商运营与企业自助的物联网连接管理平台。系统实现"供应商 → 代理商 → 企业"三级租户层级，集成上游供应商 CMP，提供 SIM 全生命周期管理、4 种资费计划类型（One-time / SIM Dependent Bundle / Fixed Bundle / Tiered Volume Pricing）、高水位月租费计算、Waterfall Logic 用量匹配、自动出账与信控催收等核心计费能力；企业状态仅由代理商管理员手工控制，Dunning 不自动变更企业状态。状态规范化采用 Reseller: ACTIVE/DEACTIVATED/SUSPENDED，Supplier: ACTIVE/SUSPENDED，并记录上游 SIM 状态与映射规则。

**技术方案**：基于现有 Supabase（PostgreSQL）+ Vercel Serverless 架构演进。现有代码库已包含 64 个 API 端点、18 个数据库迁移文件、完整的计费引擎和供应商适配器（wxzhonggeng）。本次规划聚焦于：将通用租户表拆分为独立实体表（resellers/customers/operators/suppliers）、实现三表 RBAC 权限模型、SIM 卡表重构（sim_cards 四方归属链 + 多 IMSI + IMEI Lock）、增强计费引擎（Waterfall Logic / 分段累进）、实现出账与信控流程、构建多供应商虚拟化层，并在 Web/API 与任务调度层采用 TypeScript + Fastify + Vercel Cron/Queue 的实现路径。

**需求澄清影响**：监控告警模块需支持告警级别与通知对象独立配置、Webhook 企业级开关与事件过滤、邮件与 Portal 站内消息并行推送，以及可配置事件模板（变量化消息渲染）。这些能力将落在告警规则配置、推送路由与消息模板三个层面，并要求与配置中心参数及审计轨迹联动。补充落地项包括 APN/Roaming Profile 的建模与变更回滚、控制策略触发口径与执行优先级、One-time 到期算法与时区口径、用量清洗规则、出账 T+N 配置粒度、欠费阈值与滞纳金计算、MVP 监控栈约束、GDPR 被遗忘权与永久保留的脱敏策略。

## Technical Context

**Language/Version**: TypeScript (Node.js LTS)
**Primary Dependencies**: Fastify, dotenv, swagger-ui-dist, @supabase/supabase-js
**Storage**: Supabase (PostgreSQL 15+) — 30+ 表，18 + 17 个迁移文件，21 个 ENUM 类型
**Testing**: API smoke tests (tools/api_smoke_test.js), E2E demos, Golden Case validation, billing E2E
**Target Platform**: Vercel (Serverless Functions) + Supabase Cloud
**Project Type**: web (API backend + lightweight admin frontend)
**Performance Goals**: 10 万 SIM, 500 万 CDR/日, 峰值 1000 TPS, P95 < 300ms
**Constraints**: 可用性 99.9%, RPO < 5 min, RTO < 30 min, MVP 8 周
**Scale/Scope**: 首期 10 万 SIM → 未来 100 万; 64 个已有 API 端点

**当前适用技术栈清单**：
- 语言与运行时：Node.js + TypeScript
- Web/API 框架：Fastify
- 定时与任务：Vercel Cron + Queue
- 数据库与数据访问：Supabase（PostgreSQL）
- OpenAPI：swagger-ui-dist + iot-cmp-api.yaml
- 部署平台：Vercel Serverless + Supabase Cloud
- 测试：API 烟测与 E2E 脚本

**技术栈调整评估**：
- Node.js → TypeScript：适合。类型安全提升复杂计费/告警逻辑可维护性，建议分阶段迁移（核心领域与公共工具优先）。
- Express → Fastify：适合。吞吐与插件生态更优，但需重构中间件与路由；建议先以新模块或边界服务落地。
- node-cron → Vercel Cron + Queue：适合。便于托管与弹性，但需要任务幂等、补偿与队列可见性设计；批处理与长耗时任务需落入队列。
- 测试补充：适合。单测覆盖纯函数与计费算法；供应商 API 采用 Mock 保障控制策略回归；数据库快照测试用于对账与计费一致性。

**调整后技术栈**：
- 语言与运行时：Node.js + TypeScript
- Web/API 框架：Fastify
- 定时与任务：Vercel Cron + Queue
- 数据库与数据访问：Supabase（PostgreSQL）
- OpenAPI：swagger-ui-dist + iot-cmp-api.yaml
- 部署平台：Vercel Serverless + Supabase Cloud
- 测试：Jest/Vitest 单元测试、供应商 API Mock、数据库快照测试、API 烟测与 E2E

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

已存在 `.specify/memory/constitution.md` — 本项目按该文件与 spec.md 中定义的技术栈约束和非功能需求执行。

## Project Structure

### Documentation (this feature)

```
specs/20260208-iot-cmp-reseller/
├── plan.md              # 本文件（实施计划）
├── research.md          # Phase 0: 技术研究与差距分析
├── data-model.md        # Phase 1: 数据模型设计
├── quickstart.md        # Phase 1: 开发快速上手指南
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
├── app.ts               # Fastify 主应用（64 个端点，持续扩展）
├── server.ts            # HTTP 服务器入口
├── queues/
│   └── handlers.ts      # 异步任务处理器与队列消费
├── cron/                # Vercel Cron 触发入口
├── billing.ts           # 计费引擎
├── supabaseRest.ts      # Supabase REST 客户端（重试 + 熔断器）
├── jwt.ts               # JWT 签发与验证
├── password.ts          # 密码哈希（scrypt）
└── vendors/
    ├── wxzhonggeng.ts   # 微众耕 供应商适配器
    ├── wxzhonggeng_config.json
    └── wxzhonggeng_schema.json

supabase/
└── migrations/          # 18 个已有 + 17 个新增 PostgreSQL 迁移文件
    ├── 0001_cmp_schema.sql       # 核心表结构（旧schema，含 tenants/carriers/sims 等）
    ├── 0002_rating_results_golden_seed.sql
    ├── 0003_api_helpers.sql
    ├── 0004_rls_policies.sql     # RLS 行级安全策略
    ├── 0005_golden_summary.sql
    ├── 0006_assert_golden.sql
    ├── 0007_golden_bill_seed.sql
    ├── 0008_bills_rls.sql
    ├── 0009_assert_golden_bills.sql
    ├── 0010_bills_api.sql
    ├── 0011_assert_bills_api.sql
    ├── 0012_bills_mutations.sql
    ├── 0013_adjustment_notes_api.sql
    ├── 0014_share_links.sql
    ├── 0015_share_links_kind_bills.sql
    ├── 0016_jobs_payload.sql
    ├── 0017_add_usage_daily_summary_updated_at.sql
    └── 0018_add_sims_upstream_fields.sql

tools/                   # 23 个测试/工具脚本
├── api_smoke_test.js    # API 烟测（82 KB）
├── e2e_demo.js          # 端到端演示
├── e2e_demo_wx.js       # 微众耕 E2E 演示
├── test_billing_e2e.js  # 计费 E2E 测试
├── import_wx_sims.js    # SIM 导入工具
└── ...

gen/ts-fetch/            # 生成的 TypeScript Fetch 客户端
fixtures/                # 测试数据（golden cases, vendor product IDs）
iot-cmp-api.yaml         # OpenAPI 3.0.3 规范（64 端点）
golden_cases.json        # 机器可读计费黄金用例
CMP_Database_Schema.sql  # 独立数据库 Schema 文件
```

**Structure Decision**: 采用现有的单体应用结构（Single project），所有源代码在 `src/` 下。以 TypeScript + Fastify 为基础进行演进，而非从零构建新服务。MVP 阶段保持单体架构以降低复杂性，商用阶段按 DDD 域拆分为微服务。

## Complexity Tracking

*无 Constitution 违规项 — 本节不适用。*
