# Waterfall 用量匹配算法规格 (T-NEW-2)

> **状态**: MVP 定稿 | **适用**: billing.js `computeMonthlyCharges()`

## 1. 输入

```
SIM: { sim_id, iccid, enterprise_id, status }
Subscriptions: [ { subscription_id, subscription_kind, package_version_id, effective_at, expires_at, state } ]
UsageRecord: { usage_day, visited_mccmnc, total_kb }
PackageDetailsMap: { [package_version_id]: { roaming_profile, resolved_price_plan_version } }
```

## 2. 算法流程 (伪代码)

```
function waterfallMatch(sim, subscriptions, usageRecord, packageDetailsMap):
  dayStart = usageRecord.usage_day 00:00:00 UTC
  dayEnd   = usageRecord.usage_day + 1 day 00:00:00 UTC

  # Step 1: 过滤时间窗口匹配的 subscriptions
  activeSubs = subscriptions.filter(sub =>
    sub.effective_at < dayEnd
    AND (sub.expires_at IS NULL OR sub.expires_at >= dayStart)
    AND sub.state IN ('ACTIVE', 'PENDING')
  )

  # Step 2: 按 kind 分组，ADD_ON 优先于 MAIN
  addOns = activeSubs.filter(kind == 'ADD_ON')
  mains  = activeSubs.filter(kind == 'MAIN')

  # Step 3: 对每组，按 roaming coverage specificity 排序
  function specificityScore(roamingProfile):
    if roamingProfile is NULL: return 999999
    if roamingProfile.type == 'GLOBAL': return 999999
    if roamingProfile.type == 'MCCMNC_ALLOWLIST':
      return roamingProfile.mccmnc.length  # 越少=越精确
    return 999999

  # Step 4: 在每组内找第一个覆盖 visited_mccmnc 的 subscription
  for group in [addOns, mains]:
    candidates = []
    for sub in group:
      pkg = packageDetailsMap[sub.package_version_id]
      if coverageIncludes(pkg.roaming_profile, usageRecord.visited_mccmnc):
        candidates.push({ sub, pkg, score: specificityScore(pkg.roaming_profile) })

    if candidates.length > 0:
      # 按 specificity 升序（越小越精确），同分按 package_version_id 字典序
      candidates.sort(by score ASC, then by package_version_id ASC)
      return candidates[0]  # 命中

  # Step 5: 无匹配 → PAYG fallback
  mainSub = mains[0] or activeSubs.find(kind == 'MAIN')
  mainPkg = packageDetailsMap[mainSub?.package_version_id]

  if mainPkg has payg_rates:
    rate = resolvePaygRatePerMb(mainPkg, usageRecord.visited_mccmnc)
    if rate is not null:
      return { classification: 'PAYG', rate_per_mb: rate }

  # Step 6: 无 PAYG rate → 标记告警，不计费
  return { classification: 'PAYG_RULE_MISSING', rate_per_mb: null, amount: 0 }
```

## 3. PAYG Zone 匹配规则 (specificity)

```
优先级（高→低）:
  1. 精确 MCC+MNC 匹配 (e.g. "234-15")     → score: 3
  2. MCC 通配符匹配    (e.g. "234-*")       → score: 2
  3. 全局通配符         (e.g. "*")           → score: 1

相同 score 取第一个匹配的 zone（按 zone name 字典序）。
```

## 4. 套餐内/超额判定

```
function classifyUsage(match, usageRecord, poolState):
  pkg = match.pkg
  planVersion = pkg.resolved_price_plan_version
  planType = planVersion.type

  if planType == 'ONE_TIME':
    # ONE_TIME: 固定费用，用量不计超额（quota_mb 为总配额）
    quotaMb = planVersion.quota_mb
    if quotaMb is NULL: return 'IN_PACKAGE'
    usedMb = poolState.getUsed(match.sub.subscription_id)
    if usedMb + usageRecord.total_mb <= quotaMb:
      return 'IN_PACKAGE'
    else:
      overMb = (usedMb + usageRecord.total_mb) - quotaMb
      return 'OVERAGE', amount = roundAmount(overMb * planVersion.overage_rate_per_mb)

  if planType == 'FIXED_BUNDLE':
    # FIXED_BUNDLE: 全局池配额
    totalQuotaMb = planVersion.total_quota_mb
    usedMb = poolState.getPoolUsed(match.pkg.package_version_id)
    remainingMb = max(0, totalQuotaMb - usedMb)
    overMb = max(0, usageRecord.total_mb - remainingMb)
    if overMb > 0:
      return 'OVERAGE', amount = roundAmount(overMb * planVersion.overage_rate_per_mb)
    return 'IN_PACKAGE'

  # SIM_DEPENDENT_BUNDLE / TIERED_VOLUME_PRICING: V1.1 scope
```

## 5. 决策树图

```
                    ┌──────────────────┐
                    │  Usage Record    │
                    │  (visited_mccmnc)│
                    └────────┬─────────┘
                             │
                    ┌────────▼─────────┐
                    │ Filter Active    │
                    │ Subscriptions    │
                    │ by time window   │
                    └────────┬─────────┘
                             │
                ┌────────────┴────────────┐
                │                         │
         ┌──────▼──────┐          ┌───────▼──────┐
         │  ADD_ON      │          │  MAIN        │
         │  candidates  │          │  candidates  │
         └──────┬──────┘          └───────┬──────┘
                │ (try first)             │ (if no ADD_ON match)
         ┌──────▼──────┐          ┌───────▼──────┐
         │ Coverage    │          │ Coverage     │
         │ match?      │          │ match?       │
         └──┬───┬──────┘          └──┬───┬───────┘
          Yes   No                 Yes   No
            │                        │     │
    ┌───────▼──────┐         ┌───────▼──┐  │
    │ Quota check  │         │ Quota    │  │
    │              │         │ check    │  │
    └──┬────┬──────┘         └──┬───┬───┘  │
     IN    OVERAGE            IN   OVER    │
    PKG                       PKG  AGE     │
                                    ┌──────▼──────┐
                                    │ PAYG rate   │
                                    │ lookup      │
                                    └──┬───┬──────┘
                                   Found  Not found
                                     │       │
                              ┌──────▼─┐  ┌──▼──────────┐
                              │ PAYG   │  │ PAYG_RULE   │
                              │ charge │  │ _MISSING    │
                              └────────┘  │ (no charge) │
                                          └─────────────┘
```

## 6. Golden Case 覆盖映射

| Case ID | 场景 | visited_mccmnc | 预期 classification | 预期 amount |
|---------|------|---------------|---------------------|------------|
| U-01 | Fixed Bundle 套餐内 | 234-15 | IN_PACKAGE | 0.00 |
| U-02 | Fixed Bundle 套餐内 (法国) | 208-01 | IN_PACKAGE | 0.00 |
| U-03 | Fixed Bundle 套餐内 (德国) | 262-02 | IN_PACKAGE | 0.00 |
| U-04 | Fixed Bundle 套餐内 (法国) | 208-01 | IN_PACKAGE | 0.00 |
| U-05 | PAYG fallback (沙特) | 424-02 | PAYG | 204.80 |
| U-06 | 无 PAYG 费率 (未知) | 999-99 | PAYG_RULE_MISSING | 0.00 |
| U-07 | Fixed Bundle 超额 | 234-15 | OVERAGE | 102.40 |
| U-08 | PAYG fallback (沙特) | 424-02 | PAYG | 204.80 |

## 7. 舍入策略

- **策略**: ROUND_HALF_UP (四舍五入)
- **精度**: 2 位小数 (最小货币单位: 分)
- **中间值**: `rating_results.amount` 保留完整计算精度
- **最终值**: `bill_line_items.amount` 舍入后存储
- **汇总**: `bill.total_amount = SUM(bill_line_items.amount)`，不对 rating_results 再次舍入
- **实现**: `roundAmount()` 函数，定义在 `src/billing.js` 头部

## 8. Edge Cases

1. **同一天多条用量记录 (不同 mccmnc)**: 每条独立走 waterfall，池配额按累计扣减
2. **SIM 当天未激活**: `isSimActivatedAt()` 返回 false → 直接走 PAYG (标记 PAYG_INACTIVE)
3. **MAIN + ADD_ON 时间窗重叠**: ADD_ON 总是优先匹配
4. **相同 specificity 的多个候选**: 按 `package_version_id` 字典序取第一个 (确定性)
5. **quota 跨天耗尽**: 前半天 IN_PACKAGE，后半天 OVERAGE (按日聚合，同一天不拆分)
