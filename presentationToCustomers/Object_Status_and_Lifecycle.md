# IoT CMP 对象状态与生命周期说明

> **用途**：面向客户与实施人员，说明平台中各类业务对象如何表达「状态」、允许哪些迁移，以及是否由定时任务自动驱动。  
> **维护方式**：按对象分批核对后写入本文；后续章节随评审逐步追加。  
> **范围**：既包含正式**状态机**对象，也包含 Authentication Token 等**时效类**机制（非状态机）。

---

## 文档目录

| # | 对象 | 机制类型 | 与定时任务 | 状态 |
|---|------|----------|------------|------|
| 1 | Authentication（Access Token） | 时效 / JWT `exp` | 到期自动失效（无 cron） | 已写入 |
| 2 | Supplier（供应商） | 状态机 | 无关 | 已写入 |
| 3 | Operator（运营商） | 无产品状态机 | — | 已写入 |
| 4 | Reseller（代理商） | 状态机 | 无关 | 已写入 |
| 5 | Enterprise（企业） | 状态机 | 无关 | 已写入 |
| 6 | Department（部门） | 无产品状态机 | — | 已写入 |
| 7 | Reseller / Enterprise User（用户） | 有状态字段，无状态机管理 | 无关 | 已写入 |
| 8 | Upstream Integration（上游集成） | 状态机 | 无关 | 已写入 |
| 9 | Outbound Webhook Subscription | 订阅状态管理 | 状态无关；投递有 cron | 已写入 |
| 10 | Inbound Webhook（目录 / 订阅） | 目录状态 + 订阅开关 | 无关 | 已写入 |
| 11 | 产品配置域（APN / Roaming / Carrier Service / Commercial Terms / Control Policy / Covered Network / Price Plan / Package） | 统一 `DRAFT`/`PUBLISHED`/`DEPRECATED` | 无关 | 已写入 |
| 11.9 | Rating Fallback Package 映射 | `ACTIVE` / `INACTIVE` | 无关 | 已写入 |
| 12 | SIM（物理 SIM） | 状态机 + 过渡子状态 | TEST_READY 到期有 cron | 已写入 |
| 13 | Subscription（订阅） | 状态机 | ONE_TIME 到期 / 排程取消有 cron | 已写入 |
| 14 | Bill（账单） | 状态机 | PUBLISHED→OVERDUE 有 cron | 已写入 |
| 15 | Job（异步任务） | 有状态定义；按任务执行推进 | Worker 消费队列（非「到期翻状态」类 cron） | 已写入 |
| 16 | Diagnostics / Events | 无对象状态机 | 无关 | 已写入 |
| 17 | Alert（告警实例） | 有状态枚举；迁移见 §17 | 评估 cron 创建/合并；确认手工 | 已写入 |
| 18 | Alert Config Profile（告警配置表） | `ACTIVE` / `INACTIVE` | 无关 | 已写入 |
| 19 | Reports（报表） | 无对象状态机 | 无关 | 已写入 |
| 20 | Reconciliation（对账运行） | 有运行状态 | 无关（非到期翻态；见 §20） | 已写入 |
| 21 | Audit Logs（审计日志） | 无对象状态机 | 无关 | 已写入 |

> 以上为本轮识别的全部对象；无更多待追加项。

---

## 1. Authentication — Access Token

### 1.1 说明

Authentication 模块签发的 **Access Token** 不是组织实体上的状态字段，而是带**有效期**的凭证。超时后系统拒绝使用该 token，需重新登录或重新换取 token。

### 1.2 「状态」等价语义

| 语义 | 含义 |
|------|------|
| **有效（Valid）** | 签名校验通过，且当前时间未超过 `exp` |
| **已过期（Expired）** | 当前时间 ≥ `exp`（允许少量时钟偏移），请求返回未授权 |

不存在 `ACTIVE` / `SUSPENDED` 一类可被管理员改写的 token 状态枚举。

### 1.3 业务规则

- 登录（`/auth/login`）与客户端凭证换 token（`/auth/token`）等路径签发 JWT 时写入 `iat`、`exp`。
- 有效期由环境变量 **`AUTH_TOKEN_TTL_SECONDS`** 控制：默认 **3600 秒（1 小时）**；实现上限制在 **60～86400 秒**。
- 响应中通常附带 `expiresIn`，便于客户端在过期前刷新。
- 鉴权中间件校验 `exp`；过期返回 **401**（如 `Token expired` / Unauthorized）。
- **与定时任务无关**：无需 Worker cron；失效由请求时校验完成。

### 1.4 迁移规则

```
签发 ──► 有效 ──(到达 exp)──► 已过期（不可再用，须重新获取）
```

- **触发方**：时间流逝 + 请求侧校验（自动）。
- **不可**：由 platform / reseller admin「手工改 token 状态」。

### 1.5 操作者

| 动作 | 角色 |
|------|------|
| 获取 / 刷新 token | 合法用户或已配置的 API Client |
| 强制失效某用户会话 | 不在本机制内（可通过改用户/租户状态间接阻断后续登录） |

---

## 2. Supplier（供应商）

### 2.1 说明

供应商为上游对接对象。具备显式状态字段；**状态变更与定时任务无关**，由管理员手工操作。

### 2.2 状态定义

| 状态 | 定义 |
|------|------|
| **ACTIVE** | 正常：允许业务开通与上游交互（导入 SIM、调用上游 API、接收该供应商 Webhook 等按策略放行） |
| **SUSPENDED** | 冻结：禁止导入该供应商 SIM、禁止向其关联上游发送 API 请求、入站 Webhook 忽略处理 |

创建时默认 **ACTIVE**。不允许物理删除供应商，以状态变更替代（历史数据保留）。

### 2.3 业务规则

- 创建 API **不绑定** Reseller；绑定通过 `POST /v1/resellers/{resellerId}/suppliers`，且每个 `supplier_id` **至多绑定一个** Reseller。
- 可更新名称与状态。
- 状态变更**实时生效**，并记录审计；变更须填写 **reason**。

### 2.4 状态迁移规则

```
ACTIVE ◄──────────────► SUSPENDED
```

| 迁移 | 触发方式 | 定时？ |
|------|----------|--------|
| ACTIVE → SUSPENDED | API / Portal：`POST …/suppliers/{supplierId}:change-status` | 否 |
| SUSPENDED → ACTIVE | 同上 | 否 |

### 2.5 操作者

| 动作 | 角色 |
|------|------|
| 变更供应商状态 | **仅 Platform Admin** |

Reseller Admin **不能**变更供应商状态。

---

## 3. Operator（运营商）

### 3.1 说明

平台将「运营商」拆为：

- **`business_operators`**：业务运营商字典（MCC/MNC/名称等）；
- **`operators`**：供应商—运营商**商业关联**（一行对应某供应商下的某字典运营商）。

二者是主数据 / 关联实体，**产品层不设计状态机**，也**没有**对外的 `:change-status` 类状态迁移 API。

### 3.2 状态定义

不适用正式状态机。  
（实现库表上 `operators` 可能存在默认 `status` 列，**不作为** V1.1 对外状态机与运营流程依据。）

### 3.3 业务规则

- 同一业务运营商可通过**多个供应商**渠道销售（多行 `operators` 共享同一 `business_operator_id`）。
- 对外 API 字段统一为 `operatorId`，服务端按规范做双路径解析（字典 ID 或关联行 PK）。
- Platform Admin 可维护字典与关联的创建/更新；这属于**主数据维护**，不是状态翻转。

### 3.4 状态迁移规则

无。不存在「运营态」之间的定时或手工状态机迁移。

### 3.5 操作者

| 动作 | 角色 |
|------|------|
| 创建 / 更新运营商主数据与关联 | Platform Admin |
| 状态机迁移 | — |

---

## 4. Reseller（代理商）

### 4.1 说明

代理商组织实体。状态机**仅手工变更**，与定时任务无关；不允许物理删除，以状态变更替代。

### 4.2 状态定义

| 状态 | 定义 |
|------|------|
| **ACTIVE** | 正常经营：可创建企业、产品包、导入 SIM 等（在权限范围内） |
| **DEACTIVATED** | 主动停用（如业务调整）：不可创建企业客户、创建产品包、导入 SIM 卡等 |
| **SUSPENDED** | 冻结（如安全事故）：代理商用户登录提示账户已停用并拒绝登录；相关 API 按 scope 拒绝创建/管理操作 |

创建时默认 **ACTIVE**。

### 4.3 业务规则

- 仅系统管理员可在 Portal / API 创建与更新代理商（不可改代理商 ID / created_by）。
- 状态变更**必须填写原因（reason）**，写入审计。
- 历史数据（SIM、账单、CDR）在状态变更后**保留归属**。
- 「后台任务全链路因 SUSPENDED 暂停」属后续运维增强，**不作为 V1.1 已实现验收项**。

### 4.4 状态迁移规则

```
        ┌──────────────┐
   ┌───►│    ACTIVE    │◄───┐
   │    └──────┬───────┘    │
   │           │            │
   │    ┌──────▼───────┐    │
   │    │ DEACTIVATED  │────┤
   │    └──────┬───────┘    │
   │           │            │
   │    ┌──────▼───────┐    │
   └────┤  SUSPENDED   │────┘
        └──────────────┘
```

（实现上通过 `change-status` 指定目标状态；合法目标为 ACTIVE / DEACTIVATED / SUSPENDED。）

| 迁移 | 触发方式 | 定时？ |
|------|----------|--------|
| 任意合法状态 → 另一合法状态 | `POST …/resellers/{resellerId}:change-status`（须 `reason`） | 否 |

### 4.5 操作者

| 动作 | 角色 |
|------|------|
| 变更代理商状态 | **仅 Platform Admin** |

Reseller Admin **不能**变更本代理商（或其它代理商）的组织状态。

---

## 5. Enterprise（企业）

### 5.1 说明

企业（客户）租户。状态保存在租户侧（如 `tenants.enterprise_status`）。**与定时任务无关**；欠费催收（Dunning）**不会**自动改写企业状态。

### 5.2 状态定义

| 状态 | 定义 |
|------|------|
| **ACTIVE** | 正常：可分配新 SIM、创建新订阅，功能可用 |
| **INACTIVE** | 停用：禁止分配新 SIM / 新增订阅；**已分配 SIM 可继续使用** |
| **SUSPENDED** | 冻结：禁止新 SIM / 新订阅 / 企业侧管理操作 |

创建时默认 **ACTIVE**。`SUSPENDED` 为可恢复冻结态，**不是**终态。

### 5.3 业务规则

- 字段 **`autoSuspendEnabled`**（自动停机相关）在规格中保留，**当前版本暂不启用自动控制**；企业状态仍依赖人工。
- 将企业设为 `SUSPENDED` / `INACTIVE` **不会自动**批量停机或拆机；若需对企业名下 SIM 执行停机/拆机，须由管理员**另行手工**操作。
- 状态变更实时生效，写审计，并触发事件 **`ENTERPRISE_STATUS_CHANGED`**。
- 变更须填写 **reason**。

### 5.4 状态迁移规则

```
        ┌──────────────┐
   ┌───►│    ACTIVE    │◄───┐
   │    └──────┬───────┘    │
   │           │            │
   │    ┌──────▼───────┐    │
   │    │   INACTIVE   │────┤
   │    └──────┬───────┘    │
   │           │            │
   │    ┌──────▼───────┐    │
   └────┤  SUSPENDED   │────┘
        └──────────────┘
```

| 迁移 | 触发方式 | 定时？ |
|------|----------|--------|
| 任意合法状态 → 另一合法状态 | `POST …/enterprises/{enterpriseId}:change-status`（须 `reason`） | 否 |

### 5.5 操作者

| 动作 | 角色 |
|------|------|
| 变更企业状态 | **Platform Admin** 或 **Reseller Admin**（仅可操作本代理商下属企业） |
| 恢复 ACTIVE | 同上（手工） |

---

## 6. Department（部门）

### 6.1 说明

部门是企业下的组织节点（`tenants.tenant_type = DEPARTMENT`），用于用户归属与 SIM 等资源的部门维度划分。**产品层不设计状态机**。

### 6.2 状态定义

不适用。部门 API 以 `departmentId`、`name`、层级关系等为主，**无**对外状态枚举与 `:change-status`。

### 6.3 业务规则

- 在企业下创建 / 列表 / 查询部门；可将企业用户分配到一个或多个部门。
- 生命周期以**存在与否、归属关系**表达，不以状态翻转表达「停用部门」。

### 6.4 状态迁移规则

无。

### 6.5 操作者

| 动作 | 角色 |
|------|------|
| 创建 / 查询部门、分配用户部门 | 具备企业组织管理权限的 Platform / Reseller / Enterprise 侧角色（以 RBAC 为准） |
| 状态机迁移 | — |

---

## 7. Reseller User / Enterprise User（用户）

### 7.1 说明

代理商用户与企业用户均落在 `users` 表（按所属 `tenant_id` 区分组织）。表上**有 `status` 字段**（创建时通常为 `ACTIVE`），登录等路径会校验须为 `ACTIVE`。

**当前产品决策**：不打算实现用户侧完整状态机管理（无对外 `change-status` / 启停用户的正式运营流程）。**暂时维持现状**——字段与登录门禁保留，不扩展为可运营状态机。

### 7.2 状态定义（字段语义，非正式状态机）

| 值（实现常见） | 含义（现状） |
|----------------|--------------|
| **ACTIVE** | 允许登录（其它校验通过时） |
| 非 ACTIVE | 登录拒绝 |

规格/库中可能出现其它取值空间，但 **V1.1 不提供**规范的状态迁移 API 与运营手册级状态机。

### 7.3 业务规则

- 创建用户时写入 `status = ACTIVE`。
- `POST /auth/login`（及部分改密相关路径）要求用户 `status === ACTIVE`。
- **不提供**与 Reseller / Enterprise 组织状态机同级的「用户状态变更」产品能力；账号停用等需求可后续单独立项，或通过组织状态、密码重置等旁路手段处理。
- **与定时任务无关**。

### 7.4 状态迁移规则

**无正式迁移规则。** 不规划由 admin 通过标准状态机接口在 ACTIVE / 停用态之间切换（直至产品另行立项）。

### 7.5 操作者

| 动作 | 角色 |
|------|------|
| 创建 / 查询用户、分配角色与部门 | Platform / Reseller Admin 等（按路由与 RBAC） |
| 用户状态机管理 | **未实现 / 暂不提供** |

---

## 8. Upstream Integration（上游集成）

### 8.1 说明

`upstream_integrations` 按 **`(resellerId, supplierId, operatorId)`** 配置上游对接（适配器、端点、凭证、Webhook Key 等）。具备明确状态机；**状态变更与定时任务无关**（由 Platform Admin API / 配置操作驱动）。

> 说明：CDR **拉取**等可由 Worker 定时执行，但那是集成**能力使用**，不是集成行 `status` 的自动迁移。

### 8.2 状态定义

| 状态 | 定义 |
|------|------|
| **ACTIVE** | 存活且启用：可作为出站 / 入站 / 诊断等运行时真源（通常同时要求 `enabled = true`） |
| **INACTIVE** | 存活但停用：仍占唯一槽位，但不作为运行时加载对象 |
| **DEPRECATED** | 软删除：不可再更新；释放 `(reseller, supplier, operator)` 唯一槽，允许新建替代集成 |

`enabled` 与活态联动：创建 / 更新时常用 `enabled=true → ACTIVE`，`enabled=false → INACTIVE`。对外 API 映射中，仅 **ACTIVE 且 enabled** 视为真正启用。

### 8.3 业务规则

- 同一 `(resellerId, supplierId, operatorId)` 在 **ACTIVE / INACTIVE** 上唯一；**DEPRECATED** 不占槽。
- **DEPRECATED** 后不可 PATCH；需新建集成。
- 删除（软删）将状态置 **DEPRECATED**，`enabled=false`，并关闭该集成下入站 Webhook 订阅（`enabled=false`）。
- 运行时加载要求 **ACTIVE + enabled**；否则上游调用 / Webhook 门禁失败（如 `UPSTREAM_NOT_CONFIGURED`）。

### 8.4 状态迁移规则

```
创建(enabled) ──► ACTIVE 或 INACTIVE
ACTIVE ◄──enabled──► INACTIVE
ACTIVE / INACTIVE ──软删 / DELETE──► DEPRECATED（终态，不可回写）
```

| 迁移 | 触发方式 | 定时？ |
|------|----------|--------|
| → ACTIVE / INACTIVE | 创建或 PATCH（经 `enabled` 等） | 否 |
| → DEPRECATED | `DELETE /v1/upstream-integrations/{id}`（软删） | 否 |

### 8.5 操作者

| 动作 | 角色 |
|------|------|
| 创建 / 更新 / 软删集成 | **Platform Admin**（JWT 或 `ADMIN_API_KEY`） |

---

## 9. Outbound Webhook Subscription（出站 Webhook 订阅）

### 9.1 说明

出站订阅表 `webhook_subscriptions`：按租户范围 + **事件类型** 配置回调 URL。订阅具备与集成类似的活态 / 废弃模型。

**订阅状态不需要定时任务管理。**  
Worker 的 **`WEBHOOK_DELIVERY_CRON`** 仅负责**投递与重试**（delivery 队列状态），不翻转订阅的 ACTIVE / INACTIVE / DEPRECATED。

### 9.2 状态定义

| 状态 | 定义 |
|------|------|
| **ACTIVE** | 订阅启用；匹配事件可入队投递 |
| **INACTIVE** | 订阅停用；保留配置但不投递 |
| **DEPRECATED** | 废弃；不可再 PATCH；释放「同 scope + eventType」活订阅唯一约束，可新建替代订阅 |

活态通过 **`enabled`** 切换：`true → ACTIVE`，`false → INACTIVE`。PATCH **不支持**直接写 `status`；废弃走 **`:deprecate`**。

### 9.3 业务规则

- 同一 scope（reseller 级或 enterprise 级）+ **单个 eventType** 仅允许一条活订阅（ACTIVE/INACTIVE）。
- DEPRECATED 后须新建订阅，不可在原记录上恢复为活态（产品口径与集成软删一致）。
- 投递失败重试、达到最大次数标记 delivery FAILED 等，属于**投递记录**生命周期，不等于订阅状态机。

### 9.4 状态迁移规则

```
创建 ──► ACTIVE（或按 enabled）
ACTIVE ◄──enabled──► INACTIVE
ACTIVE / INACTIVE ──:deprecate──► DEPRECATED
```

| 迁移 | 触发方式 | 定时？ |
|------|----------|--------|
| ACTIVE ↔ INACTIVE | PATCH `enabled` | 否 |
| → DEPRECATED | `POST …/webhooks/{webhookId}:deprecate` | 否 |
| 投递重试 | `WEBHOOK_DELIVERY_CRON` | **是（仅投递，不改订阅状态）** |

### 9.5 操作者

| 动作 | 角色 |
|------|------|
| 创建 / 更新 / 废弃出站订阅 | 具备 Webhook 管理权限的 Platform / Reseller（及规格允许的 Enterprise）角色 |
| 投递执行 | Worker（系统） |

---

## 10. Inbound Webhooks（入站 Webhook：目录与订阅）

### 10.1 说明

入站侧分两层：

1. **事件目录** `upstream_inbound_webhook_events`：平台级 `event_key` 清单；  
2. **集成订阅** `upstream_integration_webhook_subscriptions`：某条 Upstream Integration 对某 `event_key` 是否接收。

二者均有「可管理的状态 / 开关」，**均不需要定时任务**来迁移状态。  
（CDR 定时拉取不属于入站 Webhook 目录，由集成 CDR 配置 + Worker 处理。）

### 10.2 状态定义

**目录（事件）**

| 状态 | 定义 |
|------|------|
| **ACTIVE** | 可被新订阅引用；门禁认可该 `eventKey` |
| **DEPRECATED** | 不再对新订阅开放（目录维护，通常随发版 / 迁移） |

**集成订阅**

| 表达 | 定义 |
|------|------|
| **`enabled = true`** | 该集成接受此入站事件 |
| **`enabled = false`** 或不存在行 | 不接受；门禁返回未订阅类错误 |

新建集成**不会**自动插入全部订阅行；需管理员按事件启用。

### 10.3 业务规则

- 入站请求路径：`/v1/suppliers/{supplierId}/operators/{operatorId}/webhooks/{adapterType}/{eventKey}`。
- 门禁依次校验：目录 ACTIVE → 集成 ACTIVE+enabled 可加载 → adapter 支持该事件 → 订阅 `enabled`。
- 目录扩容以**迁移种子 + 发版**为主，不作为日常 admin 随意增删状态机运营。
- 集成软删（DEPRECATED）时，会将该集成下入站订阅批量 `enabled=false`。

### 10.4 状态迁移规则

**目录**

```
ACTIVE ──（发版 / 运维废弃）──► DEPRECATED
```

**订阅**

```
未订阅 / enabled=false  ◄──API 启用/停用──►  enabled=true
集成 DEPRECATED 时 ──► 订阅全部 enabled=false
```

| 迁移 | 触发方式 | 定时？ |
|------|----------|--------|
| 目录 ACTIVE → DEPRECATED | 迁移 / 发版维护（非日常 cron） | 否 |
| 订阅 enabled 开 / 关 | 集成创建或更新时的 `subscriptions[]` API | 否 |

### 10.5 操作者

| 动作 | 角色 |
|------|------|
| 配置集成入站订阅 | **Platform Admin**（随 Upstream Integration API） |
| 目录状态维护 | 发版 / 迁移（开发与平台运维） |
| 入站请求处理 | 上游系统调用 → API 同步处理（非订阅状态 cron） |

---

## 11. 产品配置域状态机（统一生命周期）

### 11.0 适用范围与定时说明

下列对象均实现**行级快照状态机**，以 UUID 主键为引用真源（不以内部递增 version 作为绑定依据）。**状态迁移均由管理员经 API / Portal 手工触发，不需要定时任务管理状态。**

| # | 对象 | 主键（示意） |
|---|------|--------------|
| 11.1 | APN Profile | `apnProfileId` |
| 11.2 | Roaming Profile | `roamingProfileId` |
| 11.3 | Carrier Service | `carrierServiceId` |
| 11.4 | Commercial Terms | `commercialTermsId` |
| 11.5 | Control Policy | `controlPolicyId` |
| 11.6 | Covered Network Profile | `coveredNetworkProfileId` |
| 11.7 | Price Plan | `pricePlanId` |
| 11.8 | Package（产品包） | `packageId` |
| 11.9 | Rating Fallback Package 映射 | `mappingId`（状态模型不同，见专节） |

### 11.0.1 统一状态定义（11.1–11.8）

| 状态 | 定义 |
|------|------|
| **DRAFT** | 草稿：可编辑业务内容；**不可**被下游正式引用为计费/开通真源 |
| **PUBLISHED** | 已发布：内容只读锁定；**可**被 Package 等下游引用 |
| **DEPRECATED** | 已废弃：对外只读（查询/审计）；不可再变更内容，不可再作为新绑定目标 |

### 11.0.2 统一迁移规则（11.1–11.8）

```
创建 ──► DRAFT ──:publish──► PUBLISHED ──:deprecate──► DEPRECATED
              │                 ▲
              └── 仅 DRAFT 可 Update / 原地改内容
```

| 规则 | 要求 |
|------|------|
| 创建 | 默认 **DRAFT** |
| 更新 | **仅 DRAFT** 允许改变业务内容；`PUBLISHED` / `DEPRECATED` 不可原地改 |
| 发布 | `POST …/:publish`：**仅 DRAFT → PUBLISHED** |
| 废弃 | `POST …/:deprecate`：**仅 PUBLISHED → DEPRECATED**；若仍有下游引用则拒绝（如 `409 RESOURCE_IN_USE`），错误中列出引用方 ID |
| 改版 | 基于已发布对象改版时，新建快照（新 UUID）或 clone / export-import 等资源特定流程，得到新 **DRAFT** |
| 定时 | **不需要** cron 驱动上述状态 |

引用总原则：**仅 `PUBLISHED` 快照可被产品包（及约定的下游）绑定。**

---

### 11.1 APN Profile

**用途**：接入点（APN）网络配置快照。

**状态 / 迁移**：同 §11.0（`DRAFT` → `PUBLISHED` → `DEPRECATED`）。

**业务规则要点**：

- 仅 `DRAFT` 可 `PUT` 更新；已发布改版可用 **clone** 生成新草稿（`sourceApnProfileId` 追溯）。
- **废弃门禁**：须为 `PUBLISHED`，且无非 `DEPRECATED` 的 **Carrier Service** 引用该 `apnProfileId`，且无 **Package** 仍间接依赖；否则拒绝并列出 `carrierServiceId` / `packageId`。

**操作者**：具备 Network Profile / 产品配置权限的 Platform / Reseller Admin（按 RBAC 与归属）。

---

### 11.2 Roaming Profile

**用途**：套外漫游费率等（MCC/MNC 条目）快照。

**状态 / 迁移**：同 §11.0。

**业务规则要点**：

- 仅 `DRAFT` 可更新；已发布改版采用 **export CSV → 编辑 → import CSV** 创建**新** `roamingProfileId`（**不提供**服务端 clone 作为主路径）。
- 发布时可写 `publishedAt` / `effectiveFrom`（实现上常见次月 1 日 UTC 生效窗口语义）；**生效窗口不等于由 cron 改写 `status`**。
- **废弃门禁**：须为 `PUBLISHED`，且无仍依赖该 ID 的 **Carrier Service**（及规格要求的其它引用方）；存在引用则拒绝。

**操作者**：同产品配置域授权角色。

---

### 11.3 Carrier Service

**用途**：将供应商/运营商侧网络能力与 APN、Roaming 等组装为可被 Package 引用的载波服务快照。

**状态 / 迁移**：同 §11.0。

**业务规则要点**：

- 创建为 `DRAFT`；所引用 **APN Profile / Roaming Profile** 须已为 **PUBLISHED**。
- 仅 `DRAFT` 可更新；`:publish` / `:deprecate` 规则同统一生命周期。
- **废弃门禁**：须为 `PUBLISHED`，且无 **Package** 仍绑定该 `carrierServiceId`；否则列出 `packageId`。

**操作者**：同产品配置域授权角色。

---

### 11.4 Commercial Terms

**用途**：商业条款快照（测试期、测试配额、到期条件/动作、承诺期等）。

**状态 / 迁移**：同 §11.0。

**业务规则要点**：

- 仅 `DRAFT` 可更新；可用 **clone** 基于既有快照建新草稿。
- Package 绑定的 `commercialTermsId` **必须**为 `PUBLISHED`。
- **废弃门禁**：须为 `PUBLISHED`，且无 Package 仍绑定该 ID；否则列出 `packageId`。
- 更新 **不得**改写已持久化的 `resellerId` / `enterpriseId`（创建时绑定）。

**操作者**：同产品配置域授权角色。

---

### 11.5 Control Policy

**用途**：控制策略模块快照（如达量断网、限速等；表 **`control_policy_modules`**）。

**状态 / 迁移**：同 §11.0。

**业务规则要点**：

- 与 Commercial Terms / Price Plan 对齐：`DRAFT` 可改、可 clone；`:publish` / `:deprecate`。
- Package 的 `controlPolicyId` **必须**为 `PUBLISHED`。
- **废弃门禁**：无 Package 仍绑定该 `controlPolicyId`。
- **注意**：库中另有企业级用量/账单侧 `control_policies` 表，**不是**本模块快照，勿混用。

**操作者**：同产品配置域授权角色。

---

### 11.6 Covered Network Profile

**用途**：套内覆盖（Covered MCC/MNC 集合）独立快照；Price Plan 通过 `coveredNetworkProfileId` 引用。

**状态 / 迁移**：同 §11.0。

**业务规则要点**：

- 仅 `PUBLISHED` 可被 Price Plan 引用。
- **废弃门禁**：须为 `PUBLISHED`，且**不存在**任意 Price Plan 仍引用本行；否则列出 `pricePlanId`。

**操作者**：同产品配置域授权角色。

---

### 11.7 Price Plan

**用途**：资费计划快照（One-time / Bundle / Tiered 等类型）；**MUST** 引用 `coveredNetworkProfileId`。

**状态 / 迁移**：同 §11.0。

**业务规则要点**：

- 仅 `DRAFT` 可 `PUT`；已发布改版推荐 Get 详情后 **新建**另一 `pricePlanId`（无独立 Clone API）。
- 发布后只读；**废弃门禁**：须为 `PUBLISHED`，且无任何 Package 仍绑定该 `pricePlanId`；否则列出 `packageId`。
- 所引用 Covered Network Profile 须为 `PUBLISHED`（创建/发布完整性校验）。

**操作者**：同产品配置域授权角色（按 enterprise / reseller 归属）。

---

### 11.8 Package（产品包）

**用途**：面向某 **reseller + enterprise** 的交付单元；绑定已发布的 Price Plan、Carrier Service、Commercial Terms、Control Policy，并在发布时建立上游产品映射。

**状态 / 迁移**：同 §11.0。

**业务规则要点**：

- 创建默认 `DRAFT`；绑定的 `pricePlanId` / `carrierServiceId` / `commercialTermsId` / `controlPolicyId` 在写入与发布时均须为 **PUBLISHED**（发布时还校验 Price Plan 所引 Covered Network 为 `PUBLISHED`）。
- 仅 `DRAFT` 可更新；**不得**改已持久化的 `resellerId` / `enterpriseId`。
- `:publish`：`DRAFT → PUBLISHED`；请求体须含上游 **`externalProductId`** 等（按契约）；发布成功后保持「已发布 Package ⇔ 一条上游映射」不变量。
- **废弃门禁**：须为 `PUBLISHED`，且不存在 `state in (ACTIVE, PENDING)` 的订阅引用该 `packageId`；`EXPIRED` / `CANCELLED` 等不阻塞。`DEPRECATED` 后只读。

**操作者**：Reseller Admin（本代理商范围）或 Platform Admin（须带合法 reseller/enterprise）。

---

### 11.9 Rating Fallback Package（批价回退包映射）

**用途**：当 SIM 无有效订阅用量需走 fallback rating 时，按 **`enterpriseId + resellerId + supplierId + operatorId`** 唯一范围指定回退使用的 **Package**。

> 本对象状态模型为 **映射启用态**，**不是** §11.0 的 `DRAFT`/`PUBLISHED`/`DEPRECATED` 三态。被指向的 Package 本身仍遵循 §11.8。

#### 状态定义

| 状态 | 定义 |
|------|------|
| **ACTIVE** | 该四元组当前生效的 fallback 映射（同一四元组最多一条 ACTIVE） |
| **INACTIVE** | 已停用的历史映射（不物理删除） |

#### 业务规则

- `set-default`：将映射置为 **ACTIVE**；`packageId` 须属于同一 enterprise/reseller，且 Carrier Service 对齐同一 supplier/operator；Package（及关联 Carrier / Covered 等）须满足批价校验（通常要求相关对象为 **PUBLISHED**）。
- 若该四元组已有 ACTIVE 记录，`set-default` **拒绝**，并返回既有 `mappingId` / `packageId`；须先 `unset-default`。
- `unset-default`：将当前 ACTIVE 置为 **INACTIVE**；若无 ACTIVE 则失败。
- **不需要定时任务**管理映射状态。

#### 状态迁移规则

```
（无 ACTIVE）──set-default──► ACTIVE ──unset-default──► INACTIVE
```

| 迁移 | 触发 | 定时？ |
|------|------|--------|
| → ACTIVE | `set-default` API | 否 |
| ACTIVE → INACTIVE | `unset-default` API | 否 |

#### 操作者

具备 Rating Fallback / 产品配置权限的 Platform 或 Reseller Admin（按 enterprise 归属与 RBAC）。

---

## 12. SIM（物理 SIM）

### 12.1 说明

物理 SIM 是平台核心资产对象。主状态（稳态）+ 过渡子状态（`lifecycle_sub_status`）共同描述生命周期。多数状态迁移经异步 **`SIM_STATUS_CHANGE` Job** 调用上游后落稳态；**`mark-test-ready`** 为本地同步迁移。另有 **TEST_READY 到期** 定时/手工评估，到期后同样入队正式生命周期 Job（含上游）。

> eSIM Profile 为轻量 CRUD，**不**共享本节完整异步状态机，此处不展开。

### 12.2 状态定义（稳态）

| 状态 | 定义 |
|------|------|
| **INVENTORY** | 库存：已入库，可分配企业；尚未进入测网/正式业务 |
| **TEST_READY** | 测试就绪：已分配企业，允许按 Commercial Terms 测期规则用网；**本地**自 `INVENTORY` 进入（不调上游） |
| **ACTIVATED** | 已开机：正式业务可用（上游已确认激活） |
| **DEACTIVATED** | 已停机：不可用网（可复机；退网前必经此态） |
| **RETIRED** | 已退网/拆机：终态（不可再激活） |

**过渡子状态**（进行中 / 失败，稳态字段暂不改）：`normal`、`activating` / `activation_failed`、`deactivating` / `deactivation_failed`、`reactivating` / `reactivation_failed`、`retiring` / `retire_failed`。`*ing` 期间拒绝其它方向生命周期操作（`409 LIFECYCLE_IN_PROGRESS`）。

### 12.3 业务规则

- 手工生命周期：`activate` / `deactivate` / `reactivate` / `retire` → `202` + Job；禁止 `ACTIVATED → RETIRED`（须先停机）。
- `mark-test-ready`：仅 `INVENTORY`（已分配企业）→ `TEST_READY`，同步、不上游。
- **TEST_READY 到期**（Worker cron 与 Admin `POST /v1/admin/jobs:test-ready-expiry-run` **同一规则**）：
  - **路径 A**：存在 MAIN 订阅（`ACTIVE` / `PROVISIONING` / `PENDING`）且 Package→Commercial Terms 可解析 → 按 `testPeriodDays`、`testQuotaMb`、`testExpiryCondition` 判定；到期按 `testExpiryAction` 入队激活或停机。
  - **路径 B**：无 MAIN 或无可解析条款 → 进入 `TEST_READY` 超过 **`TEST_READY_DAYS_WITHOUT_MAIN_SUBSCRIPTION`**（默认 30 天）后，固定入队 **停机**。
  - 起点：优先进入测网时间戳 / 状态历史；进行中生命周期则跳过。
- **与订阅耦合**（详见 §13）：无剩余 `ACTIVE` 订阅时可自动停机；唯一 `ACTIVE` 且 SIM 为 `DEACTIVATED` 时可自动开机。**不会**因订阅变 `ACTIVE` 把 `TEST_READY` 强行改为 `ACTIVATED`。

### 12.4 状态迁移规则

```
INVENTORY ──mark-test-ready（同步）──► TEST_READY
TEST_READY ──activate / 到期路径A(ACTIVATED)──► ACTIVATED
TEST_READY ──deactivate / 到期路径A(DEACTIVATED) / 路径B──► DEACTIVATED
ACTIVATED ──deactivate──► DEACTIVATED
DEACTIVATED ──reactivate──► ACTIVATED
DEACTIVATED ──retire──► RETIRED
（禁止 ACTIVATED → RETIRED）
```

| 迁移 | 触发方式 | 定时？ |
|------|----------|--------|
| INVENTORY → TEST_READY | `mark-test-ready` API | 否 |
| → ACTIVATED / DEACTIVATED / RETIRED（手工） | 生命周期 API → Job + 上游 | 否 |
| TEST_READY → ACTIVATED/DEACTIVATED（到期） | cron / Admin 评估 → Job + 上游 | **是**（路径 A/B） |
| 无 ACTIVE 订阅 → DEACTIVATED | 订阅到期/排程取消后的耦合 | 随订阅 cron |
| DEACTIVATED + 唯一 ACTIVE → ACTIVATED | 订阅开通成功后的耦合 | 随开通 Job |

### 12.5 操作者

| 动作 | 角色 |
|------|------|
| 导入 / 分配 / 生命周期 API | Platform / Reseller Admin（及规格允许的范围） |
| mark-test-ready | 同上 |
| TEST_READY 到期评估 | Worker（系统）；Admin 可手工触发 |
| 上游 Job 执行 | Worker |

---

## 13. Subscription（订阅）

### 13.1 说明

订阅表达 **SIM ↔ Package** 的实例关系。开通须经上游 **`SUBSCRIPTION_PROVISION` Job**；同步创建响应仅为 `PROVISIONING` 或 `PENDING`，**不得**在无上游确认时宣称 `ACTIVE`。上游失败时 **删除**本地订阅行（**无** `FAILED` 订阅态）。

### 13.2 状态定义

| 状态 | 定义 |
|------|------|
| **PENDING** | 预约：尚未到达 `effectiveAt`；未进入上游开通执行 |
| **PROVISIONING** | 已受理，上游开通 Job 排队或执行中；**尚未**确认开通 |
| **ACTIVE** | 上游开通成功且已生效；**唯一**计入业务「活跃订阅」 |
| **CANCELLED** | 未生效即撤销，或策略允许的取消终态 |
| **EXPIRED** | 到期或被替换/排程取消后归档 |

> **活跃订阅口径**：仅 `ACTIVE`。`PROVISIONING` / `PENDING` **不算**活跃（用于 SIM 停机/开机耦合与「是否还有可用订户」判断）。

### 13.3 业务规则

- **创建**：校验 SIM/Package/供应商映射等 → 写订阅 + `SUBSCRIPTION_PROVISION` Job → `202`；成功 → `ACTIVE`；失败 → **删行** + Job/事件失败通知。
- **ONE_TIME**：创建时按 `validityDays` + `expiryBoundary` 写 `expires_at`；Worker 扫描到期后 `ACTIVE` → `EXPIRED`。**不**默认取消上游产品包（避免误伤 PAYG/MAIN）。
- **月度类资费**（FIXED / SIM_DEPENDENT / TIERED）：**无**日历有效期自动 `EXPIRED`；结束靠退订排程、切换归档等。
- **退订**：`ACTIVE` 不可立即取消，须排程（周期末或 ONE_TIME 的 `expiresAt`）；`PENDING` 可立即 `CANCELLED`；`PROVISIONING` / 已终态拒绝。
- **与 SIM 耦合**：
  - 失去最后一条 `ACTIVE`（ONE_TIME 到期或排程取消等）且 SIM 为 `ACTIVATED`/`TEST_READY` → 入队 SIM 停机；
  - 变为 `ACTIVE` 且 SIM 为 `DEACTIVATED`、该卡恰好 1 条 `ACTIVE` → 入队 SIM 开机；
  - SIM 已是 `ACTIVATED` / 处于 `TEST_READY` / `INVENTORY` / `RETIRED` → 不因订阅变 `ACTIVE` 改稳态（测期仍由 Commercial Terms 管）。

### 13.4 状态迁移规则

```
[*] ──立即创建──► PROVISIONING ──上游成功──► ACTIVE
PROVISIONING ──上游失败──► [*]（删除行）
[*] ──预约创建──► PENDING ──到点──► PROVISIONING → …
PENDING ──cancel──► CANCELLED
ACTIVE ──ONE_TIME 到期 / 排程取消执行 / 切换归档──► EXPIRED
ACTIVE ──（不允许 immediate cancel；仅排程）──► … → EXPIRED
```

| 迁移 | 触发方式 | 定时？ |
|------|----------|--------|
| → PROVISIONING / PENDING | 创建订阅 API | 否 |
| PROVISIONING → ACTIVE | 开通 Job 成功 | Worker 消费 Job |
| PROVISIONING → 删除 | 开通 Job 失败 | Worker |
| PENDING → CANCELLED | cancel API | 否 |
| ACTIVE → EXPIRED（ONE_TIME） | `SUBSCRIPTION_ONE_TIME_EXPIRY` cron | **是** |
| ACTIVE → EXPIRED（排程） | `subscription_cancel_schedules` cron | **是** |
| 无 ACTIVE → SIM 停机 | 耦合逻辑 | 随上述 cron / Job |
| 唯一 ACTIVE + DEACTIVATED → SIM 开机 | 耦合逻辑 | 随开通 Job |

### 13.5 操作者

| 动作 | 角色 |
|------|------|
| 创建 / 切换 / 取消订阅 | Platform / Reseller / Enterprise（按 RBAC 与企业归属） |
| 开通 Job / ONE_TIME 到期 / 排程取消 | Worker（系统） |
| SIM 耦合停机/开机 | Worker（系统，经生命周期 Job） |

---

## 14. Bill（账单）

### 14.1 说明

账单按企业账期生成，经发布后进入应收生命周期。具备显式状态机；其中 **`PUBLISHED → OVERDUE`** 由定时任务按账单 **`dueDate`（`bills.due_date`）** 自动迁移。已发布账单的金额不可回写篡改，差异走调账单（Adjustment Note）路径（本节不展开调账状态机）。

### 14.2 状态定义

| 状态 | 定义 |
|------|------|
| **GENERATED** | 已出账生成，尚未对外发布；可继续处理至发布或作废 |
| **PUBLISHED** | 已发布给客户/代理商侧可见；进入应收；金额锁定 |
| **OVERDUE** | 已过到期日仍未付清（由系统按 `dueDate` 自动判定） |
| **PAID** | 已人工核销为已支付（线下收款后标记） |
| **WRITTEN_OFF** | 坏账核销，不再催收 |
| **VOIDED** | 已作废（终态；同账期可按规则重新出账） |

### 14.3 业务规则

- **生成**：出账 Job（`BILLING_GENERATE`）写入账单，通常为 `GENERATED`；生成时系统会写入默认 **`dueDate`**（实现上一般为账期末 + 30 天）。若配置 `autoPublish`，可在同一 Job 内直接发布。
- **发布**（`GENERATED → PUBLISHED`）：
  - 手工：`POST /v1/bills/{billId}:publish`（Reseller 等授权角色）。
  - 请求体 **`dueDate` 可选**：不提供则沿用账单上已有 `dueDate`（含生成时写入的默认值）；**若提供则覆盖**为用户指定日期。
  - 因此日常可不填 `dueDate`；系统生成时已写入即可支撑后续逾期判定。
- **逾期**（`PUBLISHED → OVERDUE`）：Worker **`DUNNING_CHECK_CRON`**（默认每日）扫描：`status = PUBLISHED` 且 **`dueDate ≤ 今日`** → 自动迁为 `OVERDUE`（写 `overdueAt`）。无 `dueDate` 的账单不会被本规则自动逾期。
- **已付 / 坏账 / 作废**：均为人工 API（mark-paid、write-off、void）；**不**由定时任务自动核销或作废。
- Dunning 催收记录（预警 / 挂起等）可与逾期账单联动，**不改变**企业主状态；与账单状态机并行，细节以信控规格为准。

### 14.4 状态迁移规则

```
GENERATED ──publish──► PUBLISHED ──pay──► PAID
     │                      │
     │ void                 ├──overdue（cron，dueDate≤今日）──► OVERDUE ──pay──► PAID
     ▼                      │                                      │
  VOIDED                    │                                      └──write_off──► WRITTEN_OFF
                            │
PUBLISHED / OVERDUE ──void──┘
```

| 迁移 | 触发方式 | 定时？ |
|------|----------|--------|
| GENERATED → PUBLISHED | 手工 publish，或出账 Job + autoPublish | 否（出账 Job 可被调度触发，但 publish 动作本身非独立「逾期类」cron） |
| PUBLISHED → OVERDUE | `DUNNING_CHECK_CRON` / `runDunningCheck`，条件 `dueDate ≤ 今日` | **是** |
| PUBLISHED / OVERDUE → PAID | 手工 mark-paid | 否 |
| OVERDUE → WRITTEN_OFF | 手工 write-off | 否 |
| GENERATED / PUBLISHED / OVERDUE → VOIDED | 手工 void | 否 |

### 14.5 操作者

| 动作 | 角色 |
|------|------|
| 触发出账 / 发布账单 | Platform / Reseller Admin（授权范围内） |
| 标记已付 / 坏账核销 / 作废 | 同上（按 RBAC） |
| PUBLISHED → OVERDUE | Worker（系统） |

---

## 15. Job（异步任务）

### 15.1 说明

**Job** 是平台异步工作单元的统一载体（如 SIM 生命周期、订阅上游开通、出账、用量批价、Webhook 投递、导入等）。`jobs` 表上有明确的 **`status` 枚举**，但**不存在**类似账单「到期日一到就统一翻状态」的独立业务 cron。

状态如何迁移，取决于 **该条 Job 的 `jobType` 被 Worker 如何执行、以及该次执行的结果**（成功、失败、上游 pending 续跑、允许时的取消等）。不同任务类型的业务副作用各不相同，但 Job 行自身的状态词汇表是共用的。

### 15.2 状态定义

| 状态 | 定义 |
|------|------|
| **QUEUED** | 已入队，等待 Worker 领取 |
| **RUNNING** | Worker 已领取，正在执行（含上游 pending、需续跑的场景） |
| **SUCCEEDED** | 该任务类型定义下的执行已成功结束 |
| **FAILED** | 执行失败（含重试耗尽、上游不支持等；细节见 `error` / payload） |
| **CANCELLED** | 在允许取消的任务类型上，被取消后的终态 |

### 15.3 业务规则

- **创建**：业务 API（或系统内部）插入 Job，通常为 **`QUEUED`**，并返回 `jobId`（常见 HTTP **202**）。
- **推进**：Worker 轮询领取 `QUEUED` → 置 **`RUNNING`** → 按 `jobType` 调用对应 handler；终态为 **`SUCCEEDED`** 或 **`FAILED`**。部分类型（如需等上游确认的 `SIM_STATUS_CHANGE`）可在 `RUNNING` 下多次续跑，直至成功或失败。
- **取消**：仅部分类型、且通常仅 **`QUEUED` / `RUNNING`** 可取消 → **`CANCELLED`**。例如 **`SIM_STATUS_CHANGE` 不可取消**（须另提新的生命周期请求）。
- **与「定时任务」的区别**：
  - Worker 上的 **cron**（如账单逾期、TEST_READY 到期、ONE_TIME 订阅到期）改变的是 **Bill / SIM / Subscription** 等业务对象状态；它们**可能顺带创建新的 Job**，但 cron **不是**在扫 Job 的「到期字段」来翻 Job 状态。
  - Job 状态迁移 = **队列消费 + 各任务执行结果**，不是日历到期规则。
- 终态 Job 一般可查询；客户端通过 `GET /v1/jobs/{jobId}` 与事件（如 **`JOB_FINISHED`**）获知结果。

### 15.4 状态迁移规则（通用骨架）

```
QUEUED ──Worker 领取──► RUNNING ──执行成功──► SUCCEEDED
   │                       │
   │（若该类型允许取消）     ├──执行失败──► FAILED
   └───────────────────────┴──取消──► CANCELLED
```

| 迁移 | 触发方式 | 「到期类」定时翻状态？ |
|------|----------|------------------------|
| → QUEUED | 业务 API / 系统入队 | 否 |
| QUEUED → RUNNING | Worker 领取并开始执行 | 否（队列消费） |
| RUNNING → SUCCEEDED / FAILED | 该 `jobType` handler 的执行结果 | 否 |
| QUEUED / RUNNING → CANCELLED | 取消 API（仅允许的类型） | 否 |

具体 `jobType`（SIM_STATUS_CHANGE、SUBSCRIPTION_PROVISION、BILLING_GENERATE、USAGE_RATING_ROLLUP、WEBHOOK_DELIVERY、SIM_IMPORT 等）的入参、可否取消、成功时改哪些业务对象，见各模块规格与 OpenAPI；**本节只固定 Job 行状态语义**。

### 15.5 操作者

| 动作 | 角色 |
|------|------|
| 创建各类业务 Job | 各业务 API 的授权调用方（或系统内部） |
| 查询 Job | Platform / Reseller / Enterprise（按 Job 租户范围） |
| 取消 Job | 授权角色 + 该 `jobType` 允许取消时 |
| 执行并改写 Job 状态 | Worker（系统） |

---

## 16. Diagnostics 与 Events（无对象状态机）

### 16.1 Diagnostics（SIM 诊断）

**说明**：诊断能力（连通性、位置、上游诊断查询、重置连接等）是对 SIM / 上游的**即时查询或操作**，不是带生命周期状态字段的持久业务实体。

| 项 | 结论 |
|----|------|
| 是否定义对象状态枚举 | **否** |
| 是否有状态机 / 定时翻状态 | **否** |
| 持久化 | 可能写入审计、Job（如重置类异步）或上游回执，但**没有**「诊断单 status」状态机 |

响应中的在线/离线、信号等是**当时快照**，不是本平台维护的稳态迁移。

### 16.2 Events（事件流）

**说明**：`events` 是追加写入的事件流水（含出站 Webhook 目录事件与内部追踪事件）。行上有 **`event_type`**（及分类查询），**没有** `OPEN`/`CLOSED` 一类可迁移的对象状态。

| 项 | 结论 |
|----|------|
| 是否定义对象状态枚举 | **否**（类型是事件种类，不是状态机） |
| 是否有状态迁移 | **否**（事件一旦写入即历史记录） |
| 与定时任务 | 无关；由业务动作 / Worker / 入站 Webhook 等**产生新事件**，不翻旧事件状态 |

查询：`GET /v1/events`（及 CSV / catalog）；投递成功与否记在 Webhook 投递表，不属于 Events 行状态。

---

## 17. Alert（告警实例）

### 17.1 说明

**告警实例**（`alerts` 表）表示评估引擎发现的运营告警。具备 **`alert_status` 枚举**；规则启用/阈值/抑制窗口在 **Alert Configurations**（配置域，见 §11 相关），**不**回写历史告警实例的配置快照。

> 配置表 profile 自身的 `ACTIVE`/`INACTIVE` 属于配置对象，不是本节告警实例状态机。

### 17.2 状态定义（枚举）

| 状态 | 定义 |
|------|------|
| **OPEN** | 未确认的活动告警（新建或再次命中合并后的默认态） |
| **ACKED** | 已由运营人员确认（acknowledge） |
| **RESOLVED** | **保留状态**：表示「已关闭 / 条件已恢复」等语义的预留枚举；V1.1 **不**自动或手工迁入。待后续业务需求再完善迁移规则与 API |
| **SUPPRESSED** | **保留状态**：表示「以 status 列表达被抑制」的预留枚举；V1.1 **不**以此状态落库。当前抑制靠 `suppressMinutes` / `suppressedUntil` **跳过新建**；待后续需求再决定是否启用本状态 |

另有字段 **`suppressedUntil`**：在抑制窗口内**跳过新建**同类告警（V1.1 抑制实现），与保留态 `SUPPRESSED` 分开理解。

### 17.3 状态机如何迁移（V1.1 实际路径）

```
（评估命中）──create──► OPEN
OPEN ──同一去重键再次命中（merge）──► OPEN（刷新 lastSeen / currentValue 等）
ACKED ──同一去重键再次命中（merge）──► OPEN（实现上会写回 OPEN）
OPEN ──POST …/alerts/{alertId}:acknowledge──► ACKED
```

| 迁移 | 触发方式 | 定时？ |
|------|----------|--------|
| → OPEN（新建） | Worker **`ALERT_EVAL_CRON`** → `runAlertEvaluation` → `createAlert` | **是**（评估调度） |
| → OPEN（合并刷新） | 同上去重键再次命中；更新指标；必要时发 `ALERT_MERGED` | **是**（评估） |
| OPEN → ACKED | 人工 `POST /v1/alerts/{alertId}:acknowledge` | **否** |
| → RESOLVED | **保留**：V1.1 不迁移 | — |
| → SUPPRESSED（status 列） | **保留**：V1.1 不迁移；抑制见 `suppressedUntil` / 跳过创建 | — |

要点：

1. **创建 / 再开**：靠定时告警评估（及探测类前置任务），不是「到期日翻状态」。
2. **确认**：仅 **OPEN → ACKED**；非 OPEN 再确认 → 冲突错误。
3. **RESOLVED / SUPPRESSED**：产品约定为**保留状态**，待业务发展再完善；summary 等接口仍可能按四态统计（保留态计数通常为 0）。
4. 新建发 **`ALERT_TRIGGERED`**（可出站 Webhook）；确认发内部 **`ALERT_ACKNOWLEDGED`**。

### 17.4 操作者

| 动作 | 角色 |
|------|------|
| 评估并创建/合并告警 | Worker（系统） |
| 列表 / 详情 / 汇总 / 导出 | 授权的 Platform / Reseller / Enterprise |
| 确认（acknowledge） | 同上（运营人员） |
| 配置规则（非实例状态） | Platform / Reseller Admin（Alert Configurations） |

---

## 18. Alert Config Profile（告警配置表）

### 18.1 说明

告警 **配置表（Profile）** 属于 Alert Configurations ABC 模型中的配置对象（`alert_config_profiles`），按 `PLATFORM` / `RESELLER` / `ENTERPRISE` scope 存放启用规则集。有明确 **`status`**，由管理员 API 维护；**与定时任务无关**（评估 cron 只**读取**生效配置，不翻配置表状态）。

### 18.2 状态定义

| 状态 | 定义 |
|------|------|
| **ACTIVE** | 该 scope 当前生效的配置表（同一 scope 实体至多一条 ACTIVE） |
| **INACTIVE** | 已停用的配置表（保留历史，不参与解析） |

### 18.3 业务规则与迁移

- 创建/更新配置表时可指定或切换 `ACTIVE` / `INACTIVE`。
- 同一 scope 已存在 ACTIVE 时，再激活另一份会冲突（须先停用）。
- 更具体 scope 的 `enabled=false` 等规则项语义见告警配置规格；**不改变**本节 profile 的 ACTIVE/INACTIVE 定时逻辑（无）。

| 迁移 | 触发方式 | 定时？ |
|------|----------|--------|
| → ACTIVE / INACTIVE | Alert Configurations API（管理员） | **否** |

### 18.4 操作者

Platform / Reseller Admin（按 scope 与 RBAC）。

---

## 19. Reports（报表）

### 19.1 说明

报表模块提供用量、经营等**查询与导出**能力，结果为即时或按筛选条件聚合的只读视图。

| 项 | 结论 |
|----|------|
| 是否定义对象状态枚举 | **否** |
| 是否有状态机 / 定时翻状态 | **否** |

底层可能依赖已批价/汇总的数据表，但 **Reports 本身没有业务对象状态机**。

---

## 20. Reconciliation（对账运行）

### 20.1 说明

对账以**一次运行（run）**为对象，比对上游与本地 SIM 等差异，并可按策略回写。运行记录有明确 **status**；状态随**该次对账执行过程**推进，**不是**「到期日一到自动翻状态」类业务 cron。

> 运维上 Worker 可能定时**发起**对账 Job，那只是触发执行；run 的 `RUNNING`→终态仍由本次执行结果决定，与 Bill 逾期翻态不同。产品口径：**对账对象状态机与定时任务无关**。

### 20.2 状态定义

| 状态 | 定义 |
|------|------|
| **RUNNING** | 对账运行进行中 |
| **COMPLETED** | 本轮对账正常结束 |
| **FAILED** | 本轮对账失败（若实现写入失败终态） |

（对外列表/契约中亦可能出现等价表述如 `COMPLETED`；以 OpenAPI / 实现为准。）

### 20.3 迁移规则

```
（API 或 Job 启动）──► RUNNING ──执行成功──► COMPLETED
                         └──执行失败──► FAILED（若适用）
```

| 迁移 | 触发方式 | 定时翻状态？ |
|------|----------|--------------|
| → RUNNING | 手工/API 启动，或调度入队后的执行开始 | **否**（执行驱动） |
| RUNNING → COMPLETED / FAILED | 该次对账 handler 结束 | **否** |

### 20.4 操作者

| 动作 | 角色 |
|------|------|
| 启动 / 查询对账 | Platform（及规格允许的运维角色） |
| 执行并更新 run 状态 | Worker / 服务进程 |

---

## 21. Audit Logs（审计日志）

### 21.1 说明

`audit_logs` 记录谁在何时对何对象做了何操作（before/after 等）。为**追加型审计流水**。

| 项 | 结论 |
|----|------|
| 是否定义对象状态枚举 | **否** |
| 是否有状态迁移 | **否**（写入即历史；可查询、不可「改状态」） |
| 与定时任务 | 无关 |

---

## 附录 A：对象与定时任务对照

| 对象 | 是否有定时状态迁移 |
|------|--------------------|
| Access Token | 否（请求时按 `exp` 判定） |
| Supplier | 否 |
| Operator | 无状态机 |
| Reseller | 否 |
| Enterprise | 否（含 Dunning 不改企业状态） |
| Department | 无状态机 |
| User（Reseller / Enterprise） | 否（且暂无状态机管理产品） |
| Upstream Integration | 否 |
| Outbound Webhook 订阅 | 否（投递 cron 不改订阅状态） |
| Inbound Webhook 目录 / 订阅 | 否 |
| APN / Roaming / Carrier Service / Commercial Terms / Control Policy / Covered Network / Price Plan / Package | 否 |
| Rating Fallback Package 映射 | 否 |
| SIM | **是**（TEST_READY 到期 → 入队激活/停机；另可被订阅耦合驱动） |
| Subscription | **是**（ONE_TIME 到期、排程取消 → EXPIRED；并可能触发 SIM 耦合） |
| Bill | **是**（PUBLISHED 且 dueDate≤今日 → OVERDUE） |
| Job | **否**（状态由 Worker 按每条任务执行结果推进；cron 不「到期翻 Job 状态」） |
| Diagnostics / Events | **否**（无对象状态机） |
| Alert 实例 | **部分**：评估 cron → OPEN（创建/合并）；手工 → ACKED；**RESOLVED / SUPPRESSED 为保留状态** |
| Alert Config Profile | **否**（ACTIVE/INACTIVE 仅手工/API） |
| Reports | **否**（无状态机） |
| Reconciliation run | **否**（状态由该次执行推进；非到期翻态） |
| Audit Logs | **否**（无状态机） |

## 附录 B：操作者速查

| 对象 | Platform Admin | Reseller Admin | 说明 |
|------|----------------|----------------|------|
| Access Token 时效 | — | — | 系统按 `exp` |
| Supplier 状态 | ✅ | ❌ | |
| Operator 主数据 | ✅ | ❌ | 无状态机 |
| Reseller 状态 | ✅ | ❌ | |
| Enterprise 状态 | ✅ | ✅（本代理商） | |
| Department | 组织管理权限 | 视 RBAC | 无状态机 |
| User 状态机 | ❌（暂不提供） | ❌ | 字段存在，无运营状态机 |
| Upstream Integration | ✅ | ❌ | |
| Outbound Webhook 订阅 | ✅（及授权角色） | ✅（授权范围内） | 投递由 Worker |
| Inbound Webhook 订阅 | ✅ | ❌ | 随集成配置 |
| 产品配置域 11.1–11.8 | ✅ | ✅（归属范围内） | publish / deprecate 手工 |
| Rating Fallback 映射 | ✅ | ✅（归属范围内） | set / unset-default |
| SIM 生命周期 | ✅ | ✅（归属范围内） | TEST_READY 到期：Worker + Admin |
| Subscription | ✅ | ✅（及 Enterprise 授权） | 到期/排程由 Worker |
| Bill | ✅ | ✅（归属范围内） | OVERDUE 由 Worker；发布时可选覆盖 dueDate |
| Job | 查询/部分取消 | 查询/部分取消（范围内） | 状态由 Worker 按任务执行推进 |
| Diagnostics / Events | 查询类 | 查询类（范围内） | 无状态机 |
| Alert 实例 | ✅ | ✅（范围内） | 确认手工；创建/合并由评估 Worker |
| Alert Config Profile | ✅ | ✅（归属范围内） | ACTIVE/INACTIVE 手工 |
| Reports | 查询 | 查询（范围内） | 无状态机 |
| Reconciliation | ✅（启动/查询） | 视规格 | 执行驱动状态 |
| Audit Logs | 查询 | 查询（范围内） | 无状态机 |

---

*文档版本：第 1–21 节已齐（本轮识别的全部对象）。后续若新增业务对象，再按同一结构追加。*
