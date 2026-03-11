# API 系统性测试任务清单

- 生成时间: 2026-03-08T07:59:20.378Z
- 范围基线: OpenAPI（packages/openapi/openapi.yaml） + 代码额外路由补齐
- 生成方式: 自动解析 schema，按字段推导边界值与类型错误输入集合

## 用例模板（每条用例都按此填写）

- 用例编号:
- 接口:
- 分类: HP | BND | TYPE | AUTH | STATE | CONCURRENCY | PERF | SEC
- 鉴权:
- 前置条件:
- 请求:
- 期望响应:
- 后置断言:
- 清理/回滚:
- 备注:

## Token/身份矩阵（权限类用例统一引用）

| 场景ID | 身份/Token | 期望 | 说明 |
|---|---|---|---|
| AUTH-00 | 无Token | 401/403 | 取决于接口是否公开 |
| AUTH-01 | 缺失Token头 | 401/403 | 验证 header 处理 |
| AUTH-02 | 无效Token | 401 | 签名/格式错误 |
| AUTH-03 | 过期Token | 401 | exp 过期 |
| AUTH-04 | 跨租户Token | 403/404 | A 租户访问 B 资源 |
| AUTH-05 | 低权限角色 | 403 | 角色不满足 RBAC |
| AUTH-06 | 高权限角色 | 2xx | 满足 RBAC 与租户范围 |
| AUTH-07 | Admin API Key | 2xx/403 | 仅 admin 接口允许 |

## 端点清单与用例任务

### OP001 DELETE /admin/share-links/{code}

- Summary: Delete Share Link (Admin)
- Security: AdminApiKeyAuth
- Source: openapi

**用例编号（本端点固定集合）**
- OP001-HP: 正向测试（标准输入 -> 成功响应）
- OP001-AUTH: 权限测试（引用 AUTH-00~AUTH-07）

**入参字段清单（含边界/类型错误枚举）**

| 位置 | 字段 | 必填 | Schema | 边界值枚举 | 类型错误枚举 |
|---|---|---:|---|---|---|
| path | code | Y | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |

**字段级用例任务（逐字段，不做笛卡尔积）**
- OP001-BND-*：对上表每个字段依次覆盖“边界值枚举”
- OP001-TYPE-*：对上表每个字段依次覆盖“类型错误枚举”

### OP002 DELETE /webhook-subscriptions/{webhookId}

- Summary: Delete Webhook Subscription
- Security: BearerAuth | ApiKeyAuth
- Source: openapi

**用例编号（本端点固定集合）**
- OP002-HP: 正向测试（标准输入 -> 成功响应）
- OP002-AUTH: 权限测试（引用 AUTH-00~AUTH-07）

**入参字段清单（含边界/类型错误枚举）**

| 位置 | 字段 | 必填 | Schema | 边界值枚举 | 类型错误枚举 |
|---|---|---:|---|---|---|
| path | webhookId | Y | string, format=uuid | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα<br/>合法UUID:__UUID__<br/>非法UUID:not-a-uuid | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |

**字段级用例任务（逐字段，不做笛卡尔积）**
- OP002-BND-*：对上表每个字段依次覆盖“边界值枚举”
- OP002-TYPE-*：对上表每个字段依次覆盖“类型错误枚举”

### OP003 GET /admin/api-clients

- Summary: List API Clients (Admin)
- Security: AdminApiKeyAuth
- Source: openapi

**用例编号（本端点固定集合）**
- OP003-HP: 正向测试（标准输入 -> 成功响应）
- OP003-AUTH: 权限测试（引用 AUTH-00~AUTH-07）

**入参字段清单（含边界/类型错误枚举）**

| 位置 | 字段 | 必填 | Schema | 边界值枚举 | 类型错误枚举 |
|---|---|---:|---|---|---|
| query | enterpriseId |  | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | status |  | string, enum="ACTIVE"\|"INACTIVE" | 合法枚举:ACTIVE<br/>合法枚举:INACTIVE<br/>非法枚举:__INVALID_ENUM__ | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | sortBy |  | string, enum="createdAt"\|"rotatedAt" | 合法枚举:createdAt<br/>合法枚举:rotatedAt<br/>非法枚举:__INVALID_ENUM__ | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | sortOrder |  | string, enum="asc"\|"desc" | 合法枚举:asc<br/>合法枚举:desc<br/>非法枚举:__INVALID_ENUM__ | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | page |  | integer | 零值:0<br/>负数:-1<br/>极大值:2147483647<br/>极小值:-2147483648 | string:abc<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | limit |  | integer | 零值:0<br/>负数:-1<br/>极大值:2147483647<br/>极小值:-2147483648 | string:abc<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |

**字段级用例任务（逐字段，不做笛卡尔积）**
- OP003-BND-*：对上表每个字段依次覆盖“边界值枚举”
- OP003-TYPE-*：对上表每个字段依次覆盖“类型错误枚举”

### OP004 GET /admin/api-clients:csv

- Summary: Export API Clients CSV (Admin)
- Security: AdminApiKeyAuth
- Source: openapi

**用例编号（本端点固定集合）**
- OP004-HP: 正向测试（标准输入 -> 成功响应）
- OP004-AUTH: 权限测试（引用 AUTH-00~AUTH-07）

**入参字段清单（含边界/类型错误枚举）**

| 位置 | 字段 | 必填 | Schema | 边界值枚举 | 类型错误枚举 |
|---|---|---:|---|---|---|
| query | enterpriseId |  | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | status |  | string, enum="ACTIVE"\|"INACTIVE" | 合法枚举:ACTIVE<br/>合法枚举:INACTIVE<br/>非法枚举:__INVALID_ENUM__ | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | sortBy |  | string, enum="createdAt"\|"rotatedAt" | 合法枚举:createdAt<br/>合法枚举:rotatedAt<br/>非法枚举:__INVALID_ENUM__ | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | sortOrder |  | string, enum="asc"\|"desc" | 合法枚举:asc<br/>合法枚举:desc<br/>非法枚举:__INVALID_ENUM__ | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | page |  | integer | 零值:0<br/>负数:-1<br/>极大值:2147483647<br/>极小值:-2147483648 | string:abc<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | limit |  | integer | 零值:0<br/>负数:-1<br/>极大值:2147483647<br/>极小值:-2147483648 | string:abc<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |

**字段级用例任务（逐字段，不做笛卡尔积）**
- OP004-BND-*：对上表每个字段依次覆盖“边界值枚举”
- OP004-TYPE-*：对上表每个字段依次覆盖“类型错误枚举”

### OP005 GET /admin/audits

- Summary: List Audit Logs (Admin)
- Security: AdminApiKeyAuth
- Source: openapi

**用例编号（本端点固定集合）**
- OP005-HP: 正向测试（标准输入 -> 成功响应）
- OP005-AUTH: 权限测试（引用 AUTH-00~AUTH-07）

**入参字段清单（含边界/类型错误枚举）**

| 位置 | 字段 | 必填 | Schema | 边界值枚举 | 类型错误枚举 |
|---|---|---:|---|---|---|
| query | tenantId |  | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | action |  | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | sortBy |  | string, enum="createdAt" | 合法枚举:createdAt<br/>非法枚举:__INVALID_ENUM__ | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | sortOrder |  | string, enum="asc"\|"desc" | 合法枚举:asc<br/>合法枚举:desc<br/>非法枚举:__INVALID_ENUM__ | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | start |  | string, format=date-time | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | end |  | string, format=date-time | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | page |  | integer | 零值:0<br/>负数:-1<br/>极大值:2147483647<br/>极小值:-2147483648 | string:abc<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | limit |  | integer | 零值:0<br/>负数:-1<br/>极大值:2147483647<br/>极小值:-2147483648 | string:abc<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |

**字段级用例任务（逐字段，不做笛卡尔积）**
- OP005-BND-*：对上表每个字段依次覆盖“边界值枚举”
- OP005-TYPE-*：对上表每个字段依次覆盖“类型错误枚举”

### OP006 GET /admin/audits:csv

- Summary: Export Audit Logs as CSV (Admin)
- Security: AdminApiKeyAuth
- Source: openapi

**用例编号（本端点固定集合）**
- OP006-HP: 正向测试（标准输入 -> 成功响应）
- OP006-AUTH: 权限测试（引用 AUTH-00~AUTH-07）

**入参字段清单（含边界/类型错误枚举）**

| 位置 | 字段 | 必填 | Schema | 边界值枚举 | 类型错误枚举 |
|---|---|---:|---|---|---|
| query | tenantId |  | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | action |  | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | sortBy |  | string, enum="createdAt" | 合法枚举:createdAt<br/>非法枚举:__INVALID_ENUM__ | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | sortOrder |  | string, enum="asc"\|"desc" | 合法枚举:asc<br/>合法枚举:desc<br/>非法枚举:__INVALID_ENUM__ | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | start |  | string, format=date-time | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | end |  | string, format=date-time | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | page |  | integer | 零值:0<br/>负数:-1<br/>极大值:2147483647<br/>极小值:-2147483648 | string:abc<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | limit |  | integer | 零值:0<br/>负数:-1<br/>极大值:2147483647<br/>极小值:-2147483648 | string:abc<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |

**字段级用例任务（逐字段，不做笛卡尔积）**
- OP006-BND-*：对上表每个字段依次覆盖“边界值枚举”
- OP006-TYPE-*：对上表每个字段依次覆盖“类型错误枚举”

### OP007 GET /admin/audits/{auditId}

- Summary: Get Audit Detail (Admin)
- Security: AdminApiKeyAuth
- Source: openapi

**用例编号（本端点固定集合）**
- OP007-HP: 正向测试（标准输入 -> 成功响应）
- OP007-AUTH: 权限测试（引用 AUTH-00~AUTH-07）

**入参字段清单（含边界/类型错误枚举）**

| 位置 | 字段 | 必填 | Schema | 边界值枚举 | 类型错误枚举 |
|---|---|---:|---|---|---|
| path | auditId | Y | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |

**字段级用例任务（逐字段，不做笛卡尔积）**
- OP007-BND-*：对上表每个字段依次覆盖“边界值枚举”
- OP007-TYPE-*：对上表每个字段依次覆盖“类型错误枚举”

### OP008 GET /admin/events

- Summary: List Events (Admin)
- Security: AdminApiKeyAuth
- Source: openapi

**用例编号（本端点固定集合）**
- OP008-HP: 正向测试（标准输入 -> 成功响应）
- OP008-AUTH: 权限测试（引用 AUTH-00~AUTH-07）

**入参字段清单（含边界/类型错误枚举）**

| 位置 | 字段 | 必填 | Schema | 边界值枚举 | 类型错误枚举 |
|---|---|---:|---|---|---|
| query | eventType |  | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | tenantId |  | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | requestId |  | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | iccid |  | string, pattern=^[0-9]{18,20}$ | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα<br/>满足pattern:<match ^[0-9]{18,20}$><br/>不满足pattern:<mismatch ^[0-9]{18,20}$> | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | beforeStatus |  | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | afterStatus |  | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | reason |  | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | sortBy |  | string, enum="occurredAt" | 合法枚举:occurredAt<br/>非法枚举:__INVALID_ENUM__ | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | sortOrder |  | string, enum="asc"\|"desc" | 合法枚举:asc<br/>合法枚举:desc<br/>非法枚举:__INVALID_ENUM__ | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | start |  | string, format=date-time | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | end |  | string, format=date-time | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | page |  | integer | 零值:0<br/>负数:-1<br/>极大值:2147483647<br/>极小值:-2147483648 | string:abc<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | limit |  | integer | 零值:0<br/>负数:-1<br/>极大值:2147483647<br/>极小值:-2147483648 | string:abc<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |

**字段级用例任务（逐字段，不做笛卡尔积）**
- OP008-BND-*：对上表每个字段依次覆盖“边界值枚举”
- OP008-TYPE-*：对上表每个字段依次覆盖“类型错误枚举”

### OP009 GET /admin/events:csv

- Summary: Export Events CSV (Admin)
- Security: AdminApiKeyAuth
- Source: openapi

**用例编号（本端点固定集合）**
- OP009-HP: 正向测试（标准输入 -> 成功响应）
- OP009-AUTH: 权限测试（引用 AUTH-00~AUTH-07）

**入参字段清单（含边界/类型错误枚举）**

| 位置 | 字段 | 必填 | Schema | 边界值枚举 | 类型错误枚举 |
|---|---|---:|---|---|---|
| query | eventType |  | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | tenantId |  | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | requestId |  | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | iccid |  | string, pattern=^[0-9]{18,20}$ | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα<br/>满足pattern:<match ^[0-9]{18,20}$><br/>不满足pattern:<mismatch ^[0-9]{18,20}$> | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | beforeStatus |  | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | afterStatus |  | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | reason |  | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | sortBy |  | string, enum="occurredAt" | 合法枚举:occurredAt<br/>非法枚举:__INVALID_ENUM__ | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | sortOrder |  | string, enum="asc"\|"desc" | 合法枚举:asc<br/>合法枚举:desc<br/>非法枚举:__INVALID_ENUM__ | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | start |  | string, format=date-time | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | end |  | string, format=date-time | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | page |  | integer | 零值:0<br/>负数:-1<br/>极大值:2147483647<br/>极小值:-2147483648 | string:abc<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | limit |  | integer | 零值:0<br/>负数:-1<br/>极大值:2147483647<br/>极小值:-2147483648 | string:abc<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |

**字段级用例任务（逐字段，不做笛卡尔积）**
- OP009-BND-*：对上表每个字段依次覆盖“边界值枚举”
- OP009-TYPE-*：对上表每个字段依次覆盖“类型错误枚举”

### OP010 GET /admin/events/{eventId}

- Summary: Get Event Detail (Admin)
- Security: AdminApiKeyAuth
- Source: openapi

**用例编号（本端点固定集合）**
- OP010-HP: 正向测试（标准输入 -> 成功响应）
- OP010-AUTH: 权限测试（引用 AUTH-00~AUTH-07）

**入参字段清单（含边界/类型错误枚举）**

| 位置 | 字段 | 必填 | Schema | 边界值枚举 | 类型错误枚举 |
|---|---|---:|---|---|---|
| path | eventId | Y | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |

**字段级用例任务（逐字段，不做笛卡尔积）**
- OP010-BND-*：对上表每个字段依次覆盖“边界值枚举”
- OP010-TYPE-*：对上表每个字段依次覆盖“类型错误枚举”

### OP011 GET /admin/jobs

- Summary: List Jobs (Admin)
- Security: AdminApiKeyAuth
- Source: openapi

**用例编号（本端点固定集合）**
- OP011-HP: 正向测试（标准输入 -> 成功响应）
- OP011-AUTH: 权限测试（引用 AUTH-00~AUTH-07）

**入参字段清单（含边界/类型错误枚举）**

| 位置 | 字段 | 必填 | Schema | 边界值枚举 | 类型错误枚举 |
|---|---|---:|---|---|---|
| query | jobType |  | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | status |  | string, enum="QUEUED"\|"RUNNING"\|"SUCCEEDED"\|"FAILED"\|"CANCELLED" | 合法枚举:QUEUED<br/>合法枚举:RUNNING<br/>合法枚举:SUCCEEDED<br/>合法枚举:FAILED<br/>合法枚举:CANCELLED<br/>非法枚举:__INVALID_ENUM__ | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | requestId |  | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | sortBy |  | string, enum="startedAt"\|"finishedAt" | 合法枚举:startedAt<br/>合法枚举:finishedAt<br/>非法枚举:__INVALID_ENUM__ | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | sortOrder |  | string, enum="asc"\|"desc" | 合法枚举:asc<br/>合法枚举:desc<br/>非法枚举:__INVALID_ENUM__ | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | startDate |  | string, format=date-time | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | endDate |  | string, format=date-time | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | page |  | integer | 零值:0<br/>负数:-1<br/>极大值:2147483647<br/>极小值:-2147483648 | string:abc<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | limit |  | integer | 零值:0<br/>负数:-1<br/>极大值:2147483647<br/>极小值:-2147483648 | string:abc<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |

**字段级用例任务（逐字段，不做笛卡尔积）**
- OP011-BND-*：对上表每个字段依次覆盖“边界值枚举”
- OP011-TYPE-*：对上表每个字段依次覆盖“类型错误枚举”

### OP012 GET /admin/jobs:csv

- Summary: Export Jobs CSV (Admin)
- Security: AdminApiKeyAuth
- Source: openapi

**用例编号（本端点固定集合）**
- OP012-HP: 正向测试（标准输入 -> 成功响应）
- OP012-AUTH: 权限测试（引用 AUTH-00~AUTH-07）

**入参字段清单（含边界/类型错误枚举）**

| 位置 | 字段 | 必填 | Schema | 边界值枚举 | 类型错误枚举 |
|---|---|---:|---|---|---|
| query | jobType |  | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | status |  | string, enum="QUEUED"\|"RUNNING"\|"SUCCEEDED"\|"FAILED"\|"CANCELLED" | 合法枚举:QUEUED<br/>合法枚举:RUNNING<br/>合法枚举:SUCCEEDED<br/>合法枚举:FAILED<br/>合法枚举:CANCELLED<br/>非法枚举:__INVALID_ENUM__ | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | requestId |  | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | sortBy |  | string, enum="startedAt"\|"finishedAt" | 合法枚举:startedAt<br/>合法枚举:finishedAt<br/>非法枚举:__INVALID_ENUM__ | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | sortOrder |  | string, enum="asc"\|"desc" | 合法枚举:asc<br/>合法枚举:desc<br/>非法枚举:__INVALID_ENUM__ | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | startDate |  | string, format=date-time | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | endDate |  | string, format=date-time | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | page |  | integer | 零值:0<br/>负数:-1<br/>极大值:2147483647<br/>极小值:-2147483648 | string:abc<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | limit |  | integer | 零值:0<br/>负数:-1<br/>极大值:2147483647<br/>极小值:-2147483648 | string:abc<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |

**字段级用例任务（逐字段，不做笛卡尔积）**
- OP012-BND-*：对上表每个字段依次覆盖“边界值枚举”
- OP012-TYPE-*：对上表每个字段依次覆盖“类型错误枚举”

### OP013 GET /admin/jobs/{jobId}

- Summary: Get Job Detail (Admin)
- Security: AdminApiKeyAuth
- Source: openapi

**用例编号（本端点固定集合）**
- OP013-HP: 正向测试（标准输入 -> 成功响应）
- OP013-AUTH: 权限测试（引用 AUTH-00~AUTH-07）

**入参字段清单（含边界/类型错误枚举）**

| 位置 | 字段 | 必填 | Schema | 边界值枚举 | 类型错误枚举 |
|---|---|---:|---|---|---|
| path | jobId | Y | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |

**字段级用例任务（逐字段，不做笛卡尔积）**
- OP013-BND-*：对上表每个字段依次覆盖“边界值枚举”
- OP013-TYPE-*：对上表每个字段依次覆盖“类型错误枚举”

### OP014 GET /admin/share-links

- Summary: List Share Links (Admin)
- Security: AdminApiKeyAuth
- Source: openapi

**用例编号（本端点固定集合）**
- OP014-HP: 正向测试（标准输入 -> 成功响应）
- OP014-AUTH: 权限测试（引用 AUTH-00~AUTH-07）

**入参字段清单（含边界/类型错误枚举）**

| 位置 | 字段 | 必填 | Schema | 边界值枚举 | 类型错误枚举 |
|---|---|---:|---|---|---|
| query | enterpriseId |  | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | kind |  | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | code |  | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | codePrefix |  | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | codeLike |  | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | requestId |  | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | expiresFrom |  | string, format=date-time | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | expiresTo |  | string, format=date-time | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | status |  | string, enum="active"\|"expired" | 合法枚举:active<br/>合法枚举:expired<br/>非法枚举:__INVALID_ENUM__ | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | sortBy |  | string, enum="expiresAt"\|"createdAt"\|"code" | 合法枚举:expiresAt<br/>合法枚举:createdAt<br/>合法枚举:code<br/>非法枚举:__INVALID_ENUM__ | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | sortOrder |  | string, enum="asc"\|"desc" | 合法枚举:asc<br/>合法枚举:desc<br/>非法枚举:__INVALID_ENUM__ | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | page |  | integer | 零值:0<br/>负数:-1<br/>极大值:2147483647<br/>极小值:-2147483648 | string:abc<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | limit |  | integer | 零值:0<br/>负数:-1<br/>极大值:2147483647<br/>极小值:-2147483648 | string:abc<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |

**字段级用例任务（逐字段，不做笛卡尔积）**
- OP014-BND-*：对上表每个字段依次覆盖“边界值枚举”
- OP014-TYPE-*：对上表每个字段依次覆盖“类型错误枚举”

### OP015 GET /admin/share-links:csv

- Summary: Export Share Links CSV (Admin)
- Security: AdminApiKeyAuth
- Source: openapi

**用例编号（本端点固定集合）**
- OP015-HP: 正向测试（标准输入 -> 成功响应）
- OP015-AUTH: 权限测试（引用 AUTH-00~AUTH-07）

**入参字段清单（含边界/类型错误枚举）**

| 位置 | 字段 | 必填 | Schema | 边界值枚举 | 类型错误枚举 |
|---|---|---:|---|---|---|
| query | enterpriseId |  | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | kind |  | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | code |  | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | codePrefix |  | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | codeLike |  | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | requestId |  | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | expiresFrom |  | string, format=date-time | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | expiresTo |  | string, format=date-time | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | status |  | string, enum="active"\|"expired" | 合法枚举:active<br/>合法枚举:expired<br/>非法枚举:__INVALID_ENUM__ | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | sortBy |  | string, enum="expiresAt"\|"createdAt"\|"code" | 合法枚举:expiresAt<br/>合法枚举:createdAt<br/>合法枚举:code<br/>非法枚举:__INVALID_ENUM__ | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | sortOrder |  | string, enum="asc"\|"desc" | 合法枚举:asc<br/>合法枚举:desc<br/>非法枚举:__INVALID_ENUM__ | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | page |  | integer | 零值:0<br/>负数:-1<br/>极大值:2147483647<br/>极小值:-2147483648 | string:abc<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | limit |  | integer | 零值:0<br/>负数:-1<br/>极大值:2147483647<br/>极小值:-2147483648 | string:abc<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |

**字段级用例任务（逐字段，不做笛卡尔积）**
- OP015-BND-*：对上表每个字段依次覆盖“边界值枚举”
- OP015-TYPE-*：对上表每个字段依次覆盖“类型错误枚举”

### OP016 GET /admin/wx/sims/{iccid}/status

- Summary: Get WXZHONGGENG SIM Status (Admin)
- Security: AdminApiKeyAuth
- Source: openapi

**用例编号（本端点固定集合）**
- OP016-HP: 正向测试（标准输入 -> 成功响应）
- OP016-AUTH: 权限测试（引用 AUTH-00~AUTH-07）
- OP016-STATE-SIM_STATUS: 状态依赖测试（状态机约束）

**入参字段清单（含边界/类型错误枚举）**

| 位置 | 字段 | 必填 | Schema | 边界值枚举 | 类型错误枚举 |
|---|---|---:|---|---|---|
| path | iccid | Y | string, pattern=^[0-9]{18,20}$ | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα<br/>满足pattern:<match ^[0-9]{18,20}$><br/>不满足pattern:<mismatch ^[0-9]{18,20}$> | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |

**字段级用例任务（逐字段，不做笛卡尔积）**
- OP016-BND-*：对上表每个字段依次覆盖“边界值枚举”
- OP016-TYPE-*：对上表每个字段依次覆盖“类型错误枚举”

### OP017 GET /alerts

- Summary: List Alerts
- Security: BearerAuth | ApiKeyAuth
- Source: openapi

**用例编号（本端点固定集合）**
- OP017-HP: 正向测试（标准输入 -> 成功响应）
- OP017-AUTH: 权限测试（引用 AUTH-00~AUTH-07）

**入参字段清单（含边界/类型错误枚举）**

| 位置 | 字段 | 必填 | Schema | 边界值枚举 | 类型错误枚举 |
|---|---|---:|---|---|---|
| query | enterpriseId |  | string, format=uuid | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα<br/>合法UUID:__UUID__<br/>非法UUID:not-a-uuid | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | alertType |  | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | from |  | string, format=date-time | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | to |  | string, format=date-time | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | acknowledged |  | boolean | true:true<br/>false:false | string:true<br/>number:1<br/>object:{...}<br/>array:[]<br/>null:null |
| query | page |  | integer | 零值:0<br/>负数:-1<br/>极大值:2147483647<br/>极小值:-2147483648 | string:abc<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | limit |  | integer | 零值:0<br/>负数:-1<br/>极大值:2147483647<br/>极小值:-2147483648 | string:abc<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |

**字段级用例任务（逐字段，不做笛卡尔积）**
- OP017-BND-*：对上表每个字段依次覆盖“边界值枚举”
- OP017-TYPE-*：对上表每个字段依次覆盖“类型错误枚举”

### OP018 GET /alerts/summary

- Summary: Alert Summary
- Security: BearerAuth | ApiKeyAuth
- Source: openapi

**用例编号（本端点固定集合）**
- OP018-HP: 正向测试（标准输入 -> 成功响应）
- OP018-AUTH: 权限测试（引用 AUTH-00~AUTH-07）

**入参字段清单（含边界/类型错误枚举）**

| 位置 | 字段 | 必填 | Schema | 边界值枚举 | 类型错误枚举 |
|---|---|---:|---|---|---|
| query | from |  | string, format=date-time | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | to |  | string, format=date-time | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | severity |  | string, enum="P0"\|"P1"\|"P2"\|"P3" | 合法枚举:P0<br/>合法枚举:P1<br/>合法枚举:P2<br/>合法枚举:P3<br/>非法枚举:__INVALID_ENUM__ | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | alertType |  | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |

**字段级用例任务（逐字段，不做笛卡尔积）**
- OP018-BND-*：对上表每个字段依次覆盖“边界值枚举”
- OP018-TYPE-*：对上表每个字段依次覆盖“类型错误枚举”

### OP019 GET /alerts/trends

- Summary: Alert Trends
- Security: BearerAuth | ApiKeyAuth
- Source: openapi

**用例编号（本端点固定集合）**
- OP019-HP: 正向测试（标准输入 -> 成功响应）
- OP019-AUTH: 权限测试（引用 AUTH-00~AUTH-07）

**入参字段清单（含边界/类型错误枚举）**

| 位置 | 字段 | 必填 | Schema | 边界值枚举 | 类型错误枚举 |
|---|---|---:|---|---|---|
| query | from |  | string, format=date-time | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | to |  | string, format=date-time | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | bucket |  | string, enum="hour"\|"day" | 合法枚举:hour<br/>合法枚举:day<br/>非法枚举:__INVALID_ENUM__ | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | alertType |  | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |

**字段级用例任务（逐字段，不做笛卡尔积）**
- OP019-BND-*：对上表每个字段依次覆盖“边界值枚举”
- OP019-TYPE-*：对上表每个字段依次覆盖“类型错误枚举”

### OP020 GET /apn-profiles

- Summary: List APN Profiles
- Security: BearerAuth | ApiKeyAuth
- Source: openapi

**用例编号（本端点固定集合）**
- OP020-HP: 正向测试（标准输入 -> 成功响应）
- OP020-AUTH: 权限测试（引用 AUTH-00~AUTH-07）

**入参字段清单（含边界/类型错误枚举）**

| 位置 | 字段 | 必填 | Schema | 边界值枚举 | 类型错误枚举 |
|---|---|---:|---|---|---|
| query | supplierId |  | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | carrierId |  | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | status |  | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | page |  | integer | 零值:0<br/>负数:-1<br/>极大值:2147483647<br/>极小值:-2147483648 | string:abc<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | pageSize |  | integer | 零值:0<br/>负数:-1<br/>极大值:2147483647<br/>极小值:-2147483648 | string:abc<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |

**字段级用例任务（逐字段，不做笛卡尔积）**
- OP020-BND-*：对上表每个字段依次覆盖“边界值枚举”
- OP020-TYPE-*：对上表每个字段依次覆盖“类型错误枚举”

### OP021 GET /apn-profiles/{apnProfileId}

- Summary: Get APN Profile Detail
- Security: BearerAuth | ApiKeyAuth
- Source: openapi

**用例编号（本端点固定集合）**
- OP021-HP: 正向测试（标准输入 -> 成功响应）
- OP021-AUTH: 权限测试（引用 AUTH-00~AUTH-07）

**入参字段清单（含边界/类型错误枚举）**

| 位置 | 字段 | 必填 | Schema | 边界值枚举 | 类型错误枚举 |
|---|---|---:|---|---|---|
| path | apnProfileId | Y | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |

**字段级用例任务（逐字段，不做笛卡尔积）**
- OP021-BND-*：对上表每个字段依次覆盖“边界值枚举”
- OP021-TYPE-*：对上表每个字段依次覆盖“类型错误枚举”

### OP022 GET /audit-logs

- Summary: List Audit Logs
- Security: BearerAuth | ApiKeyAuth
- Source: openapi

**用例编号（本端点固定集合）**
- OP022-HP: 正向测试（标准输入 -> 成功响应）
- OP022-AUTH: 权限测试（引用 AUTH-00~AUTH-07）

**入参字段清单（含边界/类型错误枚举）**

| 位置 | 字段 | 必填 | Schema | 边界值枚举 | 类型错误枚举 |
|---|---|---:|---|---|---|
| query | actor |  | string, format=uuid | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα<br/>合法UUID:__UUID__<br/>非法UUID:not-a-uuid | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | action |  | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | from |  | string, format=date-time | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | to |  | string, format=date-time | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | resellerId |  | string, format=uuid | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα<br/>合法UUID:__UUID__<br/>非法UUID:not-a-uuid | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | page |  | integer | 零值:0<br/>负数:-1<br/>极大值:2147483647<br/>极小值:-2147483648 | string:abc<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | pageSize |  | integer | 零值:0<br/>负数:-1<br/>极大值:2147483647<br/>极小值:-2147483648 | string:abc<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |

**字段级用例任务（逐字段，不做笛卡尔积）**
- OP022-BND-*：对上表每个字段依次覆盖“边界值枚举”
- OP022-TYPE-*：对上表每个字段依次覆盖“类型错误枚举”

### OP023 GET /bills

- Summary: List Bills
- Security: BearerAuth | ApiKeyAuth
- Source: openapi

**用例编号（本端点固定集合）**
- OP023-HP: 正向测试（标准输入 -> 成功响应）
- OP023-AUTH: 权限测试（引用 AUTH-00~AUTH-07）

**入参字段清单（含边界/类型错误枚举）**

| 位置 | 字段 | 必填 | Schema | 边界值枚举 | 类型错误枚举 |
|---|---|---:|---|---|---|
| query | period |  | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | status |  | string, enum="GENERATED"\|"PUBLISHED"\|"PAID"\|"OVERDUE"\|"WRITTEN_OFF" | 合法枚举:GENERATED<br/>合法枚举:PUBLISHED<br/>合法枚举:PAID<br/>合法枚举:OVERDUE<br/>合法枚举:WRITTEN_OFF<br/>非法枚举:__INVALID_ENUM__ | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | sortBy |  | string, enum="period"\|"dueDate"\|"totalAmount"\|"status" | 合法枚举:period<br/>合法枚举:dueDate<br/>合法枚举:totalAmount<br/>合法枚举:status<br/>非法枚举:__INVALID_ENUM__ | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | sortOrder |  | string, enum="asc"\|"desc" | 合法枚举:asc<br/>合法枚举:desc<br/>非法枚举:__INVALID_ENUM__ | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |

**字段级用例任务（逐字段，不做笛卡尔积）**
- OP023-BND-*：对上表每个字段依次覆盖“边界值枚举”
- OP023-TYPE-*：对上表每个字段依次覆盖“类型错误枚举”

### OP024 GET /bills:csv

- Summary: Export Bills CSV
- Security: BearerAuth | ApiKeyAuth
- Source: openapi

**用例编号（本端点固定集合）**
- OP024-HP: 正向测试（标准输入 -> 成功响应）
- OP024-AUTH: 权限测试（引用 AUTH-00~AUTH-07）

**入参字段清单（含边界/类型错误枚举）**

| 位置 | 字段 | 必填 | Schema | 边界值枚举 | 类型错误枚举 |
|---|---|---:|---|---|---|
| query | period |  | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | status |  | string, enum="GENERATED"\|"PUBLISHED"\|"PAID"\|"OVERDUE"\|"WRITTEN_OFF" | 合法枚举:GENERATED<br/>合法枚举:PUBLISHED<br/>合法枚举:PAID<br/>合法枚举:OVERDUE<br/>合法枚举:WRITTEN_OFF<br/>非法枚举:__INVALID_ENUM__ | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | sortBy |  | string, enum="period"\|"dueDate"\|"totalAmount"\|"status" | 合法枚举:period<br/>合法枚举:dueDate<br/>合法枚举:totalAmount<br/>合法枚举:status<br/>非法枚举:__INVALID_ENUM__ | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | sortOrder |  | string, enum="asc"\|"desc" | 合法枚举:asc<br/>合法枚举:desc<br/>非法枚举:__INVALID_ENUM__ | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | limit |  | integer | 零值:0<br/>负数:-1<br/>极大值:2147483647<br/>极小值:-2147483648 | string:abc<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | page |  | integer | 零值:0<br/>负数:-1<br/>极大值:2147483647<br/>极小值:-2147483648 | string:abc<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |

**字段级用例任务（逐字段，不做笛卡尔积）**
- OP024-BND-*：对上表每个字段依次覆盖“边界值枚举”
- OP024-TYPE-*：对上表每个字段依次覆盖“类型错误枚举”

### OP025 GET /bills/{billId}

- Summary: Get Bill Details
- Security: BearerAuth | ApiKeyAuth
- Source: openapi

**用例编号（本端点固定集合）**
- OP025-HP: 正向测试（标准输入 -> 成功响应）
- OP025-AUTH: 权限测试（引用 AUTH-00~AUTH-07）

**入参字段清单（含边界/类型错误枚举）**

| 位置 | 字段 | 必填 | Schema | 边界值枚举 | 类型错误枚举 |
|---|---|---:|---|---|---|
| path | billId | Y | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |

**字段级用例任务（逐字段，不做笛卡尔积）**
- OP025-BND-*：对上表每个字段依次覆盖“边界值枚举”
- OP025-TYPE-*：对上表每个字段依次覆盖“类型错误枚举”

### OP026 GET /bills/{billId}/files

- Summary: Download Bill Files
- Security: BearerAuth | ApiKeyAuth
- Source: openapi

**用例编号（本端点固定集合）**
- OP026-HP: 正向测试（标准输入 -> 成功响应）
- OP026-AUTH: 权限测试（引用 AUTH-00~AUTH-07）

**入参字段清单（含边界/类型错误枚举）**

| 位置 | 字段 | 必填 | Schema | 边界值枚举 | 类型错误枚举 |
|---|---|---:|---|---|---|
| path | billId | Y | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |

**字段级用例任务（逐字段，不做笛卡尔积）**
- OP026-BND-*：对上表每个字段依次覆盖“边界值枚举”
- OP026-TYPE-*：对上表每个字段依次覆盖“类型错误枚举”

### OP027 GET /bills/{billId}/files/csv

- Summary: Download Bill CSV
- Security: BearerAuth | ApiKeyAuth
- Source: openapi

**用例编号（本端点固定集合）**
- OP027-HP: 正向测试（标准输入 -> 成功响应）
- OP027-AUTH: 权限测试（引用 AUTH-00~AUTH-07）

**入参字段清单（含边界/类型错误枚举）**

| 位置 | 字段 | 必填 | Schema | 边界值枚举 | 类型错误枚举 |
|---|---|---:|---|---|---|
| path | billId | Y | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |

**字段级用例任务（逐字段，不做笛卡尔积）**
- OP027-BND-*：对上表每个字段依次覆盖“边界值枚举”
- OP027-TYPE-*：对上表每个字段依次覆盖“类型错误枚举”

### OP028 GET /bills/{billId}/reconciliation

- Summary: Bill reconciliation summary
- Security: BearerAuth
- Source: code:src/app.ts

**用例编号（本端点固定集合）**
- OP028-HP: 正向测试（标准输入 -> 成功响应）
- OP028-AUTH: 权限测试（引用 AUTH-00~AUTH-07）

**入参字段清单（含边界/类型错误枚举）**

| 位置 | 字段 | 必填 | Schema | 边界值枚举 | 类型错误枚举 |
|---|---|---:|---|---|---|
| path | billId | Y | string, format=uuid | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα<br/>合法UUID:__UUID__<br/>非法UUID:not-a-uuid | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |

**字段级用例任务（逐字段，不做笛卡尔积）**
- OP028-BND-*：对上表每个字段依次覆盖“边界值枚举”
- OP028-TYPE-*：对上表每个字段依次覆盖“类型错误枚举”

### OP029 GET /bills/{billId}/reconciliation:csv

- Summary: Bill reconciliation CSV export
- Security: BearerAuth
- Source: code:src/app.ts

**用例编号（本端点固定集合）**
- OP029-HP: 正向测试（标准输入 -> 成功响应）
- OP029-AUTH: 权限测试（引用 AUTH-00~AUTH-07）

**入参字段清单（含边界/类型错误枚举）**

| 位置 | 字段 | 必填 | Schema | 边界值枚举 | 类型错误枚举 |
|---|---|---:|---|---|---|
| path | billId | Y | string, format=uuid | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα<br/>合法UUID:__UUID__<br/>非法UUID:not-a-uuid | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |

**字段级用例任务（逐字段，不做笛卡尔积）**
- OP029-BND-*：对上表每个字段依次覆盖“边界值枚举”
- OP029-TYPE-*：对上表每个字段依次覆盖“类型错误枚举”

### OP030 GET /departments/{departmentId}

- Summary: Get Department Detail
- Security: BearerAuth | ApiKeyAuth
- Source: openapi

**用例编号（本端点固定集合）**
- OP030-HP: 正向测试（标准输入 -> 成功响应）
- OP030-AUTH: 权限测试（引用 AUTH-00~AUTH-07）

**入参字段清单（含边界/类型错误枚举）**

| 位置 | 字段 | 必填 | Schema | 边界值枚举 | 类型错误枚举 |
|---|---|---:|---|---|---|
| path | departmentId | Y | string, format=uuid | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα<br/>合法UUID:__UUID__<br/>非法UUID:not-a-uuid | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |

**字段级用例任务（逐字段，不做笛卡尔积）**
- OP030-BND-*：对上表每个字段依次覆盖“边界值枚举”
- OP030-TYPE-*：对上表每个字段依次覆盖“类型错误枚举”

### OP031 GET /enterprises

- Summary: List Enterprises
- Security: BearerAuth | ApiKeyAuth
- Source: openapi

**用例编号（本端点固定集合）**
- OP031-HP: 正向测试（标准输入 -> 成功响应）
- OP031-AUTH: 权限测试（引用 AUTH-00~AUTH-07）

**入参字段清单（含边界/类型错误枚举）**

| 位置 | 字段 | 必填 | Schema | 边界值枚举 | 类型错误枚举 |
|---|---|---:|---|---|---|
| query | page |  | integer | 零值:0<br/>负数:-1<br/>极大值:2147483647<br/>极小值:-2147483648 | string:abc<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | pageSize |  | integer | 零值:0<br/>负数:-1<br/>极大值:2147483647<br/>极小值:-2147483648 | string:abc<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | status |  | string, enum="ACTIVE"\|"INACTIVE"\|"SUSPENDED" | 合法枚举:ACTIVE<br/>合法枚举:INACTIVE<br/>合法枚举:SUSPENDED<br/>非法枚举:__INVALID_ENUM__ | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | resellerId |  | string, format=uuid | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα<br/>合法UUID:__UUID__<br/>非法UUID:not-a-uuid | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |

**字段级用例任务（逐字段，不做笛卡尔积）**
- OP031-BND-*：对上表每个字段依次覆盖“边界值枚举”
- OP031-TYPE-*：对上表每个字段依次覆盖“类型错误枚举”

### OP032 GET /enterprises/{enterpriseId}

- Summary: Get Enterprise Detail
- Security: BearerAuth | ApiKeyAuth
- Source: openapi

**用例编号（本端点固定集合）**
- OP032-HP: 正向测试（标准输入 -> 成功响应）
- OP032-AUTH: 权限测试（引用 AUTH-00~AUTH-07）

**入参字段清单（含边界/类型错误枚举）**

| 位置 | 字段 | 必填 | Schema | 边界值枚举 | 类型错误枚举 |
|---|---|---:|---|---|---|
| path | enterpriseId | Y | string, format=uuid | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα<br/>合法UUID:__UUID__<br/>非法UUID:not-a-uuid | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |

**字段级用例任务（逐字段，不做笛卡尔积）**
- OP032-BND-*：对上表每个字段依次覆盖“边界值枚举”
- OP032-TYPE-*：对上表每个字段依次覆盖“类型错误枚举”

### OP033 GET /enterprises/{enterpriseId}/departments

- Summary: List Departments
- Security: BearerAuth | ApiKeyAuth
- Source: openapi

**用例编号（本端点固定集合）**
- OP033-HP: 正向测试（标准输入 -> 成功响应）
- OP033-AUTH: 权限测试（引用 AUTH-00~AUTH-07）

**入参字段清单（含边界/类型错误枚举）**

| 位置 | 字段 | 必填 | Schema | 边界值枚举 | 类型错误枚举 |
|---|---|---:|---|---|---|
| path | enterpriseId | Y | string, format=uuid | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα<br/>合法UUID:__UUID__<br/>非法UUID:not-a-uuid | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | page |  | integer | 零值:0<br/>负数:-1<br/>极大值:2147483647<br/>极小值:-2147483648 | string:abc<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | pageSize |  | integer | 零值:0<br/>负数:-1<br/>极大值:2147483647<br/>极小值:-2147483648 | string:abc<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |

**字段级用例任务（逐字段，不做笛卡尔积）**
- OP033-BND-*：对上表每个字段依次覆盖“边界值枚举”
- OP033-TYPE-*：对上表每个字段依次覆盖“类型错误枚举”

### OP034 GET /enterprises/{enterpriseId}/packages

- Summary: List Packages for Enterprise
- Security: BearerAuth | ApiKeyAuth
- Source: openapi

**用例编号（本端点固定集合）**
- OP034-HP: 正向测试（标准输入 -> 成功响应）
- OP034-AUTH: 权限测试（引用 AUTH-00~AUTH-07）

**入参字段清单（含边界/类型错误枚举）**

| 位置 | 字段 | 必填 | Schema | 边界值枚举 | 类型错误枚举 |
|---|---|---:|---|---|---|
| path | enterpriseId | Y | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | status |  | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | page |  | integer | 零值:0<br/>负数:-1<br/>极大值:2147483647<br/>极小值:-2147483648 | string:abc<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | pageSize |  | integer | 零值:0<br/>负数:-1<br/>极大值:2147483647<br/>极小值:-2147483648 | string:abc<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |

**字段级用例任务（逐字段，不做笛卡尔积）**
- OP034-BND-*：对上表每个字段依次覆盖“边界值枚举”
- OP034-TYPE-*：对上表每个字段依次覆盖“类型错误枚举”

### OP035 GET /enterprises/{enterpriseId}/price-plans

- Summary: List Price Plans
- Security: BearerAuth | ApiKeyAuth
- Source: openapi

**用例编号（本端点固定集合）**
- OP035-HP: 正向测试（标准输入 -> 成功响应）
- OP035-AUTH: 权限测试（引用 AUTH-00~AUTH-07）

**入参字段清单（含边界/类型错误枚举）**

| 位置 | 字段 | 必填 | Schema | 边界值枚举 | 类型错误枚举 |
|---|---|---:|---|---|---|
| path | enterpriseId | Y | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | type |  | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | status |  | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | page |  | integer | 零值:0<br/>负数:-1<br/>极大值:2147483647<br/>极小值:-2147483648 | string:abc<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | pageSize |  | integer | 零值:0<br/>负数:-1<br/>极大值:2147483647<br/>极小值:-2147483648 | string:abc<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |

**字段级用例任务（逐字段，不做笛卡尔积）**
- OP035-BND-*：对上表每个字段依次覆盖“边界值枚举”
- OP035-TYPE-*：对上表每个字段依次覆盖“类型错误枚举”

### OP036 GET /enterprises/{enterpriseId}/sims:csv

- Summary: Export Enterprise SIM Cards CSV
- Security: BearerAuth | ApiKeyAuth
- Source: openapi

**用例编号（本端点固定集合）**
- OP036-HP: 正向测试（标准输入 -> 成功响应）
- OP036-AUTH: 权限测试（引用 AUTH-00~AUTH-07）

**入参字段清单（含边界/类型错误枚举）**

| 位置 | 字段 | 必填 | Schema | 边界值枚举 | 类型错误枚举 |
|---|---|---:|---|---|---|
| path | enterpriseId | Y | string, format=uuid | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα<br/>合法UUID:__UUID__<br/>非法UUID:not-a-uuid | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | departmentId |  | string, format=uuid | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα<br/>合法UUID:__UUID__<br/>非法UUID:not-a-uuid | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | iccid |  | string, pattern=^[0-9]{18,20}$ | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα<br/>满足pattern:<match ^[0-9]{18,20}$><br/>不满足pattern:<mismatch ^[0-9]{18,20}$> | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | msisdn |  | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | status |  | string, enum="INVENTORY"\|"TEST_READY"\|"ACTIVATED"\|"DEACTIVATED"\|"RETIRED" | 合法枚举:INVENTORY<br/>合法枚举:TEST_READY<br/>合法枚举:ACTIVATED<br/>合法枚举:DEACTIVATED<br/>合法枚举:RETIRED<br/>非法枚举:__INVALID_ENUM__ | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | limit |  | integer | 零值:0<br/>负数:-1<br/>极大值:2147483647<br/>极小值:-2147483648 | string:abc<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | page |  | integer | 零值:0<br/>负数:-1<br/>极大值:2147483647<br/>极小值:-2147483648 | string:abc<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |

**字段级用例任务（逐字段，不做笛卡尔积）**
- OP036-BND-*：对上表每个字段依次覆盖“边界值枚举”
- OP036-TYPE-*：对上表每个字段依次覆盖“类型错误枚举”

### OP037 GET /events

- Summary: List Events
- Security: BearerAuth | ApiKeyAuth
- Source: openapi

**用例编号（本端点固定集合）**
- OP037-HP: 正向测试（标准输入 -> 成功响应）
- OP037-AUTH: 权限测试（引用 AUTH-00~AUTH-07）

**入参字段清单（含边界/类型错误枚举）**

| 位置 | 字段 | 必填 | Schema | 边界值枚举 | 类型错误枚举 |
|---|---|---:|---|---|---|
| query | enterpriseId |  | string, format=uuid | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα<br/>合法UUID:__UUID__<br/>非法UUID:not-a-uuid | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | resellerId |  | string, format=uuid | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα<br/>合法UUID:__UUID__<br/>非法UUID:not-a-uuid | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | eventType |  | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | from |  | string, format=date-time | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | to |  | string, format=date-time | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | simId |  | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | page |  | integer | 零值:0<br/>负数:-1<br/>极大值:2147483647<br/>极小值:-2147483648 | string:abc<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | pageSize |  | integer | 零值:0<br/>负数:-1<br/>极大值:2147483647<br/>极小值:-2147483648 | string:abc<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |

**字段级用例任务（逐字段，不做笛卡尔积）**
- OP037-BND-*：对上表每个字段依次覆盖“边界值枚举”
- OP037-TYPE-*：对上表每个字段依次覆盖“类型错误枚举”

### OP038 GET /jobs/{jobId}

- Summary: Get Job Status
- Security: BearerAuth | ApiKeyAuth
- Source: openapi

**用例编号（本端点固定集合）**
- OP038-HP: 正向测试（标准输入 -> 成功响应）
- OP038-AUTH: 权限测试（引用 AUTH-00~AUTH-07）

**入参字段清单（含边界/类型错误枚举）**

| 位置 | 字段 | 必填 | Schema | 边界值枚举 | 类型错误枚举 |
|---|---|---:|---|---|---|
| path | jobId | Y | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |

**字段级用例任务（逐字段，不做笛卡尔积）**
- OP038-BND-*：对上表每个字段依次覆盖“边界值枚举”
- OP038-TYPE-*：对上表每个字段依次覆盖“类型错误枚举”

### OP039 GET /operators

- Summary: List Operators
- Security: BearerAuth | ApiKeyAuth
- Source: openapi

**用例编号（本端点固定集合）**
- OP039-HP: 正向测试（标准输入 -> 成功响应）
- OP039-AUTH: 权限测试（引用 AUTH-00~AUTH-07）

**入参字段清单（含边界/类型错误枚举）**

| 位置 | 字段 | 必填 | Schema | 边界值枚举 | 类型错误枚举 |
|---|---|---:|---|---|---|
| query | operatorId |  | string, format=uuid | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα<br/>合法UUID:__UUID__<br/>非法UUID:not-a-uuid | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | mcc |  | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | mnc |  | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | name |  | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | page |  | integer | 零值:0<br/>负数:-1<br/>极大值:2147483647<br/>极小值:-2147483648 | string:abc<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | pageSize |  | integer | 零值:0<br/>负数:-1<br/>极大值:2147483647<br/>极小值:-2147483648 | string:abc<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | limit |  | integer | 零值:0<br/>负数:-1<br/>极大值:2147483647<br/>极小值:-2147483648 | string:abc<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |

**字段级用例任务（逐字段，不做笛卡尔积）**
- OP039-BND-*：对上表每个字段依次覆盖“边界值枚举”
- OP039-TYPE-*：对上表每个字段依次覆盖“类型错误枚举”

### OP040 GET /package-versions

- Summary: List Package Versions
- Security: BearerAuth | ApiKeyAuth
- Source: openapi

**用例编号（本端点固定集合）**
- OP040-HP: 正向测试（标准输入 -> 成功响应）
- OP040-AUTH: 权限测试（引用 AUTH-00~AUTH-07）

**入参字段清单（含边界/类型错误枚举）**

| 位置 | 字段 | 必填 | Schema | 边界值枚举 | 类型错误枚举 |
|---|---|---:|---|---|---|
| query | limit |  | integer | 零值:0<br/>负数:-1<br/>极大值:2147483647<br/>极小值:-2147483648 | string:abc<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | page |  | integer | 零值:0<br/>负数:-1<br/>极大值:2147483647<br/>极小值:-2147483648 | string:abc<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | status |  | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | serviceType |  | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | effectiveFromStart |  | string, format=date-time | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | effectiveFromEnd |  | string, format=date-time | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | mcc |  | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | mnc |  | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | mccmnc |  | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | carrierNameLike |  | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | mccmncList |  | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | carrierName |  | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | carrierId |  | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | apnLike |  | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | sortBy |  | string, enum="createdAt"\|"effectiveFrom"\|"status" | 合法枚举:createdAt<br/>合法枚举:effectiveFrom<br/>合法枚举:status<br/>非法枚举:__INVALID_ENUM__ | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | sortOrder |  | string, enum="asc"\|"desc" | 合法枚举:asc<br/>合法枚举:desc<br/>非法枚举:__INVALID_ENUM__ | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | packageId |  | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | q |  | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |

**字段级用例任务（逐字段，不做笛卡尔积）**
- OP040-BND-*：对上表每个字段依次覆盖“边界值枚举”
- OP040-TYPE-*：对上表每个字段依次覆盖“类型错误枚举”

### OP041 GET /package-versions:csv

- Summary: Export Package Versions CSV
- Security: BearerAuth | ApiKeyAuth
- Source: openapi

**用例编号（本端点固定集合）**
- OP041-HP: 正向测试（标准输入 -> 成功响应）
- OP041-AUTH: 权限测试（引用 AUTH-00~AUTH-07）

**入参字段清单（含边界/类型错误枚举）**

| 位置 | 字段 | 必填 | Schema | 边界值枚举 | 类型错误枚举 |
|---|---|---:|---|---|---|
| query | limit |  | integer | 零值:0<br/>负数:-1<br/>极大值:2147483647<br/>极小值:-2147483648 | string:abc<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | page |  | integer | 零值:0<br/>负数:-1<br/>极大值:2147483647<br/>极小值:-2147483648 | string:abc<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | status |  | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | serviceType |  | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | effectiveFromStart |  | string, format=date-time | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | effectiveFromEnd |  | string, format=date-time | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | mcc |  | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | mnc |  | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | mccmnc |  | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | carrierNameLike |  | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | mccmncList |  | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | carrierName |  | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | carrierId |  | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | apnLike |  | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | sortBy |  | string, enum="createdAt"\|"effectiveFrom"\|"status" | 合法枚举:createdAt<br/>合法枚举:effectiveFrom<br/>合法枚举:status<br/>非法枚举:__INVALID_ENUM__ | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | sortOrder |  | string, enum="asc"\|"desc" | 合法枚举:asc<br/>合法枚举:desc<br/>非法枚举:__INVALID_ENUM__ | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | packageId |  | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | q |  | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |

**字段级用例任务（逐字段，不做笛卡尔积）**
- OP041-BND-*：对上表每个字段依次覆盖“边界值枚举”
- OP041-TYPE-*：对上表每个字段依次覆盖“类型错误枚举”

### OP042 GET /packages

- Summary: List Packages
- Security: BearerAuth | ApiKeyAuth
- Source: openapi

**用例编号（本端点固定集合）**
- OP042-HP: 正向测试（标准输入 -> 成功响应）
- OP042-AUTH: 权限测试（引用 AUTH-00~AUTH-07）

**入参字段清单（含边界/类型错误枚举）**

| 位置 | 字段 | 必填 | Schema | 边界值枚举 | 类型错误枚举 |
|---|---|---:|---|---|---|
| query | q |  | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | sortBy |  | string, enum="name" | 合法枚举:name<br/>非法枚举:__INVALID_ENUM__ | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | sortOrder |  | string, enum="asc"\|"desc" | 合法枚举:asc<br/>合法枚举:desc<br/>非法枚举:__INVALID_ENUM__ | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | limit |  | integer | 零值:0<br/>负数:-1<br/>极大值:2147483647<br/>极小值:-2147483648 | string:abc<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | page |  | integer | 零值:0<br/>负数:-1<br/>极大值:2147483647<br/>极小值:-2147483648 | string:abc<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |

**字段级用例任务（逐字段，不做笛卡尔积）**
- OP042-BND-*：对上表每个字段依次覆盖“边界值枚举”
- OP042-TYPE-*：对上表每个字段依次覆盖“类型错误枚举”

### OP043 GET /packages:csv

- Summary: Export Packages CSV
- Security: BearerAuth | ApiKeyAuth
- Source: openapi

**用例编号（本端点固定集合）**
- OP043-HP: 正向测试（标准输入 -> 成功响应）
- OP043-AUTH: 权限测试（引用 AUTH-00~AUTH-07）

**入参字段清单（含边界/类型错误枚举）**

| 位置 | 字段 | 必填 | Schema | 边界值枚举 | 类型错误枚举 |
|---|---|---:|---|---|---|
| query | q |  | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | sortBy |  | string, enum="name" | 合法枚举:name<br/>非法枚举:__INVALID_ENUM__ | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | sortOrder |  | string, enum="asc"\|"desc" | 合法枚举:asc<br/>合法枚举:desc<br/>非法枚举:__INVALID_ENUM__ | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | limit |  | integer | 零值:0<br/>负数:-1<br/>极大值:2147483647<br/>极小值:-2147483648 | string:abc<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | page |  | integer | 零值:0<br/>负数:-1<br/>极大值:2147483647<br/>极小值:-2147483648 | string:abc<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |

**字段级用例任务（逐字段，不做笛卡尔积）**
- OP043-BND-*：对上表每个字段依次覆盖“边界值枚举”
- OP043-TYPE-*：对上表每个字段依次覆盖“类型错误枚举”

### OP044 GET /packages/{packageId}

- Summary: Get Package Detail
- Security: BearerAuth | ApiKeyAuth
- Source: openapi

**用例编号（本端点固定集合）**
- OP044-HP: 正向测试（标准输入 -> 成功响应）
- OP044-AUTH: 权限测试（引用 AUTH-00~AUTH-07）

**入参字段清单（含边界/类型错误枚举）**

| 位置 | 字段 | 必填 | Schema | 边界值枚举 | 类型错误枚举 |
|---|---|---:|---|---|---|
| path | packageId | Y | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |

**字段级用例任务（逐字段，不做笛卡尔积）**
- OP044-BND-*：对上表每个字段依次覆盖“边界值枚举”
- OP044-TYPE-*：对上表每个字段依次覆盖“类型错误枚举”

### OP045 GET /price-plans/{pricePlanId}

- Summary: Get Price Plan Detail
- Security: BearerAuth | ApiKeyAuth
- Source: openapi

**用例编号（本端点固定集合）**
- OP045-HP: 正向测试（标准输入 -> 成功响应）
- OP045-AUTH: 权限测试（引用 AUTH-00~AUTH-07）

**入参字段清单（含边界/类型错误枚举）**

| 位置 | 字段 | 必填 | Schema | 边界值枚举 | 类型错误枚举 |
|---|---|---:|---|---|---|
| path | pricePlanId | Y | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |

**字段级用例任务（逐字段，不做笛卡尔积）**
- OP045-BND-*：对上表每个字段依次覆盖“边界值枚举”
- OP045-TYPE-*：对上表每个字段依次覆盖“类型错误枚举”

### OP046 GET /ready

- Summary: Readiness Probe
- Security: BearerAuth | ApiKeyAuth
- Source: openapi

**用例编号（本端点固定集合）**
- OP046-HP: 正向测试（标准输入 -> 成功响应）
- OP046-AUTH: 权限测试（引用 AUTH-00~AUTH-07）

**入参字段清单（含边界/类型错误枚举）**

| 位置 | 字段 | 必填 | Schema | 边界值枚举 | 类型错误枚举 |
|---|---|---:|---|---|---|

**字段级用例任务（逐字段，不做笛卡尔积）**
- OP046-BND-*：对上表每个字段依次覆盖“边界值枚举”
- OP046-TYPE-*：对上表每个字段依次覆盖“类型错误枚举”

### OP047 GET /reconciliation/runs

- Summary: List Reconciliation Runs
- Security: BearerAuth | ApiKeyAuth
- Source: openapi

**用例编号（本端点固定集合）**
- OP047-HP: 正向测试（标准输入 -> 成功响应）
- OP047-AUTH: 权限测试（引用 AUTH-00~AUTH-07）

**入参字段清单（含边界/类型错误枚举）**

| 位置 | 字段 | 必填 | Schema | 边界值枚举 | 类型错误枚举 |
|---|---|---:|---|---|---|
| query | supplierId |  | string, format=uuid | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα<br/>合法UUID:__UUID__<br/>非法UUID:not-a-uuid | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | date |  | string, format=date | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | scope |  | string, enum="FULL"\|"INCREMENTAL" | 合法枚举:FULL<br/>合法枚举:INCREMENTAL<br/>非法枚举:__INVALID_ENUM__ | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | status |  | string, enum="RUNNING"\|"COMPLETED"\|"FAILED" | 合法枚举:RUNNING<br/>合法枚举:COMPLETED<br/>合法枚举:FAILED<br/>非法枚举:__INVALID_ENUM__ | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | page |  | integer | 零值:0<br/>负数:-1<br/>极大值:2147483647<br/>极小值:-2147483648 | string:abc<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | pageSize |  | integer | 零值:0<br/>负数:-1<br/>极大值:2147483647<br/>极小值:-2147483648 | string:abc<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |

**字段级用例任务（逐字段，不做笛卡尔积）**
- OP047-BND-*：对上表每个字段依次覆盖“边界值枚举”
- OP047-TYPE-*：对上表每个字段依次覆盖“类型错误枚举”

### OP048 GET /reconciliation/runs/{runId}

- Summary: Get Reconciliation Run
- Security: BearerAuth | ApiKeyAuth
- Source: openapi

**用例编号（本端点固定集合）**
- OP048-HP: 正向测试（标准输入 -> 成功响应）
- OP048-AUTH: 权限测试（引用 AUTH-00~AUTH-07）

**入参字段清单（含边界/类型错误枚举）**

| 位置 | 字段 | 必填 | Schema | 边界值枚举 | 类型错误枚举 |
|---|---|---:|---|---|---|
| path | runId | Y | string, format=uuid | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα<br/>合法UUID:__UUID__<br/>非法UUID:not-a-uuid | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |

**字段级用例任务（逐字段，不做笛卡尔积）**
- OP048-BND-*：对上表每个字段依次覆盖“边界值枚举”
- OP048-TYPE-*：对上表每个字段依次覆盖“类型错误枚举”

### OP049 GET /reconciliation/runs/{runId}/mismatches

- Summary: List Reconciliation Mismatches
- Security: BearerAuth | ApiKeyAuth
- Source: openapi

**用例编号（本端点固定集合）**
- OP049-HP: 正向测试（标准输入 -> 成功响应）
- OP049-AUTH: 权限测试（引用 AUTH-00~AUTH-07）

**入参字段清单（含边界/类型错误枚举）**

| 位置 | 字段 | 必填 | Schema | 边界值枚举 | 类型错误枚举 |
|---|---|---:|---|---|---|
| path | runId | Y | string, format=uuid | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα<br/>合法UUID:__UUID__<br/>非法UUID:not-a-uuid | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | field |  | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | resolution |  | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | iccid |  | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | enterpriseId |  | string, format=uuid | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα<br/>合法UUID:__UUID__<br/>非法UUID:not-a-uuid | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | page |  | integer | 零值:0<br/>负数:-1<br/>极大值:2147483647<br/>极小值:-2147483648 | string:abc<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | pageSize |  | integer | 零值:0<br/>负数:-1<br/>极大值:2147483647<br/>极小值:-2147483648 | string:abc<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |

**字段级用例任务（逐字段，不做笛卡尔积）**
- OP049-BND-*：对上表每个字段依次覆盖“边界值枚举”
- OP049-TYPE-*：对上表每个字段依次覆盖“类型错误枚举”

### OP050 GET /reconciliation/runs/{runId}/mismatches/{iccid}/trace

- Summary: Get Reconciliation Mismatch Trace
- Security: BearerAuth | ApiKeyAuth
- Source: openapi

**用例编号（本端点固定集合）**
- OP050-HP: 正向测试（标准输入 -> 成功响应）
- OP050-AUTH: 权限测试（引用 AUTH-00~AUTH-07）

**入参字段清单（含边界/类型错误枚举）**

| 位置 | 字段 | 必填 | Schema | 边界值枚举 | 类型错误枚举 |
|---|---|---:|---|---|---|
| path | runId | Y | string, format=uuid | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα<br/>合法UUID:__UUID__<br/>非法UUID:not-a-uuid | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| path | iccid | Y | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |

**字段级用例任务（逐字段，不做笛卡尔积）**
- OP050-BND-*：对上表每个字段依次覆盖“边界值枚举”
- OP050-TYPE-*：对上表每个字段依次覆盖“类型错误枚举”

### OP051 GET /reports/anomaly-sims

- Summary: Anomaly SIMs Report
- Security: BearerAuth | ApiKeyAuth
- Source: openapi

**用例编号（本端点固定集合）**
- OP051-HP: 正向测试（标准输入 -> 成功响应）
- OP051-AUTH: 权限测试（引用 AUTH-00~AUTH-07）

**入参字段清单（含边界/类型错误枚举）**

| 位置 | 字段 | 必填 | Schema | 边界值枚举 | 类型错误枚举 |
|---|---|---:|---|---|---|
| query | enterpriseId |  | string, format=uuid | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα<br/>合法UUID:__UUID__<br/>非法UUID:not-a-uuid | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | period | Y | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |

**字段级用例任务（逐字段，不做笛卡尔积）**
- OP051-BND-*：对上表每个字段依次覆盖“边界值枚举”
- OP051-TYPE-*：对上表每个字段依次覆盖“类型错误枚举”

### OP052 GET /reports/deactivation-reasons

- Summary: Deactivation Reasons Report
- Security: BearerAuth | ApiKeyAuth
- Source: openapi

**用例编号（本端点固定集合）**
- OP052-HP: 正向测试（标准输入 -> 成功响应）
- OP052-AUTH: 权限测试（引用 AUTH-00~AUTH-07）

**入参字段清单（含边界/类型错误枚举）**

| 位置 | 字段 | 必填 | Schema | 边界值枚举 | 类型错误枚举 |
|---|---|---:|---|---|---|
| query | enterpriseId |  | string, format=uuid | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα<br/>合法UUID:__UUID__<br/>非法UUID:not-a-uuid | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | period | Y | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |

**字段级用例任务（逐字段，不做笛卡尔积）**
- OP052-BND-*：对上表每个字段依次覆盖“边界值枚举”
- OP052-TYPE-*：对上表每个字段依次覆盖“类型错误枚举”

### OP053 GET /reports/top-sims

- Summary: Top SIMs Report
- Security: BearerAuth | ApiKeyAuth
- Source: openapi

**用例编号（本端点固定集合）**
- OP053-HP: 正向测试（标准输入 -> 成功响应）
- OP053-AUTH: 权限测试（引用 AUTH-00~AUTH-07）

**入参字段清单（含边界/类型错误枚举）**

| 位置 | 字段 | 必填 | Schema | 边界值枚举 | 类型错误枚举 |
|---|---|---:|---|---|---|
| query | enterpriseId |  | string, format=uuid | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα<br/>合法UUID:__UUID__<br/>非法UUID:not-a-uuid | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | period | Y | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | limit |  | integer | 零值:0<br/>负数:-1<br/>极大值:2147483647<br/>极小值:-2147483648 | string:abc<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |

**字段级用例任务（逐字段，不做笛卡尔积）**
- OP053-BND-*：对上表每个字段依次覆盖“边界值枚举”
- OP053-TYPE-*：对上表每个字段依次覆盖“类型错误枚举”

### OP054 GET /reports/usage-trend

- Summary: Usage Trend Report
- Security: BearerAuth | ApiKeyAuth
- Source: openapi

**用例编号（本端点固定集合）**
- OP054-HP: 正向测试（标准输入 -> 成功响应）
- OP054-AUTH: 权限测试（引用 AUTH-00~AUTH-07）

**入参字段清单（含边界/类型错误枚举）**

| 位置 | 字段 | 必填 | Schema | 边界值枚举 | 类型错误枚举 |
|---|---|---:|---|---|---|
| query | enterpriseId |  | string, format=uuid | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα<br/>合法UUID:__UUID__<br/>非法UUID:not-a-uuid | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | period | Y | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | granularity |  | string, enum="day"\|"month" | 合法枚举:day<br/>合法枚举:month<br/>非法枚举:__INVALID_ENUM__ | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |

**字段级用例任务（逐字段，不做笛卡尔积）**
- OP054-BND-*：对上表每个字段依次覆盖“边界值枚举”
- OP054-TYPE-*：对上表每个字段依次覆盖“类型错误枚举”

### OP055 GET /resellers

- Summary: List Resellers
- Security: BearerAuth | ApiKeyAuth
- Source: openapi

**用例编号（本端点固定集合）**
- OP055-HP: 正向测试（标准输入 -> 成功响应）
- OP055-AUTH: 权限测试（引用 AUTH-00~AUTH-07）

**入参字段清单（含边界/类型错误枚举）**

| 位置 | 字段 | 必填 | Schema | 边界值枚举 | 类型错误枚举 |
|---|---|---:|---|---|---|
| query | page |  | integer | 零值:0<br/>负数:-1<br/>极大值:2147483647<br/>极小值:-2147483648 | string:abc<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | pageSize |  | integer | 零值:0<br/>负数:-1<br/>极大值:2147483647<br/>极小值:-2147483648 | string:abc<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | status |  | string, enum="ACTIVE"\|"DEACTIVATED"\|"SUSPENDED" | 合法枚举:ACTIVE<br/>合法枚举:DEACTIVATED<br/>合法枚举:SUSPENDED<br/>非法枚举:__INVALID_ENUM__ | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |

**字段级用例任务（逐字段，不做笛卡尔积）**
- OP055-BND-*：对上表每个字段依次覆盖“边界值枚举”
- OP055-TYPE-*：对上表每个字段依次覆盖“类型错误枚举”

### OP056 GET /resellers/{resellerId}

- Summary: Get Reseller Detail
- Security: BearerAuth | ApiKeyAuth
- Source: openapi

**用例编号（本端点固定集合）**
- OP056-HP: 正向测试（标准输入 -> 成功响应）
- OP056-AUTH: 权限测试（引用 AUTH-00~AUTH-07）

**入参字段清单（含边界/类型错误枚举）**

| 位置 | 字段 | 必填 | Schema | 边界值枚举 | 类型错误枚举 |
|---|---|---:|---|---|---|
| path | resellerId | Y | string, format=uuid | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα<br/>合法UUID:__UUID__<br/>非法UUID:not-a-uuid | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |

**字段级用例任务（逐字段，不做笛卡尔积）**
- OP056-BND-*：对上表每个字段依次覆盖“边界值枚举”
- OP056-TYPE-*：对上表每个字段依次覆盖“类型错误枚举”

### OP057 GET /resellers/{resellerId}/users

- Summary: List Reseller Users
- Security: BearerAuth | ApiKeyAuth
- Source: openapi

**用例编号（本端点固定集合）**
- OP057-HP: 正向测试（标准输入 -> 成功响应）
- OP057-AUTH: 权限测试（引用 AUTH-00~AUTH-07）

**入参字段清单（含边界/类型错误枚举）**

| 位置 | 字段 | 必填 | Schema | 边界值枚举 | 类型错误枚举 |
|---|---|---:|---|---|---|
| path | resellerId | Y | string, format=uuid | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα<br/>合法UUID:__UUID__<br/>非法UUID:not-a-uuid | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | page |  | integer | 零值:0<br/>负数:-1<br/>极大值:2147483647<br/>极小值:-2147483648 | string:abc<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | pageSize |  | integer | 零值:0<br/>负数:-1<br/>极大值:2147483647<br/>极小值:-2147483648 | string:abc<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |

**字段级用例任务（逐字段，不做笛卡尔积）**
- OP057-BND-*：对上表每个字段依次覆盖“边界值枚举”
- OP057-TYPE-*：对上表每个字段依次覆盖“类型错误枚举”

### OP058 GET /roaming-profiles

- Summary: List Roaming Profiles
- Security: BearerAuth | ApiKeyAuth
- Source: openapi

**用例编号（本端点固定集合）**
- OP058-HP: 正向测试（标准输入 -> 成功响应）
- OP058-AUTH: 权限测试（引用 AUTH-00~AUTH-07）

**入参字段清单（含边界/类型错误枚举）**

| 位置 | 字段 | 必填 | Schema | 边界值枚举 | 类型错误枚举 |
|---|---|---:|---|---|---|
| query | supplierId |  | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | carrierId |  | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | status |  | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | page |  | integer | 零值:0<br/>负数:-1<br/>极大值:2147483647<br/>极小值:-2147483648 | string:abc<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | pageSize |  | integer | 零值:0<br/>负数:-1<br/>极大值:2147483647<br/>极小值:-2147483648 | string:abc<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |

**字段级用例任务（逐字段，不做笛卡尔积）**
- OP058-BND-*：对上表每个字段依次覆盖“边界值枚举”
- OP058-TYPE-*：对上表每个字段依次覆盖“类型错误枚举”

### OP059 GET /roaming-profiles/{roamingProfileId}

- Summary: Get Roaming Profile Detail
- Security: BearerAuth | ApiKeyAuth
- Source: openapi

**用例编号（本端点固定集合）**
- OP059-HP: 正向测试（标准输入 -> 成功响应）
- OP059-AUTH: 权限测试（引用 AUTH-00~AUTH-07）

**入参字段清单（含边界/类型错误枚举）**

| 位置 | 字段 | 必填 | Schema | 边界值枚举 | 类型错误枚举 |
|---|---|---:|---|---|---|
| path | roamingProfileId | Y | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |

**字段级用例任务（逐字段，不做笛卡尔积）**
- OP059-BND-*：对上表每个字段依次覆盖“边界值枚举”
- OP059-TYPE-*：对上表每个字段依次覆盖“类型错误枚举”

### OP060 GET /s/{code}

- Summary: Open Share Link
- Security: BearerAuth | ApiKeyAuth
- Source: openapi

**用例编号（本端点固定集合）**
- OP060-HP: 正向测试（标准输入 -> 成功响应）
- OP060-AUTH: 权限测试（引用 AUTH-00~AUTH-07）

**入参字段清单（含边界/类型错误枚举）**

| 位置 | 字段 | 必填 | Schema | 边界值枚举 | 类型错误枚举 |
|---|---|---:|---|---|---|
| path | code | Y | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |

**字段级用例任务（逐字段，不做笛卡尔积）**
- OP060-BND-*：对上表每个字段依次覆盖“边界值枚举”
- OP060-TYPE-*：对上表每个字段依次覆盖“类型错误枚举”

### OP061 GET /s/{code}.json

- Summary: Get Share Link Params
- Security: BearerAuth | ApiKeyAuth
- Source: openapi

**用例编号（本端点固定集合）**
- OP061-HP: 正向测试（标准输入 -> 成功响应）
- OP061-AUTH: 权限测试（引用 AUTH-00~AUTH-07）

**入参字段清单（含边界/类型错误枚举）**

| 位置 | 字段 | 必填 | Schema | 边界值枚举 | 类型错误枚举 |
|---|---|---:|---|---|---|
| path | code | Y | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |

**字段级用例任务（逐字段，不做笛卡尔积）**
- OP061-BND-*：对上表每个字段依次覆盖“边界值枚举”
- OP061-TYPE-*：对上表每个字段依次覆盖“类型错误枚举”

### OP062 GET /sims

- Summary: Search SIM Cards
- Security: BearerAuth | ApiKeyAuth
- Source: openapi

**用例编号（本端点固定集合）**
- OP062-HP: 正向测试（标准输入 -> 成功响应）
- OP062-AUTH: 权限测试（引用 AUTH-00~AUTH-07）

**入参字段清单（含边界/类型错误枚举）**

| 位置 | 字段 | 必填 | Schema | 边界值枚举 | 类型错误枚举 |
|---|---|---:|---|---|---|
| query | enterpriseId |  | string, format=uuid | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα<br/>合法UUID:__UUID__<br/>非法UUID:not-a-uuid | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | departmentId |  | string, format=uuid | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα<br/>合法UUID:__UUID__<br/>非法UUID:not-a-uuid | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | resellerId |  | string, format=uuid | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα<br/>合法UUID:__UUID__<br/>非法UUID:not-a-uuid | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | iccid |  | string, pattern=^[0-9]{18,20}$ | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα<br/>满足pattern:<match ^[0-9]{18,20}$><br/>不满足pattern:<mismatch ^[0-9]{18,20}$> | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | msisdn |  | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | status |  | string, enum="INVENTORY"\|"TEST_READY"\|"ACTIVATED"\|"DEACTIVATED"\|"RETIRED" | 合法枚举:INVENTORY<br/>合法枚举:TEST_READY<br/>合法枚举:ACTIVATED<br/>合法枚举:DEACTIVATED<br/>合法枚举:RETIRED<br/>非法枚举:__INVALID_ENUM__ | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | supplierId |  | string, format=uuid | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα<br/>合法UUID:__UUID__<br/>非法UUID:not-a-uuid | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | operatorId |  | string, format=uuid | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα<br/>合法UUID:__UUID__<br/>非法UUID:not-a-uuid | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | page |  | integer | 零值:0<br/>负数:-1<br/>极大值:2147483647<br/>极小值:-2147483648 | string:abc<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | pageSize |  | integer | 零值:0<br/>负数:-1<br/>极大值:2147483647<br/>极小值:-2147483648 | string:abc<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | limit |  | integer | 零值:0<br/>负数:-1<br/>极大值:2147483647<br/>极小值:-2147483648 | string:abc<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |

**字段级用例任务（逐字段，不做笛卡尔积）**
- OP062-BND-*：对上表每个字段依次覆盖“边界值枚举”
- OP062-TYPE-*：对上表每个字段依次覆盖“类型错误枚举”

### OP063 GET /sims:csv

- Summary: Export SIM Cards CSV
- Security: BearerAuth | ApiKeyAuth
- Source: openapi

**用例编号（本端点固定集合）**
- OP063-HP: 正向测试（标准输入 -> 成功响应）
- OP063-AUTH: 权限测试（引用 AUTH-00~AUTH-07）

**入参字段清单（含边界/类型错误枚举）**

| 位置 | 字段 | 必填 | Schema | 边界值枚举 | 类型错误枚举 |
|---|---|---:|---|---|---|
| query | enterpriseId |  | string, format=uuid | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα<br/>合法UUID:__UUID__<br/>非法UUID:not-a-uuid | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | departmentId |  | string, format=uuid | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα<br/>合法UUID:__UUID__<br/>非法UUID:not-a-uuid | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | resellerId |  | string, format=uuid | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα<br/>合法UUID:__UUID__<br/>非法UUID:not-a-uuid | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | iccid |  | string, pattern=^[0-9]{18,20}$ | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα<br/>满足pattern:<match ^[0-9]{18,20}$><br/>不满足pattern:<mismatch ^[0-9]{18,20}$> | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | msisdn |  | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | status |  | string, enum="INVENTORY"\|"TEST_READY"\|"ACTIVATED"\|"DEACTIVATED"\|"RETIRED" | 合法枚举:INVENTORY<br/>合法枚举:TEST_READY<br/>合法枚举:ACTIVATED<br/>合法枚举:DEACTIVATED<br/>合法枚举:RETIRED<br/>非法枚举:__INVALID_ENUM__ | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | supplierId |  | string, format=uuid | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα<br/>合法UUID:__UUID__<br/>非法UUID:not-a-uuid | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | operatorId |  | string, format=uuid | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα<br/>合法UUID:__UUID__<br/>非法UUID:not-a-uuid | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | page |  | integer | 零值:0<br/>负数:-1<br/>极大值:2147483647<br/>极小值:-2147483648 | string:abc<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | pageSize |  | integer | 零值:0<br/>负数:-1<br/>极大值:2147483647<br/>极小值:-2147483648 | string:abc<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | limit |  | integer | 零值:0<br/>负数:-1<br/>极大值:2147483647<br/>极小值:-2147483648 | string:abc<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |

**字段级用例任务（逐字段，不做笛卡尔积）**
- OP063-BND-*：对上表每个字段依次覆盖“边界值枚举”
- OP063-TYPE-*：对上表每个字段依次覆盖“类型错误枚举”

### OP064 GET /sims/{iccid}

- Summary: Get SIM Details
- Security: BearerAuth | ApiKeyAuth
- Source: openapi

**用例编号（本端点固定集合）**
- OP064-HP: 正向测试（标准输入 -> 成功响应）
- OP064-AUTH: 权限测试（引用 AUTH-00~AUTH-07）

**入参字段清单（含边界/类型错误枚举）**

| 位置 | 字段 | 必填 | Schema | 边界值枚举 | 类型错误枚举 |
|---|---|---:|---|---|---|
| path | iccid | Y | string, pattern=^[0-9]{18,20}$ | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα<br/>满足pattern:<match ^[0-9]{18,20}$><br/>不满足pattern:<mismatch ^[0-9]{18,20}$> | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |

**字段级用例任务（逐字段，不做笛卡尔积）**
- OP064-BND-*：对上表每个字段依次覆盖“边界值枚举”
- OP064-TYPE-*：对上表每个字段依次覆盖“类型错误枚举”

### OP065 GET /sims/{iccid}/balance

- Summary: Get Real-time Balance
- Security: BearerAuth | ApiKeyAuth
- Source: openapi

**用例编号（本端点固定集合）**
- OP065-HP: 正向测试（标准输入 -> 成功响应）
- OP065-AUTH: 权限测试（引用 AUTH-00~AUTH-07）

**入参字段清单（含边界/类型错误枚举）**

| 位置 | 字段 | 必填 | Schema | 边界值枚举 | 类型错误枚举 |
|---|---|---:|---|---|---|
| path | iccid | Y | string, pattern=^[0-9]{18,20}$ | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα<br/>满足pattern:<match ^[0-9]{18,20}$><br/>不满足pattern:<mismatch ^[0-9]{18,20}$> | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |

**字段级用例任务（逐字段，不做笛卡尔积）**
- OP065-BND-*：对上表每个字段依次覆盖“边界值枚举”
- OP065-TYPE-*：对上表每个字段依次覆盖“类型错误枚举”

### OP066 GET /sims/{iccid}/connectivity-status

- Summary: Get Connectivity Status
- Security: BearerAuth | ApiKeyAuth
- Source: openapi

**用例编号（本端点固定集合）**
- OP066-HP: 正向测试（标准输入 -> 成功响应）
- OP066-AUTH: 权限测试（引用 AUTH-00~AUTH-07）

**入参字段清单（含边界/类型错误枚举）**

| 位置 | 字段 | 必填 | Schema | 边界值枚举 | 类型错误枚举 |
|---|---|---:|---|---|---|
| path | iccid | Y | string, pattern=^[0-9]{18,20}$ | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα<br/>满足pattern:<match ^[0-9]{18,20}$><br/>不满足pattern:<mismatch ^[0-9]{18,20}$> | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |

**字段级用例任务（逐字段，不做笛卡尔积）**
- OP066-BND-*：对上表每个字段依次覆盖“边界值枚举”
- OP066-TYPE-*：对上表每个字段依次覆盖“类型错误枚举”

### OP067 GET /sims/{iccid}/location

- Summary: Get Current Location
- Security: BearerAuth | ApiKeyAuth
- Source: openapi

**用例编号（本端点固定集合）**
- OP067-HP: 正向测试（标准输入 -> 成功响应）
- OP067-AUTH: 权限测试（引用 AUTH-00~AUTH-07）

**入参字段清单（含边界/类型错误枚举）**

| 位置 | 字段 | 必填 | Schema | 边界值枚举 | 类型错误枚举 |
|---|---|---:|---|---|---|
| path | iccid | Y | string, pattern=^[0-9]{18,20}$ | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα<br/>满足pattern:<match ^[0-9]{18,20}$><br/>不满足pattern:<mismatch ^[0-9]{18,20}$> | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |

**字段级用例任务（逐字段，不做笛卡尔积）**
- OP067-BND-*：对上表每个字段依次覆盖“边界值枚举”
- OP067-TYPE-*：对上表每个字段依次覆盖“类型错误枚举”

### OP068 GET /sims/{iccid}/location-history

- Summary: Get Location History
- Security: BearerAuth | ApiKeyAuth
- Source: openapi

**用例编号（本端点固定集合）**
- OP068-HP: 正向测试（标准输入 -> 成功响应）
- OP068-AUTH: 权限测试（引用 AUTH-00~AUTH-07）

**入参字段清单（含边界/类型错误枚举）**

| 位置 | 字段 | 必填 | Schema | 边界值枚举 | 类型错误枚举 |
|---|---|---:|---|---|---|
| path | iccid | Y | string, pattern=^[0-9]{18,20}$ | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα<br/>满足pattern:<match ^[0-9]{18,20}$><br/>不满足pattern:<mismatch ^[0-9]{18,20}$> | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | startDate | Y | string, format=date-time | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | endDate | Y | string, format=date-time | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |

**字段级用例任务（逐字段，不做笛卡尔积）**
- OP068-BND-*：对上表每个字段依次覆盖“边界值枚举”
- OP068-TYPE-*：对上表每个字段依次覆盖“类型错误枚举”

### OP069 GET /sims/{iccid}/subscriptions

- Summary: List SIM Subscriptions
- Security: BearerAuth | ApiKeyAuth
- Source: openapi

**用例编号（本端点固定集合）**
- OP069-HP: 正向测试（标准输入 -> 成功响应）
- OP069-AUTH: 权限测试（引用 AUTH-00~AUTH-07）

**入参字段清单（含边界/类型错误枚举）**

| 位置 | 字段 | 必填 | Schema | 边界值枚举 | 类型错误枚举 |
|---|---|---:|---|---|---|
| path | iccid | Y | string, pattern=^[0-9]{18,20}$ | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα<br/>满足pattern:<match ^[0-9]{18,20}$><br/>不满足pattern:<mismatch ^[0-9]{18,20}$> | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |

**字段级用例任务（逐字段，不做笛卡尔积）**
- OP069-BND-*：对上表每个字段依次覆盖“边界值枚举”
- OP069-TYPE-*：对上表每个字段依次覆盖“类型错误枚举”

### OP070 GET /sims/{iccid}/usage

- Summary: Get Data Usage History
- Security: BearerAuth | ApiKeyAuth
- Source: openapi

**用例编号（本端点固定集合）**
- OP070-HP: 正向测试（标准输入 -> 成功响应）
- OP070-AUTH: 权限测试（引用 AUTH-00~AUTH-07）

**入参字段清单（含边界/类型错误枚举）**

| 位置 | 字段 | 必填 | Schema | 边界值枚举 | 类型错误枚举 |
|---|---|---:|---|---|---|
| path | iccid | Y | string, pattern=^[0-9]{18,20}$ | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα<br/>满足pattern:<match ^[0-9]{18,20}$><br/>不满足pattern:<mismatch ^[0-9]{18,20}$> | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | startDate | Y | string, format=date-time | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | endDate | Y | string, format=date-time | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |

**字段级用例任务（逐字段，不做笛卡尔积）**
- OP070-BND-*：对上表每个字段依次覆盖“边界值枚举”
- OP070-TYPE-*：对上表每个字段依次覆盖“类型错误枚举”

### OP071 GET /suppliers

- Summary: List Suppliers
- Security: BearerAuth | ApiKeyAuth
- Source: openapi

**用例编号（本端点固定集合）**
- OP071-HP: 正向测试（标准输入 -> 成功响应）
- OP071-AUTH: 权限测试（引用 AUTH-00~AUTH-07）

**入参字段清单（含边界/类型错误枚举）**

| 位置 | 字段 | 必填 | Schema | 边界值枚举 | 类型错误枚举 |
|---|---|---:|---|---|---|
| query | status |  | string, enum="ACTIVE"\|"SUSPENDED" | 合法枚举:ACTIVE<br/>合法枚举:SUSPENDED<br/>非法枚举:__INVALID_ENUM__ | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | page |  | integer | 零值:0<br/>负数:-1<br/>极大值:2147483647<br/>极小值:-2147483648 | string:abc<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | pageSize |  | integer | 零值:0<br/>负数:-1<br/>极大值:2147483647<br/>极小值:-2147483648 | string:abc<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |

**字段级用例任务（逐字段，不做笛卡尔积）**
- OP071-BND-*：对上表每个字段依次覆盖“边界值枚举”
- OP071-TYPE-*：对上表每个字段依次覆盖“类型错误枚举”

### OP072 GET /suppliers/{supplierId}

- Summary: Get Supplier Detail
- Security: BearerAuth | ApiKeyAuth
- Source: openapi

**用例编号（本端点固定集合）**
- OP072-HP: 正向测试（标准输入 -> 成功响应）
- OP072-AUTH: 权限测试（引用 AUTH-00~AUTH-07）

**入参字段清单（含边界/类型错误枚举）**

| 位置 | 字段 | 必填 | Schema | 边界值枚举 | 类型错误枚举 |
|---|---|---:|---|---|---|
| path | supplierId | Y | string, format=uuid | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα<br/>合法UUID:__UUID__<br/>非法UUID:not-a-uuid | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |

**字段级用例任务（逐字段，不做笛卡尔积）**
- OP072-BND-*：对上表每个字段依次覆盖“边界值枚举”
- OP072-TYPE-*：对上表每个字段依次覆盖“类型错误枚举”

### OP073 GET /webhook-subscriptions

- Summary: List Webhook Subscriptions
- Security: BearerAuth | ApiKeyAuth
- Source: openapi

**用例编号（本端点固定集合）**
- OP073-HP: 正向测试（标准输入 -> 成功响应）
- OP073-AUTH: 权限测试（引用 AUTH-00~AUTH-07）

**入参字段清单（含边界/类型错误枚举）**

| 位置 | 字段 | 必填 | Schema | 边界值枚举 | 类型错误枚举 |
|---|---|---:|---|---|---|
| query | resellerId |  | string, format=uuid | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα<br/>合法UUID:__UUID__<br/>非法UUID:not-a-uuid | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | enterpriseId |  | string, format=uuid | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα<br/>合法UUID:__UUID__<br/>非法UUID:not-a-uuid | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | page |  | integer | 零值:0<br/>负数:-1<br/>极大值:2147483647<br/>极小值:-2147483648 | string:abc<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | pageSize |  | integer | 零值:0<br/>负数:-1<br/>极大值:2147483647<br/>极小值:-2147483648 | string:abc<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |

**字段级用例任务（逐字段，不做笛卡尔积）**
- OP073-BND-*：对上表每个字段依次覆盖“边界值枚举”
- OP073-TYPE-*：对上表每个字段依次覆盖“类型错误枚举”

### OP074 GET /webhook-subscriptions/{webhookId}

- Summary: Get Webhook Subscription
- Security: BearerAuth | ApiKeyAuth
- Source: openapi

**用例编号（本端点固定集合）**
- OP074-HP: 正向测试（标准输入 -> 成功响应）
- OP074-AUTH: 权限测试（引用 AUTH-00~AUTH-07）

**入参字段清单（含边界/类型错误枚举）**

| 位置 | 字段 | 必填 | Schema | 边界值枚举 | 类型错误枚举 |
|---|---|---:|---|---|---|
| path | webhookId | Y | string, format=uuid | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα<br/>合法UUID:__UUID__<br/>非法UUID:not-a-uuid | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |

**字段级用例任务（逐字段，不做笛卡尔积）**
- OP074-BND-*：对上表每个字段依次覆盖“边界值枚举”
- OP074-TYPE-*：对上表每个字段依次覆盖“类型错误枚举”

### OP075 GET /webhook-subscriptions/{webhookId}/deliveries

- Summary: List Webhook Deliveries
- Security: BearerAuth | ApiKeyAuth
- Source: openapi

**用例编号（本端点固定集合）**
- OP075-HP: 正向测试（标准输入 -> 成功响应）
- OP075-AUTH: 权限测试（引用 AUTH-00~AUTH-07）

**入参字段清单（含边界/类型错误枚举）**

| 位置 | 字段 | 必填 | Schema | 边界值枚举 | 类型错误枚举 |
|---|---|---:|---|---|---|
| path | webhookId | Y | string, format=uuid | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα<br/>合法UUID:__UUID__<br/>非法UUID:not-a-uuid | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | page |  | integer | 零值:0<br/>负数:-1<br/>极大值:2147483647<br/>极小值:-2147483648 | string:abc<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| query | pageSize |  | integer | 零值:0<br/>负数:-1<br/>极大值:2147483647<br/>极小值:-2147483648 | string:abc<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |

**字段级用例任务（逐字段，不做笛卡尔积）**
- OP075-BND-*：对上表每个字段依次覆盖“边界值枚举”
- OP075-TYPE-*：对上表每个字段依次覆盖“类型错误枚举”

### OP076 PATCH /operators/{operatorId}

- Summary: Update Operator
- Security: BearerAuth | ApiKeyAuth
- Source: openapi

**用例编号（本端点固定集合）**
- OP076-HP: 正向测试（标准输入 -> 成功响应）
- OP076-AUTH: 权限测试（引用 AUTH-00~AUTH-07）

**入参字段清单（含边界/类型错误枚举）**

| 位置 | 字段 | 必填 | Schema | 边界值枚举 | 类型错误枚举 |
|---|---|---:|---|---|---|
| path | operatorId | Y | string, format=uuid | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα<br/>合法UUID:__UUID__<br/>非法UUID:not-a-uuid | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | name |  | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |

**字段级用例任务（逐字段，不做笛卡尔积）**
- OP076-BND-*：对上表每个字段依次覆盖“边界值枚举”
- OP076-TYPE-*：对上表每个字段依次覆盖“类型错误枚举”

### OP077 PATCH /resellers/{resellerId}/users/{userId}/assign-enterprises

- Summary: Update Reseller
- Security: BearerAuth | ApiKeyAuth
- Source: openapi

**用例编号（本端点固定集合）**
- OP077-HP: 正向测试（标准输入 -> 成功响应）
- OP077-AUTH: 权限测试（引用 AUTH-00~AUTH-07）

**入参字段清单（含边界/类型错误枚举）**

| 位置 | 字段 | 必填 | Schema | 边界值枚举 | 类型错误枚举 |
|---|---|---:|---|---|---|
| path | resellerId | Y | string, format=uuid | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα<br/>合法UUID:__UUID__<br/>非法UUID:not-a-uuid | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | name |  | string, minLength=2, maxLength=100 | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα<br/>最小长度:<string length=2><br/>小于最小长度:<string length=1><br/>最大长度:<string length=100><br/>超过最大长度:<string length=101> | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | contactEmail |  | string, format=email | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | contactPhone |  | string, nullable=true | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[] |
| body:application/json | brandingConfig |  | object | 空对象:{...}<br/>缺失必填字段:__MISSING_REQUIRED__<br/>多余字段:__EXTRA_FIELDS__ | array:[]<br/>string:x<br/>number:1<br/>boolean:true<br/>null:null |
| body:application/json | brandingConfig.logoUrl |  | string, nullable=true | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[] |
| body:application/json | brandingConfig.primaryColor |  | string, nullable=true | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[] |
| body:application/json | brandingConfig.customDomain |  | string, nullable=true | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[] |

**字段级用例任务（逐字段，不做笛卡尔积）**
- OP077-BND-*：对上表每个字段依次覆盖“边界值枚举”
- OP077-TYPE-*：对上表每个字段依次覆盖“类型错误枚举”

### OP078 PATCH /sims/{iccid}

- Summary: Change SIM Status
- Security: BearerAuth | ApiKeyAuth
- Source: openapi

**用例编号（本端点固定集合）**
- OP078-HP: 正向测试（标准输入 -> 成功响应）
- OP078-AUTH: 权限测试（引用 AUTH-00~AUTH-07）
- OP078-STATE-SIM_STATUS: 状态依赖测试（状态机约束）

**入参字段清单（含边界/类型错误枚举）**

| 位置 | 字段 | 必填 | Schema | 边界值枚举 | 类型错误枚举 |
|---|---|---:|---|---|---|
| path | iccid | Y | string, pattern=^[0-9]{18,20}$ | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα<br/>满足pattern:<match ^[0-9]{18,20}$><br/>不满足pattern:<mismatch ^[0-9]{18,20}$> | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | status | Y | string, enum="ACTIVATED"\|"DEACTIVATED" | 合法枚举:ACTIVATED<br/>合法枚举:DEACTIVATED<br/>非法枚举:__INVALID_ENUM__ | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | reason |  | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |

**字段级用例任务（逐字段，不做笛卡尔积）**
- OP078-BND-*：对上表每个字段依次覆盖“边界值枚举”
- OP078-TYPE-*：对上表每个字段依次覆盖“类型错误枚举”

### OP079 PATCH /suppliers/{supplierId}

- Summary: Update Supplier
- Security: BearerAuth | ApiKeyAuth
- Source: openapi

**用例编号（本端点固定集合）**
- OP079-HP: 正向测试（标准输入 -> 成功响应）
- OP079-AUTH: 权限测试（引用 AUTH-00~AUTH-07）

**入参字段清单（含边界/类型错误枚举）**

| 位置 | 字段 | 必填 | Schema | 边界值枚举 | 类型错误枚举 |
|---|---|---:|---|---|---|
| path | supplierId | Y | string, format=uuid | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα<br/>合法UUID:__UUID__<br/>非法UUID:not-a-uuid | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | name |  | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | status |  | string, enum="ACTIVE"\|"SUSPENDED" | 合法枚举:ACTIVE<br/>合法枚举:SUSPENDED<br/>非法枚举:__INVALID_ENUM__ | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |

**字段级用例任务（逐字段，不做笛卡尔积）**
- OP079-BND-*：对上表每个字段依次覆盖“边界值枚举”
- OP079-TYPE-*：对上表每个字段依次覆盖“类型错误枚举”

### OP080 PATCH /webhook-subscriptions/{webhookId}

- Summary: Update Webhook Subscription
- Security: BearerAuth | ApiKeyAuth
- Source: openapi

**用例编号（本端点固定集合）**
- OP080-HP: 正向测试（标准输入 -> 成功响应）
- OP080-AUTH: 权限测试（引用 AUTH-00~AUTH-07）

**入参字段清单（含边界/类型错误枚举）**

| 位置 | 字段 | 必填 | Schema | 边界值枚举 | 类型错误枚举 |
|---|---|---:|---|---|---|
| path | webhookId | Y | string, format=uuid | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα<br/>合法UUID:__UUID__<br/>非法UUID:not-a-uuid | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | url |  | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | secret |  | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | eventTypes |  | array | 空数组:[]<br/>单元素数组:[...] | object:{...}<br/>string:x<br/>number:1<br/>boolean:true<br/>null:null |
| body:application/json | eventTypes[] |  | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | enabled |  | boolean | true:true<br/>false:false | string:true<br/>number:1<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | description |  | string, nullable=true | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[] |

**字段级用例任务（逐字段，不做笛卡尔积）**
- OP080-BND-*：对上表每个字段依次覆盖“边界值枚举”
- OP080-TYPE-*：对上表每个字段依次覆盖“类型错误枚举”

### OP081 POST /admin/api-clients/{clientId}:deactivate

- Summary: Deactivate API Client (Admin)
- Security: AdminApiKeyAuth
- Source: openapi

**用例编号（本端点固定集合）**
- OP081-HP: 正向测试（标准输入 -> 成功响应）
- OP081-AUTH: 权限测试（引用 AUTH-00~AUTH-07）
- OP081-CONC: 并发/幂等性测试（同资源并发、重复提交）

**入参字段清单（含边界/类型错误枚举）**

| 位置 | 字段 | 必填 | Schema | 边界值枚举 | 类型错误枚举 |
|---|---|---:|---|---|---|
| path | clientId | Y | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |

**字段级用例任务（逐字段，不做笛卡尔积）**
- OP081-BND-*：对上表每个字段依次覆盖“边界值枚举”
- OP081-TYPE-*：对上表每个字段依次覆盖“类型错误枚举”

### OP082 POST /admin/api-clients/{clientId}:rotate

- Summary: Rotate API Client Secret (Admin)
- Security: AdminApiKeyAuth
- Source: openapi

**用例编号（本端点固定集合）**
- OP082-HP: 正向测试（标准输入 -> 成功响应）
- OP082-AUTH: 权限测试（引用 AUTH-00~AUTH-07）
- OP082-CONC: 并发/幂等性测试（同资源并发、重复提交）

**入参字段清单（含边界/类型错误枚举）**

| 位置 | 字段 | 必填 | Schema | 边界值枚举 | 类型错误枚举 |
|---|---|---:|---|---|---|
| path | clientId | Y | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | clientSecret |  | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |

**字段级用例任务（逐字段，不做笛卡尔积）**
- OP082-BND-*：对上表每个字段依次覆盖“边界值枚举”
- OP082-TYPE-*：对上表每个字段依次覆盖“类型错误枚举”

### OP083 POST /admin/jobs:test-ready-expiry-run

- Summary: Run TEST_READY Expiry Evaluation Job (Admin)
- Security: AdminApiKeyAuth
- Source: openapi

**用例编号（本端点固定集合）**
- OP083-HP: 正向测试（标准输入 -> 成功响应）
- OP083-AUTH: 权限测试（引用 AUTH-00~AUTH-07）

**入参字段清单（含边界/类型错误枚举）**

| 位置 | 字段 | 必填 | Schema | 边界值枚举 | 类型错误枚举 |
|---|---|---:|---|---|---|
| body:application/json | enterpriseId |  | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | pageSize |  | integer | 零值:0<br/>负数:-1<br/>极大值:2147483647<br/>极小值:-2147483648 | string:abc<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |

**字段级用例任务（逐字段，不做笛卡尔积）**
- OP083-BND-*：对上表每个字段依次覆盖“边界值枚举”
- OP083-TYPE-*：对上表每个字段依次覆盖“类型错误枚举”

### OP084 POST /admin/jobs:wx-sync-daily-usage

- Summary: Run WXZHONGGENG Daily Usage Sync Job (Admin)
- Security: AdminApiKeyAuth
- Source: openapi

**用例编号（本端点固定集合）**
- OP084-HP: 正向测试（标准输入 -> 成功响应）
- OP084-AUTH: 权限测试（引用 AUTH-00~AUTH-07）

**入参字段清单（含边界/类型错误枚举）**

| 位置 | 字段 | 必填 | Schema | 边界值枚举 | 类型错误枚举 |
|---|---|---:|---|---|---|
| body:application/json | enterpriseId |  | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | startDate |  | string, format=date-time | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | endDate |  | string, format=date-time | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | pageSize |  | integer | 零值:0<br/>负数:-1<br/>极大值:2147483647<br/>极小值:-2147483648 | string:abc<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |

**字段级用例任务（逐字段，不做笛卡尔积）**
- OP084-BND-*：对上表每个字段依次覆盖“边界值枚举”
- OP084-TYPE-*：对上表每个字段依次覆盖“类型错误枚举”

### OP085 POST /admin/jobs:wx-sync-sim-info-batch

- Summary: Sync WXZHONGGENG SIM Info Batch (Admin)
- Security: AdminApiKeyAuth
- Source: openapi

**用例编号（本端点固定集合）**
- OP085-HP: 正向测试（标准输入 -> 成功响应）
- OP085-AUTH: 权限测试（引用 AUTH-00~AUTH-07）

**入参字段清单（含边界/类型错误枚举）**

| 位置 | 字段 | 必填 | Schema | 边界值枚举 | 类型错误枚举 |
|---|---|---:|---|---|---|
| body:application/json | enterpriseId |  | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | pageSize |  | integer | 零值:0<br/>负数:-1<br/>极大值:2147483647<br/>极小值:-2147483648 | string:abc<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | pageIndex |  | integer | 零值:0<br/>负数:-1<br/>极大值:2147483647<br/>极小值:-2147483648 | string:abc<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |

**字段级用例任务（逐字段，不做笛卡尔积）**
- OP085-BND-*：对上表每个字段依次覆盖“边界值枚举”
- OP085-TYPE-*：对上表每个字段依次覆盖“类型错误枚举”

### OP086 POST /admin/share-links/{code}:invalidate

- Summary: Invalidate Share Link (Admin)
- Security: AdminApiKeyAuth
- Source: openapi

**用例编号（本端点固定集合）**
- OP086-HP: 正向测试（标准输入 -> 成功响应）
- OP086-AUTH: 权限测试（引用 AUTH-00~AUTH-07）

**入参字段清单（含边界/类型错误枚举）**

| 位置 | 字段 | 必填 | Schema | 边界值枚举 | 类型错误枚举 |
|---|---|---:|---|---|---|
| path | code | Y | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |

**字段级用例任务（逐字段，不做笛卡尔积）**
- OP086-BND-*：对上表每个字段依次覆盖“边界值枚举”
- OP086-TYPE-*：对上表每个字段依次覆盖“类型错误枚举”

### OP087 POST /admin/sims:evaluate-test-expiry

- Summary: Evaluate TEST_READY Expiry (Admin)
- Security: AdminApiKeyAuth
- Source: openapi

**用例编号（本端点固定集合）**
- OP087-HP: 正向测试（标准输入 -> 成功响应）
- OP087-AUTH: 权限测试（引用 AUTH-00~AUTH-07）

**入参字段清单（含边界/类型错误枚举）**

| 位置 | 字段 | 必填 | Schema | 边界值枚举 | 类型错误枚举 |
|---|---|---:|---|---|---|
| query | enterpriseId |  | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |

**字段级用例任务（逐字段，不做笛卡尔积）**
- OP087-BND-*：对上表每个字段依次覆盖“边界值枚举”
- OP087-TYPE-*：对上表每个字段依次覆盖“类型错误枚举”

### OP088 POST /admin/sims/{iccid}:assign-test

- Summary: Assign SIM to TEST_READY (Admin)
- Security: AdminApiKeyAuth
- Source: openapi

**用例编号（本端点固定集合）**
- OP088-HP: 正向测试（标准输入 -> 成功响应）
- OP088-AUTH: 权限测试（引用 AUTH-00~AUTH-07）

**入参字段清单（含边界/类型错误枚举）**

| 位置 | 字段 | 必填 | Schema | 边界值枚举 | 类型错误枚举 |
|---|---|---:|---|---|---|
| path | iccid | Y | string, pattern=^[0-9]{18,20}$ | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα<br/>满足pattern:<match ^[0-9]{18,20}$><br/>不满足pattern:<mismatch ^[0-9]{18,20}$> | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |

**字段级用例任务（逐字段，不做笛卡尔积）**
- OP088-BND-*：对上表每个字段依次覆盖“边界值枚举”
- OP088-TYPE-*：对上表每个字段依次覆盖“类型错误枚举”

### OP089 POST /admin/sims/{iccid}:backdate-test-start

- Summary: Backdate TEST_READY start (Admin)
- Security: AdminApiKeyAuth
- Source: openapi

**用例编号（本端点固定集合）**
- OP089-HP: 正向测试（标准输入 -> 成功响应）
- OP089-AUTH: 权限测试（引用 AUTH-00~AUTH-07）

**入参字段清单（含边界/类型错误枚举）**

| 位置 | 字段 | 必填 | Schema | 边界值枚举 | 类型错误枚举 |
|---|---|---:|---|---|---|
| path | iccid | Y | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | daysBack |  | integer | 零值:0<br/>负数:-1<br/>极大值:2147483647<br/>极小值:-2147483648 | string:abc<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |

**字段级用例任务（逐字段，不做笛卡尔积）**
- OP089-BND-*：对上表每个字段依次覆盖“边界值枚举”
- OP089-TYPE-*：对上表每个字段依次覆盖“类型错误枚举”

### OP090 POST /admin/sims/{iccid}:reset-activated

- Summary: Reset SIM to ACTIVATED (Admin)
- Security: AdminApiKeyAuth
- Source: openapi

**用例编号（本端点固定集合）**
- OP090-HP: 正向测试（标准输入 -> 成功响应）
- OP090-AUTH: 权限测试（引用 AUTH-00~AUTH-07）

**入参字段清单（含边界/类型错误枚举）**

| 位置 | 字段 | 必填 | Schema | 边界值枚举 | 类型错误枚举 |
|---|---|---:|---|---|---|
| path | iccid | Y | string, pattern=^[0-9]{18,20}$ | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα<br/>满足pattern:<match ^[0-9]{18,20}$><br/>不满足pattern:<mismatch ^[0-9]{18,20}$> | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |

**字段级用例任务（逐字段，不做笛卡尔积）**
- OP090-BND-*：对上表每个字段依次覆盖“边界值枚举”
- OP090-TYPE-*：对上表每个字段依次覆盖“类型错误枚举”

### OP091 POST /admin/sims/{iccid}:reset-inventory

- Summary: Reset SIM to INVENTORY (Admin)
- Security: AdminApiKeyAuth
- Source: openapi

**用例编号（本端点固定集合）**
- OP091-HP: 正向测试（标准输入 -> 成功响应）
- OP091-AUTH: 权限测试（引用 AUTH-00~AUTH-07）

**入参字段清单（含边界/类型错误枚举）**

| 位置 | 字段 | 必填 | Schema | 边界值枚举 | 类型错误枚举 |
|---|---|---:|---|---|---|
| path | iccid | Y | string, pattern=^[0-9]{18,20}$ | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα<br/>满足pattern:<match ^[0-9]{18,20}$><br/>不满足pattern:<mismatch ^[0-9]{18,20}$> | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |

**字段级用例任务（逐字段，不做笛卡尔积）**
- OP091-BND-*：对上表每个字段依次覆盖“边界值枚举”
- OP091-TYPE-*：对上表每个字段依次覆盖“类型错误枚举”

### OP092 POST /admin/sims/{iccid}:retire

- Summary: Retire SIM (Admin)
- Security: AdminApiKeyAuth
- Source: openapi

**用例编号（本端点固定集合）**
- OP092-HP: 正向测试（标准输入 -> 成功响应）
- OP092-AUTH: 权限测试（引用 AUTH-00~AUTH-07）
- OP092-STATE-SIM_STATUS: 状态依赖测试（allowedFrom 状态机约束 + reason/confirm）
- OP092-CONC: 并发/幂等性测试（同资源并发、重复提交）

**入参字段清单（含边界/类型错误枚举）**

| 位置 | 字段 | 必填 | Schema | 边界值枚举 | 类型错误枚举 |
|---|---|---:|---|---|---|
| path | iccid | Y | string, pattern=^[0-9]{18,20}$ | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα<br/>满足pattern:<match ^[0-9]{18,20}$><br/>不满足pattern:<mismatch ^[0-9]{18,20}$> | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |

**字段级用例任务（逐字段，不做笛卡尔积）**
- OP092-BND-*：对上表每个字段依次覆盖“边界值枚举”
- OP092-TYPE-*：对上表每个字段依次覆盖“类型错误枚举”

### OP093 POST /admin/sims/{iccid}:seed-usage

- Summary: Seed usage_daily_summary (Admin)
- Security: AdminApiKeyAuth
- Source: openapi

**用例编号（本端点固定集合）**
- OP093-HP: 正向测试（标准输入 -> 成功响应）
- OP093-AUTH: 权限测试（引用 AUTH-00~AUTH-07）

**入参字段清单（含边界/类型错误枚举）**

| 位置 | 字段 | 必填 | Schema | 边界值枚举 | 类型错误枚举 |
|---|---|---:|---|---|---|
| path | iccid | Y | string, pattern=^[0-9]{18,20}$ | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα<br/>满足pattern:<match ^[0-9]{18,20}$><br/>不满足pattern:<mismatch ^[0-9]{18,20}$> | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | usageDay |  | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | visitedMccMnc |  | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | totalKb |  | integer | 零值:0<br/>负数:-1<br/>极大值:2147483647<br/>极小值:-2147483648 | string:abc<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | uplinkKb |  | integer | 零值:0<br/>负数:-1<br/>极大值:2147483647<br/>极小值:-2147483648 | string:abc<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | downlinkKb |  | integer | 零值:0<br/>负数:-1<br/>极大值:2147483647<br/>极小值:-2147483648 | string:abc<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |

**字段级用例任务（逐字段，不做笛卡尔积）**
- OP093-BND-*：对上表每个字段依次覆盖“边界值枚举”
- OP093-TYPE-*：对上表每个字段依次覆盖“类型错误枚举”

### OP094 POST /alerts/{alertId}:acknowledge

- Summary: Acknowledge Alert
- Security: BearerAuth | ApiKeyAuth
- Source: openapi

**用例编号（本端点固定集合）**
- OP094-HP: 正向测试（标准输入 -> 成功响应）
- OP094-AUTH: 权限测试（引用 AUTH-00~AUTH-07）

**入参字段清单（含边界/类型错误枚举）**

| 位置 | 字段 | 必填 | Schema | 边界值枚举 | 类型错误枚举 |
|---|---|---:|---|---|---|
| path | alertId | Y | string, format=uuid | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα<br/>合法UUID:__UUID__<br/>非法UUID:not-a-uuid | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |

**字段级用例任务（逐字段，不做笛卡尔积）**
- OP094-BND-*：对上表每个字段依次覆盖“边界值枚举”
- OP094-TYPE-*：对上表每个字段依次覆盖“类型错误枚举”

### OP095 POST /apn-profiles

- Summary: Create APN Profile
- Security: BearerAuth | ApiKeyAuth
- Source: openapi

**用例编号（本端点固定集合）**
- OP095-HP: 正向测试（标准输入 -> 成功响应）
- OP095-AUTH: 权限测试（引用 AUTH-00~AUTH-07）

**入参字段清单（含边界/类型错误枚举）**

| 位置 | 字段 | 必填 | Schema | 边界值枚举 | 类型错误枚举 |
|---|---|---:|---|---|---|
| body:application/json | name | Y | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | apn | Y | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | authType |  | string, enum="NONE"\|"PAP"\|"CHAP" | 合法枚举:NONE<br/>合法枚举:PAP<br/>合法枚举:CHAP<br/>非法枚举:__INVALID_ENUM__ | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | username |  | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | passwordRef |  | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | supplierId | Y | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | carrierId |  | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |

**字段级用例任务（逐字段，不做笛卡尔积）**
- OP095-BND-*：对上表每个字段依次覆盖“边界值枚举”
- OP095-TYPE-*：对上表每个字段依次覆盖“类型错误枚举”

### OP096 POST /apn-profiles/{apnProfileId}:publish

- Summary: Publish APN Profile
- Security: BearerAuth | ApiKeyAuth
- Source: openapi

**用例编号（本端点固定集合）**
- OP096-HP: 正向测试（标准输入 -> 成功响应）
- OP096-AUTH: 权限测试（引用 AUTH-00~AUTH-07）
- OP096-STATE-APN_PUBLISH: 状态依赖测试（仅 DRAFT 可发布；版本递增与回滚约束）
- OP096-CONC: 并发/幂等性测试（同资源并发、重复提交）

**入参字段清单（含边界/类型错误枚举）**

| 位置 | 字段 | 必填 | Schema | 边界值枚举 | 类型错误枚举 |
|---|---|---:|---|---|---|
| path | apnProfileId | Y | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |

**字段级用例任务（逐字段，不做笛卡尔积）**
- OP096-BND-*：对上表每个字段依次覆盖“边界值枚举”
- OP096-TYPE-*：对上表每个字段依次覆盖“类型错误枚举”

### OP097 POST /apn-profiles/{apnProfileId}/versions

- Summary: Create APN Profile Version
- Security: BearerAuth | ApiKeyAuth
- Source: openapi

**用例编号（本端点固定集合）**
- OP097-HP: 正向测试（标准输入 -> 成功响应）
- OP097-AUTH: 权限测试（引用 AUTH-00~AUTH-07）

**入参字段清单（含边界/类型错误枚举）**

| 位置 | 字段 | 必填 | Schema | 边界值枚举 | 类型错误枚举 |
|---|---|---:|---|---|---|
| path | apnProfileId | Y | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | apn |  | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | authType |  | string, enum="NONE"\|"PAP"\|"CHAP" | 合法枚举:NONE<br/>合法枚举:PAP<br/>合法枚举:CHAP<br/>非法枚举:__INVALID_ENUM__ | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | username |  | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | passwordRef |  | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |

**字段级用例任务（逐字段，不做笛卡尔积）**
- OP097-BND-*：对上表每个字段依次覆盖“边界值枚举”
- OP097-TYPE-*：对上表每个字段依次覆盖“类型错误枚举”

### OP098 POST /auth/login

- Summary: User Login
- Security: NONE
- Source: openapi

**用例编号（本端点固定集合）**
- OP098-HP: 正向测试（标准输入 -> 成功响应）
- OP098-AUTH: 权限测试（引用 AUTH-00~AUTH-07）

**入参字段清单（含边界/类型错误枚举）**

| 位置 | 字段 | 必填 | Schema | 边界值枚举 | 类型错误枚举 |
|---|---|---:|---|---|---|
| body:application/json | email | Y | string, format=email | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | password | Y | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |

**字段级用例任务（逐字段，不做笛卡尔积）**
- OP098-BND-*：对上表每个字段依次覆盖“边界值枚举”
- OP098-TYPE-*：对上表每个字段依次覆盖“类型错误枚举”

### OP099 POST /auth/refresh

- Summary: Refresh Access Token
- Security: NONE
- Source: openapi

**用例编号（本端点固定集合）**
- OP099-HP: 正向测试（标准输入 -> 成功响应）
- OP099-AUTH: 权限测试（引用 AUTH-00~AUTH-07）

**入参字段清单（含边界/类型错误枚举）**

| 位置 | 字段 | 必填 | Schema | 边界值枚举 | 类型错误枚举 |
|---|---|---:|---|---|---|
| body:application/json | refreshToken | Y | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |

**字段级用例任务（逐字段，不做笛卡尔积）**
- OP099-BND-*：对上表每个字段依次覆盖“边界值枚举”
- OP099-TYPE-*：对上表每个字段依次覆盖“类型错误枚举”

### OP100 POST /auth/token

- Summary: Get Access Token
- Security: NONE
- Source: openapi

**用例编号（本端点固定集合）**
- OP100-HP: 正向测试（标准输入 -> 成功响应）
- OP100-AUTH: 权限测试（引用 AUTH-00~AUTH-07）

**入参字段清单（含边界/类型错误枚举）**

| 位置 | 字段 | 必填 | Schema | 边界值枚举 | 类型错误枚举 |
|---|---|---:|---|---|---|
| body:application/json | clientId | Y | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | clientSecret | Y | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |

**字段级用例任务（逐字段，不做笛卡尔积）**
- OP100-BND-*：对上表每个字段依次覆盖“边界值枚举”
- OP100-TYPE-*：对上表每个字段依次覆盖“类型错误枚举”

### OP101 POST /bills/{billId}:adjust

- Summary: Create Adjustment Note
- Security: BearerAuth | ApiKeyAuth
- Source: openapi

**用例编号（本端点固定集合）**
- OP101-HP: 正向测试（标准输入 -> 成功响应）
- OP101-AUTH: 权限测试（引用 AUTH-00~AUTH-07）
- OP101-CONC: 并发/幂等性测试（同资源并发、重复提交）

**入参字段清单（含边界/类型错误枚举）**

| 位置 | 字段 | 必填 | Schema | 边界值枚举 | 类型错误枚举 |
|---|---|---:|---|---|---|
| path | billId | Y | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | type | Y | string, enum="CREDIT"\|"DEBIT" | 合法枚举:CREDIT<br/>合法枚举:DEBIT<br/>非法枚举:__INVALID_ENUM__ | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | amount | Y | number, format=float | 零值:0<br/>负数:-1<br/>极大值:2147483647<br/>极小值:-2147483648<br/>小数:0.1<br/>极大浮点:1.7976931348623157e+308<br/>极小浮点:5e-324 | string:abc<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | reason |  | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |

**字段级用例任务（逐字段，不做笛卡尔积）**
- OP101-BND-*：对上表每个字段依次覆盖“边界值枚举”
- OP101-TYPE-*：对上表每个字段依次覆盖“类型错误枚举”

### OP102 POST /bills/{billId}:mark-paid

- Summary: Mark Bill as Paid
- Security: BearerAuth | ApiKeyAuth
- Source: openapi

**用例编号（本端点固定集合）**
- OP102-HP: 正向测试（标准输入 -> 成功响应）
- OP102-AUTH: 权限测试（引用 AUTH-00~AUTH-07）

**入参字段清单（含边界/类型错误枚举）**

| 位置 | 字段 | 必填 | Schema | 边界值枚举 | 类型错误枚举 |
|---|---|---:|---|---|---|
| path | billId | Y | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | paymentRef |  | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | paidAt |  | string, format=date-time | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |

**字段级用例任务（逐字段，不做笛卡尔积）**
- OP102-BND-*：对上表每个字段依次覆盖“边界值枚举”
- OP102-TYPE-*：对上表每个字段依次覆盖“类型错误枚举”

### OP103 POST /cmp/webhook/sim-status-changed

- Summary: CMP Webhook - SIM Status Changed
- Security: ApiKeyAuth
- Source: openapi

**用例编号（本端点固定集合）**
- OP103-HP: 正向测试（标准输入 -> 成功响应）
- OP103-AUTH: 权限测试（引用 AUTH-00~AUTH-07）
- OP103-STATE-SIM_STATUS: 状态依赖测试（状态机约束）

**入参字段清单（含边界/类型错误枚举）**

| 位置 | 字段 | 必填 | Schema | 边界值枚举 | 类型错误枚举 |
|---|---|---:|---|---|---|
| body:application/json | iccid | Y | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | status | Y | string, enum="INVENTORY"\|"TEST_READY"\|"ACTIVATED"\|"DEACTIVATED"\|"RETIRED" | 合法枚举:INVENTORY<br/>合法枚举:TEST_READY<br/>合法枚举:ACTIVATED<br/>合法枚举:DEACTIVATED<br/>合法枚举:RETIRED<br/>非法枚举:__INVALID_ENUM__ | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |

**字段级用例任务（逐字段，不做笛卡尔积）**
- OP103-BND-*：对上表每个字段依次覆盖“边界值枚举”
- OP103-TYPE-*：对上表每个字段依次覆盖“类型错误枚举”

### OP104 POST /enterprises

- Summary: Create Enterprise
- Security: BearerAuth | ApiKeyAuth
- Source: openapi

**用例编号（本端点固定集合）**
- OP104-HP: 正向测试（标准输入 -> 成功响应）
- OP104-AUTH: 权限测试（引用 AUTH-00~AUTH-07）

**入参字段清单（含边界/类型错误枚举）**

| 位置 | 字段 | 必填 | Schema | 边界值枚举 | 类型错误枚举 |
|---|---|---:|---|---|---|
| body:application/json | name | Y | string, minLength=2, maxLength=200 | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα<br/>最小长度:<string length=2><br/>小于最小长度:<string length=1><br/>最大长度:<string length=200><br/>超过最大长度:<string length=201> | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | resellerId |  | string, format=uuid, nullable=true | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα<br/>合法UUID:__UUID__<br/>非法UUID:not-a-uuid | number:123<br/>boolean:true<br/>object:{...}<br/>array:[] |
| body:application/json | autoSuspendEnabled |  | boolean | true:true<br/>false:false | string:true<br/>number:1<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | contactEmail | Y | string, format=email | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | contactPhone |  | string, nullable=true | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[] |

**字段级用例任务（逐字段，不做笛卡尔积）**
- OP104-BND-*：对上表每个字段依次覆盖“边界值枚举”
- OP104-TYPE-*：对上表每个字段依次覆盖“类型错误枚举”

### OP105 POST /enterprises/{enterpriseId}:change-status

- Summary: Change Enterprise Status
- Security: BearerAuth | ApiKeyAuth
- Source: openapi

**用例编号（本端点固定集合）**
- OP105-HP: 正向测试（标准输入 -> 成功响应）
- OP105-AUTH: 权限测试（引用 AUTH-00~AUTH-07）

**入参字段清单（含边界/类型错误枚举）**

| 位置 | 字段 | 必填 | Schema | 边界值枚举 | 类型错误枚举 |
|---|---|---:|---|---|---|
| path | enterpriseId | Y | string, format=uuid | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα<br/>合法UUID:__UUID__<br/>非法UUID:not-a-uuid | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | status | Y | string, enum="ACTIVE"\|"INACTIVE"\|"SUSPENDED" | 合法枚举:ACTIVE<br/>合法枚举:INACTIVE<br/>合法枚举:SUSPENDED<br/>非法枚举:__INVALID_ENUM__ | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | reason | Y | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |

**字段级用例任务（逐字段，不做笛卡尔积）**
- OP105-BND-*：对上表每个字段依次覆盖“边界值枚举”
- OP105-TYPE-*：对上表每个字段依次覆盖“类型错误枚举”

### OP106 POST /enterprises/{enterpriseId}/departments

- Summary: Create Department
- Security: BearerAuth | ApiKeyAuth
- Source: openapi

**用例编号（本端点固定集合）**
- OP106-HP: 正向测试（标准输入 -> 成功响应）
- OP106-AUTH: 权限测试（引用 AUTH-00~AUTH-07）

**入参字段清单（含边界/类型错误枚举）**

| 位置 | 字段 | 必填 | Schema | 边界值枚举 | 类型错误枚举 |
|---|---|---:|---|---|---|
| path | enterpriseId | Y | string, format=uuid | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα<br/>合法UUID:__UUID__<br/>非法UUID:not-a-uuid | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | name | Y | string, minLength=2, maxLength=100 | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα<br/>最小长度:<string length=2><br/>小于最小长度:<string length=1><br/>最大长度:<string length=100><br/>超过最大长度:<string length=101> | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |

**字段级用例任务（逐字段，不做笛卡尔积）**
- OP106-BND-*：对上表每个字段依次覆盖“边界值枚举”
- OP106-TYPE-*：对上表每个字段依次覆盖“类型错误枚举”

### OP107 POST /enterprises/{enterpriseId}/packages

- Summary: Create Package
- Security: BearerAuth | ApiKeyAuth
- Source: openapi

**用例编号（本端点固定集合）**
- OP107-HP: 正向测试（标准输入 -> 成功响应）
- OP107-AUTH: 权限测试（引用 AUTH-00~AUTH-07）

**入参字段清单（含边界/类型错误枚举）**

| 位置 | 字段 | 必填 | Schema | 边界值枚举 | 类型错误枚举 |
|---|---|---:|---|---|---|
| path | enterpriseId | Y | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | name | Y | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | description |  | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | pricePlanVersionId | Y | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | carrierServiceConfig | Y | object | 空对象:{...}<br/>缺失必填字段:__MISSING_REQUIRED__<br/>多余字段:__EXTRA_FIELDS__ | array:[]<br/>string:x<br/>number:1<br/>boolean:true<br/>null:null |
| body:application/json | carrierServiceConfig.supplierId |  | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | carrierServiceConfig.carrierId |  | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | carrierServiceConfig.rat |  | string, enum="4G"\|"3G"\|"5G"\|"NB-IoT" | 合法枚举:4G<br/>合法枚举:3G<br/>合法枚举:5G<br/>合法枚举:NB-IoT<br/>非法枚举:__INVALID_ENUM__ | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | carrierServiceConfig.apn |  | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | carrierServiceConfig.apnProfileVersionId |  | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | carrierServiceConfig.roamingProfileVersionId |  | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | carrierServiceConfig.roamingProfile |  | object | 空对象:{...}<br/>缺失必填字段:__MISSING_REQUIRED__<br/>多余字段:__EXTRA_FIELDS__ | array:[]<br/>string:x<br/>number:1<br/>boolean:true<br/>null:null |
| body:application/json | carrierServiceConfig.roamingProfile.allowedMccMnc |  | array | 空数组:[]<br/>单元素数组:[...] | object:{...}<br/>string:x<br/>number:1<br/>boolean:true<br/>null:null |
| body:application/json | carrierServiceConfig.roamingProfile.allowedMccMnc[] |  | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |

**字段级用例任务（逐字段，不做笛卡尔积）**
- OP107-BND-*：对上表每个字段依次覆盖“边界值枚举”
- OP107-TYPE-*：对上表每个字段依次覆盖“类型错误枚举”

### OP108 POST /enterprises/{enterpriseId}/price-plans

- Summary: Create Price Plan
- Security: BearerAuth | ApiKeyAuth
- Source: openapi

**用例编号（本端点固定集合）**
- OP108-HP: 正向测试（标准输入 -> 成功响应）
- OP108-AUTH: 权限测试（引用 AUTH-00~AUTH-07）

**入参字段清单（含边界/类型错误枚举）**

| 位置 | 字段 | 必填 | Schema | 边界值枚举 | 类型错误枚举 |
|---|---|---:|---|---|---|
| path | enterpriseId | Y | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | name | Y | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | type | Y | string, enum="ONE_TIME"\|"SIM_DEPENDENT_BUNDLE"\|"FIXED_BUNDLE"\|"TIERED_VOLUME_PRICING" | 合法枚举:ONE_TIME<br/>合法枚举:SIM_DEPENDENT_BUNDLE<br/>合法枚举:FIXED_BUNDLE<br/>合法枚举:TIERED_VOLUME_PRICING<br/>非法枚举:__INVALID_ENUM__ | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | serviceType |  | string, enum="DATA"\|"VOICE"\|"SMS" | 合法枚举:DATA<br/>合法枚举:VOICE<br/>合法枚举:SMS<br/>非法枚举:__INVALID_ENUM__ | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | currency |  | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | billingCycleType |  | string, enum="CALENDAR_MONTH"\|"CUSTOM_RANGE" | 合法枚举:CALENDAR_MONTH<br/>合法枚举:CUSTOM_RANGE<br/>非法枚举:__INVALID_ENUM__ | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | firstCycleProration |  | string, enum="NONE"\|"DAILY_PRORATION" | 合法枚举:NONE<br/>合法枚举:DAILY_PRORATION<br/>非法枚举:__INVALID_ENUM__ | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | prorationRounding |  | string, enum="ROUND_HALF_UP" | 合法枚举:ROUND_HALF_UP<br/>非法枚举:__INVALID_ENUM__ | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | oneTimeFee |  | number | 零值:0<br/>负数:-1<br/>极大值:2147483647<br/>极小值:-2147483648<br/>小数:0.1<br/>极大浮点:1.7976931348623157e+308<br/>极小浮点:5e-324 | string:abc<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | quotaKb |  | integer | 零值:0<br/>负数:-1<br/>极大值:2147483647<br/>极小值:-2147483648 | string:abc<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | validityDays |  | integer | 零值:0<br/>负数:-1<br/>极大值:2147483647<br/>极小值:-2147483648 | string:abc<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | expiryBoundary |  | string, enum="CALENDAR_DAY_END"\|"DURATION_EXCLUSIVE_END" | 合法枚举:CALENDAR_DAY_END<br/>合法枚举:DURATION_EXCLUSIVE_END<br/>非法枚举:__INVALID_ENUM__ | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | monthlyFee |  | number | 零值:0<br/>负数:-1<br/>极大值:2147483647<br/>极小值:-2147483648<br/>小数:0.1<br/>极大浮点:1.7976931348623157e+308<br/>极小浮点:5e-324 | string:abc<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | deactivatedMonthlyFee |  | number | 零值:0<br/>负数:-1<br/>极大值:2147483647<br/>极小值:-2147483648<br/>小数:0.1<br/>极大浮点:1.7976931348623157e+308<br/>极小浮点:5e-324 | string:abc<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | perSimQuotaKb |  | integer | 零值:0<br/>负数:-1<br/>极大值:2147483647<br/>极小值:-2147483648 | string:abc<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | totalQuotaKb |  | integer | 零值:0<br/>负数:-1<br/>极大值:2147483647<br/>极小值:-2147483648 | string:abc<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | overageRatePerKb |  | number | 零值:0<br/>负数:-1<br/>极大值:2147483647<br/>极小值:-2147483648<br/>小数:0.1<br/>极大浮点:1.7976931348623157e+308<br/>极小浮点:5e-324 | string:abc<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | tiers |  | array | 空数组:[]<br/>单元素数组:[...] | object:{...}<br/>string:x<br/>number:1<br/>boolean:true<br/>null:null |
| body:application/json | tiers[] |  | object | 空对象:{...}<br/>缺失必填字段:__MISSING_REQUIRED__<br/>多余字段:__EXTRA_FIELDS__ | array:[]<br/>string:x<br/>number:1<br/>boolean:true<br/>null:null |
| body:application/json | tiers[].fromKb |  | integer | 零值:0<br/>负数:-1<br/>极大值:2147483647<br/>极小值:-2147483648 | string:abc<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | tiers[].toKb |  | integer | 零值:0<br/>负数:-1<br/>极大值:2147483647<br/>极小值:-2147483648 | string:abc<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | tiers[].ratePerKb |  | number | 零值:0<br/>负数:-1<br/>极大值:2147483647<br/>极小值:-2147483648<br/>小数:0.1<br/>极大浮点:1.7976931348623157e+308<br/>极小浮点:5e-324 | string:abc<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | paygRates |  | array | 空数组:[]<br/>单元素数组:[...] | object:{...}<br/>string:x<br/>number:1<br/>boolean:true<br/>null:null |
| body:application/json | paygRates[] |  | object | 空对象:{...}<br/>缺失必填字段:__MISSING_REQUIRED__<br/>多余字段:__EXTRA_FIELDS__ | array:[]<br/>string:x<br/>number:1<br/>boolean:true<br/>null:null |
| body:application/json | paygRates[].zoneCode |  | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | paygRates[].countries |  | array | 空数组:[]<br/>单元素数组:[...] | object:{...}<br/>string:x<br/>number:1<br/>boolean:true<br/>null:null |
| body:application/json | paygRates[].countries[] |  | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | paygRates[].ratePerKb |  | number | 零值:0<br/>负数:-1<br/>极大值:2147483647<br/>极小值:-2147483648<br/>小数:0.1<br/>极大浮点:1.7976931348623157e+308<br/>极小浮点:5e-324 | string:abc<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | commercialTerms |  | object | 空对象:{...}<br/>缺失必填字段:__MISSING_REQUIRED__<br/>多余字段:__EXTRA_FIELDS__ | array:[]<br/>string:x<br/>number:1<br/>boolean:true<br/>null:null |
| body:application/json | commercialTerms.testPeriodDays |  | integer | 零值:0<br/>负数:-1<br/>极大值:2147483647<br/>极小值:-2147483648 | string:abc<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | commercialTerms.testQuotaKb |  | integer | 零值:0<br/>负数:-1<br/>极大值:2147483647<br/>极小值:-2147483648 | string:abc<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | commercialTerms.testExpiryCondition |  | string, enum="PERIOD_ONLY"\|"QUOTA_ONLY"\|"PERIOD_OR_QUOTA" | 合法枚举:PERIOD_ONLY<br/>合法枚举:QUOTA_ONLY<br/>合法枚举:PERIOD_OR_QUOTA<br/>非法枚举:__INVALID_ENUM__ | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | commercialTerms.commitmentPeriodMonths |  | integer | 零值:0<br/>负数:-1<br/>极大值:2147483647<br/>极小值:-2147483648 | string:abc<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | controlPolicy |  | object | 空对象:{...}<br/>缺失必填字段:__MISSING_REQUIRED__<br/>多余字段:__EXTRA_FIELDS__ | array:[]<br/>string:x<br/>number:1<br/>boolean:true<br/>null:null |
| body:application/json | controlPolicy.enabled |  | boolean | true:true<br/>false:false | string:true<br/>number:1<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | controlPolicy.throttlingPolicyId |  | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | controlPolicy.cutoffThresholdKb |  | integer | 零值:0<br/>负数:-1<br/>极大值:2147483647<br/>极小值:-2147483648 | string:abc<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |

**字段级用例任务（逐字段，不做笛卡尔积）**
- OP108-BND-*：对上表每个字段依次覆盖“边界值枚举”
- OP108-TYPE-*：对上表每个字段依次覆盖“类型错误枚举”

### OP109 POST /enterprises/{enterpriseId}/users

- Summary: Create Enterprise User
- Security: BearerAuth | ApiKeyAuth
- Source: openapi

**用例编号（本端点固定集合）**
- OP109-HP: 正向测试（标准输入 -> 成功响应）
- OP109-AUTH: 权限测试（引用 AUTH-00~AUTH-07）

**入参字段清单（含边界/类型错误枚举）**

| 位置 | 字段 | 必填 | Schema | 边界值枚举 | 类型错误枚举 |
|---|---|---:|---|---|---|
| path | enterpriseId | Y | string, format=uuid | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα<br/>合法UUID:__UUID__<br/>非法UUID:not-a-uuid | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | email | Y | string, format=email | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | displayName | Y | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | role | Y | string, enum="customer_admin"\|"customer_ops" | 合法枚举:customer_admin<br/>合法枚举:customer_ops<br/>非法枚举:__INVALID_ENUM__ | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | departmentId |  | string, format=uuid, nullable=true | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα<br/>合法UUID:__UUID__<br/>非法UUID:not-a-uuid | number:123<br/>boolean:true<br/>object:{...}<br/>array:[] |

**字段级用例任务（逐字段，不做笛卡尔积）**
- OP109-BND-*：对上表每个字段依次覆盖“边界值枚举”
- OP109-TYPE-*：对上表每个字段依次覆盖“类型错误枚举”

### OP110 POST /enterprises/{enterpriseId}/users/{userId}/assign-departments

- Summary: Assign Enterprise User Departments
- Security: BearerAuth | ApiKeyAuth
- Source: openapi

**用例编号（本端点固定集合）**
- OP110-HP: 正向测试（标准输入 -> 成功响应）
- OP110-AUTH: 权限测试（引用 AUTH-00~AUTH-07）

**入参字段清单（含边界/类型错误枚举）**

| 位置 | 字段 | 必填 | Schema | 边界值枚举 | 类型错误枚举 |
|---|---|---:|---|---|---|
| path | enterpriseId | Y | string, format=uuid | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα<br/>合法UUID:__UUID__<br/>非法UUID:not-a-uuid | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| path | userId | Y | string, format=uuid | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα<br/>合法UUID:__UUID__<br/>非法UUID:not-a-uuid | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | assignedDepartmentIds | Y | array | 空数组:[]<br/>单元素数组:[...] | object:{...}<br/>string:x<br/>number:1<br/>boolean:true<br/>null:null |
| body:application/json | assignedDepartmentIds[] | Y | string, format=uuid | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα<br/>合法UUID:__UUID__<br/>非法UUID:not-a-uuid | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |

**字段级用例任务（逐字段，不做笛卡尔积）**
- OP110-BND-*：对上表每个字段依次覆盖“边界值枚举”
- OP110-TYPE-*：对上表每个字段依次覆盖“类型错误枚举”

### OP111 POST /jobs/{jobId}:cancel

- Summary: Cancel Job
- Security: BearerAuth | ApiKeyAuth
- Source: openapi

**用例编号（本端点固定集合）**
- OP111-HP: 正向测试（标准输入 -> 成功响应）
- OP111-AUTH: 权限测试（引用 AUTH-00~AUTH-07）
- OP111-STATE-JOB_CANCEL: 状态依赖测试（仅 QUEUED/RUNNING 可取消，其它返回 409）
- OP111-CONC: 并发/幂等性测试（同资源并发、重复提交）

**入参字段清单（含边界/类型错误枚举）**

| 位置 | 字段 | 必填 | Schema | 边界值枚举 | 类型错误枚举 |
|---|---|---:|---|---|---|
| path | jobId | Y | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |

**字段级用例任务（逐字段，不做笛卡尔积）**
- OP111-BND-*：对上表每个字段依次覆盖“边界值枚举”
- OP111-TYPE-*：对上表每个字段依次覆盖“类型错误枚举”

### OP112 POST /operators

- Summary: Create Operator
- Security: BearerAuth | ApiKeyAuth
- Source: openapi

**用例编号（本端点固定集合）**
- OP112-HP: 正向测试（标准输入 -> 成功响应）
- OP112-AUTH: 权限测试（引用 AUTH-00~AUTH-07）

**入参字段清单（含边界/类型错误枚举）**

| 位置 | 字段 | 必填 | Schema | 边界值枚举 | 类型错误枚举 |
|---|---|---:|---|---|---|
| body:application/json | mcc | Y | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | mnc | Y | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | name | Y | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |

**字段级用例任务（逐字段，不做笛卡尔积）**
- OP112-BND-*：对上表每个字段依次覆盖“边界值枚举”
- OP112-TYPE-*：对上表每个字段依次覆盖“类型错误枚举”

### OP113 POST /packages/{packageId}:publish

- Summary: Publish Package
- Security: BearerAuth | ApiKeyAuth
- Source: openapi

**用例编号（本端点固定集合）**
- OP113-HP: 正向测试（标准输入 -> 成功响应）
- OP113-AUTH: 权限测试（引用 AUTH-00~AUTH-07）
- OP113-STATE-PKG_PUBLISH: 状态依赖测试（仅 DRAFT 可发布；依赖 profile/version 状态）
- OP113-CONC: 并发/幂等性测试（同资源并发、重复提交）

**入参字段清单（含边界/类型错误枚举）**

| 位置 | 字段 | 必填 | Schema | 边界值枚举 | 类型错误枚举 |
|---|---|---:|---|---|---|
| path | packageId | Y | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |

**字段级用例任务（逐字段，不做笛卡尔积）**
- OP113-BND-*：对上表每个字段依次覆盖“边界值枚举”
- OP113-TYPE-*：对上表每个字段依次覆盖“类型错误枚举”

### OP114 POST /price-plans/{pricePlanId}/versions

- Summary: Create Price Plan Version
- Security: BearerAuth | ApiKeyAuth
- Source: openapi

**用例编号（本端点固定集合）**
- OP114-HP: 正向测试（标准输入 -> 成功响应）
- OP114-AUTH: 权限测试（引用 AUTH-00~AUTH-07）

**入参字段清单（含边界/类型错误枚举）**

| 位置 | 字段 | 必填 | Schema | 边界值枚举 | 类型错误枚举 |
|---|---|---:|---|---|---|
| path | pricePlanId | Y | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | serviceType |  | string, enum="DATA"\|"VOICE"\|"SMS" | 合法枚举:DATA<br/>合法枚举:VOICE<br/>合法枚举:SMS<br/>非法枚举:__INVALID_ENUM__ | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | currency |  | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | billingCycleType |  | string, enum="CALENDAR_MONTH"\|"CUSTOM_RANGE" | 合法枚举:CALENDAR_MONTH<br/>合法枚举:CUSTOM_RANGE<br/>非法枚举:__INVALID_ENUM__ | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | firstCycleProration |  | string, enum="NONE"\|"DAILY_PRORATION" | 合法枚举:NONE<br/>合法枚举:DAILY_PRORATION<br/>非法枚举:__INVALID_ENUM__ | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | prorationRounding |  | string, enum="ROUND_HALF_UP" | 合法枚举:ROUND_HALF_UP<br/>非法枚举:__INVALID_ENUM__ | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | oneTimeFee |  | number | 零值:0<br/>负数:-1<br/>极大值:2147483647<br/>极小值:-2147483648<br/>小数:0.1<br/>极大浮点:1.7976931348623157e+308<br/>极小浮点:5e-324 | string:abc<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | quotaKb |  | integer | 零值:0<br/>负数:-1<br/>极大值:2147483647<br/>极小值:-2147483648 | string:abc<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | validityDays |  | integer | 零值:0<br/>负数:-1<br/>极大值:2147483647<br/>极小值:-2147483648 | string:abc<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | expiryBoundary |  | string, enum="CALENDAR_DAY_END"\|"DURATION_EXCLUSIVE_END" | 合法枚举:CALENDAR_DAY_END<br/>合法枚举:DURATION_EXCLUSIVE_END<br/>非法枚举:__INVALID_ENUM__ | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | monthlyFee |  | number | 零值:0<br/>负数:-1<br/>极大值:2147483647<br/>极小值:-2147483648<br/>小数:0.1<br/>极大浮点:1.7976931348623157e+308<br/>极小浮点:5e-324 | string:abc<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | deactivatedMonthlyFee |  | number | 零值:0<br/>负数:-1<br/>极大值:2147483647<br/>极小值:-2147483648<br/>小数:0.1<br/>极大浮点:1.7976931348623157e+308<br/>极小浮点:5e-324 | string:abc<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | perSimQuotaKb |  | integer | 零值:0<br/>负数:-1<br/>极大值:2147483647<br/>极小值:-2147483648 | string:abc<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | totalQuotaKb |  | integer | 零值:0<br/>负数:-1<br/>极大值:2147483647<br/>极小值:-2147483648 | string:abc<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | overageRatePerKb |  | number | 零值:0<br/>负数:-1<br/>极大值:2147483647<br/>极小值:-2147483648<br/>小数:0.1<br/>极大浮点:1.7976931348623157e+308<br/>极小浮点:5e-324 | string:abc<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | tiers |  | array | 空数组:[]<br/>单元素数组:[...] | object:{...}<br/>string:x<br/>number:1<br/>boolean:true<br/>null:null |
| body:application/json | tiers[] |  | object | 空对象:{...}<br/>缺失必填字段:__MISSING_REQUIRED__<br/>多余字段:__EXTRA_FIELDS__ | array:[]<br/>string:x<br/>number:1<br/>boolean:true<br/>null:null |
| body:application/json | tiers[].fromKb |  | integer | 零值:0<br/>负数:-1<br/>极大值:2147483647<br/>极小值:-2147483648 | string:abc<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | tiers[].toKb |  | integer | 零值:0<br/>负数:-1<br/>极大值:2147483647<br/>极小值:-2147483648 | string:abc<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | tiers[].ratePerKb |  | number | 零值:0<br/>负数:-1<br/>极大值:2147483647<br/>极小值:-2147483648<br/>小数:0.1<br/>极大浮点:1.7976931348623157e+308<br/>极小浮点:5e-324 | string:abc<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | paygRates |  | array | 空数组:[]<br/>单元素数组:[...] | object:{...}<br/>string:x<br/>number:1<br/>boolean:true<br/>null:null |
| body:application/json | paygRates[] |  | object | 空对象:{...}<br/>缺失必填字段:__MISSING_REQUIRED__<br/>多余字段:__EXTRA_FIELDS__ | array:[]<br/>string:x<br/>number:1<br/>boolean:true<br/>null:null |
| body:application/json | paygRates[].zoneCode |  | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | paygRates[].countries |  | array | 空数组:[]<br/>单元素数组:[...] | object:{...}<br/>string:x<br/>number:1<br/>boolean:true<br/>null:null |
| body:application/json | paygRates[].countries[] |  | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | paygRates[].ratePerKb |  | number | 零值:0<br/>负数:-1<br/>极大值:2147483647<br/>极小值:-2147483648<br/>小数:0.1<br/>极大浮点:1.7976931348623157e+308<br/>极小浮点:5e-324 | string:abc<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | commercialTerms |  | object | 空对象:{...}<br/>缺失必填字段:__MISSING_REQUIRED__<br/>多余字段:__EXTRA_FIELDS__ | array:[]<br/>string:x<br/>number:1<br/>boolean:true<br/>null:null |
| body:application/json | commercialTerms.testPeriodDays |  | integer | 零值:0<br/>负数:-1<br/>极大值:2147483647<br/>极小值:-2147483648 | string:abc<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | commercialTerms.testQuotaKb |  | integer | 零值:0<br/>负数:-1<br/>极大值:2147483647<br/>极小值:-2147483648 | string:abc<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | commercialTerms.testExpiryCondition |  | string, enum="PERIOD_ONLY"\|"QUOTA_ONLY"\|"PERIOD_OR_QUOTA" | 合法枚举:PERIOD_ONLY<br/>合法枚举:QUOTA_ONLY<br/>合法枚举:PERIOD_OR_QUOTA<br/>非法枚举:__INVALID_ENUM__ | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | commercialTerms.commitmentPeriodMonths |  | integer | 零值:0<br/>负数:-1<br/>极大值:2147483647<br/>极小值:-2147483648 | string:abc<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | controlPolicy |  | object | 空对象:{...}<br/>缺失必填字段:__MISSING_REQUIRED__<br/>多余字段:__EXTRA_FIELDS__ | array:[]<br/>string:x<br/>number:1<br/>boolean:true<br/>null:null |
| body:application/json | controlPolicy.enabled |  | boolean | true:true<br/>false:false | string:true<br/>number:1<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | controlPolicy.throttlingPolicyId |  | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | controlPolicy.cutoffThresholdKb |  | integer | 零值:0<br/>负数:-1<br/>极大值:2147483647<br/>极小值:-2147483648 | string:abc<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |

**字段级用例任务（逐字段，不做笛卡尔积）**
- OP114-BND-*：对上表每个字段依次覆盖“边界值枚举”
- OP114-TYPE-*：对上表每个字段依次覆盖“类型错误枚举”

### OP115 POST /profile-versions/{profileVersionId}:rollback

- Summary: Rollback Scheduled Profile Version
- Security: BearerAuth | ApiKeyAuth
- Source: openapi

**用例编号（本端点固定集合）**
- OP115-HP: 正向测试（标准输入 -> 成功响应）
- OP115-AUTH: 权限测试（引用 AUTH-00~AUTH-07）

**入参字段清单（含边界/类型错误枚举）**

| 位置 | 字段 | 必填 | Schema | 边界值枚举 | 类型错误枚举 |
|---|---|---:|---|---|---|
| path | profileVersionId | Y | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |

**字段级用例任务（逐字段，不做笛卡尔积）**
- OP115-BND-*：对上表每个字段依次覆盖“边界值枚举”
- OP115-TYPE-*：对上表每个字段依次覆盖“类型错误枚举”

### OP116 POST /reconciliation/runs

- Summary: Create Reconciliation Run
- Security: BearerAuth | ApiKeyAuth
- Source: openapi

**用例编号（本端点固定集合）**
- OP116-HP: 正向测试（标准输入 -> 成功响应）
- OP116-AUTH: 权限测试（引用 AUTH-00~AUTH-07）

**入参字段清单（含边界/类型错误枚举）**

| 位置 | 字段 | 必填 | Schema | 边界值枚举 | 类型错误枚举 |
|---|---|---:|---|---|---|
| body:application/json | supplierId | Y | string, format=uuid | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα<br/>合法UUID:__UUID__<br/>非法UUID:not-a-uuid | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | date | Y | string, format=date | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | scope |  | string, enum="FULL"\|"INCREMENTAL" | 合法枚举:FULL<br/>合法枚举:INCREMENTAL<br/>非法枚举:__INVALID_ENUM__ | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |

**字段级用例任务（逐字段，不做笛卡尔积）**
- OP116-BND-*：对上表每个字段依次覆盖“边界值枚举”
- OP116-TYPE-*：对上表每个字段依次覆盖“类型错误枚举”

### OP117 POST /resellers

- Summary: Create Reseller
- Security: BearerAuth | ApiKeyAuth
- Source: openapi

**用例编号（本端点固定集合）**
- OP117-HP: 正向测试（标准输入 -> 成功响应）
- OP117-AUTH: 权限测试（引用 AUTH-00~AUTH-07）

**入参字段清单（含边界/类型错误枚举）**

| 位置 | 字段 | 必填 | Schema | 边界值枚举 | 类型错误枚举 |
|---|---|---:|---|---|---|
| body:application/json | name | Y | string, minLength=2, maxLength=100 | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα<br/>最小长度:<string length=2><br/>小于最小长度:<string length=1><br/>最大长度:<string length=100><br/>超过最大长度:<string length=101> | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | currency | Y | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | contactEmail | Y | string, format=email | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | contactPhone |  | string, nullable=true | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[] |
| body:application/json | brandingConfig |  | object | 空对象:{...}<br/>缺失必填字段:__MISSING_REQUIRED__<br/>多余字段:__EXTRA_FIELDS__ | array:[]<br/>string:x<br/>number:1<br/>boolean:true<br/>null:null |
| body:application/json | brandingConfig.logoUrl |  | string, nullable=true | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[] |
| body:application/json | brandingConfig.primaryColor |  | string, nullable=true | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[] |
| body:application/json | brandingConfig.customDomain |  | string, nullable=true | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[] |

**字段级用例任务（逐字段，不做笛卡尔积）**
- OP117-BND-*：对上表每个字段依次覆盖“边界值枚举”
- OP117-TYPE-*：对上表每个字段依次覆盖“类型错误枚举”

### OP118 POST /resellers/{resellerId}:change-status

- Summary: Change Reseller Status
- Security: BearerAuth | ApiKeyAuth
- Source: openapi

**用例编号（本端点固定集合）**
- OP118-HP: 正向测试（标准输入 -> 成功响应）
- OP118-AUTH: 权限测试（引用 AUTH-00~AUTH-07）

**入参字段清单（含边界/类型错误枚举）**

| 位置 | 字段 | 必填 | Schema | 边界值枚举 | 类型错误枚举 |
|---|---|---:|---|---|---|
| path | resellerId | Y | string, format=uuid | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα<br/>合法UUID:__UUID__<br/>非法UUID:not-a-uuid | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | status | Y | string, enum="ACTIVE"\|"DEACTIVATED"\|"SUSPENDED" | 合法枚举:ACTIVE<br/>合法枚举:DEACTIVATED<br/>合法枚举:SUSPENDED<br/>非法枚举:__INVALID_ENUM__ | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | reason | Y | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |

**字段级用例任务（逐字段，不做笛卡尔积）**
- OP118-BND-*：对上表每个字段依次覆盖“边界值枚举”
- OP118-TYPE-*：对上表每个字段依次覆盖“类型错误枚举”

### OP119 POST /resellers/{resellerId}/users

- Summary: Create Reseller User
- Security: BearerAuth | ApiKeyAuth
- Source: openapi

**用例编号（本端点固定集合）**
- OP119-HP: 正向测试（标准输入 -> 成功响应）
- OP119-AUTH: 权限测试（引用 AUTH-00~AUTH-07）

**入参字段清单（含边界/类型错误枚举）**

| 位置 | 字段 | 必填 | Schema | 边界值枚举 | 类型错误枚举 |
|---|---|---:|---|---|---|
| path | resellerId | Y | string, format=uuid | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα<br/>合法UUID:__UUID__<br/>非法UUID:not-a-uuid | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | email | Y | string, format=email | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | displayName | Y | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | role | Y | string, enum="reseller_admin"\|"reseller_sales_director"\|"reseller_sales"\|"reseller_finance" | 合法枚举:reseller_admin<br/>合法枚举:reseller_sales_director<br/>合法枚举:reseller_sales<br/>合法枚举:reseller_finance<br/>非法枚举:__INVALID_ENUM__ | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | assignedEnterpriseIds |  | array | 空数组:[]<br/>单元素数组:[...] | object:{...}<br/>string:x<br/>number:1<br/>boolean:true<br/>null:null |
| body:application/json | assignedEnterpriseIds[] |  | string, format=uuid | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα<br/>合法UUID:__UUID__<br/>非法UUID:not-a-uuid | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |

**字段级用例任务（逐字段，不做笛卡尔积）**
- OP119-BND-*：对上表每个字段依次覆盖“边界值枚举”
- OP119-TYPE-*：对上表每个字段依次覆盖“类型错误枚举”

### OP120 POST /resellers/{resellerId}/users/{userId}/assign-enterprises

- Summary: Assign Reseller User Enterprises
- Security: BearerAuth | ApiKeyAuth
- Source: openapi

**用例编号（本端点固定集合）**
- OP120-HP: 正向测试（标准输入 -> 成功响应）
- OP120-AUTH: 权限测试（引用 AUTH-00~AUTH-07）

**入参字段清单（含边界/类型错误枚举）**

| 位置 | 字段 | 必填 | Schema | 边界值枚举 | 类型错误枚举 |
|---|---|---:|---|---|---|
| path | resellerId | Y | string, format=uuid | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα<br/>合法UUID:__UUID__<br/>非法UUID:not-a-uuid | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| path | userId | Y | string, format=uuid | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα<br/>合法UUID:__UUID__<br/>非法UUID:not-a-uuid | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | assignedEnterpriseIds | Y | array | 空数组:[]<br/>单元素数组:[...] | object:{...}<br/>string:x<br/>number:1<br/>boolean:true<br/>null:null |
| body:application/json | assignedEnterpriseIds[] | Y | string, format=uuid | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα<br/>合法UUID:__UUID__<br/>非法UUID:not-a-uuid | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |

**字段级用例任务（逐字段，不做笛卡尔积）**
- OP120-BND-*：对上表每个字段依次覆盖“边界值枚举”
- OP120-TYPE-*：对上表每个字段依次覆盖“类型错误枚举”

### OP121 POST /roaming-profiles

- Summary: Create Roaming Profile
- Security: BearerAuth | ApiKeyAuth
- Source: openapi

**用例编号（本端点固定集合）**
- OP121-HP: 正向测试（标准输入 -> 成功响应）
- OP121-AUTH: 权限测试（引用 AUTH-00~AUTH-07）

**入参字段清单（含边界/类型错误枚举）**

| 位置 | 字段 | 必填 | Schema | 边界值枚举 | 类型错误枚举 |
|---|---|---:|---|---|---|
| body:application/json | name | Y | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | mccmncList | Y | array | 空数组:[]<br/>单元素数组:[...] | object:{...}<br/>string:x<br/>number:1<br/>boolean:true<br/>null:null |
| body:application/json | mccmncList[] | Y | object | 空对象:{...}<br/>缺失必填字段:__MISSING_REQUIRED__<br/>多余字段:__EXTRA_FIELDS__ | array:[]<br/>string:x<br/>number:1<br/>boolean:true<br/>null:null |
| body:application/json | mccmncList[].mcc | Y | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | mccmncList[].mnc | Y | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | mccmncList[].ratePerKb | Y | number | 零值:0<br/>负数:-1<br/>极大值:2147483647<br/>极小值:-2147483648<br/>小数:0.1<br/>极大浮点:1.7976931348623157e+308<br/>极小浮点:5e-324 | string:abc<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | supplierId | Y | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | carrierId |  | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |

**字段级用例任务（逐字段，不做笛卡尔积）**
- OP121-BND-*：对上表每个字段依次覆盖“边界值枚举”
- OP121-TYPE-*：对上表每个字段依次覆盖“类型错误枚举”

### OP122 POST /roaming-profiles/{roamingProfileId}:publish

- Summary: Publish Roaming Profile
- Security: BearerAuth | ApiKeyAuth
- Source: openapi

**用例编号（本端点固定集合）**
- OP122-HP: 正向测试（标准输入 -> 成功响应）
- OP122-AUTH: 权限测试（引用 AUTH-00~AUTH-07）
- OP122-STATE-ROAMING_PUBLISH: 状态依赖测试（仅 DRAFT 可发布；版本递增与回滚约束）
- OP122-CONC: 并发/幂等性测试（同资源并发、重复提交）

**入参字段清单（含边界/类型错误枚举）**

| 位置 | 字段 | 必填 | Schema | 边界值枚举 | 类型错误枚举 |
|---|---|---:|---|---|---|
| path | roamingProfileId | Y | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |

**字段级用例任务（逐字段，不做笛卡尔积）**
- OP122-BND-*：对上表每个字段依次覆盖“边界值枚举”
- OP122-TYPE-*：对上表每个字段依次覆盖“类型错误枚举”

### OP123 POST /roaming-profiles/{roamingProfileId}/versions

- Summary: Create Roaming Profile Version
- Security: BearerAuth | ApiKeyAuth
- Source: openapi

**用例编号（本端点固定集合）**
- OP123-HP: 正向测试（标准输入 -> 成功响应）
- OP123-AUTH: 权限测试（引用 AUTH-00~AUTH-07）

**入参字段清单（含边界/类型错误枚举）**

| 位置 | 字段 | 必填 | Schema | 边界值枚举 | 类型错误枚举 |
|---|---|---:|---|---|---|
| path | roamingProfileId | Y | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | mccmncList |  | array | 空数组:[]<br/>单元素数组:[...] | object:{...}<br/>string:x<br/>number:1<br/>boolean:true<br/>null:null |
| body:application/json | mccmncList[] |  | object | 空对象:{...}<br/>缺失必填字段:__MISSING_REQUIRED__<br/>多余字段:__EXTRA_FIELDS__ | array:[]<br/>string:x<br/>number:1<br/>boolean:true<br/>null:null |
| body:application/json | mccmncList[].mcc | Y | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | mccmncList[].mnc | Y | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | mccmncList[].ratePerKb | Y | number | 零值:0<br/>负数:-1<br/>极大值:2147483647<br/>极小值:-2147483648<br/>小数:0.1<br/>极大浮点:1.7976931348623157e+308<br/>极小浮点:5e-324 | string:abc<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |

**字段级用例任务（逐字段，不做笛卡尔积）**
- OP123-BND-*：对上表每个字段依次覆盖“边界值枚举”
- OP123-TYPE-*：对上表每个字段依次覆盖“类型错误枚举”

### OP124 POST /share-links

- Summary: Create Share Link
- Security: BearerAuth | ApiKeyAuth
- Source: openapi

**用例编号（本端点固定集合）**
- OP124-HP: 正向测试（标准输入 -> 成功响应）
- OP124-AUTH: 权限测试（引用 AUTH-00~AUTH-07）

**入参字段清单（含边界/类型错误枚举）**

| 位置 | 字段 | 必填 | Schema | 边界值枚举 | 类型错误枚举 |
|---|---|---:|---|---|---|
| body:application/json | kind | Y | string, enum="packages"\|"packageVersions"\|"bills" | 合法枚举:packages<br/>合法枚举:packageVersions<br/>合法枚举:bills<br/>非法枚举:__INVALID_ENUM__ | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | params | Y | object | 空对象:{...}<br/>缺失必填字段:__MISSING_REQUIRED__<br/>多余字段:__EXTRA_FIELDS__ | array:[]<br/>string:x<br/>number:1<br/>boolean:true<br/>null:null |

**字段级用例任务（逐字段，不做笛卡尔积）**
- OP124-BND-*：对上表每个字段依次覆盖“边界值枚举”
- OP124-TYPE-*：对上表每个字段依次覆盖“类型错误枚举”

### OP125 POST /sims

- Summary: Create single SIM (reseller_admin)
- Security: BearerAuth
- Source: code:src/routes/simPhase4.ts
- RBAC: roles=[reseller_admin] permissions=[sims.create]

**用例编号（本端点固定集合）**
- OP125-HP: 正向测试（标准输入 -> 成功响应）
- OP125-AUTH: 权限测试（引用 AUTH-00~AUTH-07）

**入参字段清单（含边界/类型错误枚举）**

| 位置 | 字段 | 必填 | Schema | 边界值枚举 | 类型错误枚举 |
|---|---|---:|---|---|---|
| body:application/json | iccid | Y | string, minLength=18, maxLength=20, pattern=^\d{18,20}$ | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα<br/>最小长度:<string length=18><br/>小于最小长度:<string length=17><br/>最大长度:<string length=20><br/>超过最大长度:<string length=21><br/>满足pattern:<match ^\d{18,20}$><br/>不满足pattern:<mismatch ^\d{18,20}$> | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | imsi | Y | string, minLength=1 | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα<br/>最小长度:<string length=1><br/>小于最小长度:<string length=0> | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | secondaryImsi1 |  | string, nullable=true | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[] |
| body:application/json | secondaryImsi2 |  | string, nullable=true | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[] |
| body:application/json | secondaryImsi3 |  | string, nullable=true | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[] |
| body:application/json | msisdn |  | string, nullable=true | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[] |
| body:application/json | apn | Y | string, minLength=1 | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα<br/>最小长度:<string length=1><br/>小于最小长度:<string length=0> | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | supplierId | Y | string, format=uuid | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα<br/>合法UUID:__UUID__<br/>非法UUID:not-a-uuid | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | operatorId | Y | string, format=uuid | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα<br/>合法UUID:__UUID__<br/>非法UUID:not-a-uuid | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | enterpriseId |  | string, format=uuid, nullable=true | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα<br/>合法UUID:__UUID__<br/>非法UUID:not-a-uuid | number:123<br/>boolean:true<br/>object:{...}<br/>array:[] |
| body:application/json | formFactor |  | string, enum="consumer_removable"\|"industrial_removable"\|"consumer_embedded"\|"industrial_embedded", nullable=true | 合法枚举:consumer_removable<br/>合法枚举:industrial_removable<br/>合法枚举:consumer_embedded<br/>合法枚举:industrial_embedded<br/>非法枚举:__INVALID_ENUM__ | number:123<br/>boolean:true<br/>object:{...}<br/>array:[] |
| body:application/json | activationCode |  | string, nullable=true | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[] |
| body:application/json | imei |  | string, pattern=^\d{15}$, nullable=true | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα<br/>满足pattern:<match ^\d{15}$><br/>不满足pattern:<mismatch ^\d{15}$> | number:123<br/>boolean:true<br/>object:{...}<br/>array:[] |
| body:application/json | imeiLockEnabled |  | boolean, nullable=true | true:true<br/>false:false | string:true<br/>number:1<br/>object:{...}<br/>array:[] |

**字段级用例任务（逐字段，不做笛卡尔积）**
- OP125-BND-*：对上表每个字段依次覆盖“边界值枚举”
- OP125-TYPE-*：对上表每个字段依次覆盖“类型错误枚举”

### OP126 POST /sims:batch-deactivate

- Summary: Batch Deactivate SIMs
- Security: BearerAuth | ApiKeyAuth
- Source: openapi

**用例编号（本端点固定集合）**
- OP126-HP: 正向测试（标准输入 -> 成功响应）
- OP126-AUTH: 权限测试（引用 AUTH-00~AUTH-07）
- OP126-CONC: 并发/幂等性测试（同资源并发、重复提交）

**入参字段清单（含边界/类型错误枚举）**

| 位置 | 字段 | 必填 | Schema | 边界值枚举 | 类型错误枚举 |
|---|---|---:|---|---|---|
| body:application/json | enterpriseId | Y | string, format=uuid | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα<br/>合法UUID:__UUID__<br/>非法UUID:not-a-uuid | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | reason |  | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | idempotencyKey |  | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |

**字段级用例任务（逐字段，不做笛卡尔积）**
- OP126-BND-*：对上表每个字段依次覆盖“边界值枚举”
- OP126-TYPE-*：对上表每个字段依次覆盖“类型错误枚举”

### OP127 POST /sims:batch-status-change

- Summary: Batch Change SIM Status
- Security: BearerAuth | ApiKeyAuth
- Source: openapi

**用例编号（本端点固定集合）**
- OP127-HP: 正向测试（标准输入 -> 成功响应）
- OP127-AUTH: 权限测试（引用 AUTH-00~AUTH-07）
- OP127-STATE-SIM_BATCH_STATUS: 状态依赖测试（批量状态机约束 + confirm + 单项结果一致性）
- OP127-CONC: 并发/幂等性测试（同资源并发、重复提交）

**入参字段清单（含边界/类型错误枚举）**

| 位置 | 字段 | 必填 | Schema | 边界值枚举 | 类型错误枚举 |
|---|---|---:|---|---|---|
| body:application/json | action | Y | string, enum="ACTIVATE"\|"DEACTIVATE"\|"REACTIVATE"\|"RETIRE" | 合法枚举:ACTIVATE<br/>合法枚举:DEACTIVATE<br/>合法枚举:REACTIVATE<br/>合法枚举:RETIRE<br/>非法枚举:__INVALID_ENUM__ | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | iccids | Y | array | 空数组:[]<br/>单元素数组:[...] | object:{...}<br/>string:x<br/>number:1<br/>boolean:true<br/>null:null |
| body:application/json | iccids[] | Y | string, pattern=^[0-9]{18,20}$ | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα<br/>满足pattern:<match ^[0-9]{18,20}$><br/>不满足pattern:<mismatch ^[0-9]{18,20}$> | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | enterpriseId |  | string, format=uuid, nullable=true | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα<br/>合法UUID:__UUID__<br/>非法UUID:not-a-uuid | number:123<br/>boolean:true<br/>object:{...}<br/>array:[] |
| body:application/json | reason |  | string, nullable=true | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[] |
| body:application/json | confirm |  | boolean | true:true<br/>false:false | string:true<br/>number:1<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | commitmentExempt |  | boolean | true:true<br/>false:false | string:true<br/>number:1<br/>object:{...}<br/>array:[]<br/>null:null |

**字段级用例任务（逐字段，不做笛卡尔积）**
- OP127-BND-*：对上表每个字段依次覆盖“边界值枚举”
- OP127-TYPE-*：对上表每个字段依次覆盖“类型错误枚举”

### OP128 POST /sims/{iccid}:reset-connection

- Summary: Reset Network Connection
- Security: BearerAuth | ApiKeyAuth
- Source: openapi

**用例编号（本端点固定集合）**
- OP128-HP: 正向测试（标准输入 -> 成功响应）
- OP128-AUTH: 权限测试（引用 AUTH-00~AUTH-07）

**入参字段清单（含边界/类型错误枚举）**

| 位置 | 字段 | 必填 | Schema | 边界值枚举 | 类型错误枚举 |
|---|---|---:|---|---|---|
| path | iccid | Y | string, pattern=^[0-9]{18,20}$ | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα<br/>满足pattern:<match ^[0-9]{18,20}$><br/>不满足pattern:<mismatch ^[0-9]{18,20}$> | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |

**字段级用例任务（逐字段，不做笛卡尔积）**
- OP128-BND-*：对上表每个字段依次覆盖“边界值枚举”
- OP128-TYPE-*：对上表每个字段依次覆盖“类型错误枚举”

### OP129 POST /sims/{simId}:activate

- Summary: SIM status change :activate
- Security: BearerAuth
- Source: code:src/routes/simPhase4.ts
- RBAC: roles=[reseller_admin, reseller_sales, reseller_sales_director] permissions=[sims.activate]

**用例编号（本端点固定集合）**
- OP129-HP: 正向测试（标准输入 -> 成功响应）
- OP129-AUTH: 权限测试（引用 AUTH-00~AUTH-07）
- OP129-STATE-SIM_STATUS: 状态依赖测试（allowedFrom 状态机约束 + reason/confirm）
- OP129-STATE-SIM_INVENTORY|TEST_READY|DEACTIVATED: 状态依赖测试（allowedFrom=INVENTORY|TEST_READY|DEACTIVATED）
- OP129-CONC: 并发/幂等性测试（同资源并发、重复提交）

**入参字段清单（含边界/类型错误枚举）**

| 位置 | 字段 | 必填 | Schema | 边界值枚举 | 类型错误枚举 |
|---|---|---:|---|---|---|
| path | simId | Y | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | reason |  | string, nullable=true | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[] |
| body:application/json | idempotencyKey |  | string, maxLength=128, nullable=true | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα<br/>最大长度:<string length=128><br/>超过最大长度:<string length=129> | number:123<br/>boolean:true<br/>object:{...}<br/>array:[] |
| body:application/json | commitmentExempt |  | boolean, nullable=true | true:true<br/>false:false | string:true<br/>number:1<br/>object:{...}<br/>array:[] |
| body:application/json | confirm |  | boolean, nullable=true | true:true<br/>false:false | string:true<br/>number:1<br/>object:{...}<br/>array:[] |

**字段级用例任务（逐字段，不做笛卡尔积）**
- OP129-BND-*：对上表每个字段依次覆盖“边界值枚举”
- OP129-TYPE-*：对上表每个字段依次覆盖“类型错误枚举”

### OP130 POST /sims/{simId}:deactivate

- Summary: SIM status change :deactivate
- Security: BearerAuth
- Source: code:src/routes/simPhase4.ts
- RBAC: roles=[reseller_admin, reseller_sales, reseller_sales_director] permissions=[sims.deactivate]

**用例编号（本端点固定集合）**
- OP130-HP: 正向测试（标准输入 -> 成功响应）
- OP130-AUTH: 权限测试（引用 AUTH-00~AUTH-07）
- OP130-STATE-SIM_STATUS: 状态依赖测试（allowedFrom 状态机约束 + reason/confirm）
- OP130-STATE-SIM_ACTIVATED|TEST_READY: 状态依赖测试（allowedFrom=ACTIVATED|TEST_READY）
- OP130-CONC: 并发/幂等性测试（同资源并发、重复提交）

**入参字段清单（含边界/类型错误枚举）**

| 位置 | 字段 | 必填 | Schema | 边界值枚举 | 类型错误枚举 |
|---|---|---:|---|---|---|
| path | simId | Y | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | reason | Y | string, nullable=true | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[] |
| body:application/json | idempotencyKey |  | string, maxLength=128, nullable=true | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα<br/>最大长度:<string length=128><br/>超过最大长度:<string length=129> | number:123<br/>boolean:true<br/>object:{...}<br/>array:[] |
| body:application/json | commitmentExempt |  | boolean, nullable=true | true:true<br/>false:false | string:true<br/>number:1<br/>object:{...}<br/>array:[] |
| body:application/json | confirm |  | boolean, nullable=true | true:true<br/>false:false | string:true<br/>number:1<br/>object:{...}<br/>array:[] |

**字段级用例任务（逐字段，不做笛卡尔积）**
- OP130-BND-*：对上表每个字段依次覆盖“边界值枚举”
- OP130-TYPE-*：对上表每个字段依次覆盖“类型错误枚举”

### OP131 POST /sims/{simId}:reactivate

- Summary: SIM status change :reactivate
- Security: BearerAuth
- Source: code:src/routes/simPhase4.ts
- RBAC: roles=[reseller_admin] permissions=[sims.reactivate]

**用例编号（本端点固定集合）**
- OP131-HP: 正向测试（标准输入 -> 成功响应）
- OP131-AUTH: 权限测试（引用 AUTH-00~AUTH-07）
- OP131-STATE-SIM_STATUS: 状态依赖测试（allowedFrom 状态机约束 + reason/confirm）
- OP131-STATE-SIM_DEACTIVATED: 状态依赖测试（allowedFrom=DEACTIVATED）
- OP131-CONC: 并发/幂等性测试（同资源并发、重复提交）

**入参字段清单（含边界/类型错误枚举）**

| 位置 | 字段 | 必填 | Schema | 边界值枚举 | 类型错误枚举 |
|---|---|---:|---|---|---|
| path | simId | Y | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | reason |  | string, nullable=true | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[] |
| body:application/json | idempotencyKey |  | string, maxLength=128, nullable=true | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα<br/>最大长度:<string length=128><br/>超过最大长度:<string length=129> | number:123<br/>boolean:true<br/>object:{...}<br/>array:[] |
| body:application/json | commitmentExempt |  | boolean, nullable=true | true:true<br/>false:false | string:true<br/>number:1<br/>object:{...}<br/>array:[] |
| body:application/json | confirm |  | boolean, nullable=true | true:true<br/>false:false | string:true<br/>number:1<br/>object:{...}<br/>array:[] |

**字段级用例任务（逐字段，不做笛卡尔积）**
- OP131-BND-*：对上表每个字段依次覆盖“边界值枚举”
- OP131-TYPE-*：对上表每个字段依次覆盖“类型错误枚举”

### OP132 POST /sims/{simId}:retire

- Summary: SIM status change :retire
- Security: BearerAuth
- Source: code:src/routes/simPhase4.ts
- RBAC: roles=[reseller_admin] permissions=[sims.retire]

**用例编号（本端点固定集合）**
- OP132-HP: 正向测试（标准输入 -> 成功响应）
- OP132-AUTH: 权限测试（引用 AUTH-00~AUTH-07）
- OP132-STATE-SIM_STATUS: 状态依赖测试（allowedFrom 状态机约束 + reason/confirm）
- OP132-STATE-SIM_DEACTIVATED: 状态依赖测试（allowedFrom=DEACTIVATED confirm 必须为 true）
- OP132-CONC: 并发/幂等性测试（同资源并发、重复提交）

**入参字段清单（含边界/类型错误枚举）**

| 位置 | 字段 | 必填 | Schema | 边界值枚举 | 类型错误枚举 |
|---|---|---:|---|---|---|
| path | simId | Y | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | reason | Y | string, nullable=true | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[] |
| body:application/json | idempotencyKey |  | string, maxLength=128, nullable=true | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα<br/>最大长度:<string length=128><br/>超过最大长度:<string length=129> | number:123<br/>boolean:true<br/>object:{...}<br/>array:[] |
| body:application/json | commitmentExempt |  | boolean, nullable=true | true:true<br/>false:false | string:true<br/>number:1<br/>object:{...}<br/>array:[] |
| body:application/json | confirm | Y | boolean, nullable=true | true:true<br/>false:false | string:true<br/>number:1<br/>object:{...}<br/>array:[] |

**字段级用例任务（逐字段，不做笛卡尔积）**
- OP132-BND-*：对上表每个字段依次覆盖“边界值枚举”
- OP132-TYPE-*：对上表每个字段依次覆盖“类型错误枚举”

### OP133 POST /sims/import-jobs

- Summary: Import SIMs from CSV
- Security: BearerAuth | ApiKeyAuth
- Source: openapi

**用例编号（本端点固定集合）**
- OP133-HP: 正向测试（标准输入 -> 成功响应）
- OP133-AUTH: 权限测试（引用 AUTH-00~AUTH-07）
- OP133-CONC: 并发/幂等性测试（同资源并发、重复提交）

**入参字段清单（含边界/类型错误枚举）**

| 位置 | 字段 | 必填 | Schema | 边界值枚举 | 类型错误枚举 |
|---|---|---:|---|---|---|
| body:multipart/form-data | supplierId | Y | string, format=uuid | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα<br/>合法UUID:__UUID__<br/>非法UUID:not-a-uuid | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:multipart/form-data | operatorId | Y | string, format=uuid | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα<br/>合法UUID:__UUID__<br/>非法UUID:not-a-uuid | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:multipart/form-data | apn | Y | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:multipart/form-data | batchId |  | string, nullable=true | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[] |
| body:multipart/form-data | file | Y | string, format=binary | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |

**字段级用例任务（逐字段，不做笛卡尔积）**
- OP133-BND-*：对上表每个字段依次覆盖“边界值枚举”
- OP133-TYPE-*：对上表每个字段依次覆盖“类型错误枚举”

### OP134 POST /subscriptions

- Summary: Create Subscription
- Security: BearerAuth | ApiKeyAuth
- Source: openapi

**用例编号（本端点固定集合）**
- OP134-HP: 正向测试（标准输入 -> 成功响应）
- OP134-AUTH: 权限测试（引用 AUTH-00~AUTH-07）
- OP134-STATE-SUBSCRIPTION_DEP: 状态依赖测试（依赖 enterprise ACTIVE、SIM 非 RETIRED、package version 状态）
- OP134-CONC: 并发/幂等性测试（同资源并发、重复提交）

**入参字段清单（含边界/类型错误枚举）**

| 位置 | 字段 | 必填 | Schema | 边界值枚举 | 类型错误枚举 |
|---|---|---:|---|---|---|
| body:application/json | iccid | Y | string, pattern=^[0-9]{18,20}$ | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα<br/>满足pattern:<match ^[0-9]{18,20}$><br/>不满足pattern:<mismatch ^[0-9]{18,20}$> | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | packageVersionId | Y | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | kind |  | string, enum="MAIN"\|"ADD_ON" | 合法枚举:MAIN<br/>合法枚举:ADD_ON<br/>非法枚举:__INVALID_ENUM__ | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | effectiveAt |  | string, format=date-time | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |

**字段级用例任务（逐字段，不做笛卡尔积）**
- OP134-BND-*：对上表每个字段依次覆盖“边界值枚举”
- OP134-TYPE-*：对上表每个字段依次覆盖“类型错误枚举”

### OP135 POST /subscriptions:switch

- Summary: Switch MAIN Subscription
- Security: BearerAuth | ApiKeyAuth
- Source: openapi

**用例编号（本端点固定集合）**
- OP135-HP: 正向测试（标准输入 -> 成功响应）
- OP135-AUTH: 权限测试（引用 AUTH-00~AUTH-07）
- OP135-STATE-SUBSCRIPTION_DEP: 状态依赖测试（依赖 enterprise ACTIVE、SIM 非 RETIRED、package version 状态）
- OP135-CONC: 并发/幂等性测试（同资源并发、重复提交）

**入参字段清单（含边界/类型错误枚举）**

| 位置 | 字段 | 必填 | Schema | 边界值枚举 | 类型错误枚举 |
|---|---|---:|---|---|---|
| body:application/json | iccid | Y | string, pattern=^[0-9]{18,20}$ | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα<br/>满足pattern:<match ^[0-9]{18,20}$><br/>不满足pattern:<mismatch ^[0-9]{18,20}$> | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | fromSubscriptionId | Y | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | toPackageVersionId | Y | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |

**字段级用例任务（逐字段，不做笛卡尔积）**
- OP135-BND-*：对上表每个字段依次覆盖“边界值枚举”
- OP135-TYPE-*：对上表每个字段依次覆盖“类型错误枚举”

### OP136 POST /subscriptions/{subscriptionId}:cancel

- Summary: Cancel Subscription
- Security: BearerAuth | ApiKeyAuth
- Source: openapi

**用例编号（本端点固定集合）**
- OP136-HP: 正向测试（标准输入 -> 成功响应）
- OP136-AUTH: 权限测试（引用 AUTH-00~AUTH-07）
- OP136-STATE-SUBSCRIPTION_DEP: 状态依赖测试（依赖 enterprise ACTIVE、SIM 非 RETIRED、package version 状态）
- OP136-CONC: 并发/幂等性测试（同资源并发、重复提交）

**入参字段清单（含边界/类型错误枚举）**

| 位置 | 字段 | 必填 | Schema | 边界值枚举 | 类型错误枚举 |
|---|---|---:|---|---|---|
| path | subscriptionId | Y | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | immediate |  | boolean | true:true<br/>false:false | string:true<br/>number:1<br/>object:{...}<br/>array:[]<br/>null:null |

**字段级用例任务（逐字段，不做笛卡尔积）**
- OP136-BND-*：对上表每个字段依次覆盖“边界值枚举”
- OP136-TYPE-*：对上表每个字段依次覆盖“类型错误枚举”

### OP137 POST /suppliers

- Summary: Create Supplier
- Security: BearerAuth | ApiKeyAuth
- Source: openapi

**用例编号（本端点固定集合）**
- OP137-HP: 正向测试（标准输入 -> 成功响应）
- OP137-AUTH: 权限测试（引用 AUTH-00~AUTH-07）

**入参字段清单（含边界/类型错误枚举）**

| 位置 | 字段 | 必填 | Schema | 边界值枚举 | 类型错误枚举 |
|---|---|---:|---|---|---|
| body:application/json | name | Y | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | status |  | string, enum="ACTIVE"\|"SUSPENDED" | 合法枚举:ACTIVE<br/>合法枚举:SUSPENDED<br/>非法枚举:__INVALID_ENUM__ | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | operatorIds | Y | array | 空数组:[]<br/>单元素数组:[...] | object:{...}<br/>string:x<br/>number:1<br/>boolean:true<br/>null:null |
| body:application/json | operatorIds[] | Y | string, format=uuid | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα<br/>合法UUID:__UUID__<br/>非法UUID:not-a-uuid | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |

**字段级用例任务（逐字段，不做笛卡尔积）**
- OP137-BND-*：对上表每个字段依次覆盖“边界值枚举”
- OP137-TYPE-*：对上表每个字段依次覆盖“类型错误枚举”

### OP138 POST /suppliers/{supplierId}:change-status

- Summary: Change Supplier Status
- Security: BearerAuth | ApiKeyAuth
- Source: openapi

**用例编号（本端点固定集合）**
- OP138-HP: 正向测试（标准输入 -> 成功响应）
- OP138-AUTH: 权限测试（引用 AUTH-00~AUTH-07）

**入参字段清单（含边界/类型错误枚举）**

| 位置 | 字段 | 必填 | Schema | 边界值枚举 | 类型错误枚举 |
|---|---|---:|---|---|---|
| path | supplierId | Y | string, format=uuid | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα<br/>合法UUID:__UUID__<br/>非法UUID:not-a-uuid | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | status | Y | string, enum="ACTIVE"\|"SUSPENDED" | 合法枚举:ACTIVE<br/>合法枚举:SUSPENDED<br/>非法枚举:__INVALID_ENUM__ | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | reason | Y | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |

**字段级用例任务（逐字段，不做笛卡尔积）**
- OP138-BND-*：对上表每个字段依次覆盖“边界值枚举”
- OP138-TYPE-*：对上表每个字段依次覆盖“类型错误枚举”

### OP139 POST /webhook-deliveries/{deliveryId}/retry

- Summary: Retry Webhook Delivery
- Security: BearerAuth | ApiKeyAuth
- Source: openapi

**用例编号（本端点固定集合）**
- OP139-HP: 正向测试（标准输入 -> 成功响应）
- OP139-AUTH: 权限测试（引用 AUTH-00~AUTH-07）

**入参字段清单（含边界/类型错误枚举）**

| 位置 | 字段 | 必填 | Schema | 边界值枚举 | 类型错误枚举 |
|---|---|---:|---|---|---|
| path | deliveryId | Y | integer | 零值:0<br/>负数:-1<br/>极大值:2147483647<br/>极小值:-2147483648 | string:abc<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |

**字段级用例任务（逐字段，不做笛卡尔积）**
- OP139-BND-*：对上表每个字段依次覆盖“边界值枚举”
- OP139-TYPE-*：对上表每个字段依次覆盖“类型错误枚举”

### OP140 POST /webhook-subscriptions

- Summary: Create Webhook Subscription
- Security: BearerAuth | ApiKeyAuth
- Source: openapi

**用例编号（本端点固定集合）**
- OP140-HP: 正向测试（标准输入 -> 成功响应）
- OP140-AUTH: 权限测试（引用 AUTH-00~AUTH-07）

**入参字段清单（含边界/类型错误枚举）**

| 位置 | 字段 | 必填 | Schema | 边界值枚举 | 类型错误枚举 |
|---|---|---:|---|---|---|
| body:application/json | resellerId |  | string, format=uuid, nullable=true | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα<br/>合法UUID:__UUID__<br/>非法UUID:not-a-uuid | number:123<br/>boolean:true<br/>object:{...}<br/>array:[] |
| body:application/json | enterpriseId |  | string, format=uuid, nullable=true | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα<br/>合法UUID:__UUID__<br/>非法UUID:not-a-uuid | number:123<br/>boolean:true<br/>object:{...}<br/>array:[] |
| body:application/json | url | Y | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | secret | Y | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | eventTypes | Y | array | 空数组:[]<br/>单元素数组:[...] | object:{...}<br/>string:x<br/>number:1<br/>boolean:true<br/>null:null |
| body:application/json | eventTypes[] | Y | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | enabled |  | boolean | true:true<br/>false:false | string:true<br/>number:1<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | description |  | string, nullable=true | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[] |

**字段级用例任务（逐字段，不做笛卡尔积）**
- OP140-BND-*：对上表每个字段依次覆盖“边界值枚举”
- OP140-TYPE-*：对上表每个字段依次覆盖“类型错误枚举”

### OP141 POST /wx/webhook/product-order

- Summary: WXZHONGGENG Product Order Webhook
- Security: BearerAuth | ApiKeyAuth
- Source: openapi

**用例编号（本端点固定集合）**
- OP141-HP: 正向测试（标准输入 -> 成功响应）
- OP141-AUTH: 权限测试（引用 AUTH-00~AUTH-07）

**入参字段清单（含边界/类型错误枚举）**

| 位置 | 字段 | 必填 | Schema | 边界值枚举 | 类型错误枚举 |
|---|---|---:|---|---|---|
| header | X-API-Key | Y | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | messageType | Y | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | iccid | Y | string, pattern=^[0-9]{18,20}$ | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα<br/>满足pattern:<match ^[0-9]{18,20}$><br/>不满足pattern:<mismatch ^[0-9]{18,20}$> | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | msisdn | Y | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | data | Y | object | 空对象:{...}<br/>缺失必填字段:__MISSING_REQUIRED__<br/>多余字段:__EXTRA_FIELDS__ | array:[]<br/>string:x<br/>number:1<br/>boolean:true<br/>null:null |
| body:application/json | data.addOnId | Y | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | data.addOnType | Y | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | data.startDate | Y | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | data.transactionId | Y | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | data.expirationDate | Y | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | sign | Y | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | uuid | Y | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |

**字段级用例任务（逐字段，不做笛卡尔积）**
- OP141-BND-*：对上表每个字段依次覆盖“边界值枚举”
- OP141-TYPE-*：对上表每个字段依次覆盖“类型错误枚举”

### OP142 POST /wx/webhook/sim-online

- Summary: WXZHONGGENG SIM Online Webhook
- Security: BearerAuth | ApiKeyAuth
- Source: openapi

**用例编号（本端点固定集合）**
- OP142-HP: 正向测试（标准输入 -> 成功响应）
- OP142-AUTH: 权限测试（引用 AUTH-00~AUTH-07）

**入参字段清单（含边界/类型错误枚举）**

| 位置 | 字段 | 必填 | Schema | 边界值枚举 | 类型错误枚举 |
|---|---|---:|---|---|---|
| header | X-API-Key | Y | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | messageType | Y | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | iccid | Y | string, pattern=^[0-9]{18,20}$ | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα<br/>满足pattern:<match ^[0-9]{18,20}$><br/>不满足pattern:<mismatch ^[0-9]{18,20}$> | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | msisdn | Y | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | sign | Y | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | uuid | Y | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | data | Y | object | 空对象:{...}<br/>缺失必填字段:__MISSING_REQUIRED__<br/>多余字段:__EXTRA_FIELDS__ | array:[]<br/>string:x<br/>number:1<br/>boolean:true<br/>null:null |
| body:application/json | data.mncList | Y | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | data.eventTime | Y | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | data.mcc | Y | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |

**字段级用例任务（逐字段，不做笛卡尔积）**
- OP142-BND-*：对上表每个字段依次覆盖“边界值枚举”
- OP142-TYPE-*：对上表每个字段依次覆盖“类型错误枚举”

### OP143 POST /wx/webhook/sim-status-changed

- Summary: WXZHONGGENG SIM Status Changed Webhook
- Security: BearerAuth | ApiKeyAuth
- Source: openapi

**用例编号（本端点固定集合）**
- OP143-HP: 正向测试（标准输入 -> 成功响应）
- OP143-AUTH: 权限测试（引用 AUTH-00~AUTH-07）
- OP143-STATE-SIM_STATUS: 状态依赖测试（状态机约束）

**入参字段清单（含边界/类型错误枚举）**

| 位置 | 字段 | 必填 | Schema | 边界值枚举 | 类型错误枚举 |
|---|---|---:|---|---|---|
| header | X-API-Key | Y | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | messageType | Y | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | iccid | Y | string, pattern=^[0-9]{18,20}$ | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα<br/>满足pattern:<match ^[0-9]{18,20}$><br/>不满足pattern:<mismatch ^[0-9]{18,20}$> | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | msisdn | Y | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | sign | Y | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | uuid | Y | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | data | Y | object | 空对象:{...}<br/>缺失必填字段:__MISSING_REQUIRED__<br/>多余字段:__EXTRA_FIELDS__ | array:[]<br/>string:x<br/>number:1<br/>boolean:true<br/>null:null |
| body:application/json | data.toStatus | Y | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | data.fromStatus | Y | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | data.eventTime | Y | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | data.transactionId | Y | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |

**字段级用例任务（逐字段，不做笛卡尔积）**
- OP143-BND-*：对上表每个字段依次覆盖“边界值枚举”
- OP143-TYPE-*：对上表每个字段依次覆盖“类型错误枚举”

### OP144 POST /wx/webhook/traffic-alert

- Summary: WXZHONGGENG Traffic Alert Webhook
- Security: BearerAuth | ApiKeyAuth
- Source: openapi

**用例编号（本端点固定集合）**
- OP144-HP: 正向测试（标准输入 -> 成功响应）
- OP144-AUTH: 权限测试（引用 AUTH-00~AUTH-07）

**入参字段清单（含边界/类型错误枚举）**

| 位置 | 字段 | 必填 | Schema | 边界值枚举 | 类型错误枚举 |
|---|---|---:|---|---|---|
| header | X-API-Key | Y | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | messageType | Y | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | iccid | Y | string, pattern=^[0-9]{18,20}$ | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα<br/>满足pattern:<match ^[0-9]{18,20}$><br/>不满足pattern:<mismatch ^[0-9]{18,20}$> | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | msisdn | Y | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | data | Y | object | 空对象:{...}<br/>缺失必填字段:__MISSING_REQUIRED__<br/>多余字段:__EXTRA_FIELDS__ | array:[]<br/>string:x<br/>number:1<br/>boolean:true<br/>null:null |
| body:application/json | data.thresholdReached | Y | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | data.eventTime | Y | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | data.limit | Y | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | data.eventName | Y | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | data.balanceAmount | Y | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | data.addOnID | Y | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | sign | Y | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | uuid | Y | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |

**字段级用例任务（逐字段，不做笛卡尔积）**
- OP144-BND-*：对上表每个字段依次覆盖“边界值枚举”
- OP144-TYPE-*：对上表每个字段依次覆盖“类型错误枚举”

### OP145 PUT /packages/{packageId}

- Summary: Update Package Draft
- Security: BearerAuth | ApiKeyAuth
- Source: openapi

**用例编号（本端点固定集合）**
- OP145-HP: 正向测试（标准输入 -> 成功响应）
- OP145-AUTH: 权限测试（引用 AUTH-00~AUTH-07）

**入参字段清单（含边界/类型错误枚举）**

| 位置 | 字段 | 必填 | Schema | 边界值枚举 | 类型错误枚举 |
|---|---|---:|---|---|---|
| path | packageId | Y | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | name |  | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | pricePlanVersionId |  | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | carrierServiceConfig |  | object | 空对象:{...}<br/>缺失必填字段:__MISSING_REQUIRED__<br/>多余字段:__EXTRA_FIELDS__ | array:[]<br/>string:x<br/>number:1<br/>boolean:true<br/>null:null |
| body:application/json | carrierServiceConfig.supplierId |  | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | carrierServiceConfig.carrierId |  | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | carrierServiceConfig.rat |  | string, enum="4G"\|"3G"\|"5G"\|"NB-IoT" | 合法枚举:4G<br/>合法枚举:3G<br/>合法枚举:5G<br/>合法枚举:NB-IoT<br/>非法枚举:__INVALID_ENUM__ | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | carrierServiceConfig.apn |  | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | carrierServiceConfig.apnProfileVersionId |  | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | carrierServiceConfig.roamingProfileVersionId |  | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | carrierServiceConfig.roamingProfile |  | object | 空对象:{...}<br/>缺失必填字段:__MISSING_REQUIRED__<br/>多余字段:__EXTRA_FIELDS__ | array:[]<br/>string:x<br/>number:1<br/>boolean:true<br/>null:null |
| body:application/json | carrierServiceConfig.roamingProfile.allowedMccMnc |  | array | 空数组:[]<br/>单元素数组:[...] | object:{...}<br/>string:x<br/>number:1<br/>boolean:true<br/>null:null |
| body:application/json | carrierServiceConfig.roamingProfile.allowedMccMnc[] |  | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |

**字段级用例任务（逐字段，不做笛卡尔积）**
- OP145-BND-*：对上表每个字段依次覆盖“边界值枚举”
- OP145-TYPE-*：对上表每个字段依次覆盖“类型错误枚举”

### OP146 PUT /sims/{iccid}/plan

- Summary: Change Rate Plan
- Security: BearerAuth | ApiKeyAuth
- Source: openapi

**用例编号（本端点固定集合）**
- OP146-HP: 正向测试（标准输入 -> 成功响应）
- OP146-AUTH: 权限测试（引用 AUTH-00~AUTH-07）

**入参字段清单（含边界/类型错误枚举）**

| 位置 | 字段 | 必填 | Schema | 边界值枚举 | 类型错误枚举 |
|---|---|---:|---|---|---|
| path | iccid | Y | string, pattern=^[0-9]{18,20}$ | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα<br/>满足pattern:<match ^[0-9]{18,20}$><br/>不满足pattern:<mismatch ^[0-9]{18,20}$> | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | newPlanCode | Y | string | 空字符串:""<br/>空白字符串:   <br/>特殊字符:"'\\\n\r<><br/>Unicode:中文測試Καλημέρα | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |
| body:application/json | effectiveDate |  | string, enum="IMMEDIATE"\|"NEXT_CYCLE" | 合法枚举:IMMEDIATE<br/>合法枚举:NEXT_CYCLE<br/>非法枚举:__INVALID_ENUM__ | number:123<br/>boolean:true<br/>object:{...}<br/>array:[]<br/>null:null |

**字段级用例任务（逐字段，不做笛卡尔积）**
- OP146-BND-*：对上表每个字段依次覆盖“边界值枚举”
- OP146-TYPE-*：对上表每个字段依次覆盖“类型错误枚举”
