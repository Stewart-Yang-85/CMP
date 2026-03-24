# API 契约：3GPP 公开运营商目录（`public_infos`）

**Feature**: `iot-cmp-reseller` | **Date**: 2026-03-24  
**关联规格**: [spec.md](../spec.md) FR-054～FR-056、[data-model.md](../data-model.md) §`public_infos`  
**存储**: 物理表 `public.public_infos`；兼容视图 `public.carriers`（`carrier_id` 映射 `public_info_id`）

**隔离（强制）**: 本目录与 **`business_operators`**、业务 **`operators` 行（含其 `operator_id` 主键）** 及 SIM/订阅/计费等流程 **无任何 JOIN、外键或校验关系**（见 spec **FR-057**）。`DELETE /v1/admin/public-infos/{id}` **不得**以「业务表外键」为由阻塞——业务表不应引用 `public_infos`。

---

## 1. 只读查询（所有已认证非管理员用户 + platform_admin）

```
GET /v1/public-infos?name={}&mcc={}&mnc={}&page={}&pageSize={}
```

**权限**: 任意**已认证**用户（reseller / customer / platform_admin）。匿名请求 **401**。

**说明**:

- **名称模糊**：`name` 非空时，对 `public_infos.name` 做**不区分大小写**子串匹配（`ilike %name%`）。
- **MCC/MNC 精确**：`mcc` 与 `mnc` **同时提供**时，按 E.212 **精确等值**过滤（规范化：数字字符串，前导零保留与库内 `char(3)` 一致）。
- **组合语义**：若同时提供 `name` 与 `mcc`+`mnc`，结果为 **AND**（既匹配名称模糊又匹配 PLMN）。
- 仅提供 `mcc` 或仅 `mnc`：**400** `INVALID_QUERY`（须成对精确查询或只用名称）。
- 三者皆空：**400** `QUERY_REQUIRED`（至少提供 `name` 或 `(mcc+mnc)`）。

**Query Parameters**:

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| name | string | 否 | 运营商名称模糊搜索 |
| mcc | string | 否 | 与 `mnc` 成对，3 位 |
| mnc | string | 否 | 与 `mcc` 成对，2～3 位 |
| page | integer | 否 | 默认 1 |
| pageSize | integer | 否 | 默认 20，最大 100 |

**Response 200**:

```json
{
  "items": [
    {
      "publicInfoId": "uuid",
      "name": "string",
      "countryName": "string",
      "mcc": "460",
      "mnc": "00",
      "lteBands": "string"
    }
  ],
  "total": 0,
  "page": 1,
  "pageSize": 20
}
```

---

## 2. 写入（仅系统管理员）

以下端点 **仅 platform_admin**；否则 **403**。

### 2.1 新增

```
POST /v1/admin/public-infos
```

**Request Body**:

```json
{
  "mcc": "460",
  "mnc": "00",
  "name": "string",
  "countryName": "string (optional)",
  "lteBands": "string (optional)"
}
```

**约束**: `UNIQUE(mcc, mnc)` 冲突 → **409** `DUPLICATE_PLMN`

**Response 201**: 单条对象（同查询项字段 + `createdAt`/`updatedAt` 可选）

### 2.2 更新

```
PATCH /v1/admin/public-infos/{publicInfoId}
```

**Request Body**: 可部分更新 `name`、`countryName`、`lteBands`、`mcc`、`mnc`（若改 PLMN 仍须满足唯一约束）

**Response 200**: 更新后对象

### 2.3 删除（纠错）

```
DELETE /v1/admin/public-infos/{publicInfoId}
```

**说明**: 目标数据模型下 **无任何业务表 FK 指向 `public_infos`**（V1.1 已移除历史 `operators.carrier_id` 引用，见 FR-057）。删除成功返回 **204**；若迁移尚未完成、仍存在遗留 FK，应优先通过**数据迁移**解除约束而非长期依赖 **409**。

**Response 204**

---

## 3. RLS（Supabase）

- **SELECT**：`authenticated` 角色可读（或与应用层一致：仅能通过服务端 service_role 代理查询时，则不设 public SELECT，仅走 API）。
- **INSERT/UPDATE/DELETE**：仅 `service_role` 经应用层校验 `platform_admin` 后执行，或 policy 绑定 JWT claim `role = platform_admin`（与项目现有 RLS 模式对齐，实现阶段二选一并在迁移注释中说明）。

---

## 4. OpenAPI

实现时同步更新 `iot-cmp-api.yaml` / `packages/openapi/openapi.yaml` 中上述路径与 schema。
