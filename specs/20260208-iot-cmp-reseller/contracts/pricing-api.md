# API 契约：产品包与资费计划

**Feature**: `iot-cmp-reseller` | **Date**: 2026-02-08（**CoveredNetworkProfile / in-profile·OOP** 2026-04-22；**Phase 31** 价目 **父表 + 四子表** + **List/Get/Update 分型响应** 2026-04-23；**§6.3.1** Package 列表响应键草图 2026-04-24）

（**`resellerId` 语义**与 **FR-058** 见 [tenant-api.md §0](tenant-api.md)。**按企业** 创建/列举价计划时，见下 **§2.0**。）

**关联 User Story**: US3（产品包与资费计划配置）、US4（订阅关系管理）
**关联需求**: FR-015 ~ FR-022, FR-052 ~ FR-053

---

## 1. US3 模块统一规则（快照模型）

- APN Profile、**CoveredNetworkProfile**（in-profile (MCC,MNC) 覆盖）、Roaming Profile、Control Policy、Price Plan、Commercial Terms 采用不可变快照模型：每次编辑都创建新 ID（或 **Covered** 在 **DRAFT** 下 **PATCH** 名称/覆盖集，见 OpenAPI），状态生命周期 **`DRAFT` / `PUBLISHED` / `DEPRECATED`**
- 仅 `DRAFT` 可更新，`PUBLISHED`/`DEPRECATED` 只读
- 列表展示统一包含：`name + publishedAt + status`，名称允许重复
- APN Profile、Control Policy 保留 `:clone`；**Roaming Profile** 修订采用 **`:export-csv` → 编辑 → `:import-csv`**（新建快照，**无** `:clone`）；**CoveredNetworkProfile** 以 **PATCH（DRAFT）** + **publish** 为主（与 OpenAPI 一致）；Price Plan 不再提供 `:clone`，改为「详情回填 + 创建新快照」
- Package 引用的是模块快照 ID，不再使用 `*VersionId`

---

## 2. Price Plan（快照）

**创建**与**列表** **MUST** 同时使用 **路径参数 `enterpriseId`**（企业租户 UUID）与 **query `resellerId`**（代理商租户 UUID，规则见下）。服务实现 **仅** 注册上述 enterprise 路径；**不存在**「无 `enterpriseId` 的 `POST /v1/price-plans`」创建端点。先前契约中若出现该全局路径，视为**已废弃的文档笔误**，以本节与 [spec.md — Price Plan HTTP 接口范围](../spec.md#spec-price-plan-http-scope) 为准。

### 2.0 按企业创建 / 列表（唯一主路径：`enterpriseId` + `resellerId`）

```
POST /v1/enterprises/{enterpriseId}/price-plans?resellerId={uuid}
GET  /v1/enterprises/{enterpriseId}/price-plans?resellerId={uuid}&type={type}&status={status}&page={n}&pageSize={n}
```

- **`enterpriseId`（path）**：**ENTERPRISE** 的 `tenants.tenant_id`；与 **`resellerId` 所指代理商**在租户树上 **MUST** 匹配（通常 `tenants.parent_id = resellerId`），与 [spec.md §Price Plan 创建与列表](../spec.md) 一致。
- **`resellerId`（query）**：**RESELLER** 的 `tenants.tenant_id`；**MUST** 与上述 `enterpriseId` 的归属关系一致。使用 **platform（admin）API key** 时 **必填**；使用 **reseller JWT** 时可省略（默认 token 中的代理商），若显式传入则 **MUST** 与 token 一致。
- **列表 query（可选）**：`type`、`status`、`page`、`pageSize` — 语义与 OpenAPI 一致；**仍须**带齐 **`enterpriseId` + `resellerId`（或 JWT 等价缺省）**，列表范围**限定在该企业**下。
- **持久化（Phase 31）**：
  - **父表** `price_plans`：身份、`type`、`service_type`、`currency`、`billing_cycle_type`、`first_cycle_proration`、`proration_rounding`、`covered_network_profile_id`、`status`、`effective_from` / `deprecated_at`、`source_price_plan_id`、`version`、`enterprise_id`、`reseller_id` 等（**无** 类型专有定价列）。
  - **子表**（与 `type` **1:1**，`PK = price_plan_id` → `price_plans`，`ON DELETE CASCADE`）：`price_plan_fixed_bundle`、`price_plan_sim_dependent_bundle`、`price_plan_one_time`、`price_plan_tiered_volume_pricing`。
  - **批价 / 订阅读宽表**：DB 视图 **`price_plans_expanded`**（父 + 子 `LEFT JOIN`）；服务层 **List / Get / Update** 返回 **分型 JSON**（与 **Create** 四种 body 对称，含 **`price_plan_type`**；**`TIERED_PRICING`** 对应 DB **`TIERED_VOLUME_PRICING`**）。
  - 详见 [data-model.md](../data-model.md) **`price_plans`** 与 **子表** 小节。

**权限（创建 POST）**: 代理商管理员（与实现 `ensureResellerAdmin` 一致）。

**Request Body（创建 POST；按 `price_plan_type` / `type` 分型，与 OpenAPI `PricePlanCreateRequest` 一致）**:
- 公共字段：`name`、`price_plan_type`（或 `type`）、`serviceType`、`currency`、`billingCycleType`、`firstCycleProration`、`prorationRounding`；可选 **`carrierService`**（仅校验，不落库）。
- **不再**接受价目 **`paygRates`**（已自 `price_plans` 移除；套外 **OOP** 仅 **Package → Roaming**）。
- 类型：`ONE_TIME | SIM_DEPENDENT_BUNDLE | FIXED_BUNDLE | TIERED_PRICING`
- 各类型专属字段与校验：
  - ONE_TIME：`oneTimeFee`、`quotaMb`、`validityDays`、`expiryBoundary`；可选 `coveredNetworkProfileId`（若该产品类型使用 in-profile 覆盖）
  - SIM_DEPENDENT_BUNDLE：`monthlyFee`、`deactivatedMonthlyFee`、`perSimQuotaMb`、`overageRatePerMb`；可选 `coveredNetworkProfileId`
  - FIXED_BUNDLE：`monthlyFee`、`deactivatedMonthlyFee`、`totalQuotaMb`、`overageRatePerMb`；**必填** **`coveredNetworkProfileId`**（**PUBLISHED** 的 **CoveredNetworkProfile**，见 OpenAPI）
  - TIERED_PRICING：`monthlyFee`、`deactivatedMonthlyFee`、`tiers[]`；可选 `coveredNetworkProfileId`（与 **paygRates** 并存时优先级见 spec / 批价实现）
- **OOP 声明位置**：**套外（out-of-profile）** 漫游单价 **仅** 来自 **Package → Carrier Service → `roamingProfileId` → Roaming Profile**；**Price Plan** 请求/响应 **MUST NOT** 携带用于 OOP 的 **`roamingProfileId`**（避免与 Carrier 双源不一致）。真源见下文 §4 与 [spec.md](../spec.md) **in-profile 与 out-of-profile**。

**Response 201**:
```json
{
  "pricePlanId": "uuid",
  "status": "DRAFT",
  "createdAt": "2026-02-08T10:00:00Z"
}
```

### 2.1 基于现有快照创建新草稿（Portal 推荐流程）

- 步骤1：`GET /v1/price-plans/{pricePlanId}` 拉取既有快照详情
- 步骤2：用户在页面编辑字段（前端按 `pricePlanType` 渲染并约束字段）
- 步骤3：对该企业调用 **`POST /v1/enterprises/{enterpriseId}/price-plans?resellerId=…`** 创建新草稿快照（**`enterpriseId` / `resellerId` 规则**与 **§2.0** 相同）

### 2.2 更新草稿快照

```
PUT /v1/price-plans/{pricePlanId}
```

**约束**:
- 仅允许更新 `DRAFT`
- **`price_plan_type` / `type` 不可变更**（与现有行一致）

**Response**：与 **创建** 分型对称的 **`PricePlanSnapshot`**（`oneOf` + `price_plan_type` discriminator），见 **`iot-cmp-api.yaml`**。

### 2.3 发布快照

```
POST /v1/price-plans/{pricePlanId}:publish
```

**前置**: `status=DRAFT`

### 2.4 废弃快照

```
POST /v1/price-plans/{pricePlanId}:deprecate
```

**前置**：当前状态为 **`PUBLISHED`**；且 **无** 产品包仍绑定该 `pricePlanId`（否则 **409** 等，与 OpenAPI 一致）。

### 2.5 查询

**列表（按企业，与 §2.0 同一 GET）**：

```
GET /v1/enterprises/{enterpriseId}/price-plans?resellerId={uuid}&type={type}&status={status}&page={}&pageSize={}
```

**详情（按 `pricePlanId`）**：

```
GET /v1/price-plans/{pricePlanId}
```

**List / Detail**：`items[]` 与 detail body 均为 **分型** 对象（**非**「宽表 + 满屏 null」）；字段集合与对应 **Create** 变体一致，并含 **`pricePlanId`、`status`、`createdAt`、`effectiveFrom`、`deprecatedAt`** 等公共元数据。详情路由 **不** 重复带 `enterpriseId`，归属与权限由服务端按 `pricePlanId` 与 token 校验。

---

## 3. Commercial Terms（快照）

### 3.1 创建草稿快照

```
POST /v1/commercial-terms
```

### 3.2 克隆为新草稿快照

```
POST /v1/commercial-terms:clone
```

### 3.3 更新草稿快照

```
PUT /v1/commercial-terms/{commercialTermsId}
```

### 3.4 发布快照

```
POST /v1/commercial-terms/{commercialTermsId}:publish
```

### 3.5 查询

```
GET /v1/commercial-terms?status={status}&page={}&pageSize={}
GET /v1/commercial-terms/{commercialTermsId}
```

---

## 4. Network Profiles 与 Carrier Service

**批价契约摘要（与 [spec.md](../spec.md) User Story 3、OpenAPI 一致）**：

- **in-profile**：话单/用量事件的拜访地 **(MCC,MNC)** 落入 **CoveredNetworkProfile** 所定义覆盖集时，适用本 **Price Plan** 的套内规则（配额、`overageRatePerMb` 等）。绑定链：**订阅 → `packageId` → `pricePlanId` → `coveredNetworkProfileId`**。
- **out-of-profile（OOP）**：未落入 Covered 时，套外规则 **必须** 与本次订阅所指向的 **`roamingProfileId`** 一致，且 **仅** 通过 **`Package` → `carrierServiceId` → Roaming Profile（及条目表）** 解析得到。**`price_plans` / Price Plan API** **不得** 再存或暴露用于 OOP 的 **`roamingProfileId`**。
- **产品形态**：同一客户多档 **Fixed Bundle**（如 30MB、50MB、100MB…）可对应多份 **`pricePlanId`**，若 **in-profile 覆盖相同**，**应共用** 同一条 **`coveredNetworkProfileId`**，仅在各资费快照上区分配额/月费等。

### 4.1 APN Profile（快照）

```
POST /v1/apn-profiles
POST /v1/apn-profiles:clone
PUT /v1/apn-profiles/{apnProfileId}
POST /v1/apn-profiles/{apnProfileId}:publish
GET /v1/apn-profiles?supplierId={}&operatorId={}&status={}&page={}&pageSize={}
GET /v1/apn-profiles/{apnProfileId}
```

### 4.2 CoveredNetworkProfile（快照）[V1.1]

**用途**：可复用的 **in-profile** **(MCC,MNC)** 覆盖目录；**无** 套外单价字段（单价在 **OOP** 路径由 **Roaming Profile** 条目表达）。

```
POST /v1/covered-network-profiles
GET /v1/covered-network-profiles?supplierId={}&operatorId={}&resellerId={}&status={}&page={}&pageSize={}
GET /v1/covered-network-profiles/{coveredNetworkProfileId}
PATCH /v1/covered-network-profiles/{coveredNetworkProfileId}
POST /v1/covered-network-profiles/{coveredNetworkProfileId}:publish
POST /v1/covered-network-profiles/{coveredNetworkProfileId}:deprecate
```

**Coverage 条目校验**（请求体 `coverage[]`）：

- `mcc`：**3** 位数字；`mnc`：**2～3** 位数字或 `*`
- 同一快照内 **`(mcc,mnc)`** 唯一；同一 `mcc-*` 通配规则与 Roaming 一致时可复用相同校验策略

**废弃**：**`POST :deprecate`** 仅当状态为 **`PUBLISHED`**；若仍有 **`price_plans`** 引用本 **`coveredNetworkProfileId`**，**409**，响应体应列出相关 **`pricePlanId`**（与 OpenAPI 示例一致）。

### 4.3 Roaming Profile（快照）

```
POST /v1/roaming-profiles
POST /v1/roaming-profiles:import-csv
GET /v1/roaming-profiles/{roamingProfileId}:export-csv
PUT /v1/roaming-profiles/{roamingProfileId}
POST /v1/roaming-profiles/{roamingProfileId}:publish
POST /v1/roaming-profiles/{roamingProfileId}:deprecate
GET /v1/roaming-profiles?supplierId={}&operatorId={}&status={}&page={}&pageSize={}
GET /v1/roaming-profiles/{roamingProfileId}
```

**修订已发布 Profile 的推荐流程**（**无** `:clone`）：

1. **`GET …:export-csv`** — 下载现有 `mccmncList` 为 CSV  
2. 本地编辑 CSV  
3. **`POST …:import-csv`** — 创建**新的** DRAFT 快照（新 `roamingProfileId`）  
4. **`POST …:publish`** — 发布新快照（次月生效）

**Roaming Entries 校验**:
- `mcc` 必填且为 3 位数字
- `mnc` 为 2~3 位数字或 `*`
- `ratePerMb` 必填，非负（OOP 批价真源）
- 可选 **`country`**（≤128 字符）、**`network`**（≤256 字符）：仅展示注解，持久化在 `mccmnc_list` JSONB，**不参与**匹配/计费
- 同一快照内 `mcc+mnc` 唯一
- 同一快照内同一 `mcc-*` 仅允许一条

**CSV 批量创建（`POST /v1/roaming-profiles:import-csv`）**:
- `multipart/form-data`：`name`、`supplierId`、`operatorId`、`file`（与 **POST /roaming-profiles** 元数据一致；**无** `resellerId`，归属同 APN：`supplier` + `operator`）
- CSV 列：`mcc`、`mnc`、`ratePerMb` 必填；`country`、`network` 可选；最多 10,000 行；含逗号的字段须引号包裹
- 成功 **201**，响应含 `roamingProfileId` 与 **`rowCount`**

**CSV 导出（`GET /v1/roaming-profiles/{roamingProfileId}:export-csv`）**:
- 成功 **200**，`Content-Type: text/csv`；列与 import 相同，可直接作为 import 的 `file` 输入（需另填 `name` 等 form 字段以创建新快照）

### 4.4 Carrier Service（引用 APN/Roaming 快照）

```
POST /v1/carrier-services
PUT /v1/carrier-services/{carrierServiceId}
GET /v1/carrier-services?supplierId={}&operatorId={}&status={}&page={}&pageSize={}
GET /v1/carrier-services/{carrierServiceId}
GET /v1/carrier-services?apnProfileId={apnProfileId}
GET /v1/carrier-services?roamingProfileId={roamingProfileId}
```

**反向查询返回字段**:
- `carrierServiceId`
- `supplierId`
- `operatorId`
- `status`
- `effectiveFrom`

---

## 5. Control Policy（快照）

```
POST /v1/control-policies
POST /v1/control-policies:clone
PUT /v1/control-policies/{controlPolicyId}
POST /v1/control-policies/{controlPolicyId}:publish
GET /v1/control-policies?status={status}&page={}&pageSize={}
GET /v1/control-policies/{controlPolicyId}
```

**`controlPolicy` JSON（请求/响应体中的快照正文）** 与 OpenAPI **`ControlPolicy`** schema 及真源 [clarifications/control-policy-module.md](../clarifications/control-policy-module.md)（Phase 29 **T205**）一致：

| 顶层 | 说明 |
|------|------|
| `enabled` | **必选** boolean，总开关 |
| `cutoff` | 可选；达量断网：`timeWindow`（`DAILY` \| `MONTHLY`）、`thresholdMb`、`action`（默认 `DEACTIVATED`） |
| `throttling` | 可选；达量限速：`timeWindow`、`tiers[]`（每档 `thresholdMb`、`downlinkKbps`、`uplinkKbps`，至少 1 档） |

**禁止** 根级旧键：`cutoffPolicyId`、`throttlingPolicyId`、`cutoffThresholdMb`（破坏性变更；服务层拒绝见 Phase 29 **T210**）。

**示例**（`enabled: true` 且 cutoff + throttling 同时配置）：

```json
{
  "enabled": true,
  "cutoff": {
    "timeWindow": "DAILY",
    "thresholdMb": 1024,
    "action": "DEACTIVATED"
  },
  "throttling": {
    "timeWindow": "MONTHLY",
    "tiers": [
      { "thresholdMb": 0, "downlinkKbps": 1000, "uplinkKbps": 1000 }
    ]
  }
}
```

资费侧 **Price Plan** 快照内嵌的 `controlPolicy`（若存在）**MUST** 使用同一形状，避免模块 API 与资费分叉。

---

## 6. Package（产品包）

### 6.1 创建产品包

```
POST /v1/enterprises/{enterpriseId}/packages
```

**Request Body**:
```json
{
  "name": "string (required)",
  "description": "string (optional)",
  "carrierServiceId": "uuid (required)",
  "pricePlanId": "uuid (required)",
  "commercialTermsId": "uuid (required)",
  "controlPolicyId": "uuid (required)"
}
```

**业务规则**:
- 产品包由四模块组成：`Carrier Service + Price Plan + Commercial Terms + Control Policy`
- 创建/更新时引用快照 ID，不允许引用未发布快照
- **连通性兼容（MUST）**：`pricePlanId`（经其 **CoveredNetworkProfile** 的 `supplierId`/`operatorId`）与 `carrierServiceId`（模块行上的 `supplier_id`/`operator_id`）**必须一致**；否则 **400**。`commercialTermsId` / `controlPolicyId` 仅要求与 Package 的 **reseller** 一致。
- 产品包变更次月生效
- 模块创建依赖顺序：
  1. APN Profile、Roaming Profile；若资费类型需要 **in-profile** 覆盖，则创建 **CoveredNetworkProfile** 并 **publish**
  2. Carrier Service（引用 APN/Roaming — **OOP** 真源）
  3. Control Policy、Commercial Terms、Price Plan（**FIXED_BUNDLE** 等须引用已发布 **`coveredNetworkProfileId`** 时，须在步骤 1 完成 Covered）
  4. Package

### 6.2 更新与发布

```
PUT /v1/packages/{packageId}
POST /v1/packages/{packageId}:publish
```

**`:publish` Request Body**（详见 [subscription-provisioning-upstream-mapping.md](../clarifications/subscription-provisioning-upstream-mapping.md)）:

```json
{
  "externalProductId": "string (required)",
  "provisioningParameters": "object (optional)"
}
```

| 字段 | 说明 |
|------|------|
| `externalProductId` | 上游供应商系统中的产品包 ID |
| `provisioningParameters` | 可选；写入 `vendor_product_mappings.provisioning_parameters` |

**服务端行为**:

- **`supplierId` MUST NOT 出现在请求体**；从 Package → `carrier_service_modules.supplier_id` **推导**并写入映射表
- 发布成功 **MUST** 原子创建 **`vendor_product_mappings`** 行（`UNIQUE(package_id)`）
- **`PUBLISHED` Package ⇔ 存在且仅存在一条映射**

**约束**:

- 仅 `DRAFT` 可更新
- 发布时执行既有四模块 `PUBLISHED` 校验及 PAYG 冲突校验（如有）
- 缺少 `externalProductId` → **400**

**`:publish` Response 200**（在既有 `PackagePublishResponse` 上扩展，以实现/OpenAPI 为准）:

```json
{
  "packageId": "uuid",
  "status": "PUBLISHED",
  "publishedAt": "2026-05-19T10:00:00Z",
  "externalProductId": "string",
  "mappingId": "uuid"
}
```

### 6.3 查询

```
GET /v1/enterprises/{enterpriseId}/packages?status={status}&page={}&pageSize={}
GET /v1/packages/{packageId}
GET /v1/packages?pricePlanId={pricePlanId}
GET /v1/packages?commercialTermsId={commercialTermsId}
GET /v1/packages?controlPolicyId={controlPolicyId}
```

### 6.3.1 列表与详情 — `PackageListItem` 草图（仅块名与键）

**列表**：`GET /v1/enterprises/{enterpriseId}/packages` → `items[]`。**详情**：`GET /v1/packages/{packageId}` → **同一条** **`PackageListItem`**（`PackageDetailResponse` = `PackageListItem`）。下列键名与块结构与 **`iot-cmp-api.yaml`** / **`packages/openapi/openapi.yaml`** 中 **`components/schemas`** 一致。叶节点用 `null` 仅占位，**不代表**可空性。

**真源**：OpenAPI schema；DB 表名见 [data-model.md](../data-model.md)。

---

**`PackageListResponse`**（`#/components/schemas/PackageListResponse`）

| 键 | 说明 |
|----|------|
| `items` | 数组，元素为 **`PackageListItem`** |
| `total` | 命中总数（与分页参数一致时） |

---

**`PackageListItem`**（`#/components/schemas/PackageListItem`）— 顶层含包行元数据（含 **`effectiveFrom` / `publishedAt` / `deprecatedAt` / `updatedAt`**）、**`moduleRef`**、以及各模块嵌入块（下表）。

`moduleRef` 内键的**稳定顺序**（与实现 JSON 序列化一致）：

```json
{
  "carrierServiceId": null,
  "apnProfileId": null,
  "roamingProfileId": null,
  "controlPolicyId": null,
  "commercialTermsId": null,
  "pricePlanId": null,
  "coveredNetworkProfileId": null
}
```

- **`apnProfileId` / `roamingProfileId`**：与 **`CarrierServiceConfig`** 内同名属性同源（Carrier 行 / 嵌套 `carrierServiceConfig`）；**不得** 与 **`CarrierServiceModuleResponse`** 内嵌配置矛盾。
- **`coveredNetworkProfileId`**：与 **`PricePlanReadCommon.coveredNetworkProfileId`** 同源；与 **`CoveredNetworkProfileListItem.coveredNetworkProfileId`** 一致。

---

**嵌入的 Carrier 行** — 形状用 **`CarrierServiceModuleResponse`**（`#/components/schemas/CarrierServiceModuleResponse`）：

`carrierServiceId` · `name` · `carrierServiceConfig`（`$ref` → **`CarrierServiceConfig`**，内含 `supplierId` / `operatorId`）· `resellerId` · `status` · `effectiveFrom` · `createdAt` · `updatedAt`

- **`rat`** 在 OpenAPI 中**不是** `CarrierServiceModuleResponse` 的并列顶层键，而位于 **`CarrierServiceConfig.rat`**（枚举 `4G` \| `3G` \| `5G` \| `NB-IoT`）；**`apnProfileId` / `roamingProfileId`** 亦在 **`CarrierServiceConfig`** 内。

---

**嵌入的 APN 摘要** — 形状用 **`ApnProfileListItem`**（`#/components/schemas/ApnProfileListItem`）：

`apnProfileId` · `name` · `apn` · `authType` · `supplierId` · `operatorId` · `status` · `publishedAt` · `effectiveFrom` · `sourceApnProfileId` · `createdAt` · `updatedAt`

---

**嵌入的 Roaming 摘要** — 包列表用 **`RoamingProfilePackageListSummary`**（`#/components/schemas/RoamingProfilePackageListSummary`），**不含** `mccmncList`（动辄数百行；完整条目见 `GET /v1/roaming-profiles/{roamingProfileId}` 或 `GET /v1/roaming-profiles` 列表项 **`RoamingProfileListItem`**）：

`roamingProfileId` · `name` · `status` · `publishedAt` · `effectiveFrom` · `createdAt` · `updatedAt`

（**列表**可省略 `mccmncList` 或截断，属 **`expand` / 详情** 策略，非新键名。）

---

**商业条款模块** — 形状用 **`CommercialTermsModuleResponse`**（`#/components/schemas/CommercialTermsModuleResponse`）：

`commercialTermsId` · `name` · `commercialTerms`（`$ref` → **`CommercialTerms`**：`testPeriodDays` · `testQuotaMb` · `testExpiryCondition` · `testExpiryAction` · `commitmentPeriodMonths` · `commitmentPeriodDays`）· `resellerId` · `status` · `effectiveFrom` · `publishedAt` · `deprecatedAt` · `createdAt` · `updatedAt`

---

**控制策略模块** — 形状用 **`ControlPolicyModuleResponse`**（`#/components/schemas/ControlPolicyModuleResponse`）；勿与按企业的计费表 `control_policies` 混淆：

`controlPolicyId` · `name` · `controlPolicy`（`$ref` → **`ControlPolicy`**：`enabled`；可选 `cutoff` → **`ControlPolicyCutoff`**；可选 `throttling` → **`ControlPolicyThrottling`** / **`ControlPolicyThrottlingTier`**）· `resellerId` · `status` · `effectiveFrom` · `publishedAt` · `deprecatedAt` · `createdAt` · `updatedAt`

---

**价目** — 与读写列表一致，**`oneOf` → `PricePlanSnapshot`**（`#/components/schemas/PricePlanSnapshot`），**判别元** **`price_plan_type`**，与 **`PricePlanReadCommon`**（`#/components/schemas/PricePlanReadCommon`）及四读分型 **`PricePlanReadOneTime`**、**`PricePlanReadSimDependentBundle`**、**`PricePlanReadFixedBundle`**、**`PricePlanReadTieredPricing`** 对齐（**`mapping`** 同 **`PricePlanCreateRequest`** 的 `discriminator`）。

**`PricePlanReadCommon` 公共键**：`pricePlanId` · `enterpriseId` · `resellerId` · `sourcePricePlanId` · `name` · `type`（**DB 枚举，如** `TIERED_VOLUME_PRICING`）· `price_plan_type`（**API 判别式**）· `serviceType` · `currency` · `status` · `createdAt` · `effectiveFrom` · `deprecatedAt` · `billingCycleType` · `firstCycleProration` · `prorationRounding` · `coveredNetworkProfileId`

**各 `price_plan_type` 在**同一**快照对象上多出的键（与对应 `PricePlanRead*` 一致，无额外嵌套包装名）**：

| `price_plan_type` | 附加键（OpenAPI 叶级名） |
|-------------------|------------------------|
| `ONE_TIME` | `oneTimeFee` · `quotaMb` · `validityDays` · `expiryBoundary`；与读分型一致时 **`type`** 枚举为 `ONE_TIME` |
| `SIM_DEPENDENT_BUNDLE` | `monthlyFee` · `deactivatedMonthlyFee` · `perSimQuotaMb` · `overageRatePerMb`（可空） |
| `FIXED_BUNDLE` | `monthlyFee` · `deactivatedMonthlyFee` · `totalQuotaMb` · `overageRatePerMb`（可空） |
| `TIERED_PRICING` | `monthlyFee` · `deactivatedMonthlyFee` · `tiers`（`items` → **`PricePlanTier`**: `fromMb` · `toMb` · `ratePerMb`）· `overageRatePerMb`（可空）；**`type`** 为 `TIERED_VOLUME_PRICING` |

---

**套内覆盖目录** — 形状用 **`CoveredNetworkProfileListItem`** 或详情 **`CoveredNetworkProfileDetailResponse`**（`#/components/schemas/...`）；条目数组在 OpenAPI 中名为 **`coverage`**（**不是** `entries`），元素 **`CoveredNetworkCoverageEntry`**：`mcc` · `mnc`

`CoveredNetworkProfileListItem` 还含：`coveredNetworkProfileId` · `name` · `resellerId` · `supplierId` · `operatorId` · `status` · `publishedAt` · `effectiveFrom` · `sourceCoveredNetworkProfileId` · `createdAt` · `updatedAt`

---

**历史对照**：旧版 HTTP 层曾返回内嵌产品包版本大对象。当前列表与 **GET 详情** 均已收敛为上述 **`PackageListItem` / `PackageDetailResponse`**；OpenAPI / contract **MUST NOT** 再暴露旧产品包版本 schema 名称。

---

**清单：重复与遗漏边界**

| 主题 | 约定 |
|------|------|
| **重复** | 避免 **`PackageListItem` 顶层** 与 **`PricePlanReadCommon`** 对 **`packageId` / `description` / `status`（包）** 与 **价目** 行语义混用。`serviceType` 以 **`PricePlanReadCommon.serviceType`** 为真源。 |
| **`supplierId` / `operatorId` / `apn`** | 与 **`CarrierServiceModuleResponse`**、**`ApnProfileListItem`** 及 data-model 读路径一致（[data-model — packages 已删列](../data-model.md)）。 |
| **嵌套名** | 统一 **`coverage`**；**Covered** 下无 **`entries`** 键名。 |
| **遗漏** | **`roamingProfile`** 为 **`RoamingProfilePackageListSummary`**，与目录 **`RoamingProfileListItem`**（含 `mccmncList`）不同。`carrierServiceConfig` 与 APN/Roaming 引用的 ID 须一致。 |
| **体积** | 全量 **MCC/MNC、Covered 条目、价目 tiers** 等可能很大；本契约在包列表/包详情中已嵌入**完整当前形态**；若未来需再瘦身，可另增 **`?fields=`** 等（未立项）。 |
| **空引用** | `CarrierServiceConfig` 内 **`apnProfileId` / `roamingProfileId`** 在 OpenAPI 中 **required**；若数据层可空，须先在 OpenAPI 将对应属性标 **`nullable`** 再服务实现。 |
| **命名** | 以 **`iot-cmp-api.yaml` `components/schemas`** 中 **propertyName** 为准；**`price_plan_type`** 为创建/读**判别**字段，**`type`** 为 **DB/生命周期** 侧类型枚举。 |

---

## 7. 订阅管理

### 7.1 创建订阅

```
POST /v1/subscriptions
```

**权限**: 代理商管理员 | 代理商销售

**Request Body**:
```json
{
  "iccid": "string (required, 18-20 digits)",
  "packageId": "uuid (required)",
  "kind": "MAIN | ADD_ON (optional; omit defaults to MAIN; empty or other values → 400)",
  "effectiveAt": "datetime (optional, default now)",
  "enterpriseId": "uuid (required)"
}
```

旧产品包版本字段已从当前订阅创建契约中废弃；请求体 **MUST** 使用 `packageId`。

**业务规则**:
- MAIN 订阅互斥：同一时间一张 SIM 仅 1 个 MAIN
- ADD_ON 不限数量
- 企业 SUSPENDED 时禁止创建
- SIM 状态为 RETIRED 时禁止创建
- Package **MUST** 为 `PUBLISHED` 且存在 **`vendor_product_mappings`**
- **`sim.supplierId` / `sim.operatorId` MUST** 与 Package → Carrier Service 一致
- **异步开通（MUST）**：受理后创建 **`SUBSCRIPTION_PROVISION` Job**；同步响应 **MUST NOT** 在无上游确认时返回 `ACTIVE`

**Response 202**（推荐；见 [subscription-provisioning-upstream-mapping.md](../clarifications/subscription-provisioning-upstream-mapping.md)）:

```json
{
  "subscriptionId": "uuid",
  "jobId": "uuid",
  "iccid": "string",
  "packageId": "uuid",
  "kind": "MAIN",
  "state": "PROVISIONING",
  "effectiveAt": "2026-02-08T10:00:00Z",
  "expiresAt": null,
  "commitmentEndAt": "2027-02-08T10:00:00Z"
}
```

- **立即生效**（`effectiveAt <= now`）：`state` = **`PROVISIONING`**
- **预约生效**（`effectiveAt > now`）：`state` = **`PENDING`**

**Worker 成功后**：`state` → **`ACTIVE`**；投递 **`SUBSCRIPTION_CHANGED`** + **`JOB_FINISHED`（SUCCEEDED）** 及 Webhook。

**Worker 失败后**：**删除** 本地 `subscriptions` 行；投递 **`JOB_FINISHED`（FAILED）** 及失败类订阅事件；**Webhook 通知下游客户系统**。

**Response 201**（兼容别名，语义同 202）: 同上字段。

**原同步 201 `ACTIVE` 响应**：**已废弃**于开通 Job 模式；实现 **MUST** 对齐 202 语义。

**Error Responses**:
| 状态码 | code | 说明 |
|--------|------|------|
| 409 | MAIN_SUBSCRIPTION_EXISTS | 已有主套餐，不可重复 |
| 409 | ENTERPRISE_SUSPENDED | 企业已暂停 |
| 409 | SIM_RETIRED | SIM 已拆机 |
| 409 | MISSING_SUPPLIER | SIM 未分配 supplier |
| 409 | PACKAGE_SUPPLIER_MISMATCH | SIM supplier 与 Package Carrier Service 不一致 |
| 409 | PACKAGE_OPERATOR_MISMATCH | SIM operator 与 Package Carrier Service 不一致 |
| 400 | BAD_REQUEST | `kind` 非 MAIN/ADD_ON（含空字符串） |
| 404 | SIM_NOT_FOUND | SIM 不存在 |
| 404 | PACKAGE_NOT_FOUND | 产品包不存在 |
| 409 | INVALID_STATUS | 产品包非 PUBLISHED（如 DRAFT、DEPRECATED），不可订阅 |
| 404 | VENDOR_PRODUCT_MAPPING_NOT_FOUND | 已发布 Package 无上游映射 |

### 7.2 按 ID 查询订阅

```
GET /v1/subscriptions/{subscriptionId}
```

**权限**: 平台管理员 | 代理商（销售/管理员）| 企业客户

**Query**（均可选）:

| 参数 | 说明 |
|------|------|
| `enterpriseId` | 可选。若提供，**MUST** 与该订阅行的 `enterpriseId` 一致，否则 **403**。不传时仅按 `subscriptionId` 加载并做 token 范围校验。 |

**路径**: `subscriptionId`（uuid）全局唯一，**不必**再传 `enterpriseId` 才能定位记录。

**范围校验**（加载后）:

| 角色 | 规则 |
|------|------|
| **Customer** | 订阅所属企业 **MUST** 与 JWT 企业一致 |
| **Reseller** | 订阅所属企业 **MUST** 在该 reseller 下属企业范围内 |
| **Platform** | 无额外企业限制 |

**Response 200**: 与 OpenAPI `Subscription` schema 一致（含 `enterpriseId`、`simId`、`iccid` 等）。

**Error Responses**:

| 状态码 | code | 说明 |
|--------|------|------|
| 400 | BAD_REQUEST | `subscriptionId` 非 uuid；或 query `enterpriseId` 非 uuid |
| 404 | SUBSCRIPTION_NOT_FOUND | 不存在 |
| 403 | FORBIDDEN | 越权；或 query `enterpriseId` 与订阅不一致 |
| 401 | UNAUTHORIZED | 客户 token 无效 |

---

### 7.3 套餐切换

```
POST /v1/subscriptions:switch
```

**权限**: 代理商管理员 | 代理商销售

**Query Parameters**:
| 参数 | 类型 | 说明 |
|------|------|------|
| batchId | string | 可选；幂等键。同一 `batchId` 已成功执行过 switch → **409 DUPLICATE_BATCH** |
| enterpriseId | uuid | admin key / 代理商必填；企业用户可省略（由 token 推导） |
| iccid | string | 必填，18–20 位 |
| fromSubscriptionId | uuid | 可选；省略时自动解析（优先 ACTIVE MAIN，否则 PENDING MAIN）；若提供则须为该 SIM 上可切换的 MAIN（ACTIVE 或 PENDING） |
| toPackageId | uuid | 必填，目标可售套餐 `packages.package_id` |
| effectiveStrategy | enum | `NEXT_CYCLE`（默认）或 `IMMEDIATE` |

（Swagger 以 query 参数展示；勿使用 JSON body。）

**业务规则**:
- 原子操作：**退订旧 MAIN** + **订购新 MAIN**（两步语义与单笔接口一致）
- **解析 from 订阅**（按 **iccid**，`fromSubscriptionId` 可省略）：
  - 省略时：**优先 ACTIVE MAIN**；若无 ACTIVE 则取 **PENDING MAIN**
  - 若两者共存（例如此前 `NEXT_CYCLE` switch 后旧 ACTIVE + 新 PENDING），默认 from = **ACTIVE**；若要切换 **PENDING** 那条，**MUST** 传 `fromSubscriptionId` 指向该 PENDING 订阅（此时 **IMMEDIATE** 在仍有 ACTIVE 时 **400**；应使用 **NEXT_CYCLE** 替换未来 PENDING）
  - 显式传 `fromSubscriptionId` 时：**MUST** 属于该 ICCID、**MAIN**、且 state 为 **ACTIVE** 或 **PENDING**
  - 无 ACTIVE / PENDING 可切换，且存在 **PROVISIONING MAIN** → **409** `SUBSCRIPTION_PROVISION_IN_PROGRESS`
  - 无 ACTIVE / PENDING 可切换（含仅 CANCELLED / EXPIRED 历史）→ **404** `SUBSCRIPTION_NOT_FOUND`
- **按旧订阅 state 与 effectiveStrategy**：

| 旧 MAIN state | `NEXT_CYCLE`（默认） | `IMMEDIATE` |
|---------------|----------------------|-------------|
| **ACTIVE** | ✅ 旧订阅登记 cancel schedule；新订阅 **PENDING** 次月 1 日 | ❌ **400**（与 cancel 一致，ACTIVE 不可立即切换） |
| **PENDING** | ✅ 旧 PENDING 立即 **CANCELLED**；新订阅 **PENDING** 次月 1 日 | ✅ 旧 PENDING 立即 **CANCELLED**；新订阅 **PROVISIONING** 立即开通（**仅当 SIM 无 ACTIVE MAIN**） |
| **PROVISIONING** | ❌ **409** `SUBSCRIPTION_PROVISION_IN_PROGRESS` | ❌ 同上 |
| **CANCELLED** | ❌ **409** `SUBSCRIPTION_ALREADY_CANCELLED` | ❌ 同上 |
| **EXPIRED** | ❌ **409** `SUBSCRIPTION_ALREADY_EXPIRED` | ❌ 同上 |

- **退订旧包**：内部等价于 `POST /v1/subscriptions/{subscriptionId}:cancel`（上表 ACTIVE / PENDING 分支与 cancel 一致）
- **订购新包**：内部等价于 `POST /v1/subscriptions`（`kind=MAIN`），并入队 **`SUBSCRIPTION_PROVISION`** Job（PENDING 未来生效时 Job 在生效前执行；PROVISIONING 立即开通）
- **toPackageId** 与 from 订阅的 **package_id** 相同 → **409**，`code` = **`SAME_TARGET_PACKAGE`**

**Response 200**:
```json
{
  "cancelledSubscriptionId": "uuid",
  "newSubscriptionId": "uuid",
  "jobId": "uuid",
  "effectiveAt": "2026-03-01T00:00:00Z",
  "scheduled": true,
  "scheduledExecuteAt": "2026-03-01T00:00:00Z",
  "message": "Cancel scheduled at end of billing period.",
  "batchId": "batch-2026-05-27-001"
}
```

（`scheduled` / `scheduledExecuteAt` / `message` 在旧 ACTIVE 次月退订时出现；`jobId` 为新订阅开通 Job；`batchId` 仅在请求提供时出现。）

**Response 409**（重复 batchId）:
```json
{
  "code": "DUPLICATE_BATCH",
  "message": "Duplicate batch switch request."
}
```

**Response 409**（不可切换的 from 状态）:
| code | 说明 |
|------|------|
| `SUBSCRIPTION_PROVISION_IN_PROGRESS` | from 为 PROVISIONING，或 SIM 仅有 PROVISIONING MAIN |
| `SUBSCRIPTION_ALREADY_CANCELLED` | from 为 CANCELLED |
| `SUBSCRIPTION_ALREADY_EXPIRED` | from 为 EXPIRED |
| `SAME_TARGET_PACKAGE` | `toPackageId` 与 from 套餐相同 |

### 7.4 退订

```
POST /v1/subscriptions/{subscriptionId}:cancel
```

**权限**: 代理商管理员 | 代理商销售

**Query Parameters**:
| 参数 | 类型 | 说明 |
|------|------|------|
| batchId | string | 可选；幂等键。同一 `batchId` 已成功执行过 cancel → **409 DUPLICATE_BATCH** |
| enterpriseId | uuid | 企业范围；admin key / 代理商必填；企业用户可省略（由 token 推导） |
| immediate | boolean | 可选。ACTIVE：false 或省略=到期退订；PENDING：省略也按立即退订处理 |

**业务规则**:
- **PROVISIONING（上游开通中）**：**MUST** 拒绝退订（`immediate` 任意值均无效）。返回 **409**，`code` = **`SUBSCRIPTION_PROVISION_IN_PROGRESS`**，`message` 说明当前仍有 **`SUBSCRIPTION_PROVISION`** 异步任务未完成，需等待开通成功或失败后再操作。
- **CANCELLED（已取消）**：**MUST** 拒绝重复退订。返回 **409**，`code` = **`SUBSCRIPTION_ALREADY_CANCELLED`**。
- **EXPIRED（已到期）**：**MUST** 拒绝退订。返回 **409**，`code` = **`SUBSCRIPTION_ALREADY_EXPIRED`**。
- **PENDING（未生效）**：始终立即取消，state → CANCELLED（即使 `immediate` 省略）
- **ACTIVE（已生效）**：不可立即取消；`immediate=false` 或省略时，取消请求插入队列，由定时任务在到期时执行
  - MAIN：到期时间 = 本计费周期末（自然月末）
  - ADD_ON：到期时间 = expires_at（若无则按本计费周期末）
- 月内取消：当月仍按全额月租计费，配额保留至月底

**Response 409**（开通任务进行中）:
```json
{
  "code": "SUBSCRIPTION_PROVISION_IN_PROGRESS",
  "message": "Cannot cancel this subscription: a SUBSCRIPTION_PROVISION task is still in progress. Wait for provisioning to complete or fail, then retry."
}
```

**Response 409**（已取消，不可重复退订）:
```json
{
  "code": "SUBSCRIPTION_ALREADY_CANCELLED",
  "message": "Subscription is already cancelled."
}
```

**Response 409**（重复 batchId）:
```json
{
  "code": "DUPLICATE_BATCH",
  "message": "Duplicate batch cancel request."
}
```

**Response 200** 在请求带 `batchId` 时回显 `batchId` 字段。

### 7.5 查询 SIM 订阅历史

```
GET /v1/sims/{simId}/subscriptions?state={}&kind={}&page={}&pageSize={}
```

**权限**: 按租户范围隔离

**Response 200**:
```json
{
  "items": [
    {
      "subscriptionId": "uuid",
      "packageId": "uuid",
      "packageName": "string",
      "kind": "MAIN",
      "state": "ACTIVE",
      "effectiveAt": "2026-01-01T00:00:00Z",
      "expiresAt": null,
      "cancelledAt": null,
      "firstSubscribedAt": "2026-01-01T00:00:00Z",
      "commitmentEndAt": "2027-01-01T00:00:00Z"
    }
  ],
  "total": 3
}
```

### 7.6 高级检索（推荐 enterprise user 使用）

```
GET /v1/subscriptions:search
```

**权限**: 平台管理员 | 代理商管理员 | 代理商销售 | 代理商销售总监 | 企业管理员 | 企业运维

**说明**:
- 分页单位为**订阅行**（非 SIM）
- 过滤逻辑对齐 `GET /v1/sims` 的租户/范围校验思路
- `state` 与数据库 `subscriptions.state` 保持一致
- 保留 `kind` 过滤（`MAIN` / `ADD_ON`）

**Query Parameters**:
| 参数 | 类型 | 说明 |
|------|------|------|
| enterpriseId | uuid | 平台/代理商可选；企业用户可选（不传则使用 token enterprise） |
| departmentId | uuid | 可选；要求同时给 `enterpriseId` |
| resellerId | uuid | 可选；代理商 token 下若传入必须与 token 一致；企业用户不可传 |
| iccid | string | ICCID 前缀检索（1-19）或 20 位精确匹配（同 `GET /v1/sims`） |
| imsi | string | 精确匹配 `sims.primary_imsi` |
| state | enum | `PENDING | PROVISIONING | ACTIVE | CANCELLED | EXPIRED` |
| kind | enum | `MAIN | ADD_ON` |
| supplierId | uuid | 按供应商过滤 |
| operatorId | uuid | 按运营商过滤（支持 operator uuid / business operator uuid 解析） |
| packageId | uuid | 按 `subscriptions.package_id` 过滤 |
| page | int | 默认 1 |
| pageSize | int | 默认 20，范围 1~100 |

**Response 200**:
```json
{
  "items": [
    {
      "subscriptionId": "uuid",
      "enterpriseId": "uuid",
      "simId": "uuid",
      "iccid": "string",
      "kind": "MAIN",
      "packageId": "uuid",
      "packageName": "string",
      "state": "ACTIVE",
      "effectiveAt": "2026-01-01T00:00:00Z",
      "expiresAt": null,
      "cancelledAt": null,
      "firstSubscribedAt": "2026-01-01T00:00:00Z",
      "commitmentEndAt": "2027-01-01T00:00:00Z"
    }
  ],
  "total": 3,
  "page": 1,
  "pageSize": 20
}
```

**Error Responses**:
| 状态码 | code | 说明 |
|--------|------|------|
| 400 | BAD_REQUEST | 参数格式非法或参数组合非法 |
| 404 | RESOURCE_NOT_FOUND | `enterpriseId` / `departmentId` / `supplierId` / `operatorId` 不存在 |
| 401 | UNAUTHORIZED | 未认证 |
| 403 | FORBIDDEN | 越权（如 `enterpriseId` 与 token 不匹配、`resellerId` 不匹配、`departmentId`/`supplierId`/`operatorId` 超出企业/代理商范围） |

### 7.7 企业精简订阅列表（兼容保留，不推荐）

```
GET /v1/enterprises/{enterpriseId}/subscriptions
```

**权限**: 企业管理员 | 企业运维（以及具备企业范围代查权限的平台/代理商角色）

**说明**:
- 分页单位为**订阅行**
- 返回字段为精简版，避免渠道商业信息泄露
- 不支持 `resellerId` / `supplierId` / `operatorId` 过滤
- 该路径当前为**兼容保留**；对 enterprise user 的主推荐入口为 `GET /v1/subscriptions:search`
- OpenAPI/Swagger 可不展示该路径，但实现代码保留

**Query Parameters**:
| 参数 | 类型 | 说明 |
|------|------|------|
| departmentId | uuid | 可选 |
| iccid | string | ICCID 前缀检索（1-19）或 20 位精确匹配 |
| imsi | string | 精确匹配 `sims.primary_imsi` |
| state | enum | `PENDING | PROVISIONING | ACTIVE | CANCELLED | EXPIRED` |
| kind | enum | `MAIN | ADD_ON` |
| packageId | uuid | 按 `subscriptions.package_id` 过滤 |
| page | int | 默认 1 |
| pageSize | int | 默认 20，范围 1~100 |

**Response 200**:
```json
{
  "items": [
    {
      "subscriptionId": "uuid",
      "iccid": "string",
      "kind": "MAIN",
      "packageId": "uuid",
      "packageName": "string",
      "state": "ACTIVE",
      "effectiveAt": "2026-01-01T00:00:00Z",
      "expiresAt": null,
      "cancelledAt": null,
      "firstSubscribedAt": "2026-01-01T00:00:00Z",
      "commitmentEndAt": "2027-01-01T00:00:00Z"
    }
  ],
  "total": 3,
  "page": 1,
  "pageSize": 20
}
```

**Error Responses**:
| 状态码 | code | 说明 |
|--------|------|------|
| 400 | BAD_REQUEST | 参数非法 |
| 401 | UNAUTHORIZED | 未认证 |
| 403 | FORBIDDEN | `enterpriseId` 超出租户范围 |

### 7.8 订阅导出（CSV）

```
POST /v1/subscriptions:batch-export
```

**定位**：按筛选条件导出订阅为 CSV。  
**实现要求**：筛选参数与权限/作用域逻辑 **MUST** 与 `GET /v1/subscriptions:search` 一致，仅输出形态改为 CSV 文件。

**权限**: 平台管理员 | 代理商管理员 | 代理商销售 | 代理商销售总监 | 企业管理员 | 企业运维

**Request Body（application/json，可空）**:

| 参数 | 类型 | 说明 |
|------|------|------|
| enterpriseId | uuid | 可选；enterprise user 不传则使用 token enterprise |
| departmentId | uuid | 可选 |
| resellerId | uuid | 可选；代理商 token 下若传入必须与 token 一致；enterprise user 不可传 |
| iccid | string | ICCID 前缀检索（1-19）或 20 位精确匹配 |
| imsi | string | 精确匹配 `sims.primary_imsi` |
| state | enum | `PENDING | PROVISIONING | ACTIVE | CANCELLED | EXPIRED` |
| kind | enum | `MAIN | ADD_ON` |
| supplierId | uuid | 按供应商过滤（含存在性与作用域校验） |
| operatorId | uuid | 按运营商过滤（支持 operator uuid / business operator uuid；含存在性与作用域校验） |
| packageId | uuid | 按 `subscriptions.package_id` 过滤 |
| batchId | string | **必填**；幂等键。同一 `batchId` 已成功执行过 export → **409 DUPLICATE_BATCH** |
| page | int | 默认 1 |
| pageSize | int | 默认 **100**，范围 1~**1000**（与 `GET /subscriptions:search` 的默认 20 / 上限 100 不同） |

**Response 200**:
- `Content-Type: text/csv; charset=utf-8`
- `Content-Disposition: attachment; filename="subscriptions-export-*.csv"`
- CSV 列（当前实现）：
  - `subscriptionId, enterpriseId, simId, iccid, kind, packageId, packageName, state, effectiveAt, expiresAt, cancelledAt, firstSubscribedAt, commitmentEndAt`

**Error Responses**:
| 状态码 | code | 说明 |
|--------|------|------|
| 400 | BAD_REQUEST | 参数格式非法或参数组合非法 |
| 401 | UNAUTHORIZED | 未认证 |
| 403 | FORBIDDEN | 越权（如 `resellerId` 不匹配、enterprise user 传 `resellerId`、过滤条件超出租户范围） |
| 404 | RESOURCE_NOT_FOUND | `enterpriseId` / `departmentId` / `supplierId` / `operatorId` 不存在 |
| 409 | DUPLICATE_BATCH | 重复的 `batchId` |

---

## 8. PAYG 匹配优先级规则

```
1. MCC+MNC 精确匹配（如 "208-01"） → 最高优先
2. MCC 通配匹配（如 "208-*"）       → 次优先
3. 无匹配                           → 阻断或高价告警
```

**冲突校验**（发布阶段）:
- 同一 visitedMccMnc 被多个同级规则覆盖 → 视为配置错误，阻断发布
- 不同级别（精确 vs 通配）→ 精确优先，不算冲突

## 9. 分段累进公式（Progressive Tiered）

```
totalCharge = Σ min(U - T[i-1], T[i] - T[i-1]) × R[i]

示例：tiers = [{0~1GB: 0.001}, {1GB~5GB: 0.0005}, {5GB+: 0.0002}]
用量 = 3GB

费用 = 1GB × 0.001 + 2GB × 0.0005 = 0.001 × 1048576 + 0.0005 × 2097152
```

## 10. 分摊算法（Daily Proration）

```
perDayFee = monthlyFee / daysInBillingMonth
activeDays = countDaysInclusive(startDay, endDay)
chargedMonthlyFee = round(perDayFee × activeDays, 2)
```
