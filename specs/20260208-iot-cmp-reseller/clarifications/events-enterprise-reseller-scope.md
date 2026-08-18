# events 表 scope 列：`enterprise_id` + `reseller_id`

**Status**: 已立项（待 tasks.md + 应用代码落地）  
**Date**: 2026-06-17  
**Migration**: `supabase/migrations/20260617100001_events_enterprise_reseller_scope.sql`

## 1. 决策

| 项 | 约定 |
|----|------|
| 废弃 | `events.tenant_id`（语义混用：有时 enterprise、有时 reseller） |
| 新增 | `enterprise_id uuid NULL` → **ENTERPRISE** `tenants.tenant_id`（= API `enterpriseId`） |
| 新增 | `reseller_id uuid NULL` → **RESELLER** `tenants.tenant_id`（= API `resellerId`，FR-058） |
| 废弃 | **`payload.resellerId`** — 写入时 **MUST NOT** 再注入；读路径以列为准 |
| 平台级事件 | 两列均可 `NULL` |

### 列组合语义

| 场景 | `enterprise_id` | `reseller_id` |
|------|-----------------|---------------|
| SIM / 账单 / 订阅 / 入站 webhook | 企业 UUID | 上级代理商 UUID |
| 纯代理商告警 `ALERT_TRIGGERED` | `NULL` 或具体 `customerId` | 代理商 UUID |
| 平台 / 无租户 | `NULL` | `NULL` |

**规则**：有 `enterprise_id` 时 **SHOULD** 同时写入 `reseller_id`（由 `tenants.parent_id` 或 `sims.reseller_id` 取得），避免查询时再 JOIN。

---

## 2. `emitEvent` 改造方案

### 2.1 入参类型（`src/services/eventEmitter.ts`）

```typescript
export type EmitEventInput = {
  eventType: string
  /** ENTERPRISE tenants.tenant_id (= enterpriseId). 取代 tenantId。 */
  enterpriseId?: string | null
  /** RESELLER tenants.tenant_id (= resellerId). 可省略：有 enterpriseId 时自动解析。 */
  resellerId?: string | null
  actorUserId?: string | null
  requestId?: string | null
  jobId?: string | null
  payload?: Record<string, unknown> | null
  occurredAt?: string
}
```

- **删除** `tenantId`（一次性破坏性变更，调用方全部改完再合）。
- **删除** `enrichPayloadWithResellerId()` 及对 `payload.resellerId` 的写入。
- **新增** `sanitizeEventPayload()`：从 payload 剔除 `resellerId`（防止调用方误传）。

### 2.2 Scope 解析（新增内部 helper）

```typescript
async function resolveEventScope(
  supabase: SupabaseClient,
  input: { enterpriseId?: string | null; resellerId?: string | null },
): Promise<{ enterpriseId: string | null; resellerId: string | null }> {
  let enterpriseId = input.enterpriseId ?? null
  let resellerId = input.resellerId ?? null

  if (enterpriseId && !resellerId) {
    resellerId = await resolveResellerTenantIdFromContext(supabase, enterpriseId)
  }
  // reseller-only（告警）：enterpriseId 保持 null 即可
  return { enterpriseId, resellerId }
}
```

### 2.3 写入行

```typescript
const { enterpriseId, resellerId } = await resolveEventScope(supabase, input)
const payload = sanitizeEventPayload(normalizePayload(input.payload))

await supabase.insert('events', {
  event_type: input.eventType,
  occurred_at: occurredAt,
  enterprise_id: enterpriseId,
  reseller_id: resellerId,
  actor_user_id: normalizeActorUserId(input.actorUserId),
  request_id: input.requestId ?? null,
  job_id: input.jobId ?? null,
  payload,
})
```

### 2.4 去重（`isDuplicateEvent`）

- 凡原先用 `tenant_id=eq.${normalizedTenantId}` 的过滤，按事件类型改为：
  - **企业域事件**（SIM / 账单 / 订阅等）：`enterprise_id=eq.${enterpriseId}`
  - **纯代理商事件**（`ALERT_TRIGGERED`）：`reseller_id=eq.${resellerId}`（`enterprise_id` 可参与 payload 内 `customerId` 比较，列上可为 null）

### 2.5 NOTIFY RPC（若启用 `EVENT_NOTIFY_FUNCTION`）

参数由 `tenant_id` 改为 `enterprise_id` + `reseller_id`（或保留 RPC 签名由 DBA 决定；应用侧同步传新字段名）。

---

## 3. 调用方迁移清单（Fastify / TS 真源）

| 模块 | 现状 | 改法 |
|------|------|------|
| `billStatusMachine.ts` | `tenantId: bill.enterprise_id` | `enterpriseId`；`resellerId: bill.reseller_id`（可选，可自动解析） |
| `billVoid.ts` | `tenantId: enterpriseId` | `enterpriseId` |
| `simLifecycleFinalize.js` | `tenantId: sim.enterprise_id` | `enterpriseId`；可从 sim 带 `reseller_id` |
| `alerting.ts` | `tenantId: resellerId` | `resellerId`；`enterpriseId: customerId ?? null` |
| `simLifecycle.ts` `insertBatchEvent` | 直写 `tenant_id` | **改为调用 `emitEvent`** 或写入 `enterprise_id`+`reseller_id` |
| `adjustmentNote.ts` | 直写 `tenant_id` | `enterprise_id` + `reseller_id`（从 bill 取） |
| `reconciliation.ts` | 直写 `tenant_id` | `enterprise_id` + `reseller_id`（从 sim 取） |
| `wxzhonggengInboundWebhook.ts` | 直写 `tenant_id` | SELECT sim 时加 `reseller_id`；写两列 |
| `app.ts` `ENTERPRISE_STATUS_CHANGED` / CMP webhook | 直写 `tenant_id` | `enterprise_id` + 解析 `reseller_id` |
| `worker.js` | 若有直写 | 同上 |

**原则**：优先统一走 `emitEvent()`；仅性能敏感或 bypass 去重的路径可直写，但必须写齐两列。

---

## 4. 读路径 / API

### 4.1 `GET /v1/events`（`src/routes/events.ts`）

| Query | PostgREST 过滤 |
|-------|----------------|
| `enterpriseId` | `enterprise_id=eq.{id}` |
| `resellerId` | `reseller_id=eq.{id}`（**不再**展开 `tenants` IN 列表） |

- 代理商 scope：默认 `reseller_id=eq.{token.resellerId}`（或仍允许不传则按 RBAC 限定）。
- 响应字段：`tenantId` → **`enterpriseId`**；新增 **`resellerId`**（来自列，非 payload）。

### 4.2 `connectivity.ts`

- `loadLatestUpdateLocationEvent` / `loadUpdateLocationEventsInRange`：`tenant_id=eq` → **`enterprise_id=eq`**。

### 4.3 `webhook.ts` `dispatchWebhookEvent`

- 不再从 `event.tenant_id` + `findTenant` 推导 scope。
- 直接使用 `event.enterprise_id` / `event.reseller_id` 匹配 `webhook_subscriptions.enterprise_id` / `reseller_id`。
- `buildDeliveryPayload`：
  - 顶层 **`enterpriseId`**（原 `tenantId` 更名）+ **`resellerId`**（来自列）。
  - **禁止**向 `payload` 内注入 `resellerId`。

### 4.4 `reconciliation.ts` 历史查询

- SELECT 列 `tenant_id` → `enterprise_id, reseller_id`。

---

## 5. OpenAPI / 契约

- `EventListItem.tenantId` → **`enterpriseId`**
- 增加 **`resellerId`**
- `EventListResponse` 保持 `total, page, pageSize`
- 更新 [integration-api.md](../contracts/integration-api.md) §4.1 示例 JSON

---

## 6. 测试

| 用例 | 断言 |
|------|------|
| `emitEvent` enterprise only | 两列均写入；payload 无 `resellerId` |
| `emitEvent` reseller-only 告警 | `reseller_id` 有值；`enterprise_id` 可为 null |
| 迁移 backfill | 原 ENTERPRISE `tenant_id` 行 → `enterprise_id`+`reseller_id` |
| 原 RESELLER `tenant_id` 行 | 仅 `reseller_id` |
| `GET /events?resellerId=` | 单列索引过滤，无需 tenants 展开 |
| Webhook dispatch | 按列匹配 subscription，delivery body 无 `payload.resellerId` |

---

## 7. 部署顺序（T184）

1. tasks.md 立项  
2. 本文档 + `data-model.md` §events  
3. 跑迁移 `20260617100001_events_enterprise_reseller_scope.sql`  
4. 应用代码（emitEvent + 直写路径 + routes + webhook + connectivity）  
5. OpenAPI  
6. Vitest + staging 抽检  
