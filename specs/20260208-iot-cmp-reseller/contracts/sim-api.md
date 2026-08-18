# API 契约：SIM 生命周期管理

**Feature**: `iot-cmp-reseller` | **Date**: 2026-02-08
**关联 User Story**: US2（SIM 卡资产入库与生命周期管理）
**关联需求**: FR-008 ~ FR-014

> **FR-058**：路径、查询与 JSON 中的 `resellerId` 均为 **RESELLER `tenants.tenant_id`**（与 OpenAPI 一致）。详见 [tenant-api.md §0](tenant-api.md)。

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
| resellerId | uuid | 是 | 导入归属的 RESELLER **`tenants.tenant_id`**（**FR-058**）；与 [tenant-api.md §0](tenant-api.md)、OpenAPI `sims/import-jobs` 一致 |
| supplierId | uuid | 是 | 供应商 ID |
| operatorId | uuid | 是 | 运营商 ID（与 OpenAPI 一致） |
| apn | string | 否 | 已弃用可选；APN 以 Carrier Service 的 APN Profile / 订阅为准，导入时可省略 |
| enterpriseId | uuid | 否 | 企业归属（为空则入库存） |
| batchId | string | 否 | 幂等键（同 batchId 不重复导入） |

**CSV 必填列**: `iccid`, `imsi`  
**CSV 可选列**: `msisdn`, `secondaryImsi1`, `secondaryImsi2`, `secondaryImsi3`, `formFactor`, `activationCode`, `imei`, `imeiLockEnabled`

**IME Lock（CSV 与 DB）**:
- 运行时表 `public.sims` 列：`imei_lock_enabled`（API `imeiLockEnabled`）、`bound_imei`（API `imei`，15 位）。
- **成对规则**：每行要么同时省略 IME Lock（仅 `iccid` + `imsi`），要么同时提供 `imeiLockEnabled=true` 与合法 15 位 `imei`；仅填其一或 `false`+`imei` → `400 INVALID_FORMAT`，该行不写入。
- 同一文件可混用「未启用」与「已启用」行。

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

**`type = SIM_STATUS_CHANGE` 时** 响应 **SHOULD** 额外包含：

```json
{
  "jobId": "uuid",
  "type": "SIM_STATUS_CHANGE",
  "status": "RUNNING",
  "payload": {
    "action": "ACTIVATE",
    "iccid": "89860012345678901234",
    "beforeStatus": "TEST_READY",
    "targetStatus": "ACTIVATED"
  },
  "result": {
    "simId": "uuid",
    "iccid": "89860012345678901234",
    "status": "TEST_READY",
    "lifecycleSubStatus": "activating"
  },
  "errorSummary": null,
  "createdAt": "2026-02-08T10:00:00Z",
  "updatedAt": "2026-02-08T10:05:00Z"
}
```

- `status=SUCCEEDED`：**仅当**上游已确认且 SIM 已写入目标 `status` + `lifecycleSubStatus=normal`。
- `status=FAILED`：SIM 为源 `status` + 对应 `*_failed`（见 §4.0）。

### 1.3 取消任务（租户 API 不暴露）

**租户 JWT API（reseller / enterprise）不提供** `POST /v1/jobs/{jobId}:cancel`。生命周期 **`SIM_STATUS_CHANGE` Job 不可取消**；失败或需改向时，须发起**新的**生命周期 API（新 `idempotencyKey`、新 Job），**不得**通过 cancel Job 撤销。

（若未来仅平台运维需要取消**非** `SIM_STATUS_CHANGE` 的导入/出账等 Job，应走 **Admin API** 或内部工具，不在 Swagger 对 reseller/enterprise 开放。）

---

## 2. SIM 单张录入

### 2.1 创建 SIM

```
POST /v1/sims
```

**权限**: 平台管理员 | 代理商管理员；customer / department token 不允许访问。

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
GET /v1/sims?enterpriseId={}&resellerId={}&status={}&supplierId={}&operatorId={}&iccid={}&page={}&pageSize={}
```

**权限**: 系统管理员 | 代理商（**企业用户返回 403**，请使用 §3.1.1）

**说明**:
- 渠道/平台全量列表：含 supplier、operator、reseller 等字段。
- 对系统管理员与代理商而言，enterpriseId 为可选参数。未提供时返回其权限范围内所有 SIM（包含未分配企业的库存）。
- 系统管理员可使用 `resellerId`（**RESELLER `tenants.tenant_id`**，**FR-058**）过滤指定代理商范围；代理商用户忽略该查询参数（作用域来自 JWT）。
- departmentId 仅在指定 enterpriseId 时生效，且部门必须隶属于该企业。
- **多 ID 一致性**：若同时提供 **两个及以上** 的 `resellerId` / `enterpriseId` / `supplierId` / `operatorId`，服务端 MUST 校验相互匹配（企业归属代理商、供应商已绑定代理商、运营商归属供应商或代理商绑定范围）。不匹配 MUST 返回 **400** `BAD_REQUEST`（不得 silently 忽略某一侧过滤条件）。
- 返回结果包含 eSIM Profile 信息（activationCode）。

**Query Parameters**:
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| enterpriseId | uuid | 否 | 企业筛选 |
| resellerId | uuid | 否 | 平台管理员：**RESELLER `tenants.tenant_id`**（**FR-058**）筛选；代理商/企业 token **忽略** |
| departmentId | uuid | 否 | 部门筛选 |
| status | string | 否 | SIM 状态筛选 |
| supplierId | uuid | 否 | 供应商筛选；**platform / reseller** 可用；**customer / department token 忽略** |
| operatorId | uuid | 否 | 运营商筛选；**platform / reseller** 可用；**customer / department token 忽略** |
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
      "activationCode": "LPA:1$sm.example.com$1234567890",
      "supplierId": "uuid",
      "supplierName": "string",
      "operatorId": "uuid",
      "operatorName": "string",
      "mcc": "460",
      "mnc": "00",
      "resellerId": "uuid",
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

- 列表项中 `resellerId`（若返回）：SIM 所属代理商的 **`tenants.tenant_id`**（**FR-058**）。

### 3.1.1 企业范围 SIM 列表（脱敏）

```
GET /v1/enterprises/{enterpriseId}/sims?departmentId={}&iccid={}&imsi={}&status={}&mcc={}&mnc={}&page={}&pageSize={}
```

**权限**: 企业用户 | 代理商 | 系统管理员

**说明**:
- 路径 **enterpriseId** 必填。企业 token 须与 JWT 企业一致；代理商须为下属企业；平台不限。
- departmentId 在企业范围内生效；部门 token 固定本部门。
- 响应**不含** supplierId、supplierName、operatorId、operatorName、resellerId、upstreamStatus 等渠道字段；可含 **mcc** / **mnc**。
- 支持按 **mcc** / **mnc** 筛选（服务端解析运营商，不向企业暴露 operator UUID）。

**Query Parameters**:
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| departmentId | uuid | 否 | 部门筛选 |
| iccid | string | 否 | ICCID 精确/前缀 |
| imsi | string | 否 | primary_imsi |
| status | string | 否 | 生命周期 |
| mcc | string | 否 | MCC 筛选 |
| mnc | string | 否 | MNC 筛选 |
| page | integer | 否 | 默认 1 |
| pageSize | integer | 否 | 默认 20，最大 100 |

### 3.1.2 SIM 列表 CSV 导出（代理商/管理员）

```
GET /v1/sims:csv?enterpriseId={}&resellerId={}&departmentId={}&status={}&iccid={}&msisdn={}&page={}&limit={}
```

**权限**: 系统管理员 | 代理商（企业用户不使用该接口）

**说明**:
- enterpriseId 为可选参数。未提供时导出其权限范围内所有 SIM（包含未分配企业的库存）。
- departmentId 仅在指定 enterpriseId 时生效。
- 系统管理员可使用 `resellerId`（**FR-058**，**RESELLER `tenants.tenant_id`**）过滤指定代理商范围；代理商用户忽略该参数。
- 导出字段包含 activationCode（eSIM Profile），且在 enterpriseId 前增加 CSV 列 **resellerId**（同上语义）。

### 3.1.3 企业范围 SIM CSV 导出

```
GET /v1/enterprises/{enterpriseId}/sims:csv?departmentId={}&status={}&iccid={}&msisdn={}&page={}&limit={}
```

**权限**: 企业用户 | 代理商 | 系统管理员

**说明**:
- 企业用户仅可访问自身 enterpriseId。
- departmentId 在企业范围内生效。
- 导出字段包含 activationCode（eSIM Profile），不包含 resellerId。

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

### 4.0 异步生命周期模型（[V1.1]）

所有 `POST ...:activate|:deactivate|:reactivate|:retire` 及批量状态变更中的单卡 outbound，遵循同一模型：

1. **受理**（同步）：校验 RBAC / 状态机 / 信控 / 承诺期；创建 `jobs.type=SIM_STATUS_CHANGE`；将 SIM 置为 **源 `status` + 进行中 `lifecycleSubStatus`**（`*ing`）；返回 **202**。
2. **执行**（异步 Worker）：调用**供应商适配器**；适配器返回 `completed` | `pending` | `failed`（`pending` 的完成策略按供应商实现：轮询、供应商 Webhook、或组合）。
3. **落库**：`completed` → 目标 `status` + `lifecycleSubStatus=normal`，`job.status=SUCCEEDED`；`failed` → 源 `status` + `*_failed`，`job.status=FAILED`。
4. **通知**：稳态变更 → `SIM_STATUS_CHANGED` Webhook；Job 终态 → `JOB_FINISHED` Webhook（见 [integration-api.md](integration-api.md)）。
5. **查询**：`GET /v1/jobs/{jobId}`、`GET /v1/sims/{simId}`。

**`lifecycleSubStatus` 枚举**：

`normal` | `activating` | `activation_failed` | `deactivating` | `deactivation_failed` | `reactivating` | `reactivation_failed` | `retiring` | `retire_failed`

| action | 源 status（示例） | 受理后 subStatus | 成功后 status | 失败后 subStatus |
|--------|-------------------|------------------|---------------|------------------|
| ACTIVATE | INVENTORY, TEST_READY | activating | ACTIVATED | activation_failed |
| DEACTIVATE | ACTIVATED, TEST_READY | deactivating | DEACTIVATED | deactivation_failed |
| REACTIVATE | DEACTIVATED | reactivating | ACTIVATED | reactivation_failed |
| RETIRE | DEACTIVATED | retiring | RETIRED | retire_failed |

**首包 202 统一结构**（各 action 相同形状；幂等重放 **200** 返回当前快照）：

```json
{
  "jobId": "uuid",
  "job": {
    "type": "SIM_STATUS_CHANGE",
    "status": "QUEUED",
    "progress": { "processed": 0, "total": 1 }
  },
  "sim": {
    "simId": "uuid",
    "iccid": "89860012345678901234",
    "status": "TEST_READY",
    "lifecycleSubStatus": "activating",
    "targetStatus": "ACTIVATED",
    "action": "ACTIVATE"
  },
  "message": "Lifecycle change accepted; awaiting upstream confirmation.",
  "requestId": "req_..."
}
```

- 首包 **MUST NOT** 含 `job.status: "SUCCEEDED"` 或 `sim.status` 等于 `targetStatus`（尚未上游确认）。
- `message` 为人类可读说明；机器逻辑 **MUST** 以字段为准。

**冲突与并发**：

| 状态码 | code | 说明 |
|--------|------|------|
| 409 | LIFECYCLE_IN_PROGRESS | 当前 `lifecycleSubStatus` 为 `*ing`，拒绝其它方向操作 |
| 409 | JOB_NOT_CANCELLABLE | 对 `SIM_STATUS_CHANGE` 调用 `jobs:cancel` |
| 409 | INVALID_STATE | 源 status 不允许该 action |
| 409 | DUPLICATE_IDEMPOTENCY_KEY | 相同 `idempotencyKey` 已被用于先前的 `SIM_STATUS_CHANGE` Job（四端点共享键空间） |

**`sim_state_history`**：仅在 `status` 稳态变更时追加；受理时 **不** 写入。

**自动触发**（测试到期激活、达量断网等）：与手工 API **相同**过渡规则。

---

### 4.1 激活

```
POST /v1/sims/{simId}:activate
```

**权限**: 代理商管理员 | 代理商销售
**前置条件**: SIM 状态为 INVENTORY 或 TEST_READY 或 DEACTIVATED
**异步**: 返回 jobId；上游确认后落稳态（见 §4.0）

**Request Body**:
```json
{
  "reason": "string (optional)",
  "idempotencyKey": "string (optional)"
}
```

**Response 202**: 见 §4.0 统一结构（`action=ACTIVATE`，`targetStatus=ACTIVATED`，`lifecycleSubStatus=activating`）。

**Response 200**（幂等）: 同结构，反映当前 `job`/`sim` 快照（可能已为 `SUCCEEDED` 或 `FAILED`）。

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
**前置条件**: SIM `status` 为 ACTIVATED 或 TEST_READY，且 `lifecycleSubStatus=normal`（非 `*ing`）

**Request Body**:
```json
{
  "reason": "string (required for manual deactivate)",
  "idempotencyKey": "string (optional)"
}
```

**Response 202**: §4.0（`action=DEACTIVATE`，`lifecycleSubStatus=deactivating`，`targetStatus=DEACTIVATED`）。

### 4.3 复机

```
POST /v1/sims/{simId}:reactivate
```

**权限**: 代理商管理员
**前置条件**: SIM `status` 为 DEACTIVATED，`lifecycleSubStatus=normal`
**信控约束**: 企业 SUSPENDED 时禁止企业用户复机

**Response 202**: §4.0（`action=REACTIVATE`，`lifecycleSubStatus=reactivating`，`targetStatus=ACTIVATED`）。

> **与 activate 区别**：自 `DEACTIVATED` 复机 **MUST** 使用 `:reactivate` 及子状态 `reactivating` / `reactivation_failed`，**不得**与自 `INVENTORY`/`TEST_READY` 的 `activating` 混用。

### 4.4 拆机

```
POST /v1/sims/{simId}:retire
```

**权限**: 仅 **`reseller_admin`** 与 **`platform_admin`**（**禁止** `customer_admin` / `customer_ops` / department 等企业用户）
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

**Response 202**: §4.0（`action=RETIRE`，`lifecycleSubStatus=retiring`，`targetStatus=RETIRED`）。

### 4.5 标记测试就绪（本地迁移）

```
POST /v1/sims/{simId}:mark-test-ready
```

**权限**: 仅 **`reseller_admin`** 与 **`platform_admin`**（`sims.mark_test_ready`）

**业务**: **INVENTORY → TEST_READY**，**CMP 本地落库，不调用上游**；**同步 200**（**不**创建 `SIM_STATUS_CHANGE` Job，**无** `lifecycle_sub_status` 过渡 `*ing`）。

**前置条件**:

- `status=INVENTORY` 且 `lifecycleSubStatus=normal`
- SIM **`enterprise_id` 已非空**（须先 `POST /sims:assign-inventory-to-enterprise` 或导入时指定企业）；否则 **409 `ENTERPRISE_REQUIRED`**

**Request Body**（与 `:retire` 相同的 `enterpriseId` / 租户解析规则；**无** `confirm` / `commitmentExempt`）:

```json
{
  "reason": "string (required)",
  "idempotencyKey": "string (optional)",
  "enterpriseId": "uuid (optional)"
}
```

**幂等**: 重复 `idempotencyKey` → **409 `DUPLICATE_IDEMPOTENCY_KEY`**（键空间 **`SIM_MARK_TEST_READY`**，与 `SIM_STATUS_CHANGE` 分离）

**Response 200**:

```json
{
  "ok": true,
  "jobId": "uuid | null",
  "sim": {
    "simId": "uuid",
    "iccid": "string",
    "status": "TEST_READY",
    "lifecycleSubStatus": "normal",
    "beforeStatus": "INVENTORY",
    "afterStatus": "TEST_READY"
  },
  "message": "SIM marked test-ready (local transition; no upstream call).",
  "requestId": "string"
}
```

**Error Responses**:
| 状态码 | code | 说明 |
|--------|------|------|
| 409 | ENTERPRISE_REQUIRED | 未 assign 企业 |
| 409 | INVALID_STATE | 非 INVENTORY 或子状态非 normal |
| 409 | DUPLICATE_IDEMPOTENCY_KEY | 重复幂等键 |
| 409 | LIFECYCLE_IN_PROGRESS | 其它生命周期进行中 |

---

## 5. SIM 批量操作

### 5.1 批量停机（企业状态手工联动）

```
POST /v1/sims:batch-deactivate
```

**权限**: 代理商管理员

**规则**:
- `enterpriseId` 必须是存在的 ENTERPRISE tenant；reseller token 下必须归属于当前 reseller，否则返回 `403 FORBIDDEN`。
- 目标企业必须处于 `SUSPENDED` 状态；`ACTIVE` / `INACTIVE` 或其它状态返回 `409 INVALID_ENTERPRISE_STATUS`。
- `reason` 必须是非空字符串。
- `idempotencyKey` 可选，但一旦使用不可重复；重复使用返回 `409 IDEMPOTENCY_CONFLICT`，不会返回旧 Job。

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

### 5.2 批量状态变更（按 SIM 清单）

```
POST /v1/sims:batch-status-change
```

**权限**: 平台管理员 | 代理商 | 企业用户 | 部门用户（仅本企业范围）。企业/部门 token **不得**使用 **Retire**、**Mark-test-ready**（与单卡 `:retire` / `:mark-test-ready` 一致）→ **403 FORBIDDEN**；允许 **Activate** / **Deactivate** / **Reactivate**。

**租户范围（与单卡生命周期一致）**：

- **Reseller token / 代理商用户**：`iccids` 或 CSV 中任一 ICCID 对应的 SIM **不属于当前 reseller**（含库存未 assign、其它代理商企业下 SIM）→ 整单 **403 `FORBIDDEN`**，列出越界 ICCID。
- **Enterprise / customer token**：任一 ICCID 不属于当前 **enterprise**（或 department 用户不属于本部门）→ 整单 **403**。
- **Platform**：不限制（按 ICCID 逐卡处理）。

**无 `enterpriseId` 参数**（与单卡 `:activate` 等不同）：

- **Reseller**：权限由批量 **ICCID 列表 + 逐卡 reseller 校验** 决定，可含库存未 assign、下属任意企业的卡；传 `enterpriseId` **无效**（接口不使用）。
- **Enterprise / customer token**：企业范围 **仅来自 JWT**，不从 body 读取 `enterpriseId`。

**设计原则**（2026-05 确认）：

- 与单卡 `:activate` / `:deactivate` / `:reactivate` / `:retire` **语义对齐**：批量 = 对 ICCID 列表逐卡受理，**每张卡一个 `SIM_STATUS_CHANGE` Job**（202 型受理 → `*ing` + `jobId`）。
- **不拆**四个独立批量 URL（`:batch-activate` 等）；统一本入口 + **`action`**。
- **ICCID 来源二选一**（互斥）：Portal 手工勾选 **或** 上传 CSV，不得同时提交。

#### 请求体 — `multipart/form-data`（Swagger / Portal 推荐）

同一表单，ICCID 来源二选一：

| 模式 | 填写字段 |
|------|----------|
| **ICCID List** | **`iccids`**（逗号分隔或 JSON 数组字符串，最多 100） |
| **ICCID CSV File** | **`file`**（CSV，仅 **iccid** 列） |

公共字段：**`action`**、`iccids`/`file`、`reason`（按 action 条件必填）等（**不含** `enterpriseId`）。

**`confirm` / `commitmentExempt` 仅用于 Retire**（与单卡 **`POST /v1/sims/{simId}:retire`** §4.4 相同）；其它 action **勿传**（传了也会被忽略，Retire 时仍须 `confirm=true`）。

#### 按 action 的字段要求

| action | 企业/部门 token | `reason` | `confirm` | `commitmentExempt` | 单卡对照 |
|--------|----------------|----------|-----------|-------------------|----------|
| Activate | 允许 | 可选 | — | — | `:activate` |
| Deactivate | 允许 | **必填** | — | — | `:deactivate` |
| Reactivate | 允许 | 可选 | — | — | `:reactivate` |
| **Retire** | **禁止（403）** | **必填** | **`true` 必填** | 可选 | **`:retire`**（仅 reseller/platform admin） |
| Mark-test-ready | **禁止（403）** | **必填** | — | — | `:mark-test-ready`（仅 reseller/platform admin） |

#### 可选 — `application/json`（集成客户端）

Deactivate 示例（无 `confirm` / `commitmentExempt`）：

```json
{
  "action": "Deactivate",
  "iccids": ["8986012345678901234"],
  "reason": "batch cleanup"
}
```

Retire 示例（与 §4.4 拆机 body 对齐，无 `enterpriseId`）：

```json
{
  "action": "Retire",
  "iccids": ["8986012345678901234"],
  "confirm": true,
  "reason": "end of contract",
  "commitmentExempt": false
}
```

- **`iccids`**：非空数组，**最多 100**；**不得**与 `file` 同请求。
- **`action`** 与单卡接口一致；**Mark-test-ready** 为同步、无 Job。

#### multipart 字段明细（与 JSON 语义对齐）

| 字段 | 适用 action | 说明 |
|------|-------------|------|
| `action` | 全部 | Activate / Deactivate / Reactivate / Retire / Mark-test-ready |
| `file` | 全部 | 与 `iccids` **二选一**；CSV 仅 **iccid** 列，≤100 行 |
| `iccids` | 全部 | 与 `file` **二选一**；逗号分隔或 JSON 数组字符串 |
| `reason` | Deactivate、**Retire**、Mark-test-ready **必填** | Activate / Reactivate 可选 |
| `confirm` | **仅 Retire** | 必须为 `true`；同 §4.4 |
| `commitmentExempt` | **仅 Retire** | 可选；跳过承诺期校验；同 §4.4 |
| `batchId` | 全部 | 可选；与 **action** 组合为幂等键，重复请求 → **409 DUPLICATE_BATCH**（CSV 未传时用 **file** 的 SHA-256） |

- **不得**在 multipart 中同时传 **`iccids`** 与 **`file`**。
- CSV **最多 100 行**数据；重复 ICCID 去重。

#### 互斥与错误码

| 条件 | HTTP | code |
|------|------|------|
| 同时提供 `iccids` 与 `file` | 400 | `BATCH_INPUT_CONFLICT` |
| 两者均未提供 / CSV 空 / 数组空 | 400 | `BAD_REQUEST` / `INVALID_FORMAT` |

批量项 **受理**后每张 SIM 各有一个 `SIM_STATUS_CHANGE` Job；**`targetStatus` / `lifecycleSubStatus` 表示意图与进行中子状态**，稳态以 Job/Webhook/`GET sim` 为准（未确认前 `status` 仍为源态）。

**Response 200/207**:
```json
{
  "action": "RETIRE",
  "targetStatus": "RETIRED",
  "total": 4,
  "succeeded": 1,
  "failed": 3,
  "idempotent": 0,
  "items": [
    {
      "simId": "uuid",
      "iccid": "8986...",
      "ok": true,
      "jobId": "uuid",
      "beforeStatus": "DEACTIVATED",
      "targetStatus": "RETIRED",
      "lifecycleSubStatus": "retiring"
    },
    {
      "input": "8986...",
      "ok": false,
      "errorCode": "COMMITMENT_NOT_MET",
      "errorMessage": "Retire blocked until 2026-08-01T00:00:00.000Z."
    },
    {
      "input": "bad-id",
      "ok": false,
      "errorCode": "INVALID_SIM_ID",
      "errorMessage": "simId must be a valid uuid or 18-20 digit iccid."
    },
    {
      "simId": "uuid",
      "iccid": "8986...",
      "ok": false,
      "errorCode": "INVALID_STATE",
      "errorMessage": "sim status ACTIVATED cannot transition to RETIRED."
    }
  ]
}
```

---

## 6. 状态机总览

**稳态主图**（`status`，5 值）：

```
INVENTORY ──── activate ────► ACTIVATED
    │                             │
    │ assign                      │ deactivate
    ▼                             ▼
 TEST_READY ──activate──►     DEACTIVATED
    │ deactivate                  │ reactivate / activate(from DEA)
    └────────► DEACTIVATED        │ retire
                                  ▼
                              RETIRED (终态)
```

**过渡边**（受理后、上游确认前，`status` 保持源态）：

| 操作 | 源 status | 过渡 subStatus | 确认后 status |
|------|-----------|----------------|---------------|
| activate | INVENTORY, TEST_READY | activating | ACTIVATED |
| activate | DEACTIVATED | activating（契约允许 :activate；复机推荐 :reactivate + reactivating） | ACTIVATED |
| deactivate | ACTIVATED, TEST_READY | deactivating | DEACTIVATED |
| reactivate | DEACTIVATED | reactivating | ACTIVATED |
| retire | DEACTIVATED | retiring | RETIRED |

**关键约束**:
- ACTIVATED → RETIRED: ❌ 禁止（必须先 DEACTIVATED）
- RETIRED → 任何状态: ❌ 禁止（终态不可回退）
- `lifecycleSubStatus` 为 `*ing` 时: ❌ 其它方向生命周期操作（`LIFECYCLE_IN_PROGRESS`）
- **稳态**变更时写入 `sim_state_history`（Type 2 SCD）；受理时不写
- **稳态**变更时触发 `SIM_STATUS_CHANGED`；Job 终态触发 `JOB_FINISHED`
- 上游 CMP 为权威源；本地 outbound **确认后**才写目标 `status`
- 详见 §4.0、[spec.md](../spec.md) US2、[integration-api.md](integration-api.md)
