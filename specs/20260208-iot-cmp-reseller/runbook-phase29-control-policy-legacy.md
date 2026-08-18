# Runbook：Control Policy 快照 JSON 存量治理（Phase 29）

**关联**：[plan.md — T184 门禁](./plan.md#t184-gate)、[tasks.md — Phase 29](./tasks.md#phase-29-control-policy)、契约真源 [clarifications/control-policy-module.md](./clarifications/control-policy-module.md)（T205）、实现 [src/utils/controlPolicyJson.ts](../../src/utils/controlPolicyJson.ts)（T210）。

## 1. 背景与破坏性说明

- **旧请求/持久化形态（废弃）**：根级 `cutoffPolicyId`、`throttlingPolicyId`、`cutoffThresholdMb`（扁平引用 + 单阈值 MB）。
- **新形态（T205）**：根级必选 `enabled`；可选嵌套 `cutoff`（`timeWindow`、`thresholdMb`、`action`）、`throttling`（`timeWindow`、`tiers[]`）。
- **部署 T210 之后**：
  - **HTTP 写入**携带废弃键 → **400**（写拒绝）。
  - **`publishControlPolicy`**：对库内 JSON **剥离**废弃键后再做 T205 校验；若剥离后不满足 `enabled` 等规则 → **409/400**（无法发布），直至人工或脚本修好。
- **仓库内** 历史上 **未** 提供与 `cutoffPolicyId` / `throttlingPolicyId` 对应的 `cutoff_policies` / `throttling_policies` 表迁移；UUID **无法**在无业务侧模板表时自动还原为完整 `cutoff`/`throttling` 对象。

## 2. 影响列（须盘点）

| 表 | 列 | 说明 |
|----|-----|------|
| `public.control_policy_modules` | `control_policy` | 模块主快照 |
| `public.packages` | `control_policy` | 产品包行内嵌快照 |
| `public.price_plans` | `payg_rates` | 资费快照内 `meta.controlPolicy`（若存在） |

## 3. 策略组合（推荐）

以下 **(1)(2)(3)** 与任务 T209 对应，可按环境组合使用。

### (1) 可选：一次性 SQL 迁移（维护窗口）

- **适用**：已知数据量可控、可接受默认假设（见 §5）、已备份。
- **脚本**：仓库 [tools/migrate_control_policy_legacy_json.sql](../../tools/migrate_control_policy_legacy_json.sql)（**只读盘点 + 可选 UPDATE**，执行前务必审阅并裁剪 `WHERE`）。
- **默认假设**：仅将 **`cutoffThresholdMb`** 映射为 `cutoff.timeWindow = 'MONTHLY'`、`action = 'DEACTIVATED'`（与计费月对齐的常见默认；若业务要求 **DAILY** 须在迁移后逐条 PATCH 或通过脚本改为 `DAILY`）。

### (2) 仅 DRAFT 重保存（无 SQL 或 SQL 失败后的兜底）

- 对仍为 **DRAFT** 的 `control_policy_modules`：由运营/客户在控制台或 API **PUT** 合法 T205 JSON（可用 `POST /v1/control-policies:validate` 预检）。
- **已 PUBLISHED** 且仅能通过「改快照」修正的：走 **deprecated → 新建 DRAFT → 发布** 的产品流程；或维护窗口执行 (1)。

### (3) 读兼容 / 写拒绝（当前实现）

- **读**：历史行可能仍含废弃键直到迁移或重保存；**GET** 原样返回库内 JSON（消费方应迁移解析逻辑）。
- **写**：新键名 **MUST** 符合 T205；废弃键 **一律拒绝**。

## 4. 执行前检查（Inventory）

在 **staging** 先做只读盘点（脚本文件 §1 `SELECT`），确认：

- 含 `cutoffPolicyId` / `throttlingPolicyId` 的行数（**无法自动还原 tiers**，需业务决策）。
- 仅含 `cutoffThresholdMb`（无嵌套 `cutoff`）的行数（**可按 §5 自动映射**）。
- `price_plans.payg_rates -> meta -> controlPolicy` 中含废弃键的版本数。

## 5. 自动映射规则（脚本实现范围）

1. **删除**根级 `cutoffPolicyId`、`throttlingPolicyId`（不自动补 `cutoff`/`throttling`；发布前须人工补全或接受「仅 `enabled` + 可选 cutoff」的合法组合）。
2. 若存在 **`cutoffThresholdMb`** 且尚无 **`cutoff`** 对象：写入  
   `cutoff: { "timeWindow": "MONTHLY", "thresholdMb": <原值>, "action": "DEACTIVATED" }`，并删除 `cutoffThresholdMb`。
3. 若同时存在旧阈值与 UUID：先删 UUID 再按上一步补 `cutoff`；**业务须复核**语义是否与原意图一致。

## 6. 生产步骤（建议顺序）

1. **备份**：`pg_dump` 或平台快照。
2. **冻结写入**（或低峰窗口）：暂停依赖 Control Policy 写路径的自动化任务（若有）。
3. **Staging 演练**：完整执行盘点 SQL +（若采用）迁移 SQL；抽样 **GET** 与 **publish** 验证。
4. **生产**：部署已含 T210 的应用 → 执行 (1) 或通知消费方执行 (2)。
5. **验证**：对抽样 `control_policy_id` / `package_id` / `price_plan_id` 做 **GET**；对 DRAFT 执行 **validate**；对允许发布的行执行 **publish** 试跑。

## 7. 回滚

- 与 Phase 28 类似：**无**轻量单语句回滚；依赖 **还原备份** 与回退应用版本。
- 若迁移 SQL 包在单事务内执行失败，应整体 `ROLLBACK`，数据库保持执行前状态。

## 8. 消费方公告要点

- 请求体 **不得** 再发送 `cutoffPolicyId` / `throttlingPolicyId` / `cutoffThresholdMb`。
- 响应体在存量未清空前可能仍短暂出现旧键（读兼容）；客户端应优先解析 **T205** 嵌套字段，并计划移除对旧键的依赖（与 [T214](./tasks.md#phase-29-control-policy) 一致）。
