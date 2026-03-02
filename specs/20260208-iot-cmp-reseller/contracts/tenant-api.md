# API 契约：租户与权限管理

**Feature**: `iot-cmp-reseller` | **Date**: 2026-02-08
**关联 User Story**: US1（多租户与角色权限管理）
**关联需求**: FR-001 ~ FR-007

---

## 1. 代理商管理

### 1.1 创建代理商

```
POST /v1/resellers
```

**权限**: 系统管理员

**Request Body**:
```json
{
  "name": "string (required, 2-100)",
  "currency": "string (required, ISO 4217, e.g. 'CNY')",
  "contactEmail": "string (required, email)",
  "contactPhone": "string (optional)",
  "brandingConfig": {
    "logoUrl": "string (optional, url)",
    "primaryColor": "string (optional, hex color)",
    "customDomain": "string (optional, domain)"
  }
}
```

**Response 201**:
```json
{
  "resellerId": "uuid",
  "name": "string",
  "currency": "CNY",
  "status": "ACTIVE",
  "brandingConfig": { ... },
  "createdAt": "2026-02-08T10:00:00Z"
}
```

**Error Responses**:
| 状态码 | code | 说明 |
|--------|------|------|
| 400 | VALIDATION_ERROR | 字段校验失败 |
| 409 | DUPLICATE_NAME | 代理商名称重复 |
| 403 | FORBIDDEN | 非系统管理员 |

### 1.2 查询代理商列表

```
GET /v1/resellers?page={page}&pageSize={pageSize}&status={status}
```

**权限**: 系统管理员

**Query Parameters**:
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| page | integer | 否 | 页码，默认 1 |
| pageSize | integer | 否 | 每页数量，默认 20，最大 100 |
| status | string | 否 | 筛选状态 |

**Response 200**:
```json
{
  "items": [ { "resellerId": "uuid", "name": "...", ... } ],
  "total": 42,
  "page": 1,
  "pageSize": 20
}
```

### 1.3 查询代理商详情

```
GET /v1/resellers/{resellerId}
```

**权限**: 系统管理员 | 本代理商管理员

**数据范围隔离**:
- 系统管理员：任意代理商
- 代理商管理员：仅本代理商

### 1.4 更新代理商

```
PATCH /v1/resellers/{resellerId}
```

**权限**: 系统管理员

**Request Body**:
```json
{
  "name": "string (optional, 2-100)",
  "contactEmail": "string (optional, email)",
  "contactPhone": "string (optional)",
  "brandingConfig": {
    "logoUrl": "string (optional, url)",
    "primaryColor": "string (optional, hex color)",
    "customDomain": "string (optional, domain)"
  }
}
```

**业务规则**:
- 不允许修改 resellerId 与 createdBy
- name 需全局唯一

**Response 200**:
```json
{
  "resellerId": "uuid",
  "name": "string",
  "status": "ACTIVE",
  "updatedAt": "2026-02-08T10:00:00Z"
}
```

### 1.5 变更代理商状态

```
POST /v1/resellers/{resellerId}:change-status
```

**权限**: 系统管理员

**Request Body**:
```json
{
  "status": "ACTIVE | DEACTIVATED | SUSPENDED",
  "reason": "string (required)"
}
```

**业务规则**:
- 仅系统管理员可手工变更
- ACTIVE → DEACTIVATED：主动停用，禁止创建企业/产品包/导入 SIM
- ACTIVE → SUSPENDED：冻结账号，代理商用户禁止登录，停止该代理商所有任务（含上游同步、计费任务）
- DEACTIVATED/SUSPENDED → ACTIVE：系统管理员手工恢复
- 状态变更实时生效

**Response 200**:
```json
{
  "resellerId": "uuid",
  "status": "SUSPENDED",
  "previousStatus": "ACTIVE",
  "changedAt": "2026-02-08T10:00:00Z"
}
```

**备注**:
- 不支持删除代理商，以状态变更代替

---

## 1bis. 供应商管理

### 1bis.1 创建供应商

```
POST /v1/suppliers
```

**权限**: 系统管理员

**Request Body**:
```json
{
  "name": "string (required, unique)",
  "status": "ACTIVE | SUSPENDED (optional, default ACTIVE)"
}
```

**Response 201**:
```json
{
  "supplierId": "uuid",
  "name": "string",
  "status": "ACTIVE",
  "createdAt": "2026-02-08T10:00:00Z"
}
```

### 1bis.2 查询供应商列表

```
GET /v1/suppliers?page={page}&pageSize={pageSize}&status={status}
```

**权限**: 系统管理员

**Response 200**:
```json
{
  "items": [ { "supplierId": "uuid", "name": "...", "status": "ACTIVE" } ],
  "total": 42,
  "page": 1,
  "pageSize": 20
}
```

### 1bis.3 查询供应商详情

```
GET /v1/suppliers/{supplierId}
```

**权限**: 系统管理员

### 1bis.4 更新供应商

```
PATCH /v1/suppliers/{supplierId}
```

**权限**: 系统管理员

**Request Body**:
```json
{
  "name": "string (optional, unique)",
  "status": "ACTIVE | SUSPENDED (optional)"
}
```

**业务规则**:
- 不允许修改 supplierId 与 createdBy
- name 需全局唯一

**Response 200**:
```json
{
  "supplierId": "uuid",
  "name": "string",
  "status": "SUSPENDED",
  "updatedAt": "2026-02-08T10:00:00Z"
}
```

### 1bis.5 变更供应商状态

```
POST /v1/suppliers/{supplierId}:change-status
```

**权限**: 系统管理员

**Request Body**:
```json
{
  "status": "ACTIVE | SUSPENDED",
  "reason": "string (required)"
}
```

**业务规则**:
- SUSPENDED：禁止导入其提供的 SIM、禁止向其关联的上游系统发送任何 API 请求、忽略其 Webhook
- ACTIVE：允许正常业务与上游交互
- 状态变更实时生效，并记录审计

**Response 200**:
```json
{
  "supplierId": "uuid",
  "status": "SUSPENDED",
  "previousStatus": "ACTIVE",
  "changedAt": "2026-02-08T10:00:00Z"
}
```

---

## 2. 企业管理

### 2.1 创建企业

```
POST /v1/enterprises
```

**权限**: 代理商管理员

**Request Body**:
```json
{
  "name": "string (required, 2-200)",
  "resellerId": "uuid (required)",
  "autoSuspendEnabled": "boolean (optional, default false)",
  "contactEmail": "string (required, email)",
  "contactPhone": "string (optional)"
}
```

**Response 201**:
```json
{
  "enterpriseId": "uuid",
  "name": "string",
  "resellerId": "uuid",
  "status": "ACTIVE",
  "autoSuspendEnabled": false,
  "createdAt": "2026-02-08T10:00:00Z"
}
```

**Error Responses**:
| 状态码 | code | 说明 |
|--------|------|------|
| 400 | VALIDATION_ERROR | 字段校验失败 |
| 404 | RESELLER_NOT_FOUND | 代理商不存在 |
| 403 | FORBIDDEN | 权限不足 |

### 2.2 查询企业列表

```
GET /v1/enterprises?resellerId={resellerId}&status={status}&page={page}&pageSize={pageSize}
```

**权限**: 系统管理员 | 代理商角色（仅可见授权范围内企业）

**数据范围隔离**:
- 系统管理员：全部企业
- 代理商管理员：本代理商下全部企业
- 销售总监：被分配的企业集合
- 销售：被分配的企业

### 2.3 查询企业详情

```
GET /v1/enterprises/{enterpriseId}
```

**权限**: 系统管理员 | 代理商角色（授权范围） | 本企业角色

### 2.4 变更企业状态

```
POST /v1/enterprises/{enterpriseId}:change-status
```

**权限**: 系统管理员 | 代理商管理员

**Request Body**:
```json
{
  "status": "ACTIVE | INACTIVE | SUSPENDED",
  "reason": "string (required)"
}
```

**业务规则**:
- ACTIVE → INACTIVE：代理商管理员手工设置
- ACTIVE → SUSPENDED：代理商管理员手工设置（系统不自动变更企业状态）
- SUSPENDED → ACTIVE：代理商管理员手工恢复
- INACTIVE → ACTIVE：代理商管理员手工恢复
- 状态变更实时生效
- 触发 `ENTERPRISE_STATUS_CHANGED` 事件
- SUSPENDED 时：禁止新 SIM / 新订阅 / 企业侧管理操作
- 变更企业状态时仅提示，不自动停机或拆机；如需对企业名下所有 SIM 执行停机/拆机，仅代理商管理员或系统管理员可手工发起

**Response 200**:
```json
{
  "enterpriseId": "uuid",
  "status": "SUSPENDED",
  "previousStatus": "ACTIVE",
  "reason": "string",
  "changedAt": "2026-02-08T10:00:00Z",
  "changedBy": "uuid"
}
```

---

## 3. 部门管理

### 3.1 创建部门

```
POST /v1/enterprises/{enterpriseId}/departments
```

**权限**: 企业管理员 | 代理商管理员

**Request Body**:
```json
{
  "name": "string (required, 2-100)",
  "parentDepartmentId": "uuid (optional, 支持子部门)"
}
```

**Response 201**:
```json
{
  "departmentId": "uuid",
  "enterpriseId": "uuid",
  "name": "string",
  "parentDepartmentId": "uuid | null",
  "createdAt": "2026-02-08T10:00:00Z"
}
```

### 3.2 查询部门列表

```
GET /v1/enterprises/{enterpriseId}/departments
```

**权限**: 企业角色（按部门隔离）

---

## 4. 用户管理

### 4.1 创建用户

```
POST /v1/resellers/{resellerId}/users
```

**权限**: 代理商管理员

**Request Body**:
```json
{
  "email": "string (required, email, unique)",
  "name": "string (required)",
  "role": "RESELLER_ADMIN | RESELLER_SALES_DIRECTOR | RESELLER_SALES | RESELLER_FINANCE",
  "assignedEnterpriseIds": ["uuid"]
}
```

**说明**:
- `assignedEnterpriseIds`：对销售总监/销售角色必填，限定可访问企业范围
- 财务角色：代理商维度只读

### 4.2 创建企业用户

```
POST /v1/enterprises/{enterpriseId}/users
```

**权限**: 企业管理员 | 代理商管理员

**Request Body**:
```json
{
  "email": "string (required, email, unique)",
  "name": "string (required)",
  "role": "CUSTOMER_ADMIN | CUSTOMER_OPS",
  "departmentId": "uuid (OPS 角色必填)"
}
```

---

## 5. 上游主数据

### 5.1 创建供应商

```
POST /v1/suppliers
```

**权限**: 系统管理员

**Request Body**:
```json
{
  "name": "string (required)",
  "operatorIds": ["uuid (至少一个, required — 关联 operators 表)"]
}
```

**业务规则**: 禁止创建未关联运营商（operators）的供应商。operatorIds 引用 operators 表 id。

### 5.2 创建运营商

```
POST /v1/operators
```

**权限**: 系统管理员

**Request Body**:
```json
{
  "mcc": "string (required, 3 digits, GSMA 校验)",
  "mnc": "string (required, 2-3 digits)",
  "name": "string (required)",
  "apnDefault": "string (optional)",
  "roamingProfileId": "uuid (optional)",
  "gsmaOverride": "boolean (optional, default false)"
}
```

**业务规则**:
- MCC+MNC 需 GSMA 分配表校验，UNIQUE(mcc, mnc)
- `gsmaOverride=true` 时允许管理员紧急覆写 + 记录审计日志
- 支持废弃工作流：`status` (active/deprecated/error)、`replaced_by_id`、`deprecation_reason`

---

## 6. 认证

### 6.1 登录

```
POST /v1/auth/login
```

**Request Body**:
```json
{
  "email": "string (required)",
  "password": "string (required)"
}
```

**Response 200**:
```json
{
  "accessToken": "string (JWT, HS256)",
  "expiresIn": 3600,
  "tokenType": "Bearer",
  "user": {
    "userId": "uuid",
    "email": "string",
    "role": "string (RBAC role code, e.g. platform_admin / reseller_admin / customer_admin)",
    "roleScope": "platform | reseller | customer",
    "resellerId": "uuid | null",
    "customerId": "uuid | null"
  }
}
```

### 6.2 刷新 Token

```
POST /v1/auth/refresh
```

---

## 7. 审计日志

### 7.1 查询审计日志

```
GET /v1/audit-logs?resellerId={resellerId}&actor={actor}&action={action}&from={from}&to={to}&page={page}&pageSize={pageSize}
```

**权限**: 系统管理员 | 代理商管理员（本代理商范围）

**Response 200**:
```json
{
  "items": [
    {
      "logId": "uuid",
      "actor": "uuid",
      "actorRole": "string",
      "tenantScope": "uuid",
      "action": "string",
      "target": "string",
      "before": {},
      "after": {},
      "requestId": "string",
      "timestamp": "2026-02-08T10:00:00Z",
      "sourceIp": "1.2.3.4"
    }
  ],
  "total": 100
}
```

---

## 8. 通用约定

### 8.1 错误格式

所有 4xx/5xx 响应使用统一格式：

```json
{
  "code": "ERROR_CODE",
  "message": "Human-readable description",
  "traceId": "req_xxxxx"
}
```

### 8.2 分页参数

| 参数 | 类型 | 默认值 | 最大值 |
|------|------|--------|--------|
| page | integer | 1 | - |
| pageSize | integer | 20 | 100 |

### 8.3 认证方式

- Bearer Token (JWT HS256)：`Authorization: Bearer <token>`
- API Key：`X-API-Key: <key>`（M2M 集成）

### 8.4 Rate Limiting

- Token Bucket 算法，按租户+接口
- 超限返回 `429 Too Many Requests`，含 `Retry-After` 头
