# Diagnostics 模块：上游能力与本地拼装

**Feature**: `iot-cmp-reseller` | **Status**: 规范真源（2026-06-17）

## 背景

Diagnostics 暴露四条以 **ICCID** 为路径参数的 API（连接状态、拜访网络、拜访网络历史、取消位置）。各上游供应商 **outbound 能力不一致**：有的提供实时查询 API，有的仅通过 **Webhook + CDR/话单** 间接提供位置信息，有的完全不支持 cancel-location。

V1.1 **MUST** 统一编排模型：**先本地库存与租户校验 → 按 SIM 的 `(supplier_id, operator_id)` 加载 `upstream_integrations` → 按 adapter 声明的能力矩阵决定「上游直调 / 本地拼装 / 不支持」**。

**OpenAPI / 合约**：[`contracts/integration-api.md`](../contracts/integration-api.md) §1  
**Integration 真源**：[`upstream-integration-config.md`](./upstream-integration-config.md)  
**WXZG API 清单（Postman 验证）**：[`docs/WXZHONGGENG_API_List.md`](../../../docs/WXZHONGGENG_API_List.md)

---

## 1. 设计原则（MUST）

### 1.1 Integration 真源

- Diagnostics **outbound**（主动查上游）**MUST** 使用 **`upstream_integrations`** 运行时（`loadUpstreamIntegrationRuntime` → `createSupplierAdapterFromIntegration`）。
- **MUST NOT** 在 Diagnostics 路由中无参调用 `createWxzhonggengClient()` 并依赖 **`.env`** 或 `wxzhonggeng_config.json` 默认 URL/凭证作为生产路径（与 §6 [`upstream-integration-config.md`](./upstream-integration-config.md) 一致）。
- 解析键：**`sims.supplier_id` + `sims.operator_id`**（关联行 `operators.operator_id`）→ 唯一 **ACTIVE + enabled** 集成行。

### 1.2 能力驱动（Adapter Capability Map）

- 每个 **`adapter_type`** **MUST** 注册 Diagnostics 能力矩阵（四接口 × 模式），路由层 **只 orchestrate**，**MUST NOT** 在 `simDiagnostics.ts` 内写 vendor 硬编码分支。
- 能力模式枚举：

| 模式 | 含义 |
|------|------|
| `UPSTREAM_FULL` | 上游 API 可覆盖该接口 response 主要字段 |
| `UPSTREAM_PARTIAL` | 上游 API 仅提供部分字段，其余本地 enrich |
| `LOCAL_ASSEMBLE` | 无对应 outbound API，仅读 CMP 本地表拼装 |
| `NOT_SUPPORTED` | 上游不支持；cancel-location 等 **MAY** 仍接受请求并落本地 job，但 **MUST NOT** 伪造上游成功 |

### 1.3 字段溯源与诚实响应

- 实现层 **SHOULD** 区分字段来源（内部）：`UPSTREAM` | `LOCAL_CDR` | `LOCAL_WEBHOOK` | `INFERRED` | `UNAVAILABLE`。
- 对外 API **MAY** 返回 `null` 或省略可选字段；**MUST NOT** 伪造信令级精度（GPS 坐标、Cell ID、session IP 等）当上游与本地均无依据时。
- OpenAPI 描述 **SHOULD** 保留 *「if supported by upstream / supplier」* 语义。

### 1.4 本地库存门槛

- 四条 Diagnostics API **MUST** 要求 ICCID 存在于 **`sims`**（CMP 库存），即使上游系统存在该卡。
- **MUST** 按 token 做租户范围校验（platform / reseller / customer / department），规则与 SIM 生命周期读接口一致（见 [`operator-identity-model.md`](./operator-identity-model.md)）。

### 1.5 入站 Webhook 与 outbound 分工

- WXZG 等供应商的 **LocationUpdate** 等事件为 **入站 Webhook**（[`upstream-inbound-webhook-catalog.md`](./upstream-inbound-webhook-catalog.md)），写入 **`events`** / **`audit_logs`**，**不是** Diagnostics outbound 的替代品，但是 **`visited-network*`** 的 **LOCAL_ASSEMBLE** 重要数据源。

---

## 2. 请求编排流程（ normative ）

```text
1. RBAC + ICCID 格式校验
2. ensureSimDiagnosticsAccess（租户 + 本地 sims 存在）
3. 从 sims 读取 supplier_id、operator_id
4. loadUpstreamIntegrationRuntime(supabase, supplierId, operatorId)
   └─ 失败 → 503 UPSTREAM_NOT_CONFIGURED
5. createSupplierAdapterFromIntegration(runtime)
6. 读取 adapter.diagnosticsCapabilities[operation]
7. 按能力模式：
   - UPSTREAM_*  → 调 adapter 出站方法 + 合并本地 enrich
   - LOCAL_ASSEMBLE → 仅查 usage_daily_summary / events / sims 等
   - NOT_SUPPORTED → cancel-location 等按 §5.4 处理
8. 返回统一 OpenAPI schema（允许部分 null）
```

---

## 3. 能力矩阵（V1.1 · `wxzhonggeng`）

| CMP 接口 | 能力模式 | WXZG outbound API | 本地拼装数据源 |
|----------|----------|-------------------|----------------|
| `GET …/connectivity-status` | **`UPSTREAM_PARTIAL`** | `POST …/queryCardStatus`（§2.4） | `usage_daily_summary`（最近 `visited_mccmnc`/`apn`/`rat`）、`sims.apn`、`operators.business_operators`（home PLMN 推断 roaming）、可选 `events` |
| `GET …/visited-network` | **`LOCAL_ASSEMBLE`** | *无 pull API* | 优先 `events`（`UPDATE_LOCATION` 最近一条）→ 其次 `usage_daily_summary` 最近 `visited_mccmnc` |
| `GET …/visited-network-records` | **`LOCAL_ASSEMBLE`** | *无 pull API* | `usage_daily_summary`（`from`/`to` 按 `usage_day`）+ **`events`**（`UPDATE_LOCATION`，按 `occurred_at`）；双源 **MAY** 合并，**SHOULD** 文档化粒度差异 |
| `POST …:cancel-location` | **`NOT_SUPPORTED`** | *无 outbound API* | 本地 **`jobs`**（`SIM_RESET_CONNECTION`）；**MUST NOT** 调用 WXZG；未来 adapter 有 API 时改为 `UPSTREAM_FULL` |

> **注意**：`POST …/queryInfo`（§2.1）为 MSISDN/IMSI 等 **基础信息**，**MUST NOT** 用于 connectivity-status；状态查询 **MUST** 使用 **`queryCardStatus`**。

---

## 4. 字段映射：`connectivity-status`

### 4.1 来自 WXZG `queryCardStatus`

| 上游字段 | CMP 字段 | 说明 |
|----------|----------|------|
| `data.status` / `data.state` | `onlineStatus` | 映射 Activty/Stop 等 → ONLINE/OFFLINE |
| `data.lastChangeStateTime` / `data.activateTime` | `lastActiveTime` | ISO 8601 |
| — | `registrationStatus` | 上游无；**INFERRED** 自 `servingMccMnc` + home PLMN |

### 4.2 本地 enrich（WXZG 无 outbound 时）

| CMP 字段 | 优先来源 | 模式 |
|----------|----------|------|
| `servingMccMnc` | `usage_daily_summary.visited_mccmnc` 或 webhook payload | LOCAL_CDR / LOCAL_WEBHOOK |
| `apn` | usage → `sims.apn` | LOCAL_CDR |
| `ratType` | `usage_daily_summary.rat` | LOCAL_CDR |
| `ipAddress`, `servingCellId`, `sessionUptime` | — | **UNAVAILABLE**（null） unless 未来 adapter 提供 |

---

## 5. 字段映射：`visited-network` / `visited-network-records`

### 5.1 `visited-network`（当前快照）

| CMP 字段 | WXZG | 本地来源 |
|----------|------|----------|
| `visitedMccMnc` | 无 pull | `events.payload`（mcc + mncList）或 `usage_daily_summary.visited_mccmnc` |
| `timestamp` | 无 pull | webhook `eventTime` 或 usage `created_at` / `usage_day` |
| `latitude`, `longitude`, `accuracy`, `cellInfo.lac/cellId` | 无 | **UNAVAILABLE**（null）；`locationType` **MAY** 为 `CELL_BASED` |

### 5.2 `visited-network-records`（历史）

| 数据源 | 粒度 | 字段 |
|--------|------|------|
| `usage_daily_summary` | 按日 | `visited_mccmnc` → `visitedMccMnc`；`usage_day` → `occurredAt` |
| `events`（`UPDATE_LOCATION`） | 按事件 | payload.mcc / mncList；`occurred_at` |

**SHOULD**：分页与 `from`/`to` 过滤在 DB 层完成；reseller/customer 仍受租户 scope 约束。

---

## 6. `cancel-location`（WXZG 与未来 adapter）

| adapter | 模式 | 行为 |
|---------|------|------|
| `wxzhonggeng` | `NOT_SUPPORTED` | `202` + 创建 `SIM_RESET_CONNECTION` job；job **SHOULD** 标记上游不可执行或快速 FAILED + 明确 `errorSummary`（实现阶段定稿） |
| *未来供应商* | `UPSTREAM_FULL` | job handler 调用 adapter 出站 cancel/reset API，异步跟踪 |

OpenAPI 已声明：*「if supported by upstream」*。

---

## 7. 错误语义

| 条件 | HTTP | code |
|------|------|------|
| ICCID 不在 `sims` | 404 | `RESOURCE_NOT_FOUND` |
| ICCID 在库但越权（reseller/customer/department） | 403 | `FORBIDDEN` |
| 无 ACTIVE integration | 503 | `UPSTREAM_NOT_CONFIGURED` |
| 上游超时/5xx，本地仍可拼装 | 200 | —（部分字段 null；**MAY** 后续增加 warning 头） |
| 上游与本地均无可拼字段 | 200 | —（schema 合法但多为 null） |
| cancel-location + NOT_SUPPORTED | 202 | —（本地 job） |

---

## 8. Adapter 注册（实现 checklist）

新增 `adapter_type` 时 **MUST** 在同一 PR 提供：

1. `diagnosticsCapabilities` 四行矩阵（本节 §3 格式）
2. 若有 outbound：adapter 方法 + `wxzhonggeng_config.json` 或 `config.endpoints` 等价物
3. 字段映射表（本节 §4–§5 格式）
4. 更新 [`integration-api.md`](../contracts/integration-api.md) 说明 *supplier-dependent*

V1.1 已注册：

| adapter_type | connectivity | visited-network | visited-records | cancel-location |
|--------------|--------------|-----------------|-----------------|-----------------|
| `wxzhonggeng` | UPSTREAM_PARTIAL | LOCAL_ASSEMBLE | LOCAL_ASSEMBLE | NOT_SUPPORTED |

---

## 9. 与当前实现的差距（跟踪）

| 项 | 目标态（本文） | 实现状态（2026-06-17） |
|----|----------------|------------------------|
| 按 SIM 加载 integration | MUST | 待实现（仍无参 `createWxzhonggengClient()`） |
| adapter 能力矩阵 | MUST | 待实现（能力仅在 provisioning SPI） |
| connectivity 用 `queryCardStatus` | MUST | 配置已对；integration 绑定待接 |
| visited-network 双源 | SHOULD | 主要 usage；events 待强化 |
| 租户 scope | MUST | 已实现 `simDiagnosticsScope` |

---

## 10. 相关文档

- [`upstream-integration-config.md`](./upstream-integration-config.md) — 集成凭证与 adapter_type
- [`upstream-inbound-webhook-catalog.md`](./upstream-inbound-webhook-catalog.md) — `update-location` 入站
- [`operator-identity-model.md`](./operator-identity-model.md) — supplier/operator ID
- [`data-model.md`](../data-model.md) — `usage_daily_summary`、`events`
- [`docs/WXZHONGGENG_API_List.md`](../../../docs/WXZHONGGENG_API_List.md) — WXZG Postman 真源
