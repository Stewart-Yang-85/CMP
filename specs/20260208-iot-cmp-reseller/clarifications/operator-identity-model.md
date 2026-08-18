# 运营商身份模型：`business_operators` 与 `operators`

**Feature**: `iot-cmp-reseller` | **Status**: 规范真源（2026-05-19）

## 背景

V1.1 将「业务运营商字典」与「供应商—运营商商业关联」拆成两张表。二者 ID 语义不同，但在对外 API 中统一使用字段名 **`operatorId`**。若混淆会导致：上游集成键错误、Webhook 路由无法唯一定位、Carrier Service / SIM 归属校验失败。

本文档为 **`operatorId` 解析规则** 的规范真源；上游集成、Webhook、订阅开通等文档 **MUST** 引用本文，**MUST NOT** 另立冲突口径。

---

## 1. 商业语义

### 1.1 同一运营商，多个供应商渠道

系统 **MUST** 支持：**一个业务运营商**（如「中国移动」）通过 **多个上游供应商** 向代理商销售资源。

| 概念 | 表 |  cardinality |
|------|-----|--------------|
| 业务运营商（字典） | `business_operators` | 全局唯一一条 / PLMN |
| 供应商—运营商关联 | `operators` | **同一 `business_operator_id` 可有多行**，每行对应一个 `supplier_id` |

示例：

```text
business_operators                    operators
┌──────────────────────┐             ┌─────────────────────────────────┐
│ operator_id = BO-移动 │◄────────────│ business_operator_id = BO-移动   │
│ mcc=460, mnc=00      │             │ operator_id = OA (PK)            │
│ name = 中国移动       │             │ supplier_id = Supplier-A         │
└──────────────────────┘             ├─────────────────────────────────┤
         ▲                           │ business_operator_id = BO-移动   │
         │                           │ operator_id = OB (PK)            │
         └───────────────────────────│ supplier_id = Supplier-B         │
                                     └─────────────────────────────────┘
```

这在商业模式上 **正常且预期**：Supplier-A 与 Supplier-B 各自对接上游，凭证、URL、产品包可能完全不同。

### 1.2 约束

- **`business_operators.operator_id`**：业务运营商字典 PK（下文称 **字典 operator ID** 或 **`businessOperatorId`**，仅文档说明用；**API 字段名仍为 `operatorId`**）。
- **`operators.operator_id`**：供应商—运营商关联行 PK（下文称 **关联行 operator ID** 或 **`operatorsRowId`**）。
- **`operators.business_operator_id`**：FK → `business_operators.operator_id`；在 **`supplier_id` 固定时** 与关联行 **1:1**。
- **UNIQUE(`supplier_id`, `business_operator_id`)**（`business_operator_id` 非空时）：同一供应商下，同一字典运营商至多一行 `operators`。
- 产品库表（`sim_cards`、`carrier_service_modules`、`upstream_integrations` 等）持久化的 **`operator_id` MUST** 为 **`operators.operator_id`（关联行 PK）**，**MUST NOT** 直接存字典 ID。

---

## 2. 两层 ID 对照

| 名称 | 物理列 | 用途 |
|------|--------|------|
| 字典 operator ID | `business_operators.operator_id` | 用户识别「哪家运营商」；API 读路径优先回显 |
| 关联行 operator ID | `operators.operator_id` | DB 外键、归属链、上游集成 UNIQUE 键的内部真源 |
| 供应商 ID | `suppliers.supplier_id` | 与关联行组合，唯一定位 `(supplier, operator)` 商业上下文 |

**定位一条 `operators` 行**：

- 推荐输入：`supplierId` + `operatorId`（字典 ID 或关联行 ID 均可，见 §3）
- 内部结果：解析为 **`operators.operator_id`** 后写入/查询

---

## 3. API 字段 `operatorId`（对外统一）

### 3.1 单一字段，双路径解析

所有对外 HTTP JSON / 查询参数 / 路径段中的 **`operatorId`**（**不**另设 `businessOperatorId` 字段）**MUST** 按下列顺序解析（须配合 **`supplierId`** 时 **MUST** 传入）：

1. 在 `operators` 中按 **`operators.operator_id = operatorId`** 且（若提供）**`supplier_id = supplierId`** 查找；
2. 若未命中，再按 **`operators.business_operator_id = operatorId`** 且（若提供）**`supplier_id = supplierId`** 查找；
3. 若仍未命中 → **400** `BAD_REQUEST`（文案与 Carrier Service 等模块一致）。

实现参考：`loadOperator(supabase, operatorId, supplierId)`（`src/services/package.ts`）。

### 3.2 写入（Create / Update）

- 客户端 **MAY** 传字典 operator ID 或关联行 operator ID。
- 服务端 **MUST** 解析为 **`operators.operator_id`** 后持久化。
- **MUST** 校验该行 **`supplier_id`** 与请求上下文一致。

### 3.3 读出（List / Get）

- 响应中的 **`operatorId` SHOULD** 优先展示 **`business_operators.operator_id`**（当 `operators.business_operator_id` 非空）；
- 若未绑定字典（legacy / 1:1 退化），**MAY** 回退为 **`operators.operator_id`**。

实现参考：`businessOperatorDisplayIdsByOperatorRowIds`（`src/services/package.ts`）。

### 3.4 适用范围

下列模块 **MUST** 遵循本节（非穷举）：

- Carrier Service / Package / APN Profile / Roaming Profile / Covered Network Profile
- SIM 列表筛选与导入
- **`upstream_integrations` CRUD**（见 [upstream-integration-config.md](./upstream-integration-config.md)）
- **入站供应商 Webhook 路径** `{operatorId}` 段（见同上 §4）

---

## 4. 与 `public_infos` 的边界

- **`business_operators` / `operators`** 为业务主数据链；**`public_infos`** 为 3GPP 公开参考目录，**零关联**（见 **FR-057**）。
- **MUST NOT** 用 `public_infos` 解析或校验 API `operatorId`。

---

## 5. 常见误解（反例）

| 误解 | 正确做法 |
|------|----------|
| 「全系统只有一个 operator UUID」 | 字典 ID 全局唯一；**关联行 ID 按 supplier 分行** |
| 「API 的 operatorId 就是 `operators.operator_id`」 | 对外字段可传字典 ID；**存库才是关联行 ID** |
| 「Webhook 只传字典 operatorId 即可」 | **还必须** 传 **`supplierId`**，否则多供应商渠道无法区分 |
| 「`upstream_integrations.operator_id` 存字典 ID」 | **MUST** 存 **`operators.operator_id`** |
| 「Carrier Service 用 businessOperatorId 字段」 | **只用 `operatorId`**，服务端双路径解析 |

---

## 6. 相关文档

- [data-model.md](../data-model.md) — 表结构
- [upstream-integration-config.md](./upstream-integration-config.md) — 上游连接凭证与 Webhook 路径
- [subscription-provisioning-upstream-mapping.md](./subscription-provisioning-upstream-mapping.md) — 订阅开通与 operator 校验
