# 账单状态机澄清

## 0. 状态切换执行方式（FAQ）

### 1. GENERATED → PUBLISHED（动作 publish）

**是否由定时任务自动执行？**  
不完全是。`publish` 在**出账任务（BILLING_GENERATE job）执行完成时**自动触发，而不是单独的定时任务。

- **流程**：`POST /billing:generate` 创建 BILLING_GENERATE 任务 → Worker 执行 `runBillingGenerate` → 生成账单（GENERATED）→ 若 `billing_config.auto_publish = true`，则立即调用 `transitionBillStatus(..., 'publish')` 转为 PUBLISHED
- **触发**：出账任务本身由 `POST /billing:generate` 创建，可手动调用，也可由外部调度器定时调用
- **配置**：`billing_config.auto_publish` 决定是否自动发布

### 2. PUBLISHED → PAID（动作 pay）

**由用户在 Web Portal 上完成？**  
是的。由人工在 Portal 或通过 API 调用 `POST /bills/{billId}:mark-paid`，表示线下已收款，在系统中标记为已支付。

### 3. PUBLISHED → OVERDUE（动作 overdue）

**是否由定时任务自动触发？**  
是的。由 Dunning 定时任务 `runDunningCheck` 触发。

- **调度**：`DUNNING_CHECK_CRON`（默认 `30 2 * * *`，即每天 02:30）
- **判断**：按每张账单的 `due_date`，当 `due_date <= 今日` 且状态为 PUBLISHED 时，执行 `transitionBillStatus(..., 'overdue')`
- **实现**：`dunning.js` 中 `listOverdueBills` 查询 `due_date <= asOfDate` 且 `status in (PUBLISHED, OVERDUE)` 的账单

### 4. OVERDUE → PAID（动作 pay）

**同第 2 项**：人工调用 `POST /bills/{billId}:mark-paid`，表示逾期账单已支付。

### 5. OVERDUE → WRITTEN_OFF（动作 write_off）

**定义**：核销，表示将逾期未收账单视为坏账，不再催收。

**执行策略**：  
- **Dunning 催收**：由代理商自己的团队完成，系统不实现自动 write_off。
- **核销操作**：由代理商用户在 Web Portal 上手动执行，通过 `POST /bills/{billId}:write-off` 接口完成。
- **V1.1 实现**：该接口已纳入 V1.1 任务（见 tasks.md T118）。

---

## 1. 定义

### 1.1 状态枚举

数据库类型 `bill_status`（`supabase/migrations/20260311100001_core_schema.sql`）：

```sql
create type bill_status as enum (
  'GENERATED',   -- 已生成
  'PUBLISHED',   -- 已发布
  'PAID',        -- 已支付
  'OVERDUE',     -- 已逾期
  'WRITTEN_OFF'  -- 已核销
);
```

### 1.2 状态流转图

```
GENERATED ──publish──► PUBLISHED ──pay──► PAID
                          │
                          ├──overdue──► OVERDUE ──pay──► PAID
                          │                │
                          │                └──write_off──► WRITTEN_OFF
                          │
                          └──(不可逆)
```

### 1.3 允许的转换

| 当前状态 | 动作 | 下一状态 |
|----------|------|----------|
| GENERATED | publish | PUBLISHED |
| PUBLISHED | pay | PAID |
| PUBLISHED | overdue | OVERDUE |
| OVERDUE | pay | PAID |
| OVERDUE | write_off | WRITTEN_OFF |

### 1.4 约束

- **GENERATED**：可修改（追加 line items）
- **PUBLISHED**：不可篡改，仅可通过 Adjustment Note 调账
- **PAID** / **WRITTEN_OFF**：终态，不可再转换

---

## 2. 实现

### 2.1 核心实现位置

`src/services/billStatusMachine.js`

### 2.2 状态转换表

```javascript
const transitions = {
  GENERATED: {
    publish: 'PUBLISHED',
  },
  PUBLISHED: {
    pay: 'PAID',
    overdue: 'OVERDUE',
  },
  OVERDUE: {
    pay: 'PAID',
    write_off: 'WRITTEN_OFF',
  },
}
```

### 2.3 主要函数

| 函数 | 作用 |
|------|------|
| `getNextBillStatus(currentStatus, action)` | 根据当前状态和动作返回下一状态，非法则返回 `null` |
| `transitionBillStatus({ supabase, billId, action, ... })` | 执行状态转换：校验、更新 DB、触发事件 |

### 2.4 转换时的副作用

| 目标状态 | 更新字段 | 触发事件 |
|----------|----------|----------|
| PUBLISHED | `published_at`, `due_date` | `BILL_PUBLISHED` |
| PAID | `paid_at`, `payment_ref` | `PAYMENT_CONFIRMED` |
| OVERDUE | `overdue_at` | 无 |

### 2.5 特殊逻辑

- **PAID + pay**：已是 PAID 时再次执行 pay，视为幂等，直接返回成功
- **非法转换**：返回 `409 INVALID_STATUS`，例如对 GENERATED 执行 pay

---

## 3. 触发入口

| 入口 | 动作 | 说明 |
|------|------|------|
| `billingGenerate.js` | publish | 出账完成后，若 `autoPublish` 为 true 则自动发布 |
| `app.js` POST `/bills/:billId:mark-paid` | pay | 人工标记已支付 |
| `dunning.js` | overdue | Dunning 定时任务检测到 due_date 已过，将 PUBLISHED 转为 OVERDUE |

**write_off** 动作：当前代码中未发现调用入口，需通过其他服务或后续实现。

---

## 4. 相关规格

- `specs/20260208-iot-cmp-reseller/contracts/billing-api.md` §8 账单状态机
- `specs/20260208-iot-cmp-reseller/data-model.md` 中 `bill_status` 枚举
- `specs/20260208-iot-cmp-reseller/spec.md` FR-039 事件目录（BILL_PUBLISHED、PAYMENT_CONFIRMED）

## 5. 其它 Clarifications

- [Jobs：`SIM_STATUS_CHANGE` 与上游供应商同步](./jobs-sim-status-change.md)
- [Webhook 向下游投递与失败重试](./webhook-delivery.md)（`BILL_PUBLISHED` 等事件推送）
