# Control Policy 模块：`controlPolicy` JSON 契约（产品包域）

**Status**: 规范真源（Phase 29 **T205**）  
**Scope**: 表 **`control_policy_modules`** 列 **`control_policy`**（JSONB）；与 HTTP **`/v1/control-policies`** 请求/响应体中的 **`controlPolicy`** 对象一致。持久化键名使用 **camelCase**，与现有 Commercial Terms / Carrier Service 模块一致。

**非范围**：计费域表 **`control_policies`**（按企业一行开关）— 见 [spec.md](../spec.md) 控制策略「数据模型边界」与 [data-model.md](../data-model.md)。

---

## 1. 顶层形状

| 字段 | 类型 | 必选 | 说明 |
|------|------|------|------|
| `enabled` | boolean | **是** | 总开关；`false` 时不执行本模块定义的策略动作（见 §4） |
| `cutoff` | object | 否 | 达量断网；与 [spec.md](../spec.md) Cutoff Rules 对齐 |
| `throttling` | object | 否 | 达量限速；与 [spec.md](../spec.md) Throttling Rules 对齐 |

**禁止** 在 `controlPolicy` 根级使用已废弃键（旧实现或误用）：`cutoffPolicyId`、`throttlingPolicyId`、`cutoffThresholdMb`。新实现 **MUST** 拒绝此类字段（HTTP **400**），见 Phase 29 **T210**。

---

## 2. `cutoff`（达量断网）

| 字段 | 类型 | 必选 | 说明 |
|------|------|------|------|
| `timeWindow` | string | **是** | **`DAILY`** \| **`MONTHLY`**（与 spec 正文 DAILY / MONTHLY 一致；统计窗口见 spec 触发口径） |
| `thresholdMb` | integer | **是** | ≥ 0；达量阈值（MB） |
| `action` | string | 否 | 默认 **`DEACTIVATED`**；当前仅允许 **`DEACTIVATED`**（与 spec 一致） |

若提供 `cutoff`，则 **`timeWindow` / `thresholdMb` / `action`（若出现）** 均须通过校验。

---

## 3. `throttling`（达量限速）

| 字段 | 类型 | 必选 | 说明 |
|------|------|------|------|
| `timeWindow` | string | **是** | **`DAILY`** \| **`MONTHLY`** |
| `tiers` | array | **是** | **至少 1 个** 元素；按 `thresholdMb` 升序建议（执行层可校验） |

### 3.1 `tiers[]` 元素

| 字段 | 类型 | 必选 | 说明 |
|------|------|------|------|
| `thresholdMb` | integer | **是** | ≥ 0 |
| `downlinkKbps` | integer | **是** | ≥ 0 |
| `uplinkKbps` | integer | **是** | ≥ 0 |

若提供 `throttling`，则 **`timeWindow`** 与 **非空 `tiers`** 为必填语义。

---

## 4. 合法组合与语义

| 场景 | 条件 | 语义（产品） |
|------|------|----------------|
| A | `enabled: false` | 不启用策略；`cutoff` / `throttling` **可省略**；若仍出现，实现 **MAY** 忽略或 **MUST** 校验一致（实现二选一，须在 OpenAPI/版本说明中固定） |
| B | `enabled: true` 且二者皆无 | 无断网、无限速阈值（与 spec「无控制」可一致）；**MUST** 仍可持久化 |
| C | `enabled: true` 且仅有 `cutoff` | 仅达量断网 |
| D | `enabled: true` 且仅有 `throttling` | 仅达量限速 |
| E | `enabled: true` 且二者皆有 | 同一 SIM 同时命中时 **断网优先**（见 [spec.md](../spec.md) 执行规则） |

---

## 5. 与 speckit 条文的关系

[speckit 补遗 § Control Policy](../spec.md)（约「cutoff 与 throttling 规则作为快照内容一并固化」）：本 JSON 即该快照载体；**无**独立 `control_policy_throttling_tiers` 物理表。

---

## 6. 变更控制

- 新增枚举值、新字段或破坏性重命名：**须** 走 [plan.md](../plan.md) **T184** 顺序，并 bump OpenAPI / 本文件版本说明。
- 与 **Price Plan** `payg_rates.meta.controlPolicy` 内嵌对象 **MUST** 使用同一契约（避免模块 API 与资费侧分叉）。

---

## 7. 存量数据与运维（Phase 29 **T209**）

部署 T210 后，**写入**含废弃根级键的请求会被拒绝；库内仍可能残留旧 JSON 直至迁移或重保存。**运维策略、盘点 SQL、可选批处理脚本** 见 [runbook-phase29-control-policy-legacy.md](../runbook-phase29-control-policy-legacy.md)；仓库内辅助文件：`tools/migrate_control_policy_legacy_json.sql`（默认 **`cutoffThresholdMb` → `cutoff.timeWindow = MONTHLY`**，执行前须备份并在 staging 演练）。
