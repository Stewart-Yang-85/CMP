# Jobs：`SIM_STATUS_CHANGE` 与上游供应商同步

## 背景（[V1.1] 收口）

**业务语义**：下游客户调用本系统生命周期 API（`:activate` / `:deactivate` / `:reactivate` / `:retire`）后，本系统 **MUST** 与上游供应商对齐卡状态。**稳态 `status` 仅在上游确认后写入**；受理瞬间写入源 `status` + `lifecycle_sub_status`（`*ing`）。

**异步任务**：

1. API **同步**受理：校验、创建 `jobs.type = SIM_STATUS_CHANGE`（`QUEUED`）、SIM → 源 `status` + `*ing`、返回 **202**（见 [sim-api.md §4.0](../contracts/sim-api.md)）。
2. **Worker** 消费 Job：调用**供应商适配器**（`src/vendors/*` SPI）；适配器返回 `completed` | `pending` | `failed`。
3. **完成**：`completed` → 目标 `status` + `normal`，`job.status = SUCCEEDED`；`failed` → 源 `status` + `*_failed`，`job.status = FAILED`。
4. **通知**：稳态变更 → `SIM_STATUS_CHANGED`；Job 终态 → `JOB_FINISHED`（见 [integration-api.md](../contracts/integration-api.md)）。

**`pending`**：由**每个供应商适配器**独立实现完成路径（轮询、供应商入站 Webhook、或组合）；CMP 核心不全局二选一。

## 与事件的区别

| 机制 | 职责 |
|------|------|
| **`SIM_STATUS_CHANGE`（job）** | 驱动出站同步与 Job 生命周期；`SUCCEEDED` = 上游确认 + 本地已落稳态 |
| **`SIM_STATUS_CHANGED`（event/webhook）** | 通知下游：**稳态** `status` 已变 |
| **`JOB_FINISHED`（event/webhook）** | 通知下游：Job 已终态（含失败，可无稳态变更） |

## Cancel 策略

- `POST /v1/jobs/{jobId}:cancel` 对 **`SIM_STATUS_CHANGE` MUST NOT** 成功（`409 JOB_NOT_CANCELLABLE`）。
- 已向供应商提交 outbound 后不得 cancel；失败或变更意图须**新的**生命周期 API + 新 Job。

## 并发

- `lifecycle_sub_status` 为 `*ing` 时，拒绝其它方向生命周期操作（`409 LIFECYCLE_IN_PROGRESS`）。

## 实现现状（工程备注）

- API / `simLifecycle` 与 spec **存在差距**（例如曾同步写目标 `status`、Job 在同一请求内置 SUCCEEDED）；实现须按 [spec.md](../spec.md) US2 与 [sim-api.md §4.0](../contracts/sim-api.md) 对齐。
- Worker **`SIM_STATUS_CHANGE`** 分支须与适配器 `pending` 语义一致。
- DB 枚举 `lifecycle_sub_status` 须迁移扩展（见 `data-model.md`）。

## 验收建议

- Given 合法 activate 受理, When 202, Then `job.status` 为 `QUEUED`/`RUNNING` 且 `sim.lifecycleSubStatus=activating`，`sim.status` 仍为源态。
- Given 上游确认, When Worker 完成, Then `job.status=SUCCEEDED`、`sim.status=ACTIVATED`、`lifecycleSubStatus=normal`，并投递 `SIM_STATUS_CHANGED` + `JOB_FINISHED`。
- Given 上游拒绝, Then `job.status=FAILED`、`activation_failed`（或对应 `*_failed`），仅 `JOB_FINISHED`（可无 `SIM_STATUS_CHANGED`）。
- Given `SIM_STATUS_CHANGE` Job, When `jobs:cancel`, Then `409 JOB_NOT_CANCELLABLE`.

## 相关文档

- [Webhook 向下游投递](./webhook-delivery.md)
- [sim-api.md §4.0](../contracts/sim-api.md)
- [integration-api.md — JOB_FINISHED](../contracts/integration-api.md)
