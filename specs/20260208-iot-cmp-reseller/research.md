# Phase 0 Research: IoT CMP Reseller System

**Feature**: `iot-cmp-reseller`
**Date**: 2026-02-08
**Spec**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md)

## 1. 现有代码库分析

### 1.1 现有架构概览

当前系统为 **Express 单体应用**，已具备相当完善的基础功能：

| 维度 | 现状 |
|------|------|
| API 端点 | 64 个（OpenAPI 3.0.3 定义） |
| 数据库表 | 30+ 表，21 个 ENUM 类型 |
| 迁移文件 | 18 个已有 + 17 个新增 SQL 迁移 |
| 供应商适配器 | 1 个（wxzhonggeng — 微众耕） |
| 计费引擎 | 基础版本（billing.js, 254 行） |
| 异步任务 | worker.js（258 行） |
| 认证 | JWT HS256 + scrypt 密码哈希 |
| 客户端生成 | TypeScript Fetch 客户端 |

### 1.2 已实现表结构

基于 `0001_cmp_schema.sql` 迁移文件，以下核心表已存在：

- **组织实体**: `suppliers`, `operators`, `upstream_integrations`, `resellers`, `customers`
- **用户与权限**: `users`, `permissions`, `roles`, `role_permissions`
- **审计**: `audit_logs`, `events`
- **异步任务**: `jobs`
- **SIM 管理**: `sim_cards`, `sim_state_history`
- **产品与资费**: `price_plans`, `price_plan_versions`, `packages`, `package_versions`
- **订阅**: `subscriptions`
- **用量**: `cdr_files`, `usage_daily_summary`
- **账单**: `bills`, `bill_line_items`
- **调账**: `adjustment_notes`, `adjustment_note_items`
- **计费结果**: `rating_results`

### 1.3 已实现 ENUM 类型

| ENUM | 值 |
|------|-----|
| `reseller_status` | ACTIVE, DEACTIVATED, SUSPENDED |
| `customer_status` | active, overdue, terminated |
| `operator_status` | active, deprecated, error |
| `permission_category` | tenant, sim, subscription, billing, reporting, integration, system, webhook |
| `role_scope` | platform, reseller, customer |
| `sim_form_factor` | consumer_removable, industrial_removable, consumer_embedded, industrial_embedded |
| `sim_status` | INVENTORY, TEST_READY, ACTIVATED, DEACTIVATED, RETIRED |
| `subscription_state` | PENDING, ACTIVE, CANCELLED, EXPIRED |
| `job_status` | QUEUED, RUNNING, SUCCEEDED, FAILED, CANCELLED |
| `bill_status` | GENERATED, PUBLISHED, PAID, OVERDUE, WRITTEN_OFF |
| `service_type` | DATA, VOICE, SMS |
| `billing_cycle_type` | CALENDAR_MONTH, CUSTOM_RANGE |
| `first_cycle_proration` | NONE, DAILY_PRORATION |
| `price_plan_type` | ONE_TIME, SIM_DEPENDENT_BUNDLE, FIXED_BUNDLE, TIERED_PRICING |
| `note_type` | CREDIT, DEBIT |
| `note_status` | DRAFT, APPROVED, APPLIED, CANCELLED |
| `subscription_kind` | MAIN, ADD_ON |

## 2. 差距分析（Spec vs 现状）

### 2.1 租户与权限（User Story 1）

| 需求 | 现状 | 差距 |
|------|------|------|
| 独立实体表 | ❌ 旧 `tenants` 通用表 | 需拆分为 `resellers`, `customers` 独立表（CMP.xlsx Q1） |
| RBAC 角色 | ❌ 旧 `user_roles` 表不完整 | 需实现三表模型：`permissions` + `roles` + `role_permissions`（CMP.xlsx Q2）；7 个预设角色、38+ 权限码 |
| 权限中间件 | ⚠️ JWT 认证已实现 | 需实现基于 `role_scope` 的细粒度 RBAC 鉴权中间件（数据范围隔离） |
| 白标 | ❌ 不存在 | 需新增 `reseller_branding_configs` 表和域名映射 |
| 上游运营商管理 | ❌ 旧 `carriers` + `supplier_carriers` 表 | 需拆分为 `operators` + `upstream_integrations`（CMP.xlsx Q3）；支持废弃流程和 API/CDR 配置 |
| 审计日志 | ✅ `audit_logs` 表含完整字段 | 无 |
| 企业状态管理 | ⚠️ 旧 `enterprise_status` ENUM | 需迁移为 `customer_status`（active/overdue/terminated），验证状态变更事件触发逻辑 |
| GSMA MCC/MNC 校验 | ⚠️ 旧 `carriers` 表存在 | 需迁移为 `operators` 表，增加 UNIQUE(mcc, mnc) + 废弃工作流（replaced_by_id, deprecation_reason） |
| 企业 M2M 认证 | ❌ 不存在 | 需在 `customers` 表增加 api_key/api_secret_hash/webhook_url（CMP.xlsx Q5） |

### 2.2 SIM 生命周期（User Story 2）

| 需求 | 现状 | 差距 |
|------|------|------|
| 5 状态生命周期 | ✅ `sim_status` ENUM 完整 | 无 |
| SIM 清单字段 | ⚠️ 基础字段存在 | 需迁移 `sims` → `sim_cards`；补充：多 IMSI（imsi_secondary_1/2/3）、SIM 形态（4 种工业级 ENUM）、IMEI Lock、四方归属链（supplier→operator→reseller→customer）（CMP.xlsx Q4） |
| 状态机约束 | ⚠️ 端点存在 | 需验证：禁止 ACTIVATED→RETIRED、承诺期门槛校验 |
| sim_state_history | ✅ Type 2 SCD 表存在 | 无 |
| 批量导入 | ⚠️ `jobs` 表存在 | 需验证 10 万条上限、幂等（batchId/fileHash） |
| 上游状态同步 | ⚠️ vendor adapter 存在 | 需完善上游通知接收和双向同步 |
| 企业 SUSPENDED 手工批量停机 | ⚠️ 逻辑需验证 | 需确保异步批量停机流程完整 |

### 2.3 产品包与资费（User Story 3）

| 需求 | 现状 | 差距 |
|------|------|------|
| 4 种资费类型 | ✅ `price_plan_type` ENUM 完整 | 无 |
| Price Plan 版本化 | ✅ `price_plan_versions` 表 | 无 |
| PAYG Rates | ✅ `payg_rates` JSONB 字段 | 需验证 MCC+MNC 匹配优先级逻辑 |
| 控制策略 | ✅ `control_policy` JSONB | 需验证限速/达量断网执行逻辑 |
| 商业条款 | ✅ `commercial_terms` JSONB | 需验证测试期到期处理 |
| 阶梯计费 | ✅ `tiers` JSONB | 需验证分段累进算法实现 |
| 产品包发布 | ⚠️ `package_versions.status` | 需验证 DRAFT→PUBLISHED 流程 |

### 2.4 计费引擎（User Story 5）

| 需求 | 现状 | 差距 |
|------|------|------|
| 高水位月租费 | ⚠️ `billing.js` 基础实现 | 需验证基于 sim_state_history 的完整判定逻辑 |
| Waterfall Logic | ⚠️ 基础逻辑 | 需完善：叠加包优先→范围最小→主套餐→Out-of-Profile |
| SIM Dependent Bundle | ⚠️ 基础逻辑 | 需验证动态累加池计算 |
| 分段累进 | ⚠️ 基础逻辑 | 需验证 Progressive 分段累进公式 |
| Out-of-Profile PAYG | ⚠️ 基础逻辑 | 需验证独立计费+告警触发 |
| 计费可追溯 | ✅ `rating_results` 表含 inputRef/ruleVersion/calculationId | 无 |
| Golden Test Cases | ✅ `golden_cases.json` 存在 | 需确保全部 U/M/C/A/O 用例通过 |

### 2.5 账单与出账（User Story 6）

| 需求 | 现状 | 差距 |
|------|------|------|
| 账单三级结构 | ⚠️ `bills` + `bill_line_items` | 需补充 L2 分组汇总层 |
| 账单状态流转 | ✅ `bill_status` ENUM | 需验证状态机逻辑 |
| T+N 自动出账 | ⚠️ Vercel Cron 触发入口 | 需实现出账触发逻辑 |
| PDF/CSV 导出 | ❌ 不存在 | 需实现 |
| 调账 | ✅ `adjustment_notes` + `adjustment_note_items` | 需验证流程 |
| 迟到话单 | ⚠️ 逻辑需验证 | 需实现自动检测+调账单草稿生成 |

### 2.6 信控与催收（User Story 7）

| 需求 | 现状 | 差距 |
|------|------|------|
| Dunning 时间轴 | ❌ 不存在 | 需全新实现 |
| autoSuspendEnabled | ✅ `customers.auto_suspend_enabled` 字段 | 保留字段，当前不用于自动状态控制 |
| 逾期提醒 | ❌ 不存在 | 需实现催收通知机制 |
| 服务阻断 | ❌ 不存在 | 需支持批量停机手工触发 |
| 复机恢复 | ❌ 不存在 | 需支持手工解除 |

### 2.7 集成与虚拟化层（User Story 8/10）

| 需求 | 现状 | 差距 |
|------|------|------|
| SPI 定义 | ⚠️ wxzhonggeng 适配器 | 需抽象 ProvisioningSPI / UsageSPI / CatalogSPI |
| 多供应商支持 | ⚠️ 仅 1 个适配器 | 需定义适配器接口规范 |
| 能力协商 | ❌ 不存在 | 需实现 Capability Negotiation |
| SFTP 话单 | ❌ 不存在 | 需实现 SFTP 接入+幂等入库 |
| Reconciliation | ❌ 不存在 | 需实现每日对账任务 |

### 2.8 监控与可观测性（User Story 9/11）

| 需求 | 现状 | 差距 |
|------|------|------|
| 事件目录 | ✅ `events` 表存在 | 需验证 6 种事件类型覆盖 |
| 告警去重/抑制 | ❌ 不存在 | 需实现 |
| Webhook 投递 | ⚠️ 基础逻辑 | 需实现 HMAC-SHA256 签名+重试 |
| 连接状态 API | ⚠️ 可能已有端点 | 需验证 |

## 3. 技术选型验证

### 3.1 TypeScript / Node.js

**现状**: 代码基于 Node.js 运行时，已明确迁移为 TypeScript（ES Module）。
**决策**: 全量 TypeScript 落地，保持现有生成的 `gen/ts-fetch/types.d.ts` 作为接口类型参考。
**理由**: 提升复杂计费/告警/对账逻辑可维护性，降低跨模块协作成本。

### 3.2 Supabase (PostgreSQL)

**验证通过**：
- 现有 18 个迁移文件运行良好
- RLS（Row Level Security）已配置（0004_rls_policies.sql, 0008_bills_rls.sql）
- `supabaseRest.ts` 客户端已实现重试+熔断器
- `pg` 驱动作为 devDependency 存在

### 3.3 Vercel Serverless

**兼容性**: Fastify + TypeScript 应用可通过 `vercel.json` + `@vercel/node` 部署。
**注意事项**:
- Serverless Function 10 秒超时（Pro 计划 300 秒）
- 批量操作（10 万 SIM 导入）需通过异步 Job + 队列处理
- Cron Jobs 通过 Vercel Cron 触发队列入口，必要时补充 Supabase pg_cron 作为兜底

### 3.4 事件驱动（替代 Kafka）

**MVP 方案**: Supabase Realtime（PostgreSQL LISTEN/NOTIFY）+ Database Webhooks
**限制**: LISTEN/NOTIFY payload 最大 8KB，大消息需通过事件表（`events`）引用
**演进路径**: 商用阶段引入 Kafka/RabbitMQ

## 4. NEEDS CLARIFICATION 项解决

spec.md 中无 `[NEEDS CLARIFICATION]` 标记 — 所有决策已在 `/adk:clarify` 阶段确定：

| 问题 | 决策 | 来源 |
|------|------|------|
| 开发语言 | TypeScript (Node.js) | Clarify Session 2026-02-08 |
| 数据库 | Supabase (PostgreSQL) | Clarify Session 2026-02-08 |
| MVP 交付形态 | API + 轻量管理后台 | Clarify Session 2026-02-08 |
| 币种策略 | 按代理商固定币种 | Clarify Session 2026-02-08 |
| 部署环境 | Vercel (Serverless) | Clarify Session 2026-02-08 |

## 5. 风险与缓解

| 风险 | 影响 | 概率 | 缓解措施 |
|------|------|------|----------|
| Serverless 超时（批量操作） | 高 | 中 | 使用异步 Job + 队列处理，拆分批次 |
| 单体 app.js 维护困难 | 中 | 高 | MVP 后按域拆分模块（路由分文件） |
| LISTEN/NOTIFY 8KB 限制 | 低 | 低 | 事件表引用模式，payload 仅含 ID |
| 计费精度（浮点） | 高 | 低（已缓解） | roundAmount() 统一 ROUND_HALF_UP + PostgreSQL `numeric(12,2)` / `numeric(18,8)` |
| 多供应商适配器并行开发 | 中 | 中 | MVP 仅需 wxzhonggeng，SPI 接口先行定义 |
| CDR 数据量（500 万/日） | 高 | 中 | PostgreSQL 分区表 + 批量 INSERT + 冷归档 |
| 计费 N+1 查询性能 | 高 | 高（已缓解） | 批量 sim_id=in.() 查询替代 per-SIM 查询，10万 SIM 从 30万次 HTTP 降至 ~600 次 |
| 租户模型 split-brain | 高 | 高（已缓解） | V008 触发器 sync_customer_status_to_tenant + 事务函数 create_reseller/create_customer |
| RLS 策略失效 | 高 | 高（已缓解） | V009 tenant-scoped RLS + 应用层 buildTenantFilterAsync() 双层隔离 |

## 6. MVP 优先级与实施顺序（D-31 修正）

基于专家工程评审修正后的优先级：

```
Phase 1 (Week 1-2): 地基修正
  ├── 确认 TS/JS 双栈运行状态
  ├── 运行 V001-V009 迁移验证 schema 完整性
  ├── 租户模型验证（create_reseller/create_customer + 触发器同步）
  ├── SIM CRUD + 5 状态机验证
  └── Fixed Bundle 资费创建

Phase 2 (Week 3-4): 计费核心
  ├── 计费引擎 Golden Test Case 验证
  ├── 手动触发出账 API
  ├── 端到端冒烟测试
  └── 部署 Vercel staging

Phase 3 (Week 5-6): 扩展能力
  ├── RBAC + 多租户隔离集成
  ├── One-time 资费 + 自动出账
  └── SIM 批量导入 + WX 上游同步

Phase 4 (Week 7-8): 增强与回归
  ├── Dunning 基础版
  └── 全量回归测试

Phase 4 (Week 7-8): 集成与验收
  ├── US8: 上游对账
  ├── US10: 虚拟化层
  └── 全量 Golden Test Cases 通过
```

P2 功能（US9 监控诊断、US11 事件架构）在 MVP 中以基础版本交付。
