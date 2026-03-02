# API 契约：计费、出账与信控

**Feature**: `iot-cmp-reseller` | **Date**: 2026-02-08
**关联 User Story**: US5（计费引擎）、US6（账单与出账）、US7（信控催收）
**关联需求**: FR-023 ~ FR-034

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
| enterpriseId | uuid | 否 | 企业 ID |
| resellerId | uuid | 否 | 代理商 ID（系统管理员用） |
| period | string | 否 | 账期 e.g. "2026-02" |
| status | string | 否 | GENERATED/PUBLISHED/PAID/OVERDUE/WRITTEN_OFF |
| page | integer | 否 | 默认 1 |
| pageSize | integer | 否 | 默认 20 |

**Response 200**:
```json
{
  "items": [
    {
      "billId": "uuid",
      "enterpriseId": "uuid",
      "enterpriseName": "string",
      "resellerId": "uuid",
      "period": "2026-02",
      "status": "PUBLISHED",
      "currency": "CNY",
      "totalAmount": 15680.50,
      "previousBalance": 0,
      "currentCharges": 15680.50,
      "adjustments": -200.00,
      "amountDue": 15480.50,
      "dueDate": "2026-03-31",
      "publishedAt": "2026-03-04T00:00:00Z",
      "createdAt": "2026-03-03T10:00:00Z"
    }
  ],
  "total": 12
}
```

### 1.2 查询账单详情

```
GET /v1/bills/{billId}
```

**权限**: 代理商角色（授权范围） | 企业管理员

**Response 200** — 三级结构:

```json
{
  "billId": "uuid",
  "enterpriseId": "uuid",
  "period": "2026-02",
  "status": "PUBLISHED",
  "currency": "CNY",

  "l1Summary": {
    "previousBalance": 0,
    "currentCharges": 15680.50,
    "adjustments": -200.00,
    "amountDue": 15480.50,
    "dueDate": "2026-03-31"
  },

  "l2Groups": [
    {
      "groupKey": "dept_001",
      "groupType": "DEPARTMENT",
      "groupName": "研发部",
      "subtotal": 8000.00,
      "simCount": 50,
      "monthlyFeeTotal": 5000.00,
      "usageChargeTotal": 2500.00,
      "overageChargeTotal": 500.00
    },
    {
      "groupKey": "pkg_global_1gb",
      "groupType": "PACKAGE",
      "groupName": "Global 1GB",
      "subtotal": 7680.50
    }
  ],

  "l3LineItemsUrl": "/v1/bills/{billId}/line-items?page=1&pageSize=100"
}
```

### 1.3 查询账单明细（L3）

```
GET /v1/bills/{billId}/line-items?groupKey={}&page={}&pageSize={}
```

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
      "usageKb": 1073741824,
      "groupKey": "dept_001",
      "groupType": "DEPARTMENT"
    }
  ],
  "total": 500
}
```

### 1.4 下载账单文件

```
GET /v1/bills/{billId}/files?format={format}
```

**权限**: 代理商角色 | 企业管理员

**Query Parameters**:
| 参数 | 类型 | 说明 |
|------|------|------|
| format | string | `pdf` (品牌化汇总) / `csv` (SIM 明细，百万级行) |

**Response 200**: 文件下载流或预签名 URL

```json
{
  "downloadUrl": "https://storage.example.com/bills/2026-02/xxx.pdf?token=...",
  "expiresAt": "2026-03-08T10:00:00Z",
  "format": "pdf",
  "sizeBytes": 1048576
}
```

### 1.5 人工核销（标记已付）

```
POST /v1/bills/{billId}:mark-paid
```

**权限**: 代理商管理员 | 代理商财务

**Request Body**:
```json
{
  "paidAmount": "number (required)",
  "paymentRef": "string (required, 支付凭证号)",
  "paidAt": "datetime (optional, default now)"
}
```

**前置条件**: 账单状态为 PUBLISHED 或 OVERDUE
**后置**: 状态 → PAID，触发 `PAYMENT_CONFIRMED` 事件

**Response 200**:
```json
{
  "billId": "uuid",
  "status": "PAID",
  "paidAmount": 15480.50,
  "paymentRef": "PAY-2026030801",
  "paidAt": "2026-03-08T10:00:00Z"
}
```

---

## 2. 调账管理

### 2.1 创建调账单

```
POST /v1/bills/{billId}:adjust
```

**权限**: 代理商管理员

**Request Body**:
```json
{
  "type": "CREDIT | DEBIT",
  "reason": "string (required)",
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
**业务规则**: 已发布账单不可篡改，差异通过 Credit/Debit Note 处理

**Response 201**:
```json
{
  "adjustmentNoteId": "uuid",
  "billId": "uuid",
  "type": "CREDIT",
  "status": "DRAFT",
  "totalAmount": 200.00,
  "items": [...],
  "createdAt": "2026-03-08T10:00:00Z"
}
```

### 2.2 审批调账单

```
POST /v1/adjustment-notes/{noteId}:approve
```

**权限**: 代理商管理员（非创建者审批）

**后置**: DRAFT → APPROVED → 调账金额计入下期结算

### 2.3 查询调账单列表

```
GET /v1/adjustment-notes?billId={}&type={}&status={}&page={}&pageSize={}
```

---

## 3. 出账触发

### 3.1 手动触发出账

```
POST /v1/billing:generate
```

**权限**: 系统管理员

**Request Body**:
```json
{
  "enterpriseId": "uuid (optional, 为空则全部企业)",
  "period": "string (required, e.g. '2026-02')"
}
```

**Response 202**:
```json
{
  "jobId": "uuid",
  "period": "2026-02",
  "status": "QUEUED"
}
```

**自动出账**: T+N 日（N 默认 3），由 Cron Job 触发，流程同手动。

### 3.2 出账流程

```
1. 数据归集 → 锁定 usage_daily_summary + sim_state_history
2. 批价计费 → 按资费计划规则计算（高水位月租 + Waterfall 用量）
3. 账单生成 → GENERATED 状态，含 L1/L2/L3
4. 发布通知 → PUBLISHED，触发 BILL_PUBLISHED 事件
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
2. 区域匹配 + 优先级排序：
   a. ADD_ON 叠加包优先
   b. 覆盖范围最小优先（France > Europe > Global）
   c. MAIN 主套餐兜底
   d. 无覆盖 → Out-of-Profile
3. 计费处理：
   - In-Profile 配额未耗尽：扣减配额
   - In-Profile 配额耗尽：按 overageRatePerKb 套外计费
   - Out-of-Profile：不扣减任何套餐配额，按 paygRates 独立计费 + 异常漫游告警
```

### 4.3 SIM Dependent Bundle 动态池

```
totalQuotaKb = activatedSimCount(高水位) × perSimQuotaKb
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

## 6. Dunning 信控流程

### 6.1 查询企业 Dunning 状态

```
GET /v1/enterprises/{enterpriseId}/dunning
```

**权限**: 代理商管理员 | 代理商财务

**Response 200**:
```json
{
  "enterpriseId": "uuid",
  "dunningStatus": "NORMAL | OVERDUE_WARNING | SUSPENDED | SERVICE_INTERRUPTED",
  "overdueAmount": 15480.50,
  "oldestOverdueBillId": "uuid",
  "oldestOverduePeriod": "2026-01",
  "daysOverdue": 15,
  "gracePeriodDays": 3,
  "nextAction": "MANUAL_REVIEW",
  "nextActionDate": "2026-02-18T00:00:00Z",
  "autoSuspendEnabled": false
}
```

### 6.2 Dunning 时间轴

```
账单日(T)      到期日(T+N)    宽限期结束        管控触发         服务阻断
   │              │              │                │                │
   ├──PUBLISHED──►├──OVERDUE────►├──GRACE_PERIOD─►├──SUSPENDED────►├──SERVICE_INTERRUPTED
   │              │              │                │                │
   │              │              ▼                ▼                ▼
   │              │         每日催收邮件      管理员手工评估    管理员手工决策
```

### 6.3 手动解除 Dunning

```
POST /v1/enterprises/{enterpriseId}/dunning:resolve
```

**权限**: 代理商管理员

**前置**: 企业已缴清所有逾期欠费
**后置**: Dunning 状态恢复 NORMAL；企业状态需由代理商管理员通过企业状态接口手工恢复

**欠费结清顺序**: 最早逾期账单 → 滞纳金 → 当前账单

---

## 7. 用量查询

### 7.1 SIM 用量汇总

```
GET /v1/sims/{simId}/usage?period={}&zone={}
```

**权限**: 按租户范围隔离

**Response 200**:
```json
{
  "simId": "uuid",
  "iccid": "string",
  "period": "2026-02",
  "totalUsageKb": 5242880,
  "byZone": [
    {
      "visitedMccMnc": "208-01",
      "countryName": "France",
      "usageKb": 3145728,
      "matchedPackage": "France 500MB",
      "matchType": "ADD_ON"
    },
    {
      "visitedMccMnc": "424-02",
      "countryName": "UAE",
      "usageKb": 2097152,
      "matchedPackage": null,
      "matchType": "OUT_OF_PROFILE"
    }
  ]
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
      "quotaKb": 524288000,
      "usedKb": 419430400,
      "usagePercent": 80.0,
      "overageKb": 0
    }
  ]
}
```

---

## 8. 账单状态机

```
GENERATED ──publish──► PUBLISHED ──pay──► PAID
                           │
                           ├──overdue──► OVERDUE ──pay──► PAID
                           │                │
                           │                └──write-off──► WRITTEN_OFF
                           │
                           └──(不可逆)
```

**约束**:
- GENERATED: 可修改（追加 line items）
- PUBLISHED: 不可篡改，仅可通过 Adjustment Note 调账
- PAID / WRITTEN_OFF: 终态
