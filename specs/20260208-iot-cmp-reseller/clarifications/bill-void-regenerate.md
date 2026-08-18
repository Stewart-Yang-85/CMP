# 账单作废与重新出账（Bill Void & Regenerate）

**Feature**: `iot-cmp-reseller` | **Phase 41**

## 1. 背景

`runBillingGenerate` 对同一 **`enterprise_id + period_start + period_end`** 仅保留**一条非 VOIDED** 账单；若已存在则跳过插入（Job 仍可能 **SUCCEEDED**，`results` 为空或不含该企业）。

运营上存在**整单重算**需求（批价错误、漏算 SIM、配置变更），不能仅依赖 **Adjustment Note**（适用于已发布账单的小额差异）。

## 2. 原则

| 原则 | 说明 |
|------|------|
| **不物理删除** | 作废账单保留行与 `bill_line_items` / `rating_results`，审计可追溯 |
| **占位释放** | **`VOIDED`** 账单不参与 `(enterprise, period)` 唯一约束，同账期可再出账 |
| **分状态门禁** | **GENERATED / PUBLISHED / OVERDUE** 可作废；**PAID / WRITTEN_OFF** 禁止 |
| **调账联动** | 作废前处理关联 **`adjustment_notes.source_bill_id`** |
| **重出不自动作废** | 须先 **`POST ...:void`**，再 **`POST /billing:generate`** |

## 3. 状态

### 3.1 新增 `bill_status = VOIDED`

```
GENERATED ──void──► VOIDED
PUBLISHED ──void──► VOIDED
OVERDUE   ──void──► VOIDED

PAID / WRITTEN_OFF ──void──► ✗ 409
```

**VOIDED** 为终态：只读，不可 `publish` / `pay` / `:adjust`。

### 3.2 数据库

- 列：**`voided_at`**、**`void_reason`**
- 唯一约束：~~`UNIQUE(enterprise_id, period_start, period_end)`~~ → **部分唯一**  
  `UNIQUE (enterprise_id, period_start, period_end) WHERE status <> 'VOIDED'`

迁移：**`20260621100006_bill_void_regenerate.sql`**（enum **`VOIDED`**）+ **`20260621100007_bill_void_regenerate.sql`**（列、部分唯一、RBAC）。须分两文件：PostgreSQL 不允许在同一事务内新增 enum 值并立即用于索引谓词。

## 4. API

### 4.1 作废账单

```
POST /v1/bills/{billId}:void
```

**权限**：**`bills.void`**（**`reseller_admin`** seed）；**platform admin / admin API key** 不受 RBAC 限制；**customer / department token** **403**。

**Request Body**:

```json
{
  "reason": "string (required, 作废原因)"
}
```

**前置条件**：

| 账单状态 | 允许 void |
|----------|-----------|
| GENERATED | ✅ |
| PUBLISHED | ✅ |
| OVERDUE | ✅ |
| PAID | ❌ **409** |
| WRITTEN_OFF | ❌ **409** |
| VOIDED | ❌ **409**（幂等视为已作废，可选 **200** 或 **409** — 实现返回 **409 INVALID_STATUS**） |

**调账 Note 联动**（`source_bill_id = billId`）：

| Note 状态 | 行为 |
|-----------|------|
| **DRAFT** | 自动 **`CANCELLED`** |
| **APPROVED** | **409 `ADJUSTMENT_NOTES_BLOCK_VOID`** — 须先处理（撤销审批/人工） |
| **APPLIED** | **409 `ADJUSTMENT_NOTES_BLOCK_VOID`** — 已并入历史结算，禁止作废源账关联链 |

**Response 200**:

```json
{
  "billId": "uuid",
  "status": "VOIDED",
  "voidedAt": "2026-06-05T12:00:00Z",
  "reason": "批价配置错误，整单重出"
}
```

**审计事件**：**`BILL_VOIDED`**（payload：`billId`, `enterpriseId`, `period`, `reason`, `cancelledNoteIds[]`）

### 4.2 重新出账

作废成功后，对**同一账期**再次调用 **`POST /v1/billing:generate`**（相同 `enterpriseId` / scope）：

1. Worker 不再因旧账单占位而 skip
2. 新建 **`bill_id`**，状态 **GENERATED**（`auto_publish` 则 **PUBLISHED**）
3. 重新跑批价 + 合并当期 **APPROVED** 调账（与作废前相同规则）
4. **VOIDED** 账单不被修改、不参与合并

## 5. 与 Adjustment Note 的分工

| 场景 | 推荐手段 |
|------|----------|
| **GENERATED** 整单错误 | **`:void` → `billing:generate`** |
| **PUBLISHED/OVERDUE** 小额差异 | **`:adjust`** → 下期合并 |
| **PUBLISHED/OVERDUE** 整单重大错误、未收款 | **`:void` → 重出**（慎用；可能已发 **BILL_PUBLISHED**） |
| **PAID / WRITTEN_OFF** | **仅调账**或财务流程，**不可 void** |

## 6. 实现入口

| 模块 | 路径 |
|------|------|
| 作废服务 | `src/services/billVoid.ts` |
| 路由 | `src/routes/bills.ts` — `POST .../void` |
| 出账 skip | `src/services/billingGenerate.ts` — `status=neq.VOIDED` |
| URL 重写 | `src/colonUrlRewrite.js` — `:void` |

## 7. 验收场景

1. **Given** 企业 2026-05 账单 **GENERATED**, **When** `:void` + 同 period `billing:generate`, **Then** 新 **billId**，旧单 **VOIDED**
2. **Given** 账单 **PUBLISHED** 且无阻塞调账, **When** `:void`, **Then** **VOIDED** + **BILL_VOIDED**
3. **Given** 存在 **APPROVED** Note（`source_bill_id` = 该账）, **When** `:void`, **Then** **409 ADJUSTMENT_NOTES_BLOCK_VOID**
4. **Given** 仅 **DRAFT** Note 关联, **When** `:void`, **Then** Note → **CANCELLED**，账单 **VOIDED**
5. **Given** 账单 **PAID**, **When** `:void`, **Then** **409 INVALID_STATUS**

## 8. 相关文档

- [bill-status-machine.md](./bill-status-machine.md)
- [adjustment-settlement.md](./adjustment-settlement.md)
- [contracts/billing-api.md](../contracts/billing-api.md) §1.6、§8
