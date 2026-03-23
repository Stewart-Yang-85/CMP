# Jobs：`SIM_STATUS_CHANGE` 与上游供应商同步

## 背景（Speckit Clarify）

**业务语义**：用户在本系统内变更 SIM 生命周期状态（如激活、停机、复机等）后，本地库与状态机已更新；**同一业务还需要与上游供应商系统对齐**，由供应商侧执行对应的卡状态变更。

**异步任务**：系统在状态变更流程中会向 **`jobs`** 表插入类型为 **`SIM_STATUS_CHANGE`** 的任务（见 `src/services/simLifecycle.js` / `simLifecycle.ts` 中 `enqueueSimStatusSyncJob` 等逻辑），由 **Worker** 异步消费：调用**供应商适配器**（如 `src/vendors/wxzhonggeng.ts` 等 SPI），完成上游状态同步。

**与事件的区别**：

- **`SIM_STATUS_CHANGE`**（job）：驱动**出站同步**——「去调上游改状态」。
- **`SIM_STATUS_CHANGED`**（`events` 表 / Webhook）：驱动**对内通知**——「状态已变，通知订阅方」。

二者可同时存在，职责不同。

## 实现现状（工程备注）

- **API / 状态机**：已具备插入 `SIM_STATUS_CHANGE` job 的路径。
- **`src/worker.js`**：当前 **`switch (job.job_type)` 未包含 `SIM_STATUS_CHANGE`**，队列中若存在该类型且状态为 `QUEUED`，Worker 会报 **`Unknown job type: SIM_STATUS_CHANGE`** 并将任务标记失败。
- **待办**：在 Worker 中实现 `case 'SIM_STATUS_CHANGE':`，根据 job payload（如 `iccid`、目标状态、供应商标识）路由到对应 vendor 适配器，并处理重试/幂等（可与 `simLifecycle` 中 `idempotency_key` 策略一致）。

## 验收建议（后续任务）

- Given 用户在本系统触发合法状态变更，When Worker 处理 `SIM_STATUS_CHANGE`，Then 上游供应商收到等价指令且本地 job 终态为 `SUCCEEDED`（或按失败策略 `FAILED` 可重试）。
- 与 **T062/T063**（WX 适配器、同步）及供应商 SPI 文档对齐测试。

## 相关文档

- [Webhook 向下游投递与失败重试](./webhook-delivery.md)（`SIM_STATUS_CHANGED` 等事件通知客户接收端）
- [账单状态机](./bill-status-machine.md)
