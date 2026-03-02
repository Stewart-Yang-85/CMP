# API 契约：SIM 生命周期管理

**Feature**: `iot-cmp-reseller` | **Date**: 2026-02-08
**关联 User Story**: US2（SIM 卡资产入库与生命周期管理）
**关联需求**: FR-008 ~ FR-014

---

## 1. SIM 导入

### 1.1 创建导入任务

```
POST /v1/sims/import-jobs
```

**权限**: 代理商管理员（不对企业开放）

**Request Body** (`multipart/form-data`):
| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| file | file | 是 | CSV 文件（最大 10 万条） |
| supplierId | uuid | 是 | 供应商 ID |
| enterpriseId | uuid | 否 | 企业归属（为空则入库存） |
| batchId | string | 否 | 幂等键（同 batchId 不重复导入） |

**CSV 必填列**: `iccid`, `imsi`, `apn`, `operatorId`
**CSV 可选列**: `msisdn`, `secondaryImsi1`, `secondaryImsi2`, `secondaryImsi3`, `formFactor`, `activationCode`, `imei`, `imeiLockEnabled`

**Response 202**:
```json
{
  "jobId": "uuid",
  "status": "QUEUED",
  "totalRows": 50000,
  "createdAt": "2026-02-08T10:00:00Z"
}
```

**Error Responses**:
| 状态码 | code | 说明 |
|--------|------|------|
| 400 | FILE_TOO_LARGE | 超过 10 万条上限 |
| 400 | INVALID_FORMAT | CSV 格式错误 |
| 409 | DUPLICATE_BATCH | 同 batchId 已存在 |
| 404 | SUPPLIER_NOT_FOUND | 供应商不存在 |

**幂等**: batchId 或 fileHash（文件内容 SHA-256）

### 1.2 查询任务进度

```
GET /v1/jobs/{jobId}
```

**权限**: 任务创建者 | 代理商管理员

**Response 200**:
```json
{
  "jobId": "uuid",
  "type": "SIM_IMPORT",
  "status": "RUNNING",
  "progress": {
    "processed": 25000,
    "total": 50000,
    "succeeded": 24800,
    "failed": 200
  },
  "errorSummary": "200 rows failed: 150 duplicate ICCID, 50 invalid carrier",
  "createdAt": "2026-02-08T10:00:00Z",
  "updatedAt": "2026-02-08T10:05:00Z"
}
```

### 1.3 取消任务

```
POST /v1/jobs/{jobId}:cancel
```

**权限**: 任务创建者 | 代理商管理员
**前置**: 仅 QUEUED / RUNNING 可取消

---

## 2. SIM 单张录入

### 2.1 创建 SIM

```
POST /v1/sims
```

**权限**: 代理商管理员

**Request Body**:
```json
{
  "iccid": "string (required, 18-20 digits, globally unique)",
  "imsi": "string (required, Primary IMSI)",
  "secondaryImsi1": "string (optional)",
  "secondaryImsi2": "string (optional)",
  "secondaryImsi3": "string (optional)",
  "msisdn": "string (optional)",
  "apn": "string (required)",
  "supplierId": "uuid (required)",
  "operatorId": "uuid (required)",
  "enterpriseId": "uuid (optional)",
  "formFactor": "consumer_removable | industrial_removable | consumer_embedded | industrial_embedded (optional, default consumer_removable)",
  "activationCode": "string (optional, eSIM 时填写)",
  "imei": "string (optional, 15 digits)",
  "imeiLockEnabled": "boolean (optional, default false)"
}
```

**Response 201**:
```json
{
  "simId": "uuid",
  "iccid": "89860012345678901234",
  "status": "INVENTORY",
  "createdAt": "2026-02-08T10:00:00Z"
}
```

**Error Responses**:
| 状态码 | code | 说明 |
|--------|------|------|
| 409 | DUPLICATE_ICCID | ICCID 已存在 |
| 400 | INVALID_OPERATOR | 运营商未关联到供应商 |

---

## 3. SIM 查询

### 3.1 查询 SIM 列表

```
GET /v1/sims?enterpriseId={}&status={}&supplierId={}&operatorId={}&iccid={}&page={}&pageSize={}
```

**权限**: 按租户范围隔离

**Query Parameters**:
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| enterpriseId | uuid | 否 | 企业筛选 |
| departmentId | uuid | 否 | 部门筛选 |
| status | string | 否 | SIM 状态筛选 |
| supplierId | uuid | 否 | 供应商筛选 |
| operatorId | uuid | 否 | 运营商筛选 |
| iccid | string | 否 | ICCID 精确/前缀搜索 |
| page | integer | 否 | 默认 1 |
| pageSize | integer | 否 | 默认 20，最大 100 |

**Response 200**:
```json
{
  "items": [
    {
      "simId": "uuid",
      "iccid": "string",
      "imsi": "string",
      "msisdn": "string",
      "status": "ACTIVATED",
      "lifecycleSubStatus": "normal",
      "upstreamStatus": "string",
      "upstreamStatusUpdatedAt": "2026-02-08T10:00:00Z",
      "formFactor": "consumer_removable",
      "supplierId": "uuid",
      "supplierName": "string",
      "operatorId": "uuid",
      "operatorName": "string",
      "mcc": "460",
      "mnc": "00",
      "enterpriseId": "uuid",
      "enterpriseName": "string",
      "departmentId": "uuid",
      "apn": "cmiot",
      "activationDate": "2026-01-15T10:00:00Z",
      "totalUsageBytes": 1073741824,
      "imei": "string"
    }
  ],
  "total": 5000,
  "page": 1,
  "pageSize": 20
}
```

### 3.2 查询 SIM 详情

```
GET /v1/sims/{simId}
```

**权限**: 按租户范围隔离（企业运维仅可见所属部门 SIM）

**Response 200**: 完整 SIM 信息 + 当前订阅 + 用量汇总

### 3.3 查询 SIM 状态历史

```
GET /v1/sims/{simId}/state-history?from={from}&to={to}
```

**Response 200**:
```json
{
  "items": [
    {
      "status": "ACTIVATED",
      "startTime": "2026-01-15T10:00:00Z",
      "endTime": "2026-02-20T08:00:00Z",
      "changedBy": "uuid",
      "reason": "Customer activation"
    }
  ]
}
```

---

## 4. SIM 状态操作

### 4.1 激活

```
POST /v1/sims/{simId}:activate
```

**权限**: 代理商管理员 | 代理商销售
**前置条件**: SIM 状态为 INVENTORY 或 TEST_READY 或 DEACTIVATED
**异步**: 返回 jobId，通过上游 API 执行

**Request Body**:
```json
{
  "reason": "string (optional)",
  "idempotencyKey": "string (optional)"
}
```

**Response 202**:
```json
{
  "jobId": "uuid",
  "simId": "uuid",
  "requestedStatus": "ACTIVATED",
  "currentStatus": "INVENTORY",
  "message": "Activation request submitted"
}
```

**状态机约束**:
- INVENTORY → ACTIVATED: ✅
- TEST_READY → ACTIVATED: ✅
- DEACTIVATED → ACTIVATED: ✅（复机）
- ACTIVATED → ACTIVATED: ❌ 409 ALREADY_ACTIVATED
- RETIRED → ACTIVATED: ❌ 409 TERMINAL_STATE

**信控约束**: 企业 SUSPENDED 时，企业用户不可复机（403 ENTERPRISE_SUSPENDED）

### 4.2 停机

```
POST /v1/sims/{simId}:deactivate
```

**权限**: 代理商管理员 | 代理商销售 | 系统自动（达量断网）
**前置条件**: SIM 状态为 ACTIVATED 或 TEST_READY

**Request Body**:
```json
{
  "reason": "string (optional)",
  "idempotencyKey": "string (optional)"
}
```

### 4.3 复机

```
POST /v1/sims/{simId}:reactivate
```

**权限**: 代理商管理员
**前置条件**: SIM 状态为 DEACTIVATED
**信控约束**: 企业 SUSPENDED 时禁止企业用户复机

### 4.4 拆机

```
POST /v1/sims/{simId}:retire
```

**权限**: 仅代理商管理员
**前置条件**: SIM 状态为 DEACTIVATED（禁止 ACTIVATED → RETIRED）
**承诺期校验**: `max(firstSubscribedAt_i + commitmentPeriod_i)` 必须已过期；豁免拆机可跳过承诺期校验，仍需二次确认

**Request Body**:
```json
{
  "confirm": true,
  "reason": "string (required)",
  "commitmentExempt": false
}
```

**Error Responses**:
| 状态码 | code | 说明 |
|--------|------|------|
| 409 | NOT_DEACTIVATED | 必须先停机 |
| 409 | COMMITMENT_NOT_MET | 承诺期未满 |
| 400 | CONFIRMATION_REQUIRED | 需要 confirm=true |
| 403 | COMMITMENT_EXEMPT_FORBIDDEN | 非管理员不允许豁免拆机 |

---

## 5. SIM 批量操作

### 5.1 批量停机（企业状态手工联动）

```
POST /v1/sims:batch-deactivate
```

**权限**: 代理商管理员

**Request Body**:
```json
{
  "enterpriseId": "uuid (required)",
  "reason": "string (required)",
  "idempotencyKey": "string (optional)"
}
```

**Response 202**:
```json
{
  "jobId": "uuid",
  "enterpriseId": "uuid",
  "affectedSimCount": 1500,
  "status": "QUEUED"
}
```

---

## 6. 状态机总览

```
INVENTORY ──── activate ────► ACTIVATED
    │                             │
    └── activate ──► TEST_READY   │ deactivate
                       │          ▼
                       └───► DEACTIVATED
                                  │
                           retire │ (仅代理商管理员, 承诺期校验)
                                  ▼
                              RETIRED (终态)
```

**关键约束**:
- ACTIVATED → RETIRED: ❌ 禁止（必须先 DEACTIVATED）
- RETIRED → 任何状态: ❌ 禁止（终态不可回退）
- 每次状态变更记录 `sim_state_history`（Type 2 SCD）
- 每次状态变更触发 `SIM_STATUS_CHANGED` 事件
- 上游 CMP 为权威源，本地变更需上游确认
