# API 契约：产品包与资费计划

**Feature**: `iot-cmp-reseller` | **Date**: 2026-02-08
**关联 User Story**: US3（产品包与资费计划配置）、US4（订阅关系管理）
**关联需求**: FR-015 ~ FR-022, FR-052 ~ FR-053

---

## 1. US3 模块统一规则（快照模型）

- APN Profile、Roaming Profile、Control Policy、Price Plan、Commercial Terms 采用不可变快照模型：每次编辑都创建新 ID，状态初始为 `DRAFT`
- 仅 `DRAFT` 可更新，`PUBLISHED`/`DEPRECATED` 只读
- 列表展示统一包含：`name + publishedAt + status`，名称允许重复
- 统一支持 `:clone` 接口，通过 `source*Id` 记录来源快照链路
- Package 引用的是模块快照 ID，不再使用 `*VersionId`

---

## 2. Price Plan（快照）

### 2.1 创建草稿快照

```
POST /v1/price-plans
```

**权限**: 代理商管理员

**Request Body（按 `pricePlanType` 分型）**:
- 公共字段：`name`、`pricePlanType`、`serviceType`、`currency`、`billingCycleType`、`firstCycleProration`、`prorationRounding`、`paygRates`
- 类型：`ONE_TIME | SIM_DEPENDENT_BUNDLE | FIXED_BUNDLE | TIERED_PRICING`
- 各类型专属字段与校验：
  - ONE_TIME：`oneTimeFee`、`quotaKb`、`validityDays`、`expiryBoundary`
  - SIM_DEPENDENT_BUNDLE：`monthlyFee`、`deactivatedMonthlyFee`、`perSimQuotaKb`、`overageRatePerKb`
  - FIXED_BUNDLE：`monthlyFee`、`deactivatedMonthlyFee`、`totalQuotaKb`、`overageRatePerKb`
  - TIERED_PRICING：`monthlyFee`、`deactivatedMonthlyFee`、`tiers[]`

**Response 201**:
```json
{
  "pricePlanId": "uuid",
  "status": "DRAFT",
  "createdAt": "2026-02-08T10:00:00Z"
}
```

### 2.2 克隆为新草稿快照

```
POST /v1/price-plans:clone
```

**Request Body**:
```json
{
  "sourcePricePlanId": "uuid (required)",
  "name": "string (optional)"
}
```

### 2.3 更新草稿快照

```
PUT /v1/price-plans/{pricePlanId}
```

**约束**:
- 仅允许更新 `DRAFT`
- `pricePlanType` 不可变更

### 2.4 发布快照

```
POST /v1/price-plans/{pricePlanId}:publish
```

**前置**: `status=DRAFT`

### 2.5 查询

```
GET /v1/price-plans?type={type}&status={status}&page={}&pageSize={}
GET /v1/price-plans/{pricePlanId}
```

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

### 4.1 APN Profile（快照）

```
POST /v1/apn-profiles
POST /v1/apn-profiles:clone
PUT /v1/apn-profiles/{apnProfileId}
POST /v1/apn-profiles/{apnProfileId}:publish
GET /v1/apn-profiles?supplierId={}&operatorId={}&status={}&page={}&pageSize={}
GET /v1/apn-profiles/{apnProfileId}
```

### 4.2 Roaming Profile（快照）

```
POST /v1/roaming-profiles
POST /v1/roaming-profiles:clone
PUT /v1/roaming-profiles/{roamingProfileId}
POST /v1/roaming-profiles/{roamingProfileId}:publish
GET /v1/roaming-profiles?supplierId={}&operatorId={}&status={}&page={}&pageSize={}
GET /v1/roaming-profiles/{roamingProfileId}
```

**Roaming Entries 校验**:
- `mcc` 必填且为 3 位数字
- `mnc` 为 2~3 位数字或 `*`
- 同一快照内 `mcc+mnc` 唯一
- 同一快照内同一 `mcc-*` 仅允许一条

### 4.3 Carrier Service（引用 APN/Roaming 快照）

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

**快照字段**:
- 开关：`enabled`
- 达量断网：`cutoffRules`
- 达量限速：`throttlingRules`

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
- 产品包变更次月生效
- 模块创建依赖顺序：
  1. APN Profile、Roaming Profile
  2. Carrier Service（引用 APN/Roaming）
  3. Control Policy、Commercial Terms、Price Plan
  4. Package

### 6.2 更新与发布

```
PUT /v1/packages/{packageId}
POST /v1/packages/{packageId}:publish
```

**约束**:
- 仅 `DRAFT` 可更新
- 发布时执行 PAYG 冲突校验

### 6.3 查询

```
GET /v1/enterprises/{enterpriseId}/packages?status={status}&page={}&pageSize={}
GET /v1/packages/{packageId}
GET /v1/packages?pricePlanId={pricePlanId}
GET /v1/packages?commercialTermsId={commercialTermsId}
GET /v1/packages?controlPolicyId={controlPolicyId}
```

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
  "packageVersionId": "uuid (required)",
  "kind": "MAIN | ADD_ON (default MAIN)",
  "effectiveAt": "datetime (optional, default now)",
  "enterpriseId": "uuid (required)"
}
```

**业务规则**:
- MAIN 订阅互斥：同一时间一张 SIM 仅 1 个 MAIN
- ADD_ON 不限数量
- 企业 SUSPENDED 时禁止创建
- SIM 状态为 RETIRED 时禁止创建

**Response 201**:
```json
{
  "subscriptionId": "uuid",
  "iccid": "string",
  "packageVersionId": "uuid",
  "kind": "MAIN",
  "state": "ACTIVE",
  "effectiveAt": "2026-02-08T10:00:00Z",
  "expiresAt": null,
  "commitmentEndAt": "2027-02-08T10:00:00Z",
  "createdAt": "2026-02-08T10:00:00Z"
}
```

**Error Responses**:
| 状态码 | code | 说明 |
|--------|------|------|
| 409 | MAIN_SUBSCRIPTION_EXISTS | 已有主套餐，不可重复 |
| 409 | ENTERPRISE_SUSPENDED | 企业已暂停 |
| 409 | SIM_RETIRED | SIM 已拆机 |
| 404 | SIM_NOT_FOUND | SIM 不存在 |
| 404 | PACKAGE_NOT_FOUND | 产品包不存在或未发布 |

### 7.2 套餐切换

```
POST /v1/subscriptions:switch
```

**权限**: 代理商管理员 | 代理商销售

**Request Body**:
```json
{
  "iccid": "string (required)",
  "newPackageVersionId": "uuid (required)",
  "effectiveStrategy": "NEXT_CYCLE (default) | IMMEDIATE"
}
```

**业务规则**:
- 原子操作：退订旧 + 订购新
- 默认次月生效（NEXT_CYCLE）
- 当月不退费，旧套餐服务至月底

**Response 200**:
```json
{
  "cancelledSubscriptionId": "uuid",
  "newSubscriptionId": "uuid",
  "effectiveAt": "2026-03-01T00:00:00Z"
}
```

### 7.3 退订

```
POST /v1/subscriptions/{subscriptionId}:cancel
```

**权限**: 代理商管理员 | 代理商销售

**Query Parameters**:
| 参数 | 类型 | 说明 |
|------|------|------|
| immediate | boolean | true=立即退订（需二次确认），false=到期退订（默认） |

**业务规则**:
- 到期退订（默认）：服务至月底，ACTIVE → EXPIRED
- 立即退订：当月月租不退费，ACTIVE → CANCELLED
- 月内取消：当月仍按全额月租计费，配额保留至月底

### 7.4 查询 SIM 订阅历史

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
      "packageVersionId": "uuid",
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

---

## 5. PAYG 匹配优先级规则

```
1. MCC+MNC 精确匹配（如 "208-01"） → 最高优先
2. MCC 通配匹配（如 "208-*"）       → 次优先
3. 无匹配                           → 阻断或高价告警
```

**冲突校验**（发布阶段）:
- 同一 visitedMccMnc 被多个同级规则覆盖 → 视为配置错误，阻断发布
- 不同级别（精确 vs 通配）→ 精确优先，不算冲突

## 6. 分段累进公式（Progressive Tiered）

```
totalCharge = Σ min(U - T[i-1], T[i] - T[i-1]) × R[i]

示例：tiers = [{0~1GB: 0.001}, {1GB~5GB: 0.0005}, {5GB+: 0.0002}]
用量 = 3GB

费用 = 1GB × 0.001 + 2GB × 0.0005 = 0.001 × 1048576 + 0.0005 × 2097152
```

## 7. 分摊算法（Daily Proration）

```
perDayFee = monthlyFee / daysInBillingMonth
activeDays = countDaysInclusive(startDay, endDay)
chargedMonthlyFee = round(perDayFee × activeDays, 2)
```
