# 入站 Webhook：事件目录与集成订阅（初步方案）

**Feature**: `iot-cmp-reseller` | **Status**: **规范真源 · 已评审**（2026-05-19）  
**范围**: **仅上游供应商 → CMP** 的入站推送；**不包含** CMP → 下游客户的出站 Webhook（见 [webhook-delivery.md](./webhook-delivery.md)、**FR-039**）。

**依赖**: [upstream-integration-config.md](./upstream-integration-config.md)、[operator-identity-model.md](./operator-identity-model.md)

---

## 0. 背景与动机

### 0.1 V1.1 已交付（Phase 37）

| 能力 | 现状 |
|------|------|
| 集成凭证 | `upstream_integrations`，**UNIQUE(`supplier_id`, `operator_id`)** |
| 适配器 | `adapter_type` + registry，按集成行加载出站 API |
| 入站 URL | 固定 4 条 WXZG 路径（`…/webhooks/wxzhonggeng/{eventKey}`） |
| 验签 | 单集成行共用 **`webhook_key`**，Header **`webhookKey`** |
| 管理 API | `GET/POST/PATCH/DELETE /v1/upstream-integrations` |

### 0.2 MVP 缺口

- 入站「事件类型」**写死在路径名**，无平台级目录、无「按集成启用哪些通知」的配置。
- 运维靠口头约定：上游门户里填哪几条 URL；CMP 侧无法返回「本条集成应配置的 URL 清单」。
- 新 adapter / 新事件类型需改 OpenAPI 路径枚举，难以扩展。

### 0.3 本方案目标

建立 **可扩展、可运维** 的三层模型，**事件种类数量不预设上限**（示例中曾用「20 种」仅为说明子集关系，**非**规格硬指标）：

```text
┌─────────────────────┐
│ 1. 入站事件目录      │  CMP 定义的「可接收通知类型」清单（平台级）
└──────────┬──────────┘
           │ 子集
┌──────────▼──────────┐
│ 2. 适配器能力        │  每个 adapterType 实际能处理目录中的哪些 eventKey
└──────────┬──────────┘
           │ 再子集
┌──────────▼──────────┐
│ 3. 集成订阅          │  每条 (supplier, operator) 集成启用哪些 eventKey
└─────────────────────┘
```

---

## 1. 概念定义

### 1.1 入站事件目录（Inbound Webhook Event Catalog）

**定义**: CMP 维护的、**标准化**的「从上游供应商可接收的通知类型」注册表。

| 属性 | 说明 |
|------|------|
| **归属** | **平台级**（非某一家 supplier 私有） |
| **event_key** | 稳定标识，如 `update-location`、`traffic-alert`（**kebab-case**，全局唯一） |
| **display_name** | 运维/Portal 展示名 |
| **description** | 业务说明 |
| **status** | `ACTIVE` / `DEPRECATED`（废弃后不再对新订阅开放） |
| **payload_schema_ref** | **MAY** 指向 OpenAPI component 或文档锚点 |

**不是**:

- 上游系统内部的事件名原样照搬（由 **adapter 映射** 到 `event_key`）。
- 下游 **`FR-039`** 事件目录（`SIM_STATUS_CHANGED` 等 CMP 内部领域事件）；二者 **MUST NOT** 混用同一张表，避免入站/出站耦合。

**V1.1 初值（与现网对齐）**:

| event_key | 说明 | 当前 HTTP 路径后缀 |
|-----------|------|-------------------|
| `subscription` | Subscription | `…/webhooks/wxzhonggeng/subscription` |
| `update-location` | Update Location | `…/webhooks/wxzhonggeng/update-location` |
| `sim-status-changed` | SIM 状态变更 | `…/webhooks/wxzhonggeng/sim-status-changed` |
| `traffic-alert` | 流量告警 | `…/webhooks/wxzhonggeng/traffic-alert` |

后续新增事件 **MAY** 追加目录行，无需事先约定总数量。

### 1.2 适配器能力（Adapter Inbound Webhook Capabilities）

**定义**: 某个 **`adapter_type`**（如 `wxzhonggeng`）在代码中声明 **能够解析并处理** 的 `event_key` 子集。

| 规则 | 说明 |
|------|------|
| 声明位置 | 适配器实现 + registry（**SHOULD** 暴露 `inboundWebhookEvents: string[]` 或等价结构） |
| 校验 | 创建/更新集成订阅时，`event_key` **MUST** ∈ 该 adapter 能力列表 |
| 与目录关系 | 能力列表 **MUST** 是事件目录 `ACTIVE` 项的子集 |

示例：

```text
事件目录（ACTIVE）:  subscription, update-location, sim-status-changed, traffic-alert, cdr-file-ready, …
wxzhonggeng 能力:    subscription, update-location, sim-status-changed, traffic-alert   （4 种）
future_vendor_x:     sim-status-changed, traffic-alert                            （2 种）
```

### 1.3 集成订阅（Integration Webhook Subscription）

**定义**: 针对 **一条** `upstream_integrations` 记录，明确 **启用哪些 `event_key` 的入站通知**。

| 属性 | 说明 |
|------|------|
| **粒度** | `(integration_id, event_key)` 唯一 |
| **enabled** | `true` / `false` |
| **语义** | 「CMP 愿意且配置为接收该类型上游推送」；与上游门户是否已登记 URL **无关**（需运维对齐） |

**与今日行为差异**:

| 今日（Phase 37） | 目标（Phase 38） |
|------|------|
| 4 条 URL 隐式全开；未订阅概念 | 仅 **enabled=true** 返回 2xx；未订阅 **`403 WEBHOOK_EVENT_NOT_SUBSCRIBED`** + 审计 |
| 上游门户决定填几条 URL | CMP **GET 集成详情** 返回 `webhookEndpoints[]` 供复制；订阅为真源 |

**「订阅」一词**: **不是** HTTP/WebSub 协议；**不是**下游 `webhook_subscriptions` 表；仅表示 **集成级接收配置**。

### 1.4 管理 API（扩展）

在现有 **`/v1/upstream-integrations`** CRUD 上扩展（**MAY** 拆子资源）：

| 能力 | 说明 |
|------|------|
| 写集成 + 订阅 | `POST` body **MAY** 含 `subscriptions: [{ eventKey, enabled }]` |
| 读集成 | 响应含 `subscriptions`、**`webhookEndpoints`**（已启用事件的完整 URL + method） |
| 目录只读 | `GET /v1/upstream-webhook-events`（平台目录 + 各 adapter 能力，供 Portal 勾选） |

**webhookEndpoints 示例**（由服务端根据 `baseUrl`、`supplierId`、`operatorId`、`adapterType`、`eventKey` 拼装）:

```json
{
  "eventKey": "update-location",
  "method": "POST",
  "url": "https://cmp.example.com/v1/suppliers/{supplierId}/operators/{operatorId}/webhooks/wxzhonggeng/update-location",
  "headers": [{ "name": "webhookKey", "description": "Value = integration webhookKey" }]
}
```

---

## 2. 数据模型（Phase 38）

> **状态**: 已评审；实现见 **Phase 38**（`tasks.md`）。**MUST** 同步 `data-model.md` 与 `supabase/migrations/`。

### 2.1 `upstream_inbound_webhook_events`（事件目录）

```sql
-- 示意
CREATE TABLE upstream_inbound_webhook_events (
  event_key text PRIMARY KEY,
  display_name text NOT NULL,
  description text,
  status text NOT NULL DEFAULT 'ACTIVE',  -- ACTIVE | DEPRECATED
  sort_order int,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
```

种子数据：V1.1 四条 WXZG 事件；后续 **INSERT** 扩目录。

### 2.2 `upstream_integration_webhook_subscriptions`（集成订阅）

```sql
-- 示意
CREATE TABLE upstream_integration_webhook_subscriptions (
  integration_id uuid NOT NULL REFERENCES upstream_integrations(integration_id) ON DELETE CASCADE,
  event_key text NOT NULL REFERENCES upstream_inbound_webhook_events(event_key),
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (integration_id, event_key)
);
```

**新建集成**: **MUST NOT** 自动插入订阅行；管理员通过 API **逐条**启用（见 §8 决策 #3）。

### 2.3 适配器能力

**MUST**: 代码注册（`registry` + 各 adapter 导出 `inboundWebhookEvents`），**不**落库；`GET /v1/upstream-webhook-events?adapterType=wxzhonggeng` 由 registry 过滤返回。

### 2.4 事件目录维护（已决策）

**MUST** 采用 **迁移种子 + 发版**（非 Platform Admin CRUD 新增 `event_key`）：

- 新 `event_key` = 新迁移 `INSERT` + adapter 声明能力 + handler/归一化逻辑同一 PR。
- **MAY** 后续增加 Admin 只读 API 或仅改 `display_name`/`description`；**MUST NOT** 允许无发版单独新增目录行（避免「库里有事件、adapter 未实现」）。

### 2.5 CDR / SFTP（已决策）

**MUST NOT** 将「定期拉取 CDR」纳入 `upstream_inbound_webhook_events`。CDR **MUST** 继续由 **`upstream_integrations`** 的 CDR 字段（**FR-042**）+ **定时任务/Worker** 主动查询。

**MAY** 在未来某 adapter 文档化支持「新 CDR 文件就绪」**HTTP 推送**时，再 **INSERT** 可选 `event_key`（如 `cdr-file-ready`）；**不**替代定时拉取。

**后续 MAY**: `adapter_inbound_webhook_capabilities` 表供非开发角色配置（低优先级）。

---

## 3. HTTP 路由策略

### 3.1 推荐：保留「每事件一条 URL」（与现网一致）

```text
POST /v1/suppliers/{supplierId}/operators/{operatorId}/webhooks/{adapterType}/{eventKey}
```

- `adapterType` = `wxzhonggeng` 时，`eventKey` **MUST** 在目录且已订阅且 adapter 支持。
- **优点**: 与 WXZG 及多数运营商门户「按回调类型填不同 URL」一致；运维直观。
- **缺点**: 路径随目录增长；需路由表或注册循环，而非硬编码 4 个 handler。

### 3.2 备选：单 URL + 载荷内分型（不优先）

```text
POST …/webhooks/{adapterType}/notify
Body: { "eventKey": "update-location", … }
```

- **MAY** 作为未来 adapter 选项；**V1.1 不采用**（已确认无存量 URL 迁移义务）。

### 3.3 入站处理流水线（统一）

```text
1. 解析 supplierId、operatorId（FR-041）
2. 解析 eventKey（路径或 body）
3. 加载 upstream_integrations + 校验 enabled 集成
4. 校验 `upstream_integration_webhook_subscriptions.enabled=true`（未订阅 → **403** `WEBHOOK_EVENT_NOT_SUBSCRIBED` + **audit_logs**）
5. 校验 adapter 能力
6. 验签 **集成级** `webhook_key`（Header **`webhookKey`**，全事件共用）
7. `adapter.normalizeInboundWebhook(eventKey, body)` → 内部动作（写 events 表、改 SIM 等）
```

---

## 4. 与出站（下游）边界

| 维度 | 入站（本文） | 出站（另文） |
|------|-------------|-------------|
| 方向 | 上游供应商 → CMP | CMP → 客户系统 |
| 目录 | `upstream_inbound_webhook_events` | **FR-039** 领域事件（`SIM_STATUS_CHANGED` 等） |
| 订阅表 | `upstream_integration_webhook_subscriptions` | `webhook_subscriptions` |
| 配置主体 | Platform Admin | 企业/代理商（视 RBAC） |
| 投递 | 同步 HTTP 接收 | 异步 `WEBHOOK_DELIVERY` Job |

**MUST NOT** 要求两种目录事件键完全一致；**MAY** 在 adapter 内将入站 `sim-status-changed` **转化为** 内部 `SIM_STATUS_CHANGED` 再出站。

---

## 5. 运维流程（目标态）

1. Platform Admin **`POST /v1/upstream-integrations`**（凭证、`adapterType`；**默认无订阅**）。
2. **`PATCH`** 或订阅子资源 **逐条** `enabled=true`。
3. 读集成响应 **`webhookEndpoints`**：仅 **enabled** 且 adapter 支持的事件。
4. 运维将 URL + Header **`webhookKey`** **人工录入** 上游供应商门户（或调用对方「注册 Webhook」API，若未来 adapter 支持）。
5. 上游推送 → CMP 按订阅与验签处理；未订阅 **403** + 审计。

---

## 6. 分阶段落地（已评审 → Phase 38）

| 阶段 | 交付 | 说明 |
|------|------|------|
| ~~**B — 订阅 JSONB**~~ | — | **不采用**（已决策：独立订阅表） |
| **C — 表 + 校验** | §2.1、§2.2 迁移；默认无订阅；未订阅 **403** + 审计 | **Phase 38** 主干 |
| **D — 动态路由 + adapter 归一化** | 单一路由模板 + `normalizeInboundWebhook` | 与 C 同期或紧随 |
| **E — 下游 Portal** | 与 FR-039 并列展示 | 独立立项 |

**与 Phase 37 关系**: Phase 37 **已完成** 凭证与固定 4 路径；本方案为 **Phase 38** 增强，**不推翻** FR-064～FR-066。无旧 URL 兼容义务。

---

## 7. 规格条目（已采纳）

已写入 `spec.md` **FR-067**～**FR-070**；实现跟踪 **Phase 38**（`tasks.md`）。

---

## 8. 评审决策（2026-05-19）

| # | 议题 | **决定** |
|---|------|----------|
| 1 | 订阅存储 | **`upstream_integration_webhook_subscriptions` 独立表** |
| 2 | 未订阅/未启用 | **`403`** + 业务码 **`WEBHOOK_EVENT_NOT_SUBSCRIBED`** + **`audit_logs`** |
| 3 | 新建集成默认订阅 | **默认全关**；Platform Admin 经 API **逐条**启用 |
| 4 | `webhook_key` 粒度 | **每集成一个 key**，全 `event_key` 共用（与上游门户一致） |
| 5 | 事件目录维护 | **A — 迁移种子 + 发版**；**非** Admin CRUD 新增 `event_key` |
| 6 | CDR / SFTP | **不纳入**入站 Webhook 目录；**定时拉取**为主（**FR-042**）；仅在未来有推送式 CDR 时再可选加 `event_key` |

---

## 9. 相关文档

- [upstream-integration-config.md](./upstream-integration-config.md) — 集成凭证、§5 入站路径（现网）
- [integration-api.md](../contracts/integration-api.md) — §0 上游集成、§0.4 Webhook
- [webhook-delivery.md](./webhook-delivery.md) — 出站投递
- [spec.md](../spec.md) — **FR-039**、**FR-042**、**FR-064**～**FR-066**
