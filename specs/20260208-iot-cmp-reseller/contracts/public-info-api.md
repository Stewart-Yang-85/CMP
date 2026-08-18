# API 契约：3GPP 公开运营商目录（`public_infos`）

**Feature**: `iot-cmp-reseller` | **Date**: 2026-03-24  
**关联规格**: [spec.md](../spec.md) FR-054～FR-056、[data-model.md](../data-model.md) §`public_infos`  
**存储**: 物理表 `public.public_infos`；兼容视图 `public.carriers`（`carrier_id` 映射 `public_info_id`）

**隔离（强制）**: 本目录与 **`business_operators`**、业务 **`operators` 行（含其 `operator_id` 主键）** 及 SIM/订阅/计费等流程 **无任何 JOIN、外键或校验关系**（见 spec **FR-057**）。`DELETE /v1/admin/public-infos/{id}` **不得**以「业务表外键」为由阻塞——业务表不应引用 `public_infos`。

---

## 1. 只读查询（系统内所有已认证用户）

```
GET /v1/public-infos?name={}&mcc={}&mnc={}&page={}&pageSize={}
```

**权限**: 任意**已认证**用户（platform / reseller / enterprise / department 等系统角色均可）。匿名请求 **401**。（`reseller` 角色 JWT 中的 `resellerId` 语义见 [tenant-api.md §0 — FR-058](tenant-api.md)。）

**说明**:

- **名称模糊**：`name` 非空时，对 `public_infos.name` 做**不区分大小写**的**子串模糊匹配**（`ilike %name%`），**不做精准等值匹配**。原因：目录行可能按运营商下属具体公司全称入库，精准匹配会漏掉可用结果。
- **MCC 单查**：仅提供 `mcc` 时，返回该国家（MCC）下全部运营商目录行。
- **MCC+MNC 精确**：`mcc` 与 `mnc` **同时提供**时，按 E.212 **精确等值**过滤到目标运营商（`mnc` 会规范化为 3 位以匹配库内存储）。
- **禁止仅 MNC**：仅提供 `mnc` → **400**（各国 MNC 大量重复，无法唯一定位）。
- **组合语义**：若同时提供 `name` 与 `mcc`（或 `mcc`+`mnc`），结果为 **AND**。
- 过滤条件皆空：返回全量目录的分页结果。

**Query Parameters**:

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| name | string | 否 | 运营商名称**模糊**搜索（子串，不区分大小写） |
| mcc | string | 否 | 单独：该国全部运营商；与 `mnc` 成对：精确 PLMN |
| mnc | string | 否 | 须与 `mcc` 成对；单独提供 → 400 |
| page | integer | 否 | 默认 **1** |
| pageSize | integer | 否 | 默认 **50**，最大 **100** |

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
  "pageSize": 50
}
```

---

## 2. 写入（仅系统管理员）

以下端点 **仅 platform_admin**；否则 **403**。

### 2.1 新增

```
POST /v1/admin/public-infos
```

**权限**: 仅 **platform_admin**；否则 **403**。匿名 **401**。

**Request Body**:

```json
{
  "mcc": "460",
  "mnc": "00",
  "name": "string",
  "country": "string",
  "lteBands": "string (optional)"
}
```

**约束**:

- **必填**: `mcc`、`mnc`、`name`、`country`
- **可选**: `lteBands`（省略时写入 `null`）
- **MNC 规范化**: 习惯性 2 位 `mnc`（如 `"02"`）在查重与落库前**左侧补 0** 为 3 位（`"002"`），与 `GET /public-infos` 一致
- **同 PLMN 冲突**: 若已存在相同 `(mcc, 规范化后 mnc)` 记录 → **409** `DUPLICATE_PLMN`（**不覆盖**；更新请用 PATCH）

**Response 201**: 单条对象（同查询项字段 + `createdAt`/`updatedAt` 可选）

### 2.2 按 publicInfoId 更新

```
PATCH /v1/admin/public-infos/{publicInfoId}
```

**权限**: 仅 **platform_admin**。

**Request Body**:

```json
{
  "mcc": "460",
  "mnc": "00",
  "name": "string",
  "country": "string",
  "lteBands": "string (optional)"
}
```

**约束**:

- **必填**: `mcc`、`mnc`、`name`、`country`
- **可选**: `lteBands`（省略 → `null`）
- **MNC 规范化**: 同 POST，2 位 `mnc` 左侧补 0 至 3 位后再做查重与更新
- 定位键为路径 `publicInfoId`；同时**始终**检查 `(mcc, 规范化后 mnc)` 是否已被**其他**行占用：
  - 冲突 → **409** `DUPLICATE_PLMN`（不覆盖另一行）
  - 本行保持原 `(mcc, mnc)` 或改到空闲 PLMN → **200**

**Response 200**: 更新后对象

### 2.3 删除（纠错）

```
DELETE /v1/admin/public-infos/{publicInfoId}
```

**权限**: 仅 **platform_admin**；否则 **403**。匿名 **401**。

**说明**: 目标数据模型下 **无任何业务表 FK 指向 `public_infos`**（V1.1 已移除历史 `operators.carrier_id` 引用，见 FR-057）。删除成功返回 **200** `{ "deleted": true }`；若仍存在遗留 FK → **409** `FK_CONFLICT`。

**Response 200**: `{ "deleted": true }`

---

## 3. RLS（Supabase）

- **SELECT**：`authenticated` 角色可读（或与应用层一致：仅能通过服务端 service_role 代理查询时，则不设 public SELECT，仅走 API）。
- **INSERT/UPDATE/DELETE**：仅 `service_role` 经应用层校验 `platform_admin` 后执行，或 policy 绑定 JWT claim `role = platform_admin`（与项目现有 RLS 模式对齐，实现阶段二选一并在迁移注释中说明）。

---

## 4. OpenAPI

实现时同步更新 `iot-cmp-api.yaml` / `packages/openapi/openapi.yaml` 中上述路径与 schema。
