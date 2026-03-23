# Webhook 投递（WEBHOOK_DELIVERY）与失败处理

## 业务语义

**向下游推送**：当本系统产生事件（如 `SIM_STATUS_CHANGED`、`BILL_PUBLISHED` 等）且客户配置了 **`webhook_subscriptions`** 时，系统会创建 **`webhook_deliveries`** 记录，并通过异步任务向客户提供的 **HTTPS URL** 投递 JSON 负载，请求头含 **`X-Webhook-Signature`**（HMAC-SHA256）等。

**与上游同步的区别**：

- **`SIM_STATUS_CHANGE`（job）**：本系统改状态后，**调用上游供应商**对齐卡状态（见 [jobs-sim-status-change.md](./jobs-sim-status-change.md)）。
- **Webhook 投递**：本系统事件发生后，**通知下游客户系统**（客户自己的接收端）。

## 实现位置

- **投递与重试逻辑**：`src/services/webhook.js` — `attemptDelivery`、`retryWebhookDelivery`
- **Worker 调度**：`src/worker.js` — `WEBHOOK_DELIVERY_CRON`（默认 `*/1 * * * *`）→ `webhookDeliveryTask` 入队 `WEBHOOK_DELIVERY` → `handleWebhookDeliveryJob` 批量处理
- **环境变量**：`WEBHOOK_DELIVERY_BATCH_LIMIT`（默认 50）、`WEBHOOK_DELIVERY_CRON`
- **手动重试**：`src/routes/webhooks.js` 等管理端点可触发单条 `retryWebhookDelivery`

## 失败与重试策略

常量（`webhook.js`）：

- **`maxAttempts`**：`3` — 新建投递时 `attempt` 初始为 **`1`**（`dispatchWebhookEvent` 插入记录后即发起首次 HTTP）；每次失败后将 `attempt` 递增并写入 `next_retry_at`；当 **`attempt + 1 > maxAttempts`** 时不再排重试，标记失败（即最多 **3 次** HTTP 尝试后进入 `FAILED`）。
- **`retryBaseSeconds`**：`2`，退避为 **`getRetryDelaySeconds(attempt)`** = `2 * 2^(attempt-1)` 秒（约 2s、4s、8s…）。

行为：

1. **HTTP 成功**（`res.ok`）：`webhook_deliveries.status = 'SENT'`，`next_retry_at = null`，记录 `response_code` / `response_body`（截断）。
2. **HTTP 失败或网络错误**：若本次失败后 **`attempt + 1 > maxAttempts`**（下一次序号将超过上限）：
   - `status = 'FAILED'`，`next_retry_at = null`
   - 调用 **`createAlert`**，`alertType = 'WEBHOOK_DELIVERY_FAILED'`，`severity = 'P2'`，metadata 含 `webhookId`、`deliveryId`、`url`、响应摘要等。
3. **尚未用尽次数**：`status` 保持 **`PENDING`**，**`attempt`** 递增，设置 **`next_retry_at`** 为未来时间点，由后续 Cron + Worker 再次拉取投递。

## Worker 如何捞取待投递记录

`handleWebhookDeliveryJob` 查询条件大致为：

- `status = 'PENDING'`
- `next_retry_at <= 当前时间`（已到重试时间）

对每条调用 **`retryWebhookDelivery`**。新创建的投递若设计为「立即尝试」，通常 `next_retry_at` 为当前或过去，会被尽快纳入批次。

## 限制与运维说明

- **非无限重试**：超过 `maxAttempts` 后标记 **`FAILED`**，需人工修复订阅 URL/网络或依赖后续产品能力（如管理端「再次投递」）。
- **调度粒度**：依赖 Cron 与 `jobs` 队列顺序，高峰时投递可能有秒级～分钟级延迟。
- **单 job 批量**：每条 `WEBHOOK_DELIVERY` job 最多处理 **`WEBHOOK_DELIVERY_BATCH_LIMIT`** 条投递；积压时需多轮 job 消化。

## 相关 Spec / 任务

- 事件类型与签名：[spec.md](../spec.md) US11、[tasks.md](../tasks.md) T080（HMAC 投递）
- 告警类型：`WEBHOOK_DELIVERY_FAILED` 已在 `alerting` 服务中注册
- [Jobs：`SIM_STATUS_CHANGE` 与上游](./jobs-sim-status-change.md) · [账单状态机](./bill-status-machine.md)（`BILL_PUBLISHED` 等）
