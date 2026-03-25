---
description: "IoT CMP Reseller 系统实施计划 — 从 Express 单体到完整多租户 IoT 连接管理平台"
---

# Implementation Plan: IoT CMP Reseller System

**Feature**: `iot-cmp-reseller` | **Date**: 2026-03-25 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/20260208-iot-cmp-reseller/spec.md`

## Summary

构建面向代理商-企业的 IoT 连接管理平台（CMP），核心能力包括：

1. **多租户组织管理**：供应商→代理商→企业→部门四级层级 + RBAC 七角色权限模型
2. **SIM/eSIM 全生命周期**：5 状态机 + 批量导入 + 上游双向同步 + IMEI 锁定
3. **产品包与资费引擎**：4 种 Price Plan 类型 + 不可变快照机制 + Zone-based PAYG
4. **计费与出账**：高水位月租 + Waterfall 用量匹配 + 三级账单（L2 按 department×package 交叉分组） + 调账
5. **信控与催收**：Dunning 等级管理 + 手工管控决策（overdue 概念仅在 Dunning 层管理，不作为企业状态）
6. **多供应商虚拟化**：SPI 适配器 + 能力协商 + 对账
7. **监控与可观测性**：统一告警引擎 + Webhook 投递 + 事件目录

**技术路线**：基于现有 Express + TypeScript 单体应用（64 个 API 端点、30+ 数据库表、12 个迁移文件），增量迭代实现 V1.0 MVP 和 V1.1 增强。

## Technical Context

**Language/Version**: TypeScript (ES Module) / Node.js LTS
**Primary Dependencies**: Express.js, @supabase/supabase-js, jsonwebtoken (HS256), scrypt (密码哈希), openapi-generator (ts-fetch 客户端)
**Storage**: Supabase (托管 PostgreSQL 15+) — 30+ 表、21 个 ENUM、12 个迁移文件、RLS 策略
**Testing**: Vitest（单元/集成）、Golden Test Cases（计费验证 — `golden_cases.json`）
**Target Platform**: Vercel Serverless Functions（Pro 计划 300s 超时）+ Supabase 托管
**Project Type**: Web API 单体（Express 应用 + Vercel Cron + Worker 队列）
**Performance Goals**: 核心 API P95 < 300ms，日均 500 万 CDR，峰值 1000 TPS
**Constraints**: Serverless 函数 300s 超时、LISTEN/NOTIFY 8KB payload、首期 10 万 SIM
**Scale/Scope**: 首期 10 万 SIM（12 月内），未来 100 万；SLA 99.9%

## Constitution Check

*GATE: 无 constitution.md 文件 — 跳过形式化门控。*

以下为基于项目规格的自检清单：

| 检查项 | 状态 | 说明 |
|--------|------|------|
| 单一数据库 | ✅ PASS | 仅 Supabase PostgreSQL |
| 单一部署平台 | ✅ PASS | Vercel Serverless |
| 单体应用 | ✅ PASS | Express 单体，按路由/服务分模块 |
| 类型安全 | ✅ PASS | TypeScript 全量覆盖 |
| 不可变数据模式 | ✅ PASS | Price Plan/APN/Roaming/Control Policy 采用快照 + 新 ID 模式 |
| 审计可追溯 | ✅ PASS | audit_logs 表 + 计费 rating_results + 事件表 |
| 数据隔离 | ✅ PASS | RLS 策略 + 应用层 buildTenantFilterAsync() 双层隔离 |

## Project Structure

### Documentation (this feature)

```
specs/20260208-iot-cmp-reseller/
├── plan.md              # 本文件（实施计划）
├── research.md          # Phase 0 研究产出（差距分析+技术选型）
├── data-model.md        # Phase 1 数据模型设计（ER 图+表结构）
├── quickstart.md        # Phase 1 快速启动指南
├── contracts/           # Phase 1 API 契约
│   ├── tenant-api.md        # 租户与权限 API
│   ├── sim-api.md           # SIM 生命周期 API
│   ├── pricing-api.md       # 产品包与资费 API
│   ├── billing-api.md       # 账单与出账 API
│   ├── integration-api.md   # 集成与虚拟化 API
│   └── public-info-api.md   # 3GPP 公开目录 API
├── checklists/              # 验收检查清单
├── clarifications/          # 工程澄清文档
│   ├── bill-status-machine.md
│   ├── jobs-sim-status-change.md
│   └── webhook-delivery.md
├── technical-design.md  # 技术设计文档
├── tasks.md             # 任务分解（/adk:tasks 生成）
└── waterfall-algorithm.md   # 计费用量匹配算法
```

### Source Code (repository root)

```
src/
├── app.js / app.ts              # Express 主应用（路由注册+中间件+RBAC 配置）
├── server.js / server.ts        # 服务入口
├── billing.js                   # 计费引擎核心
├── worker.js                    # 异步任务 Worker
├── jwt.js                       # JWT 认证
├── password.js                  # 密码哈希
├── supabaseRest.js              # Supabase REST 客户端（重试+熔断）
├── routes/                      # API 路由层
├── services/                    # 业务逻辑层（38+ 服务模块）
├── middleware/                   # 中间件层
├── vendors/                     # 供应商适配器
├── cron/                        # Cron 任务入口
├── queues/                      # 异步队列
├── types/                       # TypeScript 类型定义
└── utils/                       # 工具函数

tests/
├── unit/                        # 单元测试
├── integration/                 # 集成测试
└── e2e/                         # 端到端测试

supabase/
└── migrations/                  # 数据库迁移
```

**Structure Decision**: 保持现有 Express 单体结构，按 `routes/` + `services/` + `middleware/` 分层。新功能遵循现有模式：路由层处理 HTTP、服务层处理业务逻辑、中间件处理横切关注点。数据库变更通过 `supabase/migrations/` 增量迁移管理。

## Phase 0: 研究产出摘要

**详细内容**: [research.md](./research.md)

### 核心发现

1. **现有代码库成熟度高**：64 个 API 端点、30+ 表、RLS 策略、JWT 认证、1 个供应商适配器已就绪
2. **所有技术未知项已在 /adk:clarify 阶段解决**：语言（TypeScript）、数据库（Supabase）、部署（Vercel）、币种策略、MVP 形态均已确定
3. **差距主要集中在 V1.1 增强**：RBAC DB 驱动、Reseller 身份统一、Price Plan 快照重构、KB→MB 统一

### 关键架构决策

| 决策 | 方案 | 理由 |
|------|------|------|
| 实体建模 | 独立表 + tenants 骨架表并存 | 域表独立管理字段与状态，tenants 提供统一身份与层级查询 |
| customers.status | ACTIVE/INACTIVE/SUSPENDED | 行政管控为主，overdue 移至 Dunning 层独立管理 |
| SIM lifecycle_sub_status | 仅激活方向（normal/activating/activation_failed） | 停机/复机/拆机用同步 API + status_sync_conflict 标志 |
| ADD_ON 月度循环取消 | 与 MAIN 一致（到本计费周期结束） | ONE_TIME 按到期截止，月度循环统一月底取消 |
| L2 账单分组 | department_id × package_id 交叉分组 | 支持按部门或按产品包双维度展开 |
| Phase 24: Reseller 身份统一 | 新增 reseller_tenant_id FK→tenants | 消除双标识歧义 |
| Phase 24: JWT 迁移 | 强制重登录（修改 JWT_SECRET） | 简单可靠 |
| Phase 23: RBAC DB 驱动 | 不加功能开关，依赖测试覆盖 | 保持代码简单 |
| Phase 19: 合并为原子部署 | Price Plan 快照重构 + KB→MB 统一一次性部署 | 消除中间态返工 |
| V1.1 破坏性变更 | 单次停机窗口（30-60 分钟） | Phase 24+23+19 一次性完成 |
| `public_infos` 隔离 | 与 business_operators/operator_id 零关联 | FR-057 强制要求 |

## Phase 1: 设计产出摘要

### 数据模型

**详细内容**: [data-model.md](./data-model.md)

核心实体关系：

```
供应商(suppliers) ──1:N──► 运营商关联(operators) ◄──M:N──► 业务运营商(business_operators)
                  ──1:N──► 上游集成(upstream_integrations)

tenants(身份骨架) ──1:1──► resellers / customers（域表）
                  parent_id 层级链：reseller_tenant → customer_tenant

代理商(resellers) ──1:N──► 企业(customers) ──1:N──► 部门(departments)
                  ──1:N──► 用户(users)

SIM 卡(sim_cards)  ──N:1──► 供应商 + 运营商 + 代理商 + 企业（四方归属链）
eSIM(esim_profiles) ──N:1──► 供应商 + 运营商 + SM-DP+(smdp_systems) + 代理商 + 企业

产品包(packages) ──引用──► Price Plan(快照ID) + Carrier Service + Control Policy(快照ID) + Commercial Terms

订阅(subscriptions) ──N:1──► SIM + 产品包
账单(bills) ──1:N──► 明细(bill_line_items, 含 department_id + package_id 用于 L2 交叉分组)

public_infos ──────── 完全独立，与业务表零关联 ────────
```

### API 契约

**详细内容**: [contracts/](./contracts/)

| 契约文件 | 覆盖范围 | User Story |
|----------|----------|------------|
| tenant-api.md | 代理商/企业/用户/供应商/运营商 CRUD | US1 |
| sim-api.md | SIM 导入/状态变更/查询/备注编辑 | US2 |
| pricing-api.md | Price Plan/APN/Roaming/Control Policy/Package 快照管理 | US3 |
| billing-api.md | 账单查询/导出/核销/调账/出账 | US5, US6 |
| integration-api.md | 供应商适配/SPI/Webhook/对账 | US8, US10 |
| public-info-api.md | 3GPP 公开目录只读查询+管理写入 | FR-054~FR-057 |

### 快速启动

**详细内容**: [quickstart.md](./quickstart.md)

覆盖：环境配置、数据库迁移、Seed 数据、本地开发、Vercel 部署。

## 实施路线图

### MVP（V1.0）— 8 周

```
Phase 1 (Week 1-2): 地基修正
  ├── TypeScript 双栈确认 + Schema 完整性验证
  ├── 租户模型验证（create_reseller/create_customer + 触发器同步）
  ├── SIM CRUD + 5 状态机验证
  └── Fixed Bundle 资费创建

Phase 2 (Week 3-4): 计费核心
  ├── 计费引擎 Golden Test Case 全量通过
  ├── 手动触发出账 API
  ├── 端到端冒烟测试
  └── Vercel staging 部署

Phase 3 (Week 5-6): 扩展能力
  ├── RBAC + 多租户隔离集成
  ├── One-time 资费 + 自动出账（T+N）
  └── SIM 批量导入 + WX 上游同步

Phase 4 (Week 7-8): 集成与验收
  ├── Dunning 基础版
  ├── 上游对账 + 虚拟化层
  └── 全量回归测试 + Golden Test Cases
```

### V1.1 增强 — 破坏性变更 + 功能扩展

**单次停机部署窗口**（Phase 24 → 23 → 19）:

```
Phase 24: Reseller 身份统一
  ├── 新增 reseller_tenant_id FK→tenants
  ├── 数据迁移（customers.reseller_id → reseller_tenant_id）
  ├── JWT SECRET 更新 → 强制重登录
  └── 弃用旧 reseller_id 引用

Phase 23: RBAC DB 驱动
  ├── roles/permissions/role_permissions 三表 Seed
  ├── 6 角色 × 38+ 权限码完整覆盖
  ├── getEffectivePermissions 重构（DB 优先，硬编码兜底）
  └── 集成测试覆盖全部角色权限组合

Phase 19: Price Plan 快照重构 + KB→MB 统一
  ├── price_plans + price_plan_versions 合并为单表快照
  ├── 所有 *_kb 字段/API 参数重命名为 *_mb
  ├── OpenAPI spec + ts-fetch 客户端重新生成
  └── 停机迁移 + pg_dump 备份回滚方案
```

**零停机功能扩展**（可独立部署）:

```
Phase 21: SIM/eSIM remark 字段
Phase 22: 账单 WRITTEN_OFF 状态
Phase 25: SIM 上游状态同步（T141a/b/c）
Phase 26: 按产品包/策略反查功能
Phase 27: public_infos 只读 API + 管理写入 + RLS
FR-057: operators.carrier_id DROP COLUMN + 外键清理
```

## 风险与缓解

| 风险 | 影响 | 概率 | 缓解措施 |
|------|------|------|----------|
| Serverless 超时（批量操作） | 高 | 中 | 异步 Job + 队列 + 批次拆分 |
| 单体 app.js 规模增长（643KB） | 中 | 高 | MVP 后按域拆分模块 |
| V1.1 停机迁移失败 | 高 | 低 | pg_dump 全量备份 + 事务迁移 + staging 充分验证 |
| CDR 数据量（500 万/日） | 高 | 中 | PostgreSQL 分区表 + 批量 INSERT + 冷归档 |
| 计费精度 | 高 | 低 | roundAmount() ROUND_HALF_UP + numeric(12,2) |
| JWT 强制重登录用户影响 | 低 | 高 | 低峰期部署 + 提前通知 |
| KB→MB Breaking Change | 中 | 高 | 提前通知 API 消费方 + OpenAPI spec 同步更新 |

## Complexity Tracking

*无 Constitution 门控违规。*

| 注意事项 | 说明 | 接受理由 |
|----------|------|----------|
| 单体 app.js 643KB | 超出常规文件大小建议 | 现有架构已稳定运行，MVP 后按域拆分 |
| 30+ 数据库表 | IoT CMP 业务域复杂度决定 | 实体间关系清晰，符合 DDD 领域建模 |
| 12 个迁移文件 | 增量迭代自然产物 | 每个迁移职责单一，可独立回滚 |
