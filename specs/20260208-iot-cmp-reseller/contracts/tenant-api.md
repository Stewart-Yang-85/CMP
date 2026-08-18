# API 契约：租户与权限管理

**Feature**: `iot-cmp-reseller` | **Date**: 2026-02-08
**关联 User Story**: US1（多租户与角色权限管理）
**关联需求**: FR-001 ~ FR-007

---

## 0. 字段约定：`resellerId`（FR-058）

与 OpenAPI `iot-cmp-api.yaml` 对齐：

| 名称 | 语义 |
|------|------|
| `tenantId`（路径参数名：`/v1/resellers/{tenantId}/…` 等） | 与 **`resellerId`（§0 语义）** 相同：RESELLER 的 **`tenants.tenant_id`**（**FR-058**）；兼容解析 **`resellers.id`**。 |
| `resellerId`（查询参数、JSON 字段、JWT claim `resellerId`） | 代理商 **RESELLER** 在表 **`tenants`** 中的 **`tenant_id`**（对外公网标识，与权限作用域一致）。 |
| `resellerRecordId`（若响应中出现） | 域表 **`resellers.id`**（便于与库内行或对账）；新集成对外优先使用 `resellerId`。 |
| `tenantId`（若与代理商资源同时出现） | 与上述 `resellerId` 同值时的兼容字段，含义仍为 RESELLER 的 `tenant_id`。 |

**兼容**：若调用方误传 `resellers.id`，服务端在已启用兼容的部署上应解析为与 `tenants.tenant_id` **同一代理商主体**（与 OpenAPI `ResellerTenantIdPath` / 各 schema 描述一致）。

**兼容截止**：自 **2027-03-31** 起，计划在后续版本中**停止**在路径与请求体中将裸 `resellers.id` 视为代理商标识；新集成应只使用 **`tenants.tenant_id`**。对外公告与移除清单见 [security-debt.md — SD-07](../security-debt.md)。

**下文 JSON 示例** 中形如 `"resellerId": "uuid"` 的占位符，均指 **`tenants.tenant_id`**，除非另行说明。

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
  "resellerRecordId": "uuid",
  "tenantId": "uuid",
  "name": "string",
  "currency": "CNY",
  "status": "ACTIVE",
  "brandingConfig": { ... },
  "createdAt": "2026-02-08T10:00:00Z"
}
```

- `resellerId` / `tenantId`：**RESELLER** 的 **`tenants.tenant_id`**（§0 / **FR-058**）。`resellerRecordId`：`resellers.id`（可选返回，以对齐 OpenAPI）。

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

- 列表项中的 `resellerId`：**RESELLER `tenants.tenant_id`**（§0 / **FR-058**）；若条目含 `resellerRecordId` / `tenantId` 含义同 §0。

### 1.3 查询代理商详情

```
GET /v1/resellers/{tenantId}
```

**路径参数**: `tenantId` — §0（**FR-058**）；值为 RESELLER **`tenants.tenant_id`**（兼容场景下可与 `resellers.id` 解析为同一主体）。

**权限**: 系统管理员 | 本代理商管理员

**数据范围隔离**:
- 系统管理员：任意代理商
- 代理商管理员：仅本代理商

### 1.4 更新代理商

```
PATCH /v1/resellers/{tenantId}
```

**路径参数**: `tenantId` — §0（**FR-058**）。

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
  "resellerRecordId": "uuid",
  "name": "string",
  "status": "ACTIVE",
  "updatedAt": "2026-02-08T10:00:00Z"
}
```

- `resellerId`：`tenants.tenant_id`（**FR-058**）；`resellerRecordId`：`resellers.id`（可选）。

### 1.5 变更代理商状态

```
POST /v1/resellers/{tenantId}:change-status
```

**路径参数**: `tenantId` — §0（**FR-058**）。

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
  "resellerRecordId": "uuid",
  "status": "SUSPENDED",
  "previousStatus": "ACTIVE",
  "changedAt": "2026-02-08T10:00:00Z"
}
```

- `resellerId`：`tenants.tenant_id`（**FR-058**）；`resellerRecordId` 可选。

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
  "resellerId": "uuid (optional for reseller_admin; required for platform_admin — see below)",
  "autoSuspendEnabled": "boolean (optional, default false)",
  "contactEmail": "string (required, email)",
  "contactPhone": "string (optional)"
}
```

- `resellerId`：**平台管理员**代建企业时需传入目标代理商的 **RESELLER `tenants.tenant_id`**（§0 / **FR-058**）。**代理商管理员**作用域来自 JWT 的 `resellerId`，请求体中可省略或留空；若传入则须与本代理商解析一致。**兼容**：短时内仍接受旧字段名 `tenantId`（与 `resellerId` 同义）。

**Response 201**:
```json
{
  "enterpriseId": "uuid",
  "name": "string",
  "tenantId": "uuid",
  "resellerId": "uuid",
  "status": "ACTIVE",
  "autoSuspendEnabled": false,
  "createdAt": "2026-02-08T10:00:00Z"
}
```

- `tenantId` / `resellerId`：所属 RESELLER 的 **`tenants.tenant_id`**（**FR-058**），同值；新集成优先读 `resellerId`。

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

**Query Parameters**:
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| resellerId | uuid | 否 | 平台管理员可按 **RESELLER `tenants.tenant_id`**（§0 / **FR-058**）筛选；**兼容**查询参数 `tenantId`。代理商侧通常由 JWT 作用域约束 |
| status | string | 否 | ACTIVE / INACTIVE / SUSPENDED |
| page | integer | 否 | 默认 1 |
| pageSize | integer | 否 | 默认 20 |

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

**Response 200**（节选）：含 `tenantId` 与 `resellerId`（同为父级 RESELLER `tenants.tenant_id`，**FR-058**）。

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

**路径参数**: `resellerId` — §0（**FR-058**，与旧参数名 `tenantId` 同义）。

**权限**: 代理商管理员

**Request Body**:
```json
{
  "email": "string (required, email, unique)",
  "name": "string (required; OpenAPI 字段名为 displayName，二者等价)",
  "password": "string (required, 8–256 字符; 写入 users.password_hash，scrypt，响应中永不返回)",
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
  "name": "string (required; OpenAPI 字段名为 displayName，二者等价)",
  "password": "string (required, 8–256 字符; 写入 users.password_hash，scrypt，响应中永不返回)",
  "role": "CUSTOMER_ADMIN | CUSTOMER_OPS",
  "departmentId": "uuid (OPS 角色必填)"
}
```

### 4.3 查询企业用户部门分配

```
GET /v1/enterprises/{enterpriseId}/users/{userId}/departments
```

**Query**: `page`（可选，默认 1）、`pageSize`（可选，默认 20）；服务端将 `pageSize` 限制在合理上限内。

**权限**: 企业管理员 | 代理商管理员 | 系统管理员

**行为说明**:
- 当目标用户为 `CUSTOMER_ADMIN`：返回该企业下全部部门。
- 当目标用户为 `CUSTOMER_OPS`：返回该用户被分配的部门集合（来自 `enterprise_user_departments`）。

**Response 200**:
```json
{
  "userId": "uuid",
  "enterpriseId": "uuid",
  "departments": [
    {
      "departmentId": "uuid",
      "enterpriseId": "uuid",
      "name": "string",
      "createdAt": "2026-02-08T10:00:00Z",
      "updatedAt": "2026-02-08T10:00:00Z"
    }
  ],
  "total": 0,
  "page": 1,
  "pageSize": 20
}
```

`total` 为符合可见性规则的全部记录数（分页前）；`departments` 为当前页条目。

### 4.4 分配（追加）企业用户部门

```
POST /v1/enterprises/{enterpriseId}/users/{userId}/assign-departments
```

**权限**: 企业管理员 | 代理商管理员 | 系统管理员

**Request Body**:
```json
{
  "mode": "replace | append (optional, default replace)",
  "assignedDepartmentIds": ["uuid"]
}
```

**行为说明**:
- `mode=replace`（默认）：使用本次列表整体覆盖（适合前端勾选全量提交）。
- `mode=append`：与现有分配集合合并并去重（适合增量追加）。
- 仅允许分配当前 `enterpriseId` 下的部门；跨企业部门返回 `403 FORBIDDEN`。

**Response 200**:
```json
{
  "userId": "uuid",
  "enterpriseId": "uuid",
  "assignedDepartmentIds": ["uuid", "uuid"]
}
```

**清空分配**:
```
DELETE /v1/enterprises/{enterpriseId}/users/{userId}/assign-departments
```

**Response 200**:
```json
{
  "userId": "uuid",
  "enterpriseId": "uuid",
  "assignedDepartmentIds": []
}
```

### 4.5 查询代理商用户企业分配

```
GET /v1/resellers/{resellerId}/users/{userId}/enterprises
```

**路径参数**: `resellerId` — §0（**FR-058**，与旧参数名 `tenantId` 同义）。

**Query**: `page`（可选，默认 1）、`pageSize`（可选，默认 20）；服务端将 `pageSize` 限制在合理上限内。

**权限**: 代理商管理员 | 系统管理员

**行为说明**:
- 当目标用户为 `RESELLER_ADMIN`：返回该代理商下全部企业。
- 当目标用户为 `RESELLER_SALES_DIRECTOR | RESELLER_SALES | RESELLER_FINANCE`：返回该用户已分配企业集合（来自 `reseller_enterprise_assignments`）。

**Response 200**:
```json
{
  "userId": "uuid",
  "resellerId": "uuid",
  "enterprises": [
    {
      "enterpriseId": "uuid",
      "name": "string",
      "enterprise_status": "ACTIVE",
      "auto_suspend_enabled": false,
      "created_at": "2026-02-08T10:00:00Z",
      "updated_at": "2026-02-08T10:00:00Z"
    }
  ],
  "total": 0,
  "page": 1,
  "pageSize": 20
}
```

`total` 为符合可见性规则的全部记录数（分页前）；`enterprises` 为当前页条目。

### 4.6 分配（追加）代理商用户企业

```
POST /v1/resellers/{resellerId}/users/{userId}/assign-enterprises
```

**路径参数**: `resellerId` — §0（**FR-058**）。

**权限**: 代理商管理员 | 系统管理员

**Request Body**:
```json
{
  "mode": "replace | append (optional, default replace)",
  "assignedEnterpriseIds": ["uuid"]
}
```

**行为说明**:
- `mode=replace`（默认）：使用本次列表整体覆盖（适合前端勾选全量提交）。
- `mode=append`：与现有分配集合合并并去重（适合增量追加）。
- 仅允许分配当前 `resellerId` 下企业；越权企业返回 `403 FORBIDDEN`。

**Response 200**:
```json
{
  "userId": "uuid",
  "resellerId": "uuid",
  "assignedEnterpriseIds": ["uuid", "uuid"]
}
```

**清空分配**:
```
DELETE /v1/resellers/{resellerId}/users/{userId}/assign-enterprises
```

**Response 200**:
```json
{
  "userId": "uuid",
  "resellerId": "uuid",
  "assignedEnterpriseIds": []
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

- `user.resellerId`：当 `roleScope` 为 `reseller` 时，为 **RESELLER `tenants.tenant_id`**（§0 / **FR-058**）；否则为 `null`。

### 6.2 修改自己的密码

```
POST /v1/auth/change-password
```

**Header**: `Authorization: Bearer <accessToken>`（须为 **6.1** 返回的、含 **UUID `userId`** 的交互式用户 JWT）。

**Request Body**:
```json
{
  "currentPassword": "string (required)",
  "newPassword": "string (required, 8–256 字符，须与 currentPassword 不同)"
}
```

**说明**:
- 仅更新 **当前 token 对应** 的 `users` 行（`password_hash`，scrypt）。
- **不可用**：M2M（`customer_m2m`）、无 UUID `userId` 的会话（如仅 admin API key）。
- **Response 200**：`{ "ok": true }`；当前 access token 仍有效，客户端可自行决定是否在改密后重新登录。

### 6.3 忘记密码 / 自助重置（邮箱链接）

与 **6.2** 分离：用户**无需登录**、**无需**旧密码。Portal 落地页配合邮件链接。

实现：迁移 `password_reset_tokens`；`POST /v1/auth/forgot-password`、`POST /v1/auth/reset-password`（见 OpenAPI）。
发信：`MAIL_PROVIDER=auto|http|smtp|log`（默认 auto）。HTTP：`MAIL_HTTP_URL` + `MAIL_HTTP_FROM`/`MAIL_FROM`（`MAIL_HTTP_FORMAT=simple|resend|sendgrid`，Bearer/`MAIL_HTTP_API_KEY`）；SMTP：`SMTP_*`。都未配置时默认 `MAIL_DEV_LOG` 写服务端日志，非生产响应可含 `devResetUrl`。

### 6.4 刷新 Token

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

**Query Parameters**: `resellerId` — 按 **RESELLER `tenants.tenant_id`**（§0 / **FR-058**）过滤（平台侧）；代理商管理员范围通常由 JWT 约束。

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

- Bearer Token (JWT HS256)：`Authorization: Bearer <token>`（JWT 中的 `resellerId` 语义见 §0 **FR-058**）
- API Key：`X-API-Key: <key>`（M2M 集成）

### 8.4 Rate Limiting

- Token Bucket 算法，按租户+接口
- 超限返回 `429 Too Many Requests`，含 `Retry-After` 头
