# 调账单下期结算（Adjustment Settlement）

**Feature**: `iot-cmp-reseller` | **Phase 39 PR-C**

## 1. 原则

- **已发布/历史账单**（`bills` 行）**不因调账而改写** `total_amount`。
- 审批通过的调账单（**`APPROVED`**）在**下一次** `runBillingGenerate` 出账时合并进**新账单**。
- 合并完成后，Note 状态变为 **`APPLIED`**，**不会重复计入**后续账期。

## 2. 状态机（调账单）

```
DRAFT ──approve──► APPROVED ──billing:generate──► APPLIED
  │
  └── bill :void (auto) ──► CANCELLED
```

| 状态 | 含义 |
|------|------|
| DRAFT | 已创建，待审批 |
| APPROVED | 已审批，等待下期出账合并 |
| APPLIED | 已并入某期新账单的 `total_amount` |
| CANCELLED | 已作废，不参与结算（**DRAFT** 关联 Note 在 **`POST ...:void`** 作废原账时自动进入） |

## 3. 金额公式

对某企业在出账时刻：

```
ratingTotal     = computeMonthlyCharges(...).totalBillAmount
creditTotal     = Σ(APPROVED CREDIT notes, same currency)
debitTotal      = Σ(APPROVED DEBIT notes, same currency)
netAdjustment   = debitTotal - creditTotal
bill.total_amount = ratingTotal + netAdjustment
```

- Note 上的 **`total_amount` 恒为正**；方向由 **`note_type`** 决定。
- 仅合并 **`status = APPROVED`** 且 **`currency`** 与当期账单一致的 Note。

## 4. 账单明细（L1）

新账单写入 **`bill_line_items`**：

| item_type | 说明 |
|-----------|------|
| `ADJUSTMENT_CREDIT` | 贷项调账行 |
| `ADJUSTMENT_DEBIT` | 借项调账行 |

`metadata.noteId` 指向源 **`adjustment_notes.note_id`**。

账单详情 **L1** JSON/CSV 增加 **`adjustmentCreditTotal`** / **`adjustmentDebitTotal`**（自上述行项汇总）。

## 5. 审计事件

| 事件 | 时机 |
|------|------|
| `BILL_ADJUSTMENT_NOTE_CREATED` | `:adjust` 创建 DRAFT |
| `BILL_ADJUSTMENT_NOTE_APPROVED` | `:approve` → APPROVED |
| `BILL_ADJUSTMENT_NOTE_APPLIED` | 出账合并后 → APPLIED |

## 6. 实现入口

- **`loadApprovedAdjustmentSettlement`** / **`markAdjustmentNotesApplied`** — `src/services/adjustmentNote.ts`
- **`runBillingGenerate`** — `src/services/billingGenerate.ts`

## 7. 幂等键（`idempotencyKey` · Phase 40）

| 写操作 | 键作用域 | 行为 |
|--------|----------|------|
| **`POST /v1/bills/{billId}:adjust`** | **`(source_bill_id, idempotency_key)`** | 相同键 → **409 IDEMPOTENCY_CONFLICT**（不重复创建 Note） |
| **`POST /v1/billing:generate`** | **`jobs.idempotency_key`**（**BILLING_GENERATE** 全局唯一） | 相同键 + 相同 scope（**period / resellerId / enterpriseId**）→ 返回已有 Job；跨 scope 复用键 → **409** |

- 省略 **`idempotencyKey`** 时行为不变（每次新建 Note / Job）；显式 **`""`** 或仅空白 → **400**。
- List **`GET /adjustment-notes`** 返回 **`billId`**、**`reason`**、**`idempotencyKey`** 便于核对历史。
- 迁移：**`20260621100005_billing_idempotency_keys.sql`**。

## 8. 调账明细 ICCID 校验

| 阶段 | 无效 ICCID 行为 |
|------|-----------------|
| **`POST ...:adjust`** | **404 `SIM_NOT_FOUND`** / **400 `INVALID_ICCID`**，不创建 Note |
| **`POST ...:approve`** | 同上，不进入 **APPROVED** |
| **`billing:generate` 合并** | **不阻断** Job；仍合并 Note 金额；写入 **`BILL_ADJUSTMENT_ICCID_WARNING`** 事件（payload 含 `issues[]`） |

校验规则：`items[].iccid` 省略 → 跳过；提供则 **MUST** 在该企业 `sims` 中存在。结算仍按 Note **`total_amount`** 合并（与 §3 一致）。
