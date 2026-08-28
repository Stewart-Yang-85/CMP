# API 契约：计费、出账与信控

**Feature**: `iot-cmp-reseller` | **Date**: 2026-02-08（**Covered / OOP 批价路径** 与 [pricing-api.md](pricing-api.md) 对齐 2026-04-22）
**关联 User Story**: US5（计费引擎）、US6（账单与出账）、US7（信控催收）
**关联需求**: FR-023 ~ FR-034

> **V1.1 Breaking Change（2026-03-24 确认）**：KB→MB 单位统一为一次性 Breaking Change。所有 API 字段名 `*Kb` 将替换为 `*Mb`（如 `usageKb`→`usageMb`、`totalUsageKb`→`totalUsageMb`），不提供兼容层。发布前需通知所有 API 消费方升级。

> **FR-058（`resellerId`）**：查询参数与响应 JSON 中的 `resellerId` 均为代理商 **RESELLER** 的 **`tenants.tenant_id`**；与 JWT/API 其余处一致。详见 [tenant-api.md §0](tenant-api.md)。

---

## 1. 账单管理

### 1.1 查询账单列表

```
GET /v1/bills?enterpriseId={}&period={}&status={}&page={}&pageSize={}
```

**权限**: 代理商角色（授权范围内）| 企业管理员

**Query Parameters**:
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| enterpriseId | uuid | 否 | 企业 ID（customer token 由 JWT 推导，通常无需传） |
| resellerId | uuid | 否 | **Reseller JWT**：可省略（默认 token `resellerId`）；若传则必须与 token 一致，否则 `403`；非法 uuid `400`；不存在 `404`。**Platform admin / admin API key**：可省略（全部 reseller）；若传则必须在库中存在，否则 `404`。**Customer API key**：不允许， `403` |
| period | string | 否 | 账期 `YYYY-MM`；**省略时**默认查询 **最近 12 个已完结 UTC 自然月**（不含当前月），再分页 |
| status | string | 否 | GENERATED/PUBLISHED/PAID/OVERDUE/WRITTEN_OFF |
| page | integer | 否 | 默认 **1** |
| pageSize | integer | 否 | 默认 **50**，最大 **100** |
| sortBy | string | 否 | period / dueDate / totalAmount / status，默认 period |
| sortOrder | string | 否 | asc / desc，默认 desc |

**列表 CSV**：`GET /v1/bills:csv` 使用相同筛选/排序/作用域；**`pageSize` 默认 100，最大 1000**（与 JSON 列表不同）。

**Reseller JWT**：不传 `period` 时，在 12 个月窗口内列出该 reseller 下所有子企业的账单；传 `period` 时仅该月。`resellerId` 规则见上表。

**Customer API key**：禁止调用本接口（`403`）。企业用户请使用 Bearer JWT（非 API key）。

**Response 200**:
```json
{
  "items": [
    {
      "billId": "uuid",
      "enterpriseId": "uuid",
      "resellerId": "uuid",
      "period": "2026-02",
      "status": "PUBLISHED",
      "currency": "CNY",
      "totalAmount": 15680.50,
      "dueDate": "2026-03-31"
    }
  ],
  "total": 48,
  "page": 1,
  "pageSize": 50
}
```

- 列表项中 `resellerId`：**RESELLER `tenants.tenant_id`**（**FR-058**），见上文引用 [tenant-api.md §0](tenant-api.md)。

### 1.2 查询账单详情

```
GET /v1/bills/{billId}
```

**权限**（与 §1.3、§1.4 相同租户范围）:
- **platform admin / admin API key**：任意 `billId`
- **reseller token**：仅 token 标识 reseller 下属企业的账单（越权 **403**）
- **customer token**（JWT 或 API key）：仅 token 标识 enterprise 的账单（越权 **404**）

**Response 200** — L1 + L2（不含 SIM 级 L3；L3 见 §1.3）:

```json
{
  "billId": "uuid",
  "enterpriseId": "uuid",
  "period": "2026-02",
  "status": "PUBLISHED",
  "currency": "CNY",
  "totalAmount": 15680.50,
  "dueDate": "2026-03-31",
  "createdAt": "2026-02-01T08:00:00Z",
  "generatedAt": "2026-02-01T08:00:00Z",
  "publishedAt": "2026-02-05T10:00:00Z",
  "paidAt": "2026-03-15T12:00:00Z",
  "paidAmount": 15480.50,
  "paymentRef": "PAY-2026030801",
  "paymentProof": "工行转账流水号 202603081030001234",
  "overdueAt": null,
  "voidedAt": null,
  "voidReason": null,
  "writtenOffAt": null,
  "writeOffReason": null,

  "l1Summary": {
    "monthlyFeeTotal": 5000.00,
    "usageChargeTotal": 2500.00,
    "overageChargeTotal": 500.00,
    "adjustmentCreditTotal": 200.00,
    "adjustmentDebitTotal": 50.00
  },

  "l2Groups": [
    {
      "groupKey": "d8283ced-2936-4349-92aa-eceb2013c611",
      "groupType": "PACKAGE",
      "groupName": "Global 1GB",
      "subtotal": 8000.00
    }
  ]
}
```

### 1.3 查询账单明细（L3）

```
GET /v1/bills/{billId}/line-items?page={}&pageSize={}
```

**用途**：用于查看一个计费周期内账单拆分到 **L3** 的明细，即产品包级别、每一张 SIM 卡的使用量与费用情况。`GET /v1/bills/{billId}` 返回 L1/L2 汇总；本接口返回可分页的 SIM × 产品包明细。

**权限**（与 §1.2 相同租户范围；需 **`bills.read`**，customer M2M API key 允许）:
- **platform admin / admin API key**：任意 `billId`
- **reseller token**：仅 token 标识 reseller 下属企业的账单
- **customer token**：仅 token 标识 enterprise 的账单

**Query**:
| 参数 | 类型 | 默认 | 说明 |
|------|------|------|------|
| page | integer | 1 | 页码 |
| pageSize | integer | 100 | 每页条数，最大 200 |

**Response 200**:
```json
{
  "items": [
    {
      "lineItemId": "uuid",
      "iccid": "89860012345678901234",
      "msisdn": "8613800138000",
      "departmentName": "研发部",
      "packageName": "Global 1GB",
      "monthlyFee": 100.00,
      "usageCharge": 50.00,
      "overageCharge": 10.00,
      "subtotal": 160.00,
      "usageMb": 1024,
      "groupKey": "d8283ced-2936-4349-92aa-eceb2013c611",
      "groupType": "PACKAGE"
    }
  ],
  "total": 500,
  "page": 1,
  "pageSize": 100
}
```

### 1.4 导出账单 CSV（Scheme A）

已废弃 **`GET /v1/bills/{billId}/files`**；改用以下两个端点（权限与 §1.2 / §1.3 相同）。

#### 1.4.1 汇总 CSV（L1 + L2）

```
GET /v1/bills/{billId}:csv
```

**Response 200**：`text/csv`，文件名 `bill-{billId}-summary.csv`

多段式 CSV，列：`section`, `name`, `count`, `amount`, `text`

| section | name 示例 | 说明 |
|---------|-----------|------|
| bill | billId, enterpriseId, period, status, currency, totalAmount, dueDate, createdAt, generatedAt, overdueAt, publishedAt, paidAt, paidAmount, paymentRef, paymentProof, writtenOffAt, writeOffReason, voidedAt, voidReason | 账单头字段（`count`/`amount` 为空，`text` 为空） |
| l1 | monthlyFeeTotal, usageChargeTotal, overageChargeTotal | L1 合计（值在 `amount`） |
| l2 | groupKey | L2 分组行：`name`=groupKey，`count`=groupType，`amount`=subtotal，`text`=groupName |

#### 1.4.2 SIM 明细 CSV（L3）

```
GET /v1/bills/{billId}/line-items:csv?page={}&pageSize={}
```

**Response 200**：`text/csv`，文件名 `bill-{billId}-line-items.csv`

列与 §1.3 JSON 字段一致：

`lineItemId`, `iccid`, `msisdn`, `departmentName`, `packageName`, `monthlyFee`, `usageCharge`, `overageCharge`, `subtotal`, `usageMb`, `groupKey`, `groupType`

默认 `pageSize=10000`，最大 10000。

默认 `pageSize=10000`，最大 10000。

### 1.5 发布账单（GENERATED → PUBLISHED）

```
POST /v1/bills/{billId}:publish
```

**权限**（租户范围同 §1.2；需 **`bills.read`**）:
- **platform admin / admin API key**：任意 `billId`
- **reseller token**：仅 token 标识 reseller 下属企业的账单
- **customer / department token**（JWT 或 API key）：**禁止**（**403**）

**Request Body**（可选）:
```json
{
  "dueDate": "2026-03-31"
}
```

**前置条件**: 账单状态为 **GENERATED**  
**后置**: 状态 → **PUBLISHED**，写 `published_at`，触发 **`BILL_PUBLISHED`** 事件

> 出账任务在 `billing_config.auto_publish = true` 时也会自动执行 `publish`；本接口用于手动发布或补发。

**Response 200**:
```json
{
  "billId": "uuid",
  "status": "PUBLISHED",
  "publishedAt": "2026-03-08T10:00:00Z",
  "dueDate": "2026-03-31"
}
```

**错误**: 非法转换 **409 `INVALID_STATUS`**（例如对 PUBLISHED 再次 publish）

### 1.5.1 作废账单（Void · 允许同账期重新出账）

```
POST /v1/bills/{billId}:void
```

**权限**（租户范围同 §1.2；需 **`bills.void`**，`reseller_admin` 已 seed）:
- **platform admin / admin API key** | **reseller** 具备 `bills.void`
- **customer / department token**：**禁止**（**403**）

**Request Body**:
```json
{
  "reason": "string (required)"
}
```

**前置条件**: 账单状态为 **GENERATED**、**PUBLISHED** 或 **OVERDUE**（**PAID** / **WRITTEN_OFF** / **VOIDED** → **409**）

**调账联动**（`adjustment_notes.source_bill_id = billId`）:
- **DRAFT** → 自动 **CANCELLED**
- **APPROVED** / **APPLIED** → **409 `ADJUSTMENT_NOTES_BLOCK_VOID`**

**后置**: 状态 → **VOIDED**，写 **`voided_at`** / **`void_reason`**，事件 **`BILL_VOIDED`**。同企业同账期可再次 **`POST /billing:generate`**（旧 **VOIDED** 行保留审计）。

详见 [bill-void-regenerate.md](../clarifications/bill-void-regenerate.md)。

**Response 200**:
```json
{
  "billId": "uuid",
  "status": "VOIDED",
  "voidedAt": "2026-06-05T12:00:00Z",
  "reason": "批价配置错误，整单重出",
  "cancelledNoteIds": ["uuid"]
}
```

### 1.6 人工核销（标记已付）

```
POST /v1/bills/{billId}:mark-paid
```

**权限**（租户范围同 §1.2；需 **`bills.mark_paid`**）:
- **platform admin / admin API key** | **reseller** 等具备 `bills.mark_paid` 的角色
- **customer / department token**（JWT 或 API key）：**禁止**（**403**）

**Request Body**:
```json
{
  "paidAmount": 15480.50,
  "paymentRef": "PAY-2026030801",
  "paymentProof": "工行转账流水号 202603081030001234",
  "paidAt": "2026-03-08T10:00:00Z"
}
```

| 字段 | 必填 | 说明 |
|------|------|------|
| paidAmount | 是 | 代理商录入的实收金额；**≥ 0**；写入 **`bills.paid_amount`**；不与 **`total_amount`** 强校验 |
| paymentRef | 是 | 支付凭证号 / 内部参考号 |
| paymentProof | 否 | 客户→代理商付款佐证（如银行转账流水单备注） |
| paidAt | 否 | 支付时间，默认当前时间 |

**前置条件**: 账单状态为 **PUBLISHED** 或 **OVERDUE**  
**后置**: 状态 → **PAID**，写 `paid_at`、`paid_amount`、`payment_ref`、可选 `payment_proof`，触发 **`PAYMENT_CONFIRMED`** 事件

**Response 200**:
```json
{
  "billId": "uuid",
  "status": "PAID",
  "paidAmount": 15480.50,
  "paymentRef": "PAY-2026030801",
  "paymentProof": "工行转账流水号 202603081030001234",
  "paidAt": "2026-03-08T10:00:00Z"
}
```

### 1.7 坏账核销（OVERDUE → WRITTEN_OFF）

```
POST /v1/bills/{billId}:write-off
```

**权限**（租户范围同 §1.2；需 **`bills.read`**）:
- **platform admin / admin API key**：任意 `billId`
- **reseller token**：仅下属企业账单
- **customer / department token**（JWT 或 API key）：**禁止**（**403**）

**Request Body**:
```json
{
  "reason": "账龄超过 180 天，销售确认无法收回"
}
```

**前置条件**: 账单状态为 **OVERDUE**  
**后置**: 状态 → **WRITTEN_OFF**（终态），写 **`written_off_at`**、**`write_off_reason`**，事件 **`BILL_WRITTEN_OFF`**

**Response 200**:
```json
{
  "billId": "uuid",
  "status": "WRITTEN_OFF",
  "totalAmount": 15800.75,
  "writtenOffAt": "2026-06-05T14:00:00Z",
  "reason": "账龄超过 180 天，销售确认无法收回"
}
```

---

## 2. 调账管理

### 2.1 创建调账单

```
POST /v1/bills/{billId}:adjust
```

**权限**: 代理商管理员（需 **`bills.adjust`**）；**customer / department token**（JWT 或 API key）**禁止**（**403**）

**Request Body**:
```json
{
  "type": "CREDIT | DEBIT",
  "reason": "string (required)",
  "idempotencyKey": "string (optional, 客户端幂等键)",
  "items": [
    {
      "iccid": "string (optional, SIM 级别调账)",
      "description": "string (required)",
      "amount": "number (required, > 0)"
    }
  ]
}
```

**前置条件**: 账单状态为 PUBLISHED 或 OVERDUE（不可对 GENERATED/PAID/WRITTEN_OFF 调账）

**业务规则**:
- 已发布账单不可篡改，差异通过 Credit/Debit Note 处理
- **同一 `billId` 允许多次调账**（不同 `idempotencyKey`、不同原因/类型/金额）；每次创建独立 **`adjustmentNoteId`**
- **`idempotencyKey`（可选）**：防重复提交（双击、网络重试）；**不限制**合法的多笔调账
- **`items[].iccid`（可选）**：若提供 **MUST** 为非空且属于该账单 **`enterpriseId`** 下已入库 SIM；`:adjust` 与 `:approve` 均校验，失败 **404 `SIM_NOT_FOUND`**（空串 **400 `INVALID_ICCID`**）。省略 `iccid` 表示非 SIM 级手工行。
- **`billing:generate` 合并**：不因无效 ICCID 阻断 Job；合并完成后写入 **`BILL_ADJUSTMENT_ICCID_WARNING`** 事件，Job 结果含 **`adjustmentIccidWarnings`**（若有）。

**幂等（`idempotencyKey`）**:

| 场景 | HTTP | 说明 |
|------|------|------|
| 首次提交（新 key 或省略 key） | **201** | 创建 **DRAFT** Note |
| 相同 **`billId` + `idempotencyKey`**（无论请求体是否一致） | **409** | **`IDEMPOTENCY_CONFLICT`** — 键已用于该账单，不重复创建 |
| 省略 **`idempotencyKey`** 或 **`null`** | — | 每次调用均新建 Note（兼容旧客户端） |
| 显式 **`""`** 或仅空白字符 | **400** | **`BAD_REQUEST`** — `idempotencyKey must be a non-empty string when provided.` |

**唯一性真源（实现）**：`(source_bill_id, idempotency_key)`，`idempotency_key IS NOT NULL` 时唯一；`source_bill_id` 为关联原账单 **`billId`**（见 Phase 40 迁移）。

**Response 201**:
```json
{
  "adjustmentNoteId": "uuid",
  "billId": "uuid",
  "type": "CREDIT",
  "status": "DRAFT",
  "totalAmount": 200.00,
  "idempotencyKey": "client-key-001",
  "items": [...],
  "createdAt": "2026-03-08T10:00:00Z"
}
```

### 2.2 审批调账单

```
POST /v1/adjustment-notes/{noteId}:approve
```

**权限**: 需 **`bills.adjust.approve`**（**reseller_admin** 已 seed）；**platform admin / admin API key** 不受 RBAC 限制；**customer / department token**（JWT 或 API key）**禁止**（**403**）

**业务规则**: 创建者 **不可** 审批自己创建的调账单（对比 **`BILL_ADJUSTMENT_NOTE_CREATED`** 事件的 **`actor_user_id`**）；违反时 **403**

**审计**: 成功后写入 **`BILL_ADJUSTMENT_NOTE_APPROVED`** 事件

**Canonical 运行时**: Fastify（`npm run build` → `npm run start:ts`）。见 [.cursor/rules/fastify-single-stack.mdc](../../.cursor/rules/fastify-single-stack.mdc)。

**后置**: DRAFT → APPROVED；**不修改**原 **`bills.total_amount`**。审批通过的 Note 在**下一次** `POST /v1/billing:generate` 出账时合并进**新账单**的 **`total_amount`**（`ratingTotal + Σ(DEBIT) − Σ(CREDIT)`，同币种 **APPROVED** Note）；合并后 Note → **APPLIED**，写入 **`BILL_ADJUSTMENT_NOTE_APPLIED`**。详见 [adjustment-settlement.md](../clarifications/adjustment-settlement.md)。

**Response 200**:
```json
{
  "adjustmentNoteId": "uuid",
  "status": "APPROVED",
  "totalAmount": 200.00,
  "currency": "CNY"
}
```

### 2.3 查询调账单列表

```
GET /v1/adjustment-notes?billId={}&type={}&status={}&page={}&pageSize={}
```

**权限**: 需 **`bills.adjust.list`**（**reseller_admin** 已 seed）；**platform admin / admin API key** 不受 RBAC 限制；**customer / department token** **禁止**（**403**）

**租户范围**:
- **platform admin / admin API key**：可列全部（可用 query 过滤）
- **reseller token**：仅 **`enterprise_id`** 属于该 reseller 下属企业的调账单
- **`billId` 过滤**：账单须在 caller 可见范围内，否则 **404**（不泄露跨租户 bill 存在性）

**Query**:
| 参数 | 类型 | 说明 |
|------|------|------|
| billId | uuid | 可选，关联原账单 |
| type | string | CREDIT / DEBIT |
| status | string | DRAFT / APPROVED / APPLIED / CANCELLED |
| page | integer | 默认 1 |
| pageSize | integer | 默认 20，最大 200 |

**Response 200**:
```json
{
  "items": [
    {
      "adjustmentNoteId": "uuid",
      "billId": "uuid",
      "enterpriseId": "uuid",
      "enterpriseName": "Acme IoT",
      "type": "CREDIT",
      "status": "DRAFT",
      "totalAmount": 200.00,
      "currency": "CNY",
      "reason": "goodwill credit",
      "idempotencyKey": "client-key-001",
      "createdAt": "2026-03-08T10:00:00Z"
    }
  ],
  "total": 1,
  "page": 1,
  "pageSize": 20
}
```

列表项 **SHOULD** 含 **`billId`**、**`reason`**、**`idempotencyKey`**（若创建时提供），便于核对历史、避免重复操作。

---

## 3. 出账触发

### 3.1 手动触发出账

```
POST /v1/billing:generate
```

**权限**: 系统管理员（platform admin / reseller admin）；**customer / department token**（JWT 或 API key）**禁止**（**403**）

**Request Body**:
```json
{
  "resellerId": "uuid (optional, platform admin 可传；reseller token 须与 JWT 一致或省略)",
  "enterpriseId": "uuid (optional, 为空则按 scope 内全部企业)",
  "period": "string (required, e.g. '2026-02')",
  "idempotencyKey": "string (optional, 客户端幂等键)"
}
```

**幂等（`idempotencyKey`）**:

出账范围由 **`period` + `resellerId` + `enterpriseId`**（与请求体及 token 解析结果一致）与 **`idempotencyKey`** 共同标识一次出账意图。

| 场景 | HTTP | 说明 |
|------|------|------|
| 首次提交 | **202** | 创建 **`BILLING_GENERATE`** Job（**QUEUED**） |
| 相同 scope + 相同 **`idempotencyKey`**，Job 仍 **QUEUED/RUNNING** | **202** | 返回**同一 `jobId`** |
| 相同 scope + 相同 **`idempotencyKey`**，Job 已成功完成 | **200** 或 **202** | 返回同一 **`jobId`** 及已有结果摘要（**`period`**、已生成 **`billId`** 列表等，以实现为准） |
| 相同 **`idempotencyKey`** 但 **`period` / `resellerId` / `enterpriseId`** 不一致 | **409** | **`IDEMPOTENCY_CONFLICT`** |
| 省略 **`idempotencyKey`** 或 **`null`** | — | 每次调用均新建 Job（兼容旧客户端；Worker 仍对 **enterprise+period** 跳过重复 bill） |
| 显式 **`""`** 或仅空白字符 | **400** | **`BAD_REQUEST`** — `idempotencyKey must be a non-empty string when provided.` |

**实现真源**：`jobs.job_type = BILLING_GENERATE` 且 `jobs.idempotency_key` 非空时唯一（见 Phase 40 迁移）。Cron 自动出账 **MAY** 使用服务端生成的 **`idempotencyKey`**（如 `cron:{resellerId}:{period}`）。

**Response 202**:
```json
{
  "jobId": "uuid",
  "period": "2026-02",
  "status": "QUEUED",
  "idempotencyKey": "client-key-billing-001"
}
```

**自动出账**: T+N 日（N 默认 3），由 Cron Job 触发，流程同手动。

### 3.2 出账流程

```
1. 数据归集 → 锁定 usage_daily_summary + sim_state_history
2. 批价计费 → 按资费计划规则计算（高水位月租 + Waterfall 用量），得到 ratingTotal
3. 调账合并 → 加载该企业 status=APPROVED 且 currency 一致的 adjustment_notes；
   nextTotal = ratingTotal + Σ(DEBIT) − Σ(CREDIT)；写入 bill_line_items（ADJUSTMENT_CREDIT / ADJUSTMENT_DEBIT）；Note → APPLIED
4. 账单生成 → GENERATED 状态，total_amount = nextTotal，含 L1/L2/L3 + 调账行
5. 发布通知 → PUBLISHED，触发 BILL_PUBLISHED 事件
```

---

## 4. 计费引擎规则（内部逻辑，非 API）

### 4.1 月租费计算（高水位 High-Water Mark）

基于 `sim_state_history` 表，按 SIM 在自然月内的状态轨迹判定：

| 条件 | 费用项 |
|------|--------|
| 账期内曾 ACTIVATED（哪怕 1 秒） | 全额 monthlyFee |
| 未曾 ACTIVATED，但曾 DEACTIVATED | deactivatedMonthlyFee |
| 仅 INVENTORY / TEST_READY | 无月租 |

- 月租费与停机保号费绝对互斥

### 4.2 用量匹配（Waterfall Logic）

```
1. 时间窗匹配：查找 SIM 在事件时刻的所有有效订阅
2. 订阅 / 资费优先级（与产品规则一致）：
   a. ADD_ON 叠加包优先
   b. 覆盖范围最小优先（France > Europe > Global）
   c. MAIN 主套餐兜底
3. 对已定订阅与 Price Plan，按拜访地 (MCC,MNC) 判定套内 / 套外（与 [pricing-api.md §4](pricing-api.md) 一致）：
   a. in-profile：若 (MCC,MNC) 属于该 Plan 所引 **CoveredNetworkProfile**（**`coveredNetworkProfileId`**）覆盖集 → 套内规则
   b. out-of-profile：否则 → **仅** 经 **Package → Carrier Service → `roamingProfileId`** 解析 **Roaming Profile** 套外单价（**不** 使用 Price Plan 上的 **`roamingProfileId`**）
   c. 若同一 Plan 上仍存在 **Zone-based `paygRates`** 等，与 (a)(b) 的相对优先级 **MUST** 与 OpenAPI / 资费契约一致（实现见批价引擎）
4. 计费处理：
   - In-Profile 配额未耗尽：扣减配额
   - In-Profile 配额耗尽：按 overageRatePerMb 等对套内耗尽后的约定计费
   - Out-of-Profile：不扣减套餐内池化 in-profile 配额；套外按 Roaming 条目及/或 **paygRates** 等（以步骤 3(c) 优先级为准）+ 可触发异常漫游类告警
```

### 4.3 SIM Dependent Bundle 动态池

```
totalQuotaMb = activatedSimCount(高水位) × perSimQuotaMb
费用 = Σ(activated × monthlyFee) + Σ(deactivated × deactivatedMonthlyFee) + overageCharge
```

### 4.4 计费可追溯

每条 `rating_results` 记录包含:
- `inputRef`: 话单来源（fileId + lineNo）
- `ruleVersion`: 资费计划版本 ID
- `calculationId`: 本次计算唯一 ID

---

## 5. 迟到话单处理

```
判定：话单 eventTime 落在已 PUBLISHED 账期窗口内

处理流程：
1. 话单正常入库 usage_daily_summary
2. 运行计费引擎计算差额
3. 自动生成 Adjustment Note（DRAFT），关联 inputRef + calculationId
4. 等待审核 → APPROVED → 计入下期结算
```

---

## 6. 企业欠费汇总

### 6.1 查询企业欠费汇总

```
GET /v1/enterprises/{enterpriseId}/overdue-summary
```

**权限**:
- **platform** / **platform_admin**（JWT 或 admin API key）
- 代理商 **reseller_admin** / **reseller_sales** / **reseller_sales_director**（企业必须在代理商范围内）
- **customer** / **department** JWT，或企业 **ApiKeyAuth**（`X-API-Key` / `customer_m2m`）：path **`enterpriseId`** 必须与 token 绑定企业一致

**说明**: 该接口仅返回企业级欠费汇总和风险提示，不发送邮件/短信，不自动变更企业状态，不自动停复机。

**Response 200**:
```json
{
  "enterpriseId": "uuid",
  "overdueRiskLevel": "NORMAL | WARNING | HIGH | CRITICAL",
  "overdueAmount": 15480.50,
  "oldestOverdueBillId": "uuid",
  "oldestOverduePeriod": "2026-01",
  "daysOverdue": 15,
  "gracePeriodDays": 3,
  "recommendedAction": "MANUAL_REVIEW_RECOMMENDED",
  "nextActionDate": "2026-02-18T00:00:00Z",
  "autoSuspendEnabled": false,
  "lateFeeAmount": 12.5
}
```

### 6.2 欠费风险时间轴

```
账单日(T)      到期日(T+N)    宽限期结束        较高风险         严重风险
   │              │              │                │                │
   ├──PUBLISHED──►├──OVERDUE────►├──WARNING──────►├──HIGH─────────►├──CRITICAL
   │              │              │                │                │
   │              │              ▼                ▼                ▼
   │              │         离线提醒建议      管理员手工评估    管理员手工决策
```

### 6.3 欠费处理入口

对外不提供 `resolve` 类催缴解除接口。欠费的商业处理应通过 Billing 模块已有账单动作完成：

- `POST /v1/bills/{billId}:mark-paid`：财务确认收款后人工核销。
- `POST /v1/bills/{billId}:write-off`：坏账核销。
- `POST /v1/bills/{billId}:void`：账单作废。
- `POST /v1/bills/{billId}:adjust`：调账并进入下期结算。

---

## 7. 用量查询

### 7.1 SIM 用量汇总

```
GET /v1/sims/{iccid}/usage?startDate={}&endDate={}&page={}&pageSize={}
GET /v1/sims/{iccid}/usage:csv?startDate={}&endDate={}&page={}&pageSize={}
```

**用途**：用于在一个计费周期内，按指定 ICCID 查询 Rating 之后的用量归集结果。数据来自 `usage_package_daily_summary`，表示该 SIM 的用量已经归集到对应订阅的产品包 / 资费计划（或默认 fallback package）中；不返回原始 CDR 或 `usage_daily_summary` 日源记录。

**CSV 导出**：`usage:csv` 与 JSON 接口使用相同输入参数、过滤条件与权限判断；由于是文件导出，`pageSize` 默认 100，最大 1000。

**权限**: 按租户范围隔离；customer token 可不传 `enterpriseId`，若传则必须是数据库存在且与 token 匹配的 enterprise。

**Response 200**:
```json
{
  "items": [
    {
      "iccid": "89860012345678901234",
      "usageDay": "2026-06-01",
      "subscriptionId": "uuid",
      "packageId": "uuid",
      "pricePlanId": "uuid",
      "pricePlanType": "FIXED_BUNDLE",
      "inProfileMb": 100,
      "outOfProfileMb": 5,
      "totalMb": 105,
      "amount": 12.34,
      "currency": "CNY"
    }
  ],
  "total": 30,
  "page": 1,
  "pageSize": 20
}
```

### 7.2 企业用量汇总

```
GET /v1/enterprises/{enterpriseId}/usage?period={}
```

**Response 200**:
```json
{
  "enterpriseId": "uuid",
  "period": "2026-02",
  "totalUsageKb": 107374182400,
  "activatedSimCount": 500,
  "byPackage": [
    {
      "packageId": "uuid",
      "packageName": "Global 1GB",
      "quotaMb": 512000,
      "usedMb": 409600,
      "usagePercent": 80.0,
      "overageMb": 0
    }
  ]
}
```

---

## 8. 账单状态机

实现：`src/services/billStatusMachine.ts`（`getNextBillStatus` / `transitionBillStatus`）。  
详细 FAQ 见 [clarifications/bill-status-machine.md](../clarifications/bill-status-machine.md)。

### 8.1 状态枚举

| 状态 | 说明 |
|------|------|
| GENERATED | 出账完成，未对外发布 |
| VOIDED | 已作废（保留审计；同账期可再出账） |
| PUBLISHED | 已发布，等待付款 |
| PAID | 已支付（终态） |
| OVERDUE | 已逾期 |
| WRITTEN_OFF | 已核销坏账（终态） |

### 8.2 流转图

```
GENERATED ──publish──► PUBLISHED ──pay──► PAID
                          │
                          ├──overdue──► OVERDUE ──pay──► PAID
                          │                │
                          │                └──write_off──► WRITTEN_OFF
```

### 8.3 允许的动作

| 当前状态 | 动作 | 下一状态 | 触发方式 |
|----------|------|----------|----------|
| GENERATED | `publish` | PUBLISHED | **POST /bills/{billId}:publish**；或出账 Worker（`auto_publish`） |
| PUBLISHED | `pay` | PAID | **POST /bills/{billId}:mark-paid** |
| PUBLISHED | `overdue` | OVERDUE | Dunning 定时任务（`due_date` 已过） |
| OVERDUE | `pay` | PAID | **POST /bills/{billId}:mark-paid** |
| OVERDUE | `write_off` | WRITTEN_OFF | **POST /bills/{billId}:write-off** |

非法转换返回 **409 `INVALID_STATUS`**（含 **GENERATED**、**PAID**、**WRITTEN_OFF**、**VOIDED** 上执行 `pay`）。

### 8.4 副作用

| 目标状态 | 更新字段 | 领域事件 |
|----------|----------|----------|
| PUBLISHED | `published_at`, `due_date` | `BILL_PUBLISHED` |
| PAID | `paid_at`, `paid_amount`, `payment_ref`, `payment_proof`（可选） | `PAYMENT_CONFIRMED` |
| OVERDUE | `overdue_at` | — |
| WRITTEN_OFF | `written_off_at`, `write_off_reason` | `BILL_WRITTEN_OFF` |

### 8.5 业务约束

- **GENERATED**：可修改（追加 line items）；可 **publish**
- **PUBLISHED**：不可直接改金额；差异通过 **Adjustment Note**（`:adjust`）处理
- **PAID** / **WRITTEN_OFF**：终态，不可再转换
