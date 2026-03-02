# API 契约：产品包与资费计划

**Feature**: `iot-cmp-reseller` | **Date**: 2026-02-08
**关联 User Story**: US3（产品包与资费计划配置）、US4（订阅关系管理）
**关联需求**: FR-015 ~ FR-022

---

## 1. 资费计划（Price Plan）

### 1.1 创建资费计划

```
POST /v1/enterprises/{enterpriseId}/price-plans
```

**权限**: 代理商管理员

**Request Body**:
```json
{
  "name": "string (required)",
  "type": "ONE_TIME | SIM_DEPENDENT_BUNDLE | FIXED_BUNDLE | TIERED_VOLUME_PRICING",
  "serviceType": "DATA | VOICE | SMS",
  "currency": "string (inherited from reseller, read-only)",
  "billingCycleType": "CALENDAR_MONTH | CUSTOM_RANGE",
  "firstCycleProration": "NONE | DAILY_PRORATION",
  "prorationRounding": "ROUND_HALF_UP (default)",

  "oneTimeFee": "number (ONE_TIME only, >= 0)",
  "quotaKb": "integer (ONE_TIME only, >= 0)",
  "validityDays": "integer (ONE_TIME only, > 0)",
  "expiryBoundary": "CALENDAR_DAY_END | DURATION_EXCLUSIVE_END",

  "monthlyFee": "number (recurring types, >= 0)",
  "deactivatedMonthlyFee": "number (recurring types, >= 0, < monthlyFee)",
  "perSimQuotaKb": "integer (SIM_DEPENDENT_BUNDLE only, >= 0)",
  "totalQuotaKb": "integer (FIXED_BUNDLE only, >= 0)",
  "overageRatePerKb": "number (BUNDLE types, >= 0)",

  "tiers": [
    {
      "fromKb": 0,
      "toKb": 1073741824,
      "ratePerKb": 0.001
    }
  ],

  "paygRates": [
    {
      "zoneCode": "string",
      "countries": ["460-00", "460-*"],
      "ratePerKb": 0.002
    }
  ],

  "commercialTerms": {
    "testPeriodDays": "integer (optional)",
    "testQuotaKb": "integer (optional)",
    "testExpiryCondition": "PERIOD_ONLY | QUOTA_ONLY | PERIOD_OR_QUOTA",
    "commitmentPeriodMonths": "integer (optional)"
  },

  "controlPolicy": {
    "enabled": true,
    "throttlingPolicyId": "uuid (optional)",
    "cutoffThresholdKb": "integer (optional, 达量断网阈值)"
  }
}
```

**字段校验规则**:
| 类型 | 必填字段 | 可选字段 |
|------|---------|---------|
| ONE_TIME | oneTimeFee, quotaKb, validityDays, expiryBoundary | paygRates |
| SIM_DEPENDENT_BUNDLE | monthlyFee, deactivatedMonthlyFee, perSimQuotaKb | overageRatePerKb, paygRates |
| FIXED_BUNDLE | monthlyFee, deactivatedMonthlyFee, totalQuotaKb | overageRatePerKb, paygRates |
| TIERED_VOLUME_PRICING | monthlyFee, deactivatedMonthlyFee, tiers[] | paygRates |

**Response 201**:
```json
{
  "pricePlanId": "uuid",
  "pricePlanVersionId": "uuid",
  "version": 1,
  "status": "DRAFT",
  "createdAt": "2026-02-08T10:00:00Z"
}
```

### 1.2 查询资费计划

```
GET /v1/enterprises/{enterpriseId}/price-plans?type={type}&status={status}&page={}&pageSize={}
```

### 1.3 查询资费计划详情

```
GET /v1/price-plans/{pricePlanId}
```

**Response 200**: 完整资费计划信息 + 当前生效版本 + 历史版本列表

### 1.4 创建新版本

```
POST /v1/price-plans/{pricePlanId}/versions
```

**权限**: 代理商管理员
**说明**: 修改已发布的资费计划需创建新版本（DRAFT），不可修改已发布版本

---

## 2. 产品包（Package）

### 2.1 创建产品包

```
POST /v1/enterprises/{enterpriseId}/packages
```

**权限**: 代理商管理员

**Request Body**:
```json
{
  "name": "string (required)",
  "description": "string (optional)",
  "pricePlanVersionId": "uuid (required, 必须绑定一个 Price Plan Version)",
  "carrierServiceConfig": {
    "supplierId": "uuid (required)",
    "carrierId": "uuid (optional)",
    "rat": "4G (default) | 3G | 5G | NB-IoT",
    "apn": "string (required)",
    "apnProfileVersionId": "uuid (optional)",
    "roamingProfileVersionId": "uuid (optional)",
    "roamingProfile": {
      "allowedMccMnc": ["208-01", "262-*"]
    }
  }
}
```

**业务规则**:
- 产品包必须绑定且仅绑定一个 Price Plan
- 产品包变更次月生效

**Response 201**:
```json
{
  "packageId": "uuid",
  "packageVersionId": "uuid",
  "version": 1,
  "status": "DRAFT",
  "createdAt": "2026-02-08T10:00:00Z"
}
```

### 2.2 修改产品包

```
PUT /v1/packages/{packageId}
```

**权限**: 代理商管理员
**说明**: 仅 DRAFT 状态可修改

### 2.3 发布产品包

```
POST /v1/packages/{packageId}:publish
```

**权限**: 代理商管理员
**前置**: DRAFT 状态
**校验**: PAYG Rates 冲突校验（同级冲突视为配置错误，阻断发布）

**Response 200**:
```json
{
  "packageId": "uuid",
  "packageVersionId": "uuid",
  "status": "PUBLISHED",
  "publishedAt": "2026-02-08T10:00:00Z"
}
```

### 2.4 查询产品包

```
GET /v1/enterprises/{enterpriseId}/packages?status={}&page={}&pageSize={}
```

### 2.5 查询产品包详情

```
GET /v1/packages/{packageId}
```

---

## 3. 网络 Profile

### 3.1 创建 APN Profile

```
POST /v1/apn-profiles
```

**权限**: 代理商管理员

**Request Body**:
```json
{
  "name": "string (required)",
  "apn": "string (required)",
  "authType": "NONE | PAP | CHAP",
  "username": "string (optional)",
  "passwordRef": "string (optional)",
  "supplierId": "uuid (required)",
  "carrierId": "uuid (optional)"
}
```

**Response 201**:
```json
{
  "apnProfileId": "uuid",
  "profileVersionId": "uuid",
  "version": 1,
  "status": "DRAFT",
  "createdAt": "2026-02-08T10:00:00Z"
}
```

### 3.2 创建 Roaming Profile

```
POST /v1/roaming-profiles
```

**权限**: 代理商管理员

**Request Body**:
```json
{
  "name": "string (required)",
  "mccmncList": ["460-00", "460-*"],
  "supplierId": "uuid (required)",
  "carrierId": "uuid (optional)"
}
```

**Response 201**:
```json
{
  "roamingProfileId": "uuid",
  "profileVersionId": "uuid",
  "version": 1,
  "status": "DRAFT",
  "createdAt": "2026-02-08T10:00:00Z"
}
```

### 3.3 查询 APN Profile

```
GET /v1/apn-profiles?supplierId={}&carrierId={}&status={}&page={}&pageSize={}
```

### 3.4 查询 Roaming Profile

```
GET /v1/roaming-profiles?supplierId={}&carrierId={}&status={}&page={}&pageSize={}
```

### 3.5 查询 APN Profile 详情

```
GET /v1/apn-profiles/{apnProfileId}
```

### 3.6 查询 Roaming Profile 详情

```
GET /v1/roaming-profiles/{roamingProfileId}
```

### 3.7 创建 APN Profile 新版本

```
POST /v1/apn-profiles/{apnProfileId}/versions
```

### 3.8 创建 Roaming Profile 新版本

```
POST /v1/roaming-profiles/{roamingProfileId}/versions
```

### 3.9 发布 APN Profile（次月生效）

```
POST /v1/apn-profiles/{apnProfileId}:publish
```

### 3.10 发布 Roaming Profile（次月生效）

```
POST /v1/roaming-profiles/{roamingProfileId}:publish
```

### 3.11 回滚已排期版本

```
POST /v1/profile-versions/{profileVersionId}:rollback
```

**说明**: 仅允许回滚未来生效的已发布版本

---

## 4. 订阅管理

### 3.1 创建订阅

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

### 3.2 套餐切换

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

### 3.3 退订

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

### 3.4 查询 SIM 订阅历史

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
