# Feature Specification: IoT CMP Reseller System

**Feature**: `iot-cmp-reseller`
**Created**: 2026-02-08
**Status**: Draft
**Input**: User description: "根据现有的需求文档重建SPEC /Users/yangzong.exe/Downloads/04_Project_CMP1/CMP_Requirements_Workshop.md"

## 工程澄清文档（Clarifications）

与实现细节、异步任务与 FAQ 相关的补充说明（不替代正文需求，供研发与验收对照）：

- [账单状态机（GENERATED / PUBLISHED、`publish` 与出账任务关系等）](clarifications/bill-status-machine.md)
- [调账单下期结算（Adjustment Settlement · CREDIT/DEBIT · APPROVED→APPLIED）](clarifications/adjustment-settlement.md)
- [Jobs：`SIM_STATUS_CHANGE` 与上游供应商同步](clarifications/jobs-sim-status-change.md)
- [订阅开通、上游产品映射与 Package 发布（`SUBSCRIPTION_PROVISION`）](clarifications/subscription-provisioning-upstream-mapping.md)
- [运营商身份模型：`business_operators` 与 `operators`、`operatorId` 解析](clarifications/operator-identity-model.md)
- [上游集成配置：DB 凭证、`adapterType`、Vendor 适配器、入站 Webhook](clarifications/upstream-integration-config.md)
- [**入站 Webhook 事件目录与集成订阅（初步方案 · 待评审）**](clarifications/upstream-inbound-webhook-catalog.md)
- [Webhook 向下游投递与失败重试（`WEBHOOK_DELIVERY`）](clarifications/webhook-delivery.md)

## 产品与租户分层原则（显式约束）

本规范在「可复用资产」与「面向客户的交付」之间采用下列**固定分层**，研发、API 与数据模型 MUST 与之对齐：

1. **Reseller 级通用目录（不绑定 enterprise）**  
   下列能力作为**同一代理商下可复用**的配置与条款，**不以 `enterpriseId` 表达「给谁用」**；跨客户复用时**不**要求为每个企业复制一条模块行：  
   - **Network Profile 子模块**：APN Profile、Roaming Profile（归属与权限以 reseller 为界）。  
   - **Carrier Service**（对外契约不涉及 `enterpriseId`）。  
   - **Commercial Terms**、**Control Policy**（条款与策略模板，按 reseller 设计与授权）。

2. **Enterprise 级定制（含敏感商业数据）**  
   **Price Plan（资费计划）** 含价格等**敏感信息**，**MUST** 按 **enterprise** 定制，请求/存储中 **MUST** 包含 **`enterpriseId`**（或与 **FR-061** 一致的 ENTERPRISE `tenants.tenant_id` 语义），以便权限隔离、审计与合规。

3. **Package（产品包）为唯一装配点**  
   **Subscription Package / Package** **MUST** 绑定 **enterprise**（**`enterpriseId` 必填**），并将面向计费的 **`pricePlanId`** 与网络/条款/策略侧的 **`carrierServiceId`、`commercialTermsId`、`controlPolicyId`** **组装为一次交付**；V1.1 当前实现中 **`pricePlanId`** 与发布前补齐的 **`carrierServiceId`** 为核心必备绑定，**`commercialTermsId`** / **`controlPolicyId`** 为可选绑定。**「哪个企业使用哪套可复用模块」** 通过 **Package（及订阅）** 表达，而**不**依赖在 Carrier Service / Commercial Terms / Control Policy 等模块行上重复刻画 enterprise（若历史表结构仍存模块级 `enterprise_id` 列，视为与本原则不一致的遗留，以迁移或废弃为方向）。

4. **Rating Fallback Package 映射为企业级定制**  
   无有效订阅用量的 fallback rating MUST 以 **`enterpriseId + resellerId + supplierId + operatorId`** 作为唯一业务范围。Roaming tariff 与 fallback package 均可能按企业客户定制，服务端 MUST 校验：`enterpriseId` 为真实 ENTERPRISE tenant；`resellerId` 为真实 RESELLER tenant；`enterpriseId` 隶属于 `resellerId`；`supplierId` 与 `operatorId` 为真实且互相匹配的供应商/运营商关联；`packageId` 必须属于同一 `enterpriseId`、同一 `resellerId`，且 carrier service 绑定同一 `supplierId/operatorId`。同一四元组最多存在一条 `ACTIVE` fallback 映射；若该四元组已存在 ACTIVE 记录，`set-default` MUST 拒绝并返回既有 `mappingId` 与 `packageId` 信息，用户需先调用 `unset-default` 停用旧映射后再设置新映射。`unset-default` 仅停用当前 ACTIVE 记录，不物理删除；若该四元组不存在 ACTIVE 记录，`unset-default` MUST 失败。

### Price Plan 创建与列表（Create / List）：`resellerId` 与 `enterpriseId` 规则 [V1.1 澄清]

下列规则适用于 **Create Price Plan** 与 **List Price Plan**；二者在**可接受的入参、身份含义与匹配约束**上 **MUST** 一致。具体由路径、查询或请求体中的哪些字段承载 **`resellerId` / `enterpriseId`** 以 **OpenAPI** 为准；语义如下。

1. **必填维度**  
   调用方 **MUST** 能显式或等价地同时给出 **「归属哪一代理商」** 与 **「哪一家企业」**——即 **`resellerId`** 与 **`enterpriseId`**。其中 **`resellerId` MUST** 与 **`tenants` 表中 `tenant_type=RESELLER` 行的 `tenant_id`** 对齐（**reseller tenant_id**），**`enterpriseId` MUST** 与 **`tenants` 中 `tenant_type=ENTERPRISE` 行的 `tenant_id`** 对齐；与全文 **「代理商对外身份约定」** 一致，禁止与 `resellers.id` 等域表内部主键混用，除非某端点文档单独立字段名（如 `resellerRecordId`）区分。

2. **与 enterprise 的匹配（不区分 token 类型）**  
   无论使用 **reseller 身份、admin（platform）身份** 或未来扩展的 **API Key 类型**，只要请求中带有 **`resellerId` 与 `enterpriseId`（或经省略/缺省后解析出的等价 `resellerId`）**，服务端 **MUST** 验证二者在租户模型中**互相对应**：该 **`enterpriseId`** 所指的 ENTERPRISE 行 **MUST** 在租户树上归属所选 **`resellerId`**（通常表现为 **`tenants.parent_id` = `resellerId`**，或与数据模型、迁移后的 **`customers.reseller_tenant_id` 等**实现约定的**等价判据**一致）。**不满足时 MUST 拒绝请求**（如 `400` / `403`，业务码以 OpenAPI 为准），**MUST NOT** 静默改写到其它 enterprise 或 reseller。

3. **Reseller 身份（如 JWT 中 `roleScope=reseller` 且具备 Price Plan 写/读授权）**  
   - **MAY** 省略 **`resellerId`**：服务端 **MUST** 将「当前 `resellerId`」视为 **与 token 绑定的** **reseller tenant_id**（**即为当前代理商自身**创建/查询所归属的价计划集合）。  
   - 若**显式提供** **`resellerId`**：**MUST** 与 token 中解析出的 **reseller tenant_id** **完全一致**；否则 **MUST** 拒绝（**如 `403` / `400`**，以 OpenAPI 为准）。

4. **Customer 身份**（如企业/部门侧 token，**非**平台、**非**代理商管理侧）  
   **MUST NOT** 授权 **Create** 与 **List** Price Plan；请求 **MUST** 以 **未授权** 拒绝（**如 `403`**，与 **RBAC** 及 OpenAPI 一致）。

5. **Admin / 平台**（**如** 内部 `X-API-Key`、或语义为 **platform_admin / platform** 的凭证）  
   **MUST** 在请求中**显式提供** **`resellerId`**，不得依赖「仅给 `enterpriseId` 由系统猜测代理商」。缺少 **`resellerId`** 时 **MUST** 拒绝（**如 `400`**，以 OpenAPI 为准），以便台帐与审计上明确**「在谁的代理商域内」** 创建/列举价计划。

6. **List 与 Create 对齐**  
   **List Price Plan** 的 **`resellerId` / `enterpriseId` 出现方式、可省略性、与上述身份分支及「reseller—enterprise 匹配」规则** 与 **Create Price Plan** **MUST** 相同；**不得** 在 List 上采用更松或更严的一套约定而不写入 OpenAPI/本文。

<a id="spec-price-plan-http-scope"></a>

### Price Plan HTTP 接口范围 [V1.1 · 与 tasks.md US3 一致]

**产品 MUST** 仅在 **Price Plan** 模块暴露下列 **六种** HTTP 能力（**精确路径、query、请求体** 以 **OpenAPI** 为真源；与 [tasks.md — US3 — Price Plan 模块 HTTP 范围](./tasks.md#us3-price-plan-http-scope) **一致**）：

1. **Create Price Plan** — 主路径 **`POST /v1/enterprises/{enterpriseId}/price-plans`**（**`resellerId` / `enterpriseId` 规则**见上节 **「Price Plan 创建与列表」**）。
2. **List Price Plans** — **`GET /v1/enterprises/{enterpriseId}/price-plans`**（与 Create **同一套** 身份与匹配规则）。
3. **Get Price Plan Detail** — **`GET /v1/price-plans/{pricePlanId}`**。
4. **Update Price Plan** — **`PUT /v1/price-plans/{pricePlanId}`**（**仅 `DRAFT`**）。
5. **Publish Price Plan** — **`POST /v1/price-plans/{pricePlanId}:publish`**。
6. **Deprecate Price Plan** — **`POST /v1/price-plans/{pricePlanId}:deprecate`**。

**MUST NOT** 实现 **`POST /v1/price-plans:clone`**、**`POST /v1/price-plans/{id}/versions`** 及**任何**未列入上表的 **Price Plan** 专用路由。由既有快照衍生新快照 **MUST** 采用 **Get detail → 客户端（或 Portal）编辑 → Create**；**MUST NOT** 依赖服务端「一键克隆」类接口。

## User Scenarios & Testing *(mandatory)*

<!--
  CRITICAL - Completeness Guarantee: spec.md MUST be a superset of user input (spec.md >= user input).
  Every line of information from user input must be traceable in spec.md.
  Source: CMP_Requirements_Workshop.md (1523 lines)
-->

### User Story 1 - 多租户与角色权限管理 (Priority: P1)

系统必须实现 V1.1 当前租户树：**代理商（RESELLER） -> 企业（ENTERPRISE） -> 部门/项目（DEPARTMENT）**。供应商、运营商与上游集成属于平台主数据和业务关联，不作为 `tenants` 租户树节点。系统支持 RBAC 权限模型，包含以下角色：

- **系统管理员（platform_admin）**：平台级超级管理员（仅内部），用于租户初始化、全局配置、运维与审计，全局访问权限无数据隔离限制
- **代理商组织角色**：
  - 管理员（reseller_admin）：代理商及下属企业完整权限，创建用户/企业/分配
  - 销售总监（reseller_sales_director）：仅限被分配企业集合，管理下属销售
  - 销售（reseller_sales）：仅限被分配企业，SIM 分配/订阅管理
  - 财务（reseller_finance）：代理商维度财务数据只读，不支持写入操作
- **企业组织角色**：
  - 管理员（customer_admin）：企业及所有部门完整权限
  - 运维（customer_ops）：仅所属部门 SIM 卡，按授权清单限制操作类型

**权限边界**：平台按"系统管理员 / 代理商组织 / 企业组织 / 部门"分层隔离与授权，数据默认最小可见、最小可操作。

**实体建模**（CMP.xlsx 对齐）：
- 采用**独立表**建模策略。`tenants` 表作为统一身份标识与层级查询基础表保留，各域表（resellers/customers/suppliers）保持独立字段与状态管理。V1.1 Fastify 服务端创建代理商/企业时写入 `tenants` + 域表记录 + 审计日志；数据库 RPC `create_reseller()` / `create_customer()` 可保留为迁移和运维辅助，但对外 API 以 Fastify 路由行为为准。`buildTenantFilterAsync()` 基于 `tenants.tenant_id` + `parent_id` 实现租户隔离。
- `resellers` 表：id（系统生成，唯一）、name（非空且全局唯一）、status（ACTIVE/DEACTIVATED/SUSPENDED，默认 ACTIVE）、contact_email、contact_phone、created_by、created_at、updated_at。created_by 保留审计引用（用户被删除不影响记录）。
- `customers` 表：id、与 **`tenants.tenant_id`（`tenant_type=ENTERPRISE`）1:1 桥接**、**`reseller_tenant_id` FK→`tenants(tenant_id)`（RESELLER）**（Phase 24 后替代 `reseller_id`）、name、status (ACTIVE/INACTIVE/SUSPENDED)、api_key (UNIQUE)、api_secret_hash (BYTEA)、webhook_url、created_by、created_at、updated_at。UNIQUE(reseller_tenant_id, name)（或迁移期等价约束）。SUSPENDED 为可恢复冻结态，不设终态。
- `suppliers` 表：id（系统生成，唯一）、name（非空且全局唯一）、status（ACTIVE/SUSPENDED，默认 ACTIVE）、created_by、created_at、updated_at。created_by 保留审计引用（用户被删除不影响记录）。
- `public_infos` 表：schema `public` 下**完全独立**的 3GPP 公开参考目录（E.212 MCC+MNC、国家、名称、频段等），**仅供用户查阅**。**不得**与业务运营商主数据、业务 `operator_id` 链路建立任何产品层关联：禁止与 `business_operators` 外键/同步/对照校验；禁止在 SIM、资费、订阅、计费、库存、状态机等流程中读取或 JOIN `public_infos`。与 `business_operators` / `operators.operator_id` **无任何关系**（历史库若存在指向本表的 FK，须在 V1.1 移除，见 FR-057）。
- `business_operators` 表：业务运营商字典（`operator_id` PK、mcc、mnc、name），**全局唯一**表示一个 PLMN/运营商品牌；与 **`public_infos` 无关**。详见 [clarifications/operator-identity-model.md](clarifications/operator-identity-model.md)。
- `operators` 表：供应商—运营商 **商业关联**（`operator_id` 行 PK、`supplier_id` FK、`business_operator_id` FK→`business_operators`）。**同一字典运营商 MAY 在多行出现**（不同 `supplier_id`），表示同一运营商经多个供应商渠道销售；**UNIQUE(`supplier_id`, `business_operator_id`)**（非空时）。产品库持久化 **`operator_id` MUST** 为 **`operators.operator_id`（行 PK）**；对外 API 字段名 **`operatorId`** 可接受字典 ID 或行 PK，服务端双路径解析，见 [operator-identity-model.md](clarifications/operator-identity-model.md)。

**RBAC 三表模型**（CMP.xlsx 对齐）：
- `permissions` 表：id、code (UNIQUE)、name、description、category。38+ 权限码覆盖 8 个模块（商业实体、用户管理、SIM 库存、SIM 生命周期、产品包、订阅、使用量、监控告警）。
- `roles` 表：id、code (UNIQUE)、name、description、scope (platform/reseller/customer)。7 种预置角色。
- `role_permissions` 表：role_id + permission_id 复合主键。
- `users` 表：`user_id`、`tenant_id`（指用户所属 RESELLER / ENTERPRISE / DEPARTMENT 租户行）、email、display_name、password_hash、status。
- `user_roles` 表：`user_id + role_name` 记录用户角色。登录时读取 `user_roles.role_name` 推导 `roleScope`；`roles` / `permissions` / `role_permissions` 用于 DB 驱动权限解析，解析不到时由 `src/middleware/rbac.ts` 的 `defaultPermissionsByRoleScope` 兜底。
- V1.1 不使用 `users.role_id` 作为登录与授权真源。

**上游集成**（CMP.xlsx 对齐；V1.1 真源见 [clarifications/upstream-integration-config.md](clarifications/upstream-integration-config.md)）：
- `upstream_integrations` 表：`integration_id`、`reseller_id` (FK→**`tenants.tenant_id` RESELLER**)、`supplier_id` (FK)、`operator_id` (FK→**`operators.operator_id`**)、`adapter_type`、`api_endpoint`、`api_key`、`api_secret_encrypted` (BYTEA)、`webhook_key`、`auth_type`、`token_url`、`cdr_enabled`、`cdr_method` (sftp/api)、`cdr_endpoint`、`cdr_username`、`cdr_password_encrypted`、`cdr_path`、`cdr_file_pattern`、`enabled`、`config` (JSONB)、`created_by`、`created_at`、`updated_at`。**业务唯一键：`UNIQUE(reseller_id, supplier_id, operator_id)`**（ACTIVE/INACTIVE 部分唯一索引；DEPRECATED 软删行不占槽）。
- **MVP `.env` 上游凭证（如 `WXZHONGGENG_*`）V1.1 生产路径 MUST 废弃**；Vendor 适配器、Worker、入站 Webhook **MUST** 从本表按 `(resellerId, supplierId, operatorId)`（或已解析的集成行）加载（`operatorId` 解析见 [operator-identity-model.md](clarifications/operator-identity-model.md)）。
- Platform Admin API：`GET/POST/PATCH/DELETE /v1/upstream-integrations`（Fastify 真源）；鉴权：**platform_admin JWT** 或 **`X-API-Key: ADMIN_API_KEY`**；`adapterType` 枚举见 [upstream-integration-config.md](clarifications/upstream-integration-config.md) §3.5、§10。
- 凭证加密：**AES-256-GCM** + env **`INTEGRATION_SECRET_KEY`**（应用 master key）；见同上 §9。
- 入站供应商 Webhook：**MUST** 使用路径 `/v1/suppliers/{supplierId}/operators/{operatorId}/webhooks/...` 定位 `webhook_key`（路径 `operatorId` 推荐字典 ID，服务端解析规则同 Carrier Service）。
- **入站 Webhook 目录与集成订阅（初步方案）**：平台级 **入站事件目录**、**适配器能力**、**集成订阅**、管理 API 返回 **`webhookEndpoints`** 等增强项见 [upstream-inbound-webhook-catalog.md](clarifications/upstream-inbound-webhook-catalog.md)（**待团队评审**；**非**出站 **FR-039** 目录；事件类型数量 **不预设上限**）。

**第三方系统（SM-DP+）**：
- 负责 eSIM Profile 生成/加密/存储、向设备（eUICC）安全分发（HTTPS + OTA）、Profile 生命周期管理（启用/停用/删除）
- `smdp_systems` 表：id、name、activation_code_format (default 1)、delimiter (default "$")、host_fqdn（FQDN，非 URL）、oid（全局唯一）、confirmation_code_required (default 1)、esim_ca_rootca_key_ref、delete_notification_on_device_change、environment (test/production)、status (ACTIVE/DEACTIVATED/SUSPENDED, default ACTIVE)、created_by、created_at、updated_at
- **DEACTIVATED**：停止向该 SM-DP+ 发送业务请求（如 eSIM Order）
- **SUSPENDED**：预留为临时维护场景

**代理商对象属性与业务规则**：
- 仅系统管理员可在 Web Portal 手工创建代理商，创建时自动记录 created_by 与 created_at
- 查询范围：系统管理员可查询全部代理商；代理商管理员仅可查询本代理商
- 仅系统管理员可更新代理商，且不可修改代理商 ID 与 created_by
- 代理商状态机仅支持系统管理员在 Web Portal 手工变更，且必须填写变更原因用于审计
- **ACTIVE**：正常经营业务
- **DEACTIVATED**：主动停用（如业务调整），不可创建企业客户、创建产品包、导入 SIM 卡
- **SUSPENDED**：被冻结（如安全事故），代理商用户登录提示“账户已停用”并拒绝登录；V1.1 关键 API 路径按 scope 拒绝相关创建/管理操作。后台任务全链路暂停属于后续运维增强，不作为 V1.1 已实现验收项。
- 不允许物理删除代理商，以状态变更替代；历史数据（SIM、账单、CDR）保留归属

**企业对象属性**：
- 基础信息：企业 ID、名称、状态（ACTIVE/INACTIVE/SUSPENDED）、`autoSuspendEnabled`、归属代理商 ID（`autoSuspendEnabled` 缺省为 Disabled，当前版本保留该字段，暂不启用自动控制）
- 企业状态业务规则：
  - **ACTIVE**：允许分配新 SIM、创建新订阅，所有功能正常
  - **INACTIVE**：禁止分配新 SIM/新增订阅，已分配 SIM 可继续使用，仅代理商管理员人工设置
  - **SUSPENDED**：禁止新 SIM/新订阅/企业侧管理操作；连带动作仅由代理商管理员或系统管理员手工触发批量停机/拆机；企业状态仅由代理商管理员在 Web Portal 手工设置；恢复 ACTIVE 亦为手工操作
  - Web Portal 变更企业状态时提示：若需对企业名下所有 SIM 执行停机或拆机，必须由代理商管理员或系统管理员手工执行
- 状态变更实时生效，记录操作日志，触发 `ENTERPRISE_STATUS_CHANGED` 事件

**白标能力**：支持代理商自定义品牌/域名/Logo。

**上游主数据**：
- 供应商：UUID ID、名称、关联运营商（通过 **`operators`** 表，**MAY** 多行指向同一 **`business_operators`** 字典运营商）、禁止创建未关联运营商的供应商、加密存储、变更留痕
- **供应商与代理商**：**`POST /v1/suppliers` 不携带 `resellerId`**；供应商实例通过 **`POST /v1/resellers/{resellerId}/suppliers`** 绑定到代理商。**每个 `supplier_id` MUST 至多绑定一个 Reseller**（`reseller_suppliers.supplier_id` 唯一）。系统为 Reseller 服务：现实中同一供应商公司若服务多个 Reseller，**MUST** 为各 Reseller 分别创建 Supplier 实例后再绑定。
- 业务运营商：**`business_operators`**（E.212 MCC+MNC + name），**全局唯一**字典；**与 `public_infos` 无关联**（禁止跨表约束与业务互查）
- 供应商—运营商关联：**`operators`**（行 PK **`operator_id`** + **`supplier_id`** + **`business_operator_id`**）；同一字典运营商 **MAY** 经多个供应商销售（见 [operator-identity-model.md](clarifications/operator-identity-model.md)）
- 上游集成凭证：**`upstream_integrations`**，按 **`(reseller_id, supplier_id, operators.operator_id)`** 唯一存储 URL/Key/WebhookKey；创建时 **MUST** 校验该 `supplier_id` 已绑定到请求体 `resellerId`（见 [upstream-integration-config.md](clarifications/upstream-integration-config.md)）
- 公共信息目录（public infos）：物理表 `public.public_infos`（兼容视图 `carriers`，见迁移 V004）；**仅系统管理员（platform_admin）** 可执行 INSERT/UPDATE（及 DELETE，用于纠错）；**所有其他角色**（含代理商、企业用户）**仅可 SELECT/通过只读 API 查询**，不可写入。
- 查询能力（面向终端用户）：按运营商**名称**模糊搜索；按 **MCC + MNC** **精确**搜索（可拆分为仅 MCC 筛选若实现需要，以 API 契约为准）；响应字段至少包含：**名称**、**国家**、**MCC**、**MNC**、**频段**（与库中 `lte_bands` 等列对应，可扩展 NR 频段文本）。

**供应商商业模式与业务规则**：
- 商业模式 a：当供应商即运营商 CMP 时，体系仍显式创建供应商（该运营商）与运营商实体，关系保持一致（UNIQUE(mcc, mnc) 与多对多）
- 商业模式 b：供应商为独立实体，供应商侧对接一个或多个运营商 CMP；Reseller 直接对接供应商 CMP
- 创建：名称唯一，状态缺省 ACTIVE；**创建 API 不绑定 Reseller**（绑定见 `POST /v1/resellers/{resellerId}/suppliers`）
- **Reseller 专属**：每个 Supplier **MUST** 仅绑定一个 Reseller；禁止将同一 `supplier_id` 再绑定到其他 Reseller（`409 SUPPLIER_BOUND_TO_OTHER_RESELLER`）
- 更新：可改名称与状态（ACTIVE/SUSPENDED）
- 查询：系统管理员可查询全部供应商
- 状态管理：
  - **ACTIVE**：允许业务开通与上游交互
  - **SUSPENDED**：禁止导入该供应商提供的 SIM、禁止向其关联的上游系统发送任何 API 请求、且不再接受其推送的 Webhook 通知（忽略处理）；状态变更实时生效并记录审计

**操作审计**：组织与权限、SIM 生命周期、资费与订阅、数据操作等必须记录审计日志。审计日志最小字段：actor、actorRole、tenantScope、action、target、before/after、requestId、timestamp、sourceIp。

**Why this priority**: 租户与权限是整个系统的基础，所有其他功能模块都依赖于租户隔离和权限控制。没有正确的多租户支持，系统无法为多个代理商和企业提供安全隔离的服务。

**Technical Implementation**:

- 租户层级：代理商 -> 企业 -> 部门/项目
- 兼容两种模式：
  - 模式 a：运营商 CMP(供应商) -> Reseller -> 企业
  - 模式 b：运营商 CMP -> 供应商 CMP -> Reseller -> 企业
- 统一模式：供应商 / 运营商 / 上游集成为平台主数据；租户树从 Reseller 开始

```text
                  （模式 a）
   运营商CMP(供应商) ─────────► Reseller System ─────────► 企业 Portal/API

                  （模式 b）
   运营商CMP(底层) ─► 供应商CMP(对接对象) ─► Reseller System ─► 企业 Portal/API

                  （V1.1 租户树）
        RESELLER ─────────► ENTERPRISE ─────────► DEPARTMENT
        供应商/运营商/上游集成通过业务表与产品、SIM、订阅关联，不作为租户父节点
```

- 关系模型：
  - 供应商 -> SIM Profile 批次：一对多
  - 供应商 <-> 运营商：多对多（同一运营商可经多个 Supplier 通道）
  - **供应商 -> 代理商：多对一**（每个 Supplier 仅绑定一个 Reseller；经 `reseller_suppliers`）
  - SIM Profile 批次 -> 产品包：一对多
  - 产品包 -> 资费计划：一对一
  - 代理商 -> 企业：一对多
  - 代理商 -> 上游集成：一对多（`upstream_integrations` 按 `resellerId + supplierId + operatorId`）
  - 企业 -> 产品包：一对多
  - SIM -> 产品包：1 个主数据产品包 + N 个叠加包
  - eSIM Profile -> 产品包：1 个主数据产品包 + N 个叠加包
- SM-DP+ 系统 -> eSIM Profile：一对多（逻辑关系）

- API 接口：
  - `POST /v1/resellers` 创建代理商
  - `POST /v1/resellers/{tenantId}/users` 创建用户
  - `POST /v1/enterprises` 创建企业
  - `POST /v1/enterprises/{enterpriseId}/departments` 创建部门

- **代理商对外身份约定（`tenants.tenant_id`）** [V1.1 / Phase 24 收口]：凡涉及**代理商（Reseller）在租户树、权限边界与对外 API 中的唯一标识**时，**输入信息、判断条件、输出信息** MUST 统一使用 **`tenants` 表中 tenant_type=RESELLER 那一行主键 `tenant_id`**（下称 **reseller tenant_id**）。该取值与 `parent_id` 子树、`buildTenantFilterAsync()`、以及 Phase 24 后指向 `tenants(tenant_id)` 的关联列（例如 `customers.reseller_tenant_id`、`reseller_suppliers.reseller_id`、`reseller_enterprise_assignments.reseller_id`）语义一致。

  - **输入**：
    - JWT 中 `resellerId` claim（及密码登录、OIDC 等签发的等价作用域字段）MUST 为 **reseller tenant_id**。
    - REST **`/v1/resellers/{tenantId}/…` 路径参数 `tenantId`**（及文档未另行说明的、语义为「归属/当前代理商」的 UUID）MUST 按 **reseller tenant_id** 解析；**查询参数、请求体**中字段名为 `resellerId`（及等价含义的 UUID）MUST 同样按 **reseller tenant_id** 解析。
    - 企业 **API Key** 认证若映射到代理商维度，MUST 与 **reseller tenant_id**（及 `customers.reseller_tenant_id`）对齐。
    - `resellers.id` 为 **`resellers` 表内部主键**，可用于表内关联与运营后台直查；**不得**作为对外 API 契约中「代理商标识」的默认含义，除非 OpenAPI 明确使用**不同字段名**（例如 `resellerRecordId`）以示区别。

  - **判断条件**：
    - 将「当前请求所属代理商」与**租户层级或分配表**比对时（例如企业 `tenants.parent_id`、企业是否属于某代理商、多租户过滤），MUST 使用 **reseller tenant_id**；禁止在业务逻辑中默认把 `resellerId` 当作 `resellers.id` 而不加说明。

  - **输出**：
    - JSON 中字段名为 `resellerId` 且语义为「归属代理商 / 代理商作用域」时，MUST 返回 **reseller tenant_id**（例如企业类资源中与 `enterprise.tenants.parent_id` 一致）。
    - 事件、Webhook、审计日志中表达代理商租户作用域时，** SHOULD 使用同一语义**；若字段名仍为 `resellerId`，其值 MUST 为 **reseller tenant_id**。
    - 若响应需同时暴露 `resellers.id`（便于运营对照），MUST 使用**独立字段名**，不得占用 `resellerId` 歧义表达。

  - **OpenAPI**：相关路径/模式 MUST 注明：路径参数 **`tenantId`**（`/resellers/{tenantId}/…`）与查询/Body 字段 **`resellerId`** 均指 RESELLER 的 **`tenants.tenant_id`**（除非该端点文档显式定义为其他实体）。

  - **与数据模型**：本约定**不**废止 `resellers` 独立表（与 **FR-040** 并存）；仅统一**对外契约与权限判断**所用的主标识符，减少 `resellers.id` 与 `tenant_id` 混用导致的鉴权与查询错误。

- **企业 / 代理商外键统一（`tenants.tenant_id`）** [V1.1 **数据库级收口**]：凡在**产品库表**中表示「归属**企业** / enterprise scope」或「归属**代理商** / reseller scope」的**外键列**（含语义等价的命名，如 `enterprise_id`、模块表中的企业作用域键、`reseller_tenant_id`，以及表示代理商租户树作用域的 `reseller_id` 等），其 PostgreSQL **`REFERENCES` 目标 MUST 为 `public.tenants(tenant_id)`**，且：
  - **企业类外键**：被引用行 **MUST** 满足 **`tenant_type = ENTERPRISE`**（与 `customers` 域表 1:1 桥接的租户行；对外 REST 中常见 **`enterpriseId`** 即此 `tenant_id`）。
  - **代理商类外键**：被引用行 **MUST** 满足 **`tenant_type = RESELLER`**（与上文「代理商对外身份约定」及 **FR-058** 一致）。
  - **与 FR-040 的关系**：`resellers`、`customers` 等独立域表保留；其主键 `id` 仅供域内关联或运营直查。**禁止**将 `customers(id)` 作为产品表中「企业归属」的 FK 终态；遗留列 **MUST** 通过迁移收敛为 **`REFERENCES tenants(tenant_id)`**（ENTERPRISE 行）。
  - **范围说明**：指向供应商、运营商、SM-DP+、`public_infos`、计费子实体等非「企业 / 代理商租户」的 FK **不在本条约束之列**。

- **RBAC 权限配置**（当前实现）：
  - 用户登录读取 `users` + `user_roles`，并签发带 `roleScope`、`role`、`resellerId`、`customerId`、`departmentId` 的 JWT
  - 权限优先按 JWT `permissions` 或 `roles` / `role_permissions` / `permissions` 表解析；缺省按 `roleScope`（platform/reseller/customer/department）分配，兜底定义于 `src/middleware/rbac.ts`
  - 请求路径由 `resolvePermissionForRequest` 映射为权限码（如 `GET /v1/bills` → `bills.list`，`GET /v1/bills/{id}` → `bills.read`）
  - Bills 模块权限码：`bills.list`、`bills.read`、`bills.export`、`bills.mark_paid`、`bills.adjust`
  - **禁止 enterprise 访问 bills**：从 `customer` 和 `department` 的权限列表中移除上述 bills.* 权限即可
  - platform_admin 与 platform scope 拥有全量权限，不受此配置限制
  - `reseller_sales` / `reseller_sales_director` 通过 `reseller_enterprise_assignments` 限定可见企业集合；`reseller_admin` / `reseller_finance` 可按代理商维度访问其下属企业数据（具体写权限仍由接口和权限码约束）

**Independent Test**: 可通过创建代理商、企业、用户并验证权限隔离来独立测试，验证不同角色只能访问授权范围内的数据。

**Acceptance Scenarios**:

1. **Given** 系统管理员已登录, **When** 调用 `POST /v1/resellers` 创建代理商, **Then** 创建 RESELLER tenant、resellers 域记录、branding 记录和审计日志
2. **Given** 系统管理员或代理商管理员已登录, **When** 调用 `POST /v1/resellers/{tenantId}/users` 创建 `reseller_admin`, **Then** 新用户可通过 `POST /v1/auth/login` 登录并获得 reseller scope token
3. **Given** 代理商管理员已创建企业并分配销售可见企业集合, **When** 销售角色尝试访问未分配的企业数据, **Then** 系统返回权限拒绝
4. **Given** 企业状态为 ACTIVE, **When** 代理商管理员将其设置为 SUSPENDED, **Then** 企业侧登录/管理操作被禁止并触发 `ENTERPRISE_STATUS_CHANGED` 事件
5. **Given** 企业 API Key 有效, **When** 客户系统调用受保护接口, **Then** 请求被映射为 customer scope，并只允许访问该企业范围内的数据

---

### User Story 2 - SIM 卡与 eSIM Profile 资产入库与生命周期管理 (Priority: P1)

V1.1 以**物理 SIM** 管理为主线，围绕 `sims` 表提供入库、查询、分配、生命周期、诊断、导出、审计和事件能力。eSIM Profile 在 V1.1 提供轻量 CRUD 与同步状态更新，不与物理 SIM 共享完整异步生命周期编排。

**SIM 卡数据模型（V1.1 当前实现）**：
- 表名：`sims`，`iccid` 全局唯一；对外接口可用 `simId`（UUID）或 ICCID 定位 SIM，具体以接口契约为准。
- 主要字段：`iccid`、`primary_imsi`、`imsi_secondary_1/2/3`、`msisdn`、`supplier_id`、`operator_id`、`reseller_id`、`enterprise_id`、`department_id`、`status`、`lifecycle_sub_status`、`apn`、`form_factor`、`activation_code`、`bound_imei`、`imei_lock_enabled`、`upstream_status`、`upstream_status_updated_at`、`remark`。
- `reseller_id` 指 RESELLER 的 `tenants.tenant_id`；`enterprise_id` / `department_id` 指对应 `tenants.tenant_id`。这与 US1 的对外身份约定一致。
- 用量展示不以 `sims.total_data_usage_kb` 作为 V1.1 真源；列表/导出中的 `totalUsageBytes` MAY 来自聚合结果或为空，准确用量与计费以 usage/rating/billing 数据为准。
- `status_sync_conflict` 字段可用于对账差异标记；“冲突后冻结全部新 lifecycle outbound”不作为 V1.1 已实现验收项。

**eSIM Profile（V1.1 当前实现）**：
- 表名：`esim_profiles`，支持创建、列表、备注更新和同步状态更新。
- 主要字段：`profile_id`、`iccid`、`eid`、`smdp_system_id`、`activation_code`、`status`、`remark`。
- V1.1 eSIM 状态更新为同步数据库更新，并记录 `esim_state_history`（表存在时）；不创建 `SIM_STATUS_CHANGE` Job，不维护 `lifecycle_sub_status`，不承诺完整 SM-DP+ 下载/启停编排。
- `smdp_systems` 提供轻量 CRUD；真实 SM-DP+ 业务编排可作为后续阶段扩展。

**物理 SIM 生命周期状态机**：
- 主状态：`INVENTORY`、`TEST_READY`、`ACTIVATED`、`DEACTIVATED`、`RETIRED`。
- `INVENTORY`：导入或单卡创建后的库存状态，可分配给企业。
- `TEST_READY`：通过 `POST /v1/sims/{simId}:mark-test-ready` 从已分配企业的 `INVENTORY` SIM 本地同步转换而来，不调上游。
- `ACTIVATED` / `DEACTIVATED` / `RETIRED`：通过异步生命周期 API 受理，worker/adapter 完成后落稳态。
- 禁止 `ACTIVATED -> RETIRED`，退网必须先 `DEACTIVATED`。

**过渡子状态**：
| `lifecycle_sub_status` | 说明 |
|------------------------|------|
| `normal` | 无进行中的生命周期操作 |
| `activating` / `activation_failed` | 激活进行中 / 激活失败 |
| `deactivating` / `deactivation_failed` | 停机进行中 / 停机失败 |
| `reactivating` / `reactivation_failed` | 复机进行中 / 复机失败 |
| `retiring` / `retire_failed` | 退网进行中 / 退网失败 |

规则：
- 生命周期 API 受理时创建 `SIM_STATUS_CHANGE` Job，并把 SIM 写为源 `status` + 对应 `*ing` 子状态。
- `*ing` 期间拒绝其它方向生命周期操作，返回 `409 LIFECYCLE_IN_PROGRESS`。
- 同方向失败后可通过新的生命周期请求重试；幂等键重复使用返回 `DUPLICATE_IDEMPOTENCY_KEY`。
- 稳态实际变更时写入 `sim_state_history`，并触发 `SIM_STATUS_CHANGED`；Job 终态触发 `JOB_FINISHED`。

**Job 与上游适配器**：
- `SIM_STATUS_CHANGE` Job 首包响应为 `202`，`job.status` 为 `QUEUED`，响应包含源 `status`、`lifecycleSubStatus`、`targetStatus`、`action` 与 `jobId`。
- `GET /v1/jobs/{jobId}` 查询进度；`SIM_STATUS_CHANGE` 不可取消，取消请求返回 `409 JOB_NOT_CANCELLABLE`。
- 供应商 SPI 支持 `completed` / `pending` / `failed` 结果；具体供应商是否完整支持 pending 轮询、回调或混合流程，以 adapter capability 与实现为准。

**入库、批量与诊断**：
- `POST /v1/sims/import-jobs` 由 reseller/platform 管理员上传 CSV，校验 supplier/operator/reseller 关系、ICCID 唯一性和文件幂等，写入 `SIM_IMPORT` Job 与 `sims`。
- `POST /v1/sims` 支持单卡录入，必填 `iccid`、`imsi`、`apn`、`supplierId`、`operatorId`；可选 `enterpriseId`、`formFactor`、二级 IMSI、MSISDN、activationCode、IME Lock。
- `POST /v1/sims:batch-status-change` 支持 JSON ICCID 列表或 multipart CSV（二选一）发起批量生命周期操作；每张 SIM 按单卡生命周期规则处理。
- 支持 SIM 列表、详情、CSV 导出、state history、connectivity/location/diagnostics/reset-connection 等运维查询能力，均按 `roleScope` 与租户 scope 过滤。

**IME Lock 与备注**：
- `imeiLockEnabled=true` 时必须同时提供 15 位 `imei`，写入 `sims.bound_imei`；未启用时二者应同时省略。
- `PATCH /v1/sims/{iccid}` 支持更新 `remark`，用于 Web Portal 标识 SIM 用途。
- `PATCH /v1/esim-profiles/{profileId}` 支持更新 eSIM Profile 的 `remark`。

**V1.1 不纳入当前验收的目标态**：
- 自动测试期到期批处理（如 PERIOD_ONLY / QUOTA_ONLY / PERIOD_OR_QUOTA 自动转态）不作为 Fastify V1.1 当前主路径验收项。
- `status_sync_conflict=true` 后冻结所有新生命周期 outbound 不作为 V1.1 当前验收项。
- 完整 SM-DP+ Profile 下载、启用、停用、删除编排不作为 V1.1 当前验收项。
- 独立长期数据保留/GDPR 清理策略放在合规与运维章节，不在 US2 展开。

**Why this priority**: SIM 是 CMP 的核心管理对象，所有计费、监控、诊断功能都围绕 SIM 展开。SIM 生命周期管理是系统的基础能力。

**Technical Implementation**:

- Canonical HTTP runtime：Fastify routes in `src/routes/simPhase4.ts`、`src/routes/esimProfiles.js`、`src/routes/simDiagnostics.ts`。
- 核心服务：`src/services/simLifecycle.ts`、`src/services/simStatusChangeJob.js`、`src/services/simLifecycleFinalize.js`、`src/services/simImport.ts`。
- 事件通知：`SIM_STATUS_CHANGED`（稳态 `status` 变更后）、`JOB_FINISHED`（`SIM_STATUS_CHANGE` Job 终态）。
- 主要 API：
  - `POST /v1/sims/import-jobs`
  - `POST /v1/sims`
  - `GET /v1/sims` / `GET /v1/sims:csv`
  - `GET /v1/sims/{simId}` / `GET /v1/sims/{simId}/state-history`
  - `PATCH /v1/sims/{iccid}`（remark）
  - `POST /v1/sims/{simId}:activate|deactivate|reactivate|retire|mark-test-ready`
  - `POST /v1/sims:batch-status-change`
  - `GET /v1/jobs/{jobId}`
  - `GET/POST/PATCH /v1/esim-profiles...`（轻量 Profile 管理）

**Independent Test**: 可通过导入 SIM 卡、执行状态变更操作、验证状态机约束来独立测试。

**Acceptance Scenarios**:

1. **Given** 代理商管理员上传 SIM CSV, **When** supplier/operator/reseller 校验通过且 ICCID 未重复, **Then** 创建 `SIM_IMPORT` Job 并导入 `INVENTORY` SIM
2. **Given** 代理商管理员单卡录入 SIM, **When** `imeiLockEnabled=true` 但未提供 15 位 `imei`, **Then** 请求被拒绝
3. **Given** SIM 已分配企业且处于 `INVENTORY`, **When** 调用 `mark-test-ready`, **Then** 同步返回 200，SIM 状态变为 `TEST_READY` 并写入状态历史
4. **Given** SIM 处于 `TEST_READY`, **When** 调用 activate, **Then** 返回 202，创建 `SIM_STATUS_CHANGE` Job，SIM 保持 `TEST_READY` 且 `lifecycle_sub_status=activating`
5. **Given** SIM `lifecycle_sub_status=deactivating`, **When** 再次调用 activate, **Then** 返回 `409 LIFECYCLE_IN_PROGRESS`
6. **Given** SIM 处于 `ACTIVATED`, **When** 调用 retire, **Then** 返回 `409 INVALID_STATE`，必须先 deactivate
7. **Given** SIM 处于 `DEACTIVATED` 且有未满足承诺期, **When** 非豁免 retire, **Then** 返回 `COMMITMENT_NOT_MET`
8. **Given** `SIM_STATUS_CHANGE` Job 存在, **When** 调用 jobs cancel, **Then** 返回 `409 JOB_NOT_CANCELLABLE`
9. **Given** 用户查询 SIM 列表或导出 CSV, **When** 携带 reseller/enterprise/department scope, **Then** 只返回授权范围内 SIM
10. **Given** 用户更新 SIM 或 eSIM Profile 备注, **When** 调用对应 PATCH 接口, **Then** 返回更新后的 `remark`
11. **Given** eSIM Profile 已创建, **When** 代理商管理员调用 eSIM 同步状态动作, **Then** 按当前状态校验后更新 `esim_profiles.status` 并记录历史（若历史表存在）

---

### User Story 3 - 产品包与资费计划配置 (Priority: P1)

**说明**：本节所述产品包与配置模块关系，与上文 **「产品与租户分层原则（显式约束）」** 一致；详细分层约定（Reseller 级可复用目录、Price Plan 按 enterprise 定制、Package 为装配点且 **MUST** 含 `enterpriseId`）见该节。

系统由代理商管理员为企业定制产品包；**每个产品包（Package）为单一实体、单一主键 `packageId`**。V1.1 当前实现要求产品包创建时必须绑定资费计划（**Price Plan**）、运营商业务（**Carrier Service**，**内含** 对 **APN Profile、Roaming Profile** 的引用/装配；**out-of-profile 批价** **仅**经 **Package → `carrierServiceId` → `roamingProfileId`** 解析，见下节 **in-profile / out-of-profile**）、商业条款（**Commercial Terms**）与控制策略（**Control Policy**）四类已发布快照模块。**对外 API / OpenAPI MUST NOT 出现 `packageVersion` 或用于产品包维度的 `version` 字段**；引用与计费真源均为 **`packageId`（UUID）** 与各模块快照 **UUID**（含 `coveredNetworkProfileId` 等），与 APN / Roaming / Price Plan 等模块的 ID 化管理方式一致。实现内部若存在辅助 `version` 列，不作为对外引用、绑定或生命周期判断真源。

**产品包模块组成（V1.1 当前实现）**：
1. **资费计划（Price Plan，必备）**：四选一（One-time / SIM Dependent Bundle / Fixed Bundle / Tiered Pricing）；当前 OpenAPI 对四类 Price Plan 均要求经 **`coveredNetworkProfileId`（CoveredNetworkProfile 快照）** 引用 **in-profile** 覆盖 (MCC,MNC)，不得在 **Price Plan** 行上以无主键的内联整表替代 **CoveredNetworkProfile**。
2. **运营商业务（Carrier Service，发布前必备）**：在产品包装配中将 **APN Profile** 与 **Roaming Profile** 作为 **Carrier Service 配置**的一部分；**Roaming Profile** 同时作为 **OOP 批价** 的唯一定位（见下节；`price_plans` 不再并列存储 `roamingProfileId`）。
3. **商业条款（Commercial Terms，必备）**：测试期、测试配额、测试到期条件、测试到期动作、承诺期；产品包创建必须绑定 `commercialTermsId`，且该快照必须为 `PUBLISHED`。
4. **控制策略（Control Policy，必备）**：开关、达量断网、达量限速；产品包创建必须绑定 `controlPolicyId`，且该快照必须为 `PUBLISHED`。

**CoveredNetworkProfile（覆盖网络档案）[V1.1+]**  
- **目的：MUST** 将「**in-profile** 所适用的 **(MCC,MNC) 覆盖集合**」抽成**可复用**的独立目录模块（**命名** **CoveredNetworkProfile**；对外/持久化主键如 **`coveredNetworkProfileId`**，以 OpenAPI/数据层为准）**；** 供 **多份** **Price Plan** 引用**同一** 覆盖定义，**避免** 在每条资费中复制冗长列表  
- **复用举例（MUST 理解，非穷举）**：为同一客户配置多档 **Fixed Bundle**（**不同** `totalQuotaMb` / 一次性档位等），例如 **30MB、50MB、100MB、150MB、200MB、300MB、500MB、800MB、1GB、3GB** … 对应**多份** `pricePlanId`（**各自** 一条 **Price Plan** 快照）**；若** 这些档位的 **in-profile 网络覆盖** 相同，**MUST** **共用** **一条**（或少数几条）**CoveredNetworkProfile** 行，在每条 **Price Plan** 上仅填 **同一** `coveredNetworkProfileId`  
- **生命周期：MUST** 与 **APN Profile / Roaming Profile** 等一样采用 **行级** **DRAFT / PUBLISHED / DEPRECATED**（或等价）**；** **仅** **PUBLISHED** 可被 **Price Plan** 引用**；** 废弃时 **MUST** 在仍存在 **Price Plan** 引用时**拒绝** 并列出 `pricePlanId`（**以** OpenAPI **为**准）  
- **覆盖模式（coverageMode）**：CoveredNetworkProfile **MUST** 显式支持 `coverageMode`，用于区分普通覆盖列表与“无任何 in-profile 覆盖”的合法快照。
  - `coverageMode=LIST`：默认模式；`coverage` 必须至少包含一项有效 `{mcc, mnc}`，表示这些 (MCC,MNC) 为 in-profile。
  - `coverageMode=NONE`：表示该 profile 不覆盖任何 (MCC,MNC)；`coverage` **MUST** 为空数组 `[]`，不得用 `[{}]` 或缺失 `mcc/mnc` 的条目表达 none。任意 `visited_mccmnc` 均不会命中 in-profile。
  - Default Fallback Package **MUST** 引用 `coverageMode=NONE` 的 CoveredNetworkProfile，使无订阅兜底用量不会命中 in-profile；其可计费 OOP 费率仅来自 Package 所绑定 Carrier Service 的 Roaming Profile，未命中 OOP rate 时归入 `UNCLASSIFIED`。

**产品包与配置模块关系（MUST 摘要）**：
- **MUST** 将 **Package** 视为由可复用快照模块装配而成的交付单元：**Price Plan**（必备，且 **MUST** 引用 **CoveredNetworkProfile** 作为 **in-profile** 真源）、**Carrier Service**（必备，**OOP 批价** **仅**由此路径获得 **`roamingProfileId`**）、**Commercial Terms**（必备）与 **Control Policy**（必备）。对外绑定真源为各模块的 **UUID 快照**（`carrierServiceId`、`commercialTermsId`、`controlPolicyId`、`pricePlanId`）及 **`packageId`**，**不得**以产品包级 `version` 作为替代真源（与上文 `packageId` 约定一致）。

**in-profile 与 out-of-profile（面向代理商的计费口径）[V1.1+]**  
- **产品定位：MUST** 本系统为**面向代理商**的**目录、批价、账务**与对运营商话单（CDR）的**对账/清算**；**不**在 CMP 内提供「无线侧是否允许附着/是否断网」的**网元级管控**——SIM 是否能在某拜访地实际使用，**由运营商**核心网/策略/签约决定；**若** CDR 表明拜访地**不在**订购产品包/资费所约定的**可计费覆盖**内，则依本节在 **批价** 上处理为 **in-profile** 或 **out-of-profile**（**可能**同时触发告警/运营策略，以计费域实现为准）  
- **in-profile：MUST** **Covered (MCC,MNC) 集** 由独立模块 **CoveredNetworkProfile** 定义；**Price Plan** **MUST** 通过 **`coveredNetworkProfileId`** **引用** **PUBLISHED** 的 **CoveredNetworkProfile** 快照，**不** 将覆盖列表**仅** 存在 Price Plan 内而**无** 复用主键（**除非** OpenAPI/迁移阶段显式允许之**临时**方案，**以** 项目决策 **为**准）**；** 仅当 用量/话单拜访地 (MCC,MNC) **落入** 该 **CoveredNetworkProfile** 所定义之集合时，**适用** 本 **Price Plan** 的**套内/合约内**计费与配额/策略（与 `Commercial Terms` / `Control Policy` 及实现一致）  

**in-profile 流量的「超额」处理（仍落在 CoveredNetworkProfile 内，但已超出本 Price Plan 套内额度/阶梯）[V1.1 澄清]**  

以下规则仅约束 **拜访地已判定为 in-profile** 之后，用量如何按当前订阅的 Price Plan 继续归集与计费。V1.1 将 **profile 分类** 与 **产品包归属** 分开判断：拜访地是否 in-profile 只由 Price Plan 绑定的 CoveredNetworkProfile 决定；但当某类 Price Plan 已无能力承接超额用量时，超出部分可进入“无可承接产品包”路径，再由 Default Fallback Package 承接。

1. **ONE_TIME（One-time）**  
   - **MUST**：ONE_TIME 表达一次性用量包；本类型不定义 `overageRatePerMb`，不承担持续超额计费。
   - **MAIN 场景**：若 ICCID 仅有 ONE_TIME Package 作为 MAIN 订阅，且该 ONE_TIME 的 `quotaMb` 已耗尽，则业务侧应对该 ICCID 执行停机/控制策略。若停机前后仍有 CDR / usage 进入计费域，超出部分不再归属该 ONE_TIME Package；计费模块应将其视为“无可承接产品包”的用量，进入 Default Fallback Package 路径。
   - **ADD_ON 场景**：若 ONE_TIME Package 作为 ADD_ON 订阅，且 ADD_ON `quotaMb` 已耗尽，则超出部分不得继续归属该 ADD_ON；计费模块必须继续尝试 MAIN 订阅的 Package。若 MAIN 的 CoveredNetworkProfile 覆盖该拜访地，则归 MAIN in-profile；若 MAIN 不覆盖但其 Carrier Service / Roaming Profile 有 OOP rate，则归 MAIN out-of-profile；若 MAIN 也无法承接，才进入 Default Fallback Package 路径。

2. **SIM_DEPENDENT_BUNDLE / FIXED_BUNDLE**  
   - **MUST**：对 **in-profile** 用量，在周期内超出**总池配额**的部分 **MUST** 使用 **`overageRatePerMb`** 计 `OVERAGE`，仍归入 in-profile 产品包用量。其中 **SIM Dependent** 之总配额 **MUST** 按实现约定由高水位激活卡数 × **`perSimQuotaMb`** 得到；**Fixed Bundle** 之总配额为 **`totalQuotaMb`**（与当前 `computeMonthlyCharges` 实现一致）。

3. **TIERED_VOLUME_PRICING（Tiered Pricing）**  
   - 请求体与 OpenAPI **MAY** 使用别名 `TIERED_PRICING` 映射至本类型（与实现一致）。  
   - **MUST**：对 **in-profile** 用量，**MUST** 按 **`tiers`** 各档之 **`fromMb` / `toMb` / `ratePerMb`** 分段累进计价。  
   - **MUST（tiers 结构校验）**：每档 `fromMb` **MUST** 为整数且 `>= 0`；每档 `toMb` **MUST** 为整数且 `> fromMb`；`ratePerMb` **MUST** 为非负数。其中首档（Tier1）`fromMb` **MAY** 大于 `0`，用于承载“月租已含基础额度”的业务模型。  
   - **MUST（tiers 关系校验）**：`tiers` **MUST** 按 `fromMb` 严格升序。  
   - **MUST（连续性）**：相邻两档 **MUST** 满足 `tier[i].fromMb == tier[i-1].toMb`（例如 `Tier2.fromMb == Tier1.toMb`）；据此 `tiers` **MUST NOT** 重叠，且 **MUST NOT** 出现空档（gap）。  
   - **MUST**：TIERED 的最高一档 tier 通常应设置足够大的 `toMb`，使最高档 `ratePerMb` 在绝大多数实际场景中承担持续超额单价作用。
   - **MUST**：若累计 in-profile 用量确实 **超过** 最高一档 tier 的 `toMb`，超出部分不再由该 TIERED Package 承接；计费模块应将超出部分视为“无可承接产品包”的用量，进入 Default Fallback Package 路径。

- **out-of-profile：MUST** **out-of-profile（OOP）** 之 **(MCC,MNC) 单价与规则** **统一定义**在 **订阅所指向的 Package 之 Carrier Service 所绑定的 Roaming Profile**（`roaming_profiles` / `roaming_profile_entries` 等）中；**Price Plan MUST NOT** 定义或承载用于 OOP 的并行价表；计费 **MUST** 自用量关联之 **Package** **向上** 解析 **`carrierServiceId` → `roamingProfileId`** 后套用该 Profile。  
- **MUST** 归类为 OOP 的用量为：拜访地 **未** 落入当前承接 Package / Price Plan 的 **CoveredNetworkProfile**，但该 Package 可通过 Carrier Service / Roaming Profile 找到 OOP rate 的数据类用量。上述 OOP 单价/规则 **MUST** 与 **同一次订阅所指向的** **`roamingProfileId`** 一致，且 **MUST** **仅** 通过 **`Package` → `carrierServiceId` → `carrier_service_modules` 内 `roamingProfileId` → `roaming_profiles`（及 `roaming_profile_entries` 等）** 解析得到；`price_plans` 与 OpenAPI 中 **Price Plan** **MUST NOT** 再单独声明 **`roamingProfileId` 用于** OOP。若当前承接 Package 未命中 OOP roaming rate，则 **MUST** 归入 `UNCLASSIFIED`，金额为 0，并保留 `visitedMccMnc` / `inputRef` / `calculationId` 供运营修复；不得退回 Price Plan 级 PAYG。  
- **可复用：MUST** **CoveredNetworkProfile** 与 **Roaming Profile** 均为**可**被多主体重用的快照模块；**多份** **Price Plan** **MAY** 共用 **一** 条 **CoveredNetworkProfile**；**OOP** 的 **Roaming** **不** 在 Price Plan 再次引用，**故** 无「**多** **Price Plan** 绑**同一** Roaming 于**资费行**」之并列字段，**仅** 在 **Carrier** 与 **多** **Package** 间**可能** 复用**同一** `roamingProfileId`  
- **Price Plan 级 Zone-based PAYG（legacy）**：V1.1 已彻底废弃 Price Plan 级 `paygRates` 兜底；历史字段或 fixtures 仅可作为 legacy 兼容/迁移背景，不得作为当前批价真源。

**实现与数据规模（工程说明，与对外 MUST 不冲突）**  
- **Roaming Profile** 的「每 (MCC,MNC) 单价等」在库中**可以**为 **`roaming_profiles` 上内联之 `mcc_mnc_list` / JSONB 列**或 **`roaming_profile_entries` 子表**（以当前 migration / `data-model.md` 为准；二者**不**在 spec 中二选一，以数据字典为真源）**；** 测试阶段仅**少量** (mcc,mnc,ratePerMb) **在容量上**与**生产约每 Profile 数百条（如 ~600 条）** 同属**常见、可接受**范围：单行 JSON/JSONB 通常在 **1MB 以下** 仍**可行**，但 **建议** 以**规范化子表** + **`(roaming_profile_id, mcc, mnc)` 唯一约束与查找索引** 支撑**对话单/用量热路径**的 O(log n) 或索引查找，**避免**在批价循环中对**整表/整数组**做线性扫描**；** 上线前 **SHOULD** 以目标数据量对**最频批价/回放路径**做性能与内存抽检

**Packages 模块（产品包）[V1.1 收口]**

- **与版本的关系**：**不做**独立「版本线」或对外 **`packageVersion` / 产品包 `version`** 作为引用真源；**仅以 `packageId`（UUID）与行级 `status`（`DRAFT` / `PUBLISHED` / `DEPRECATED`）** 管理，与 **Network Profile、Carrier Service、Commercial Terms、Control Policy、Price Plan** 等 **ID + 状态** 模型对齐（与上文 **「产品配置域统一生命周期」** 及 **FR-016** / **FR-060** 一致；内部单表/单实体，见 Technical Implementation 包段落）。

- **能力面（常用接口类型）**：**Create、List、Get（详情）、Update、Publish、Deprecate、Export packages CSV、Reverse Lookup / 反查 Packages**（例如按 `pricePlanId` / `commercialTermsId` / `controlPolicyId` / `carrierServiceId` 等查询仍引用该模块行的 Package 列表，与既有「反查产品包」需求一致；Export / 反查路径与查询参数以 **OpenAPI** 为准）。

- **归属（MUST）**：每一项 Package 表示 **reseller 为某一 enterprise 定制** 的交付单元；**MUST** 同时绑定 **一个 reseller** 与 **一个 enterprise**（数据层与对外字段 **`resellerId`**、**`enterpriseId`** 均指 `tenants.tenant_id` 语义，**FR-061**）。

- **创建（Create）**：
  - **MUST** 提供 **`enterpriseId`**，新建行默认 **`DRAFT`**。
  - **MUST** 提供 **`pricePlanId`、`carrierServiceId`、`commercialTermsId`、`controlPolicyId`**；当前 OpenAPI 将 `controlPolicyId` / `commercialTermsId` 标为 Package 创建必填字段是正确契约。四个模块 ID 均必须引用 `PUBLISHED` 快照。
  - **Reseller JWT**（`reseller_admin` 等）：`resellerId` **可省略**（默认用 token 作用域内 reseller）；若请求体/参数提供 **`resellerId`**，**MUST** 与认证解析得到的 reseller **一致**，否则 **403**。
  - **Platform / Admin API key**：**MUST** 同时提供 **`resellerId`** 与 **`enterpriseId`**，且 **MUST** 校验二者为「企业隶属于该代理商」的合法组合（匹配关系）；失败时 **400** / **404** / **403**（以 OpenAPI 与实现为准）。

- **查询（List / 反查）**：
  - **Reseller JWT**：`resellerId` 过滤参数 **可省略**（默认本代理商可见范围）；若提供 **`resellerId`**，**MUST** 与 token 作用域 **一致**。**`enterpriseId`** 可用于限定企业（须在权限范围内）。
  - **Admin / Platform**：当前 OpenAPI 以 `GET /v1/enterprises/{enterpriseId}/packages` 为主列表路径；若需平台全局查询，使用 `enterpriseId=00000000-0000-0000-0000-000000000000` 并按 OpenAPI 规则处理 `resellerId` 等过滤。若同时提供 **`resellerId`** 与具体 **`enterpriseId`**，**MUST** 做归属匹配过滤。

- **更新（Update）**：**仅**允许 **`DRAFT`** 状态；**MUST NOT** 修改已持久化的 **`resellerId`**、**`enterpriseId`**（其它业务字段的变更口径与上表「内容更新」/ Commercial Terms 等一致）。

- **发布（Publish）**：**仅**允许 **`DRAFT` → `PUBLISHED`**，否则 **MUST** 报错。发布时 **MUST** 校验 `pricePlanId`、`carrierServiceId`、`commercialTermsId` 与 `controlPolicyId` 均存在且为 `PUBLISHED`。**Reseller JWT** 下，对 **不在本代理商可管理范围内** 的 Package 调用发布（越权/归属不符），**MUST** **403**。
  - **上游产品映射（MUST）**：`POST /v1/packages/{packageId}:publish` **MUST** 接受请求体 **`externalProductId`**（上游供应商产品包 ID）；可选 **`provisioningParameters`**。**MUST NOT** 由客户端传入 `supplierId`——**`supplier_id` 一律从 Package 所引 Carrier Service 行推导**并写入 **`vendor_product_mappings`**（详见 [subscription-provisioning-upstream-mapping.md](clarifications/subscription-provisioning-upstream-mapping.md)）。
  - **不变量**：**`PUBLISHED` Package ⇔ 存在且仅存在一条映射**（`package_id` 唯一）；Package **创建/更新** HTTP **不变**，仅 **`:publish`** 扩展请求体。

- **废弃（Deprecate）**：**仅**允许当前为 **`PUBLISHED`** 的对象废弃；当前 V1.1 实现会在存在 `ACTIVE` 或 `PENDING` 订阅引用该 `packageId` 时拒绝（如 **409**）。其它更细的挂起/宽限期阻塞状态不纳入 V1.1 规格。

**模块管理域归类（MVP）**：
- **Network Profiles 域**：APN Profile、**CoveredNetworkProfile**、Roaming Profile、Carrier Service、Control Policy
- **Price Plans 域**：Price Plan（**MUST** 引用 `coveredNetworkProfileId`）、Commercial Terms
- **Price Plan** 对外 HTTP **仅** **[六种能力](#spec-price-plan-http-scope)**（Create / List / Get detail / Update / Publish / Deprecate），**MUST NOT** 提供 **`:clone`**、**`/versions`** 等其它价目端点；详见上文 **「Price Plan HTTP 接口范围」**。
- Carrier Service、Control Policy、Commercial Terms 均提供独立管理能力；其中 **Carrier Service** 与 **APN Profile / Roaming Profile** 对齐，对外至少包含 **创建、列表、详情、发布（Publish）、废弃（Deprecate）**（另含校验与 `DRAFT` 下的更新）；**Control Policy** 至少包含创建、列表、详情、发布、废弃及 `DRAFT` 下的更新；**Commercial Terms** 至少包含创建、列表、详情、发布、废弃及 `DRAFT` 下的更新（生命周期与 Price Plan 对齐）。
- 快照机制适配结论：
  - **CoveredNetworkProfile**、APN Profile、Roaming Profile、Control Policy、Price Plan、**Carrier Service 模块**均可采用“不可变快照 + 新 ID”或等价的 **行级 `DRAFT` / `PUBLISHED` / `DEPRECATED`** 语义（Carrier Service 以 `carrierServiceId` 为快照 ID，编辑策略与实现一致）
  - V1.1 当前实现允许对 `DRAFT` 快照原地更新；`PUBLISHED` / `DEPRECATED` 快照不允许原地修改。需要基于已发布对象改版时，按资源类型使用「查询详情后新建」、clone（APN / Commercial Terms / Control Policy）或 Roaming Profile 的 export/import CSV 流程创建新快照 ID。
  - 仅 `PUBLISHED` 快照可被产品包引用；`DRAFT` 快照用于编辑
  - 快照列表统一支持按“名称 + 发布时间 + 状态”展示，其中名称允许重复
  - **状态与引用口径**：生命周期与可编辑性以**快照行**为准；对外契约（OpenAPI / Portal）中同一资源的 `status` 只表达该快照的发布与下线语义（如 `DRAFT` / `PUBLISHED` / `DEPRECATED`）。**不以内部递增 `version` 作为引用或排期的依据**；所有绑定、反查、计费与下发均以快照 UUID（`apnProfileId`、`roamingProfileId`、`pricePlanId` 等）为真源。实现层若曾存在独立的「版本表」或历史枚举命名，应过渡为与本规范一致的单轨语义，避免「实体级 ACTIVE + 版本级 DRAFT」并行出现在同一响应字段名 `status` 下造成歧义。

**产品配置域统一生命周期与引用规则（Price Plan / CoveredNetworkProfile / APN Profile / Roaming Profile / Carrier Service / Commercial Terms / Control Policy / Package）[V1.1]**：

以下模块在**对外契约与集成**上统一为：**仅用行主键 UUID 管理，不在 OpenAPI 中暴露 `packageVersion`、产品包维度 `version`、或依赖内部递增版本号作为绑定依据**；**Package 内部数据模型收敛为单表 / 单实体**（例如单一 `packages` 表），**不得**再以独立 `package_versions` 表作为对外引用或文档中的真源。（**CoveredNetworkProfile** 为 **in-profile** 覆盖**独立**快照，**MUST** 与下表**同一**生命周期列**一致**，**除** 废弃条件以 **是否仍被 `price_plans.coveredNetworkProfileId` 引用** 为**准**。）

| 规则 | 适用对象 | 要求 |
|:--|:--|:--|
| 新建默认状态 | 上表所列配置域模块（**含** **CoveredNetworkProfile**；下文简称「**上列**」） | 创建成功后 **MUST** 为 `DRAFT`（除非文档另有说明的特例）。 |
| 内容更新 | 上列 | **MUST** 仅允许对 `DRAFT` 对象执行会改变业务内容的更新（与既有「已发布不可原地改、改版走新 ID」的快照策略兼容时，从旧 `PUBLISHED` 改版仍表现为**新行 + 新 ID**）。 |
| 发布 | 上列 | `POST …/:publish` **MUST** 仅接受当前状态为 `DRAFT` 的对象；否则返回错误（如 `409 INVALID_STATUS`）。 |
| 发布前引用完整性 | **Package** | 发布 Package 时 **MUST** 校验其绑定的 `pricePlanId`（且该 Price Plan 所引用的 `coveredNetworkProfileId` 已为 `PUBLISHED`）、`carrierServiceId`、`commercialTermsId` 与 `controlPolicyId` 均存在且为 `PUBLISHED`。 |
| 创建/编辑时引用完整性 | **Package**（`DRAFT`） | 写入或更新 Package 绑定关系时 **MUST** 要求 `pricePlanId`、`carrierServiceId`、`commercialTermsId` 与 `controlPolicyId` 均指向 `PUBLISHED` 快照；缺失任一模块 ID 均为无效 Package 请求。 |
| 废弃 | 上列 | `POST …/:deprecate` **MUST** 仅接受当前状态为 `PUBLISHED` 的对象；否则返回错误。各模块 **MUST** 在仍存在下游引用时拒绝废弃（Price Plan / **CoveredNetworkProfile** / Carrier Service / APN / Roaming / Commercial Terms / Control Policy 等：以既有「**引用方** 列表」为准，错误体列出 `packageId` / `pricePlanId` 等）。 |
| Package 废弃附加条件 | **Package** | 除状态为 `PUBLISHED` 外，V1.1 当前实现要求不存在 `state in (ACTIVE,PENDING)` 的订阅引用该 `packageId`。`EXPIRED` / `CANCELLED` 等已结束或不再占用套餐的订阅不计入阻塞；更细的挂起/宽限期状态留待后续版本扩展。 |
| `DEPRECATED` 之后 | 上列 | 对外 API **MUST** 将 `DEPRECATED` 视为**只读**（查询可保留以便审计/展示）；变更类操作 **MUST** 拒绝，**除非**平台内部运维文档明示的例外路径。 |

**资费计划类型**：
1. **One-time（一次性）**：购买即收，含额度与有效时长，到期边界支持 CALENDAR_DAY_END / DURATION_EXCLUSIVE_END，取消不退款
2. **SIM Dependent Bundle（前向流量池，monthly recurring）**：按卡动态累加池额度；总配额 = activatedSimCount(高水位) × perSimQuotaMb
3. **Fixed Bundle（后向流量池，monthly recurring）**：固定总池额度，不随 SIM 数变化
4. **Tiered Pricing（阶梯计费，monthly recurring）**：分段累进（Progressive），非全量按档

**One-time 到期口径**：
- 生效时间：`effectiveAt` 按系统时区解释
- `validityDays` ≥ 1，生效当日计为第 1 天
- `expiryBoundary = CALENDAR_DAY_END`：`expiryAt = endOfDay(date(effectiveAt) + (validityDays - 1) days)`
- `expiryBoundary = DURATION_EXCLUSIVE_END`：`expiryAt = effectiveAt + validityDays * 24h`，用量窗口为 `[effectiveAt, expiryAt)`

**通用规则**：
- 金额精度：币种最小货币单位，四舍五入保留 2 位小数
- 币种策略：按代理商固定币种（代理商创建时配置结算币种，下属企业及产品包继承，不支持跨币种混合计费）
- 流量单位：MB，向上取整
- 生效时间：TIMESTAMPTZ，按系统时区解释
- 每个 Price Plan 仅针对一种电信业务类型（DATA/VOICE/SMS）
- 计费周期：支持自然月 (CALENDAR_MONTH) 与自定义周期 (CUSTOM_RANGE)

**通用字段**：serviceType、currency、billingCycleType、firstCycleProration（NONE/DAILY_PRORATION）、prorationRounding

**分摊算法**（DAILY_PRORATION 时）：
- `perDayFee = monthlyFee / daysInBillingMonth`
- `activeDays = countDaysInclusive(startDay, endDay)`
- `chargedMonthlyFee = round(perDayFee * activeDays, 2)`

**分区标准资费（Zone-based PAYG Rates，legacy）**：
- V1.1 已废弃 Price Plan 级 `paygRates` / Zone PAYG 兜底，不作为当前批价、OpenAPI 或验收真源。
- 历史字段若仍出现在旧 fixture、迁移记录或早期文档中，仅表示 legacy 数据背景；当前 OOP 费率唯一真源为 **Package → Carrier Service → Roaming Profile**。
- 缺少 OOP roaming rate 时，不启用 Price Plan PAYG 兜底，Rating 结果进入 `UNCLASSIFIED`，金额为 0。
- Price Plan 快照规则：
  - 对 Price Plan 的编辑仅允许在 `DRAFT` 快照上原地更新；`PUBLISHED` / `DEPRECATED` 快照不可原地修改。基于已发布资费改版时，前端推荐先 `GET /v1/price-plans/{id}` 拉取详情，再调用创建接口生成新的 `pricePlanId`（可通过 `sourcePricePlanId` 追溯来源）。
  - 新快照状态默认 `DRAFT`，发布后转 `PUBLISHED`；**仅当**快照已为 `PUBLISHED` 且**不存在任何** Package 仍引用该 `pricePlanId` 时，才允许通过 `POST /v1/price-plans/{pricePlanId}:deprecate` 转为 `DEPRECATED`（设置 `deprecatedAt`）。若仍存在引用，MUST 拒绝废弃，并在错误详情中列出所有引用方的 **`packageId`**，以便运营先完成产品包改绑或下线后再操作。
  - 产品包引用 `pricePlanId`（快照 ID），不再使用内部 `version`
  - Web Portal 复制/改版推荐流程（**无** 独立 Copy/Clone API，与 **[Price Plan HTTP 接口范围](#spec-price-plan-http-scope)** 一致）：先 **`GET /v1/price-plans/{id}`** 拉取既有快照详情；用户在页面按类型编辑后，调用 **`POST /v1/enterprises/{enterpriseId}/price-plans`** 创建新 **`DRAFT`** 快照（**`resellerId` / `enterpriseId`** 规则见 **「Price Plan 创建与列表」**）。前端 MUST 按 `type` 仅提交该类型允许字段，避免四类 Price Plan 共用请求体导致误填。
- APN Profile 快照规则（与上列 Price Plan 规则**对齐**，以 ID 控版本、不用内部 `version` 控引用）：
  - 对 APN Profile 的编辑仅允许在 `DRAFT` 快照上原地更新；基于已发布 APN 改版时，可通过 `POST /v1/apn-profiles/{apnProfileId}/clone` 创建新草稿快照，来源链路通过 `sourceApnProfileId`（数据层列名 `source_apn_profile_id`）追溯。
  - 新快照状态默认 `DRAFT`，发布后转 `PUBLISHED`；**仅当**快照为 `PUBLISHED`，且不存在任意 **Carrier Service（`carrier_service_modules`，状态非 `DEPRECATED`）** 在其配置中引用该 `apnProfileId`，且不存在任意 **Package（单表 `packages` 等，通过 `carrier_service_id` 或解析后的 Carrier Service 配置仍间接引用该 `apnProfileId`）** 仍引用该 `apnProfileId` 时，才允许 `POST /v1/apn-profiles/{apnProfileId}:deprecate` 转为 `DEPRECATED`；否则 MUST 拒绝（如 `409 RESOURCE_IN_USE`），并在错误信息中给出引用方 `carrierServiceId` 与 `packageId` 列表。淘汰或不可再绑定时转 `DEPRECATED`。
  - Carrier Service、`package_network_policies` 等引用方只绑定 `apnProfileId`（快照 ID）；**不再使用内部 `version` 或第二套「仅表示未废弃」的状态与 `DRAFT`/`PUBLISHED` 混用**。定时生效（如次月生效）通过快照上的生效窗口或排期实体表达，不依赖版本序号。
- **CoveredNetworkProfile 快照规则**（与 APN / Roaming 等 **对齐**）：
  - 对 **CoveredNetworkProfile** 的编辑仅允许在 `DRAFT` 快照上更新；**仅当** 快照为 **`PUBLISHED` 且** **不存在** 任意 **Price Plan** `coveredNetworkProfileId` 仍**引用** 本行，才允许 **废弃/下线**；否则 **MUST** 拒绝并列出 `pricePlanId`（**以** OpenAPI **为**准）
- Roaming Profile 快照规则（与 Price Plan / APN Profile **对齐**）：
  - **已发布（`PUBLISHED`）行不可原地修改**；需要新费率表时 **MUST** 采用 **导出 CSV → 编辑 → `POST /v1/roaming-profiles:import-csv`** 创建**新的** `roamingProfileId`（**DRAFT**），再发布。**MUST NOT** 依赖服务端 clone 或「克隆后 PUT 更新」流程（**`POST …:clone` 未提供 / 已废弃**）。
  - **`GET /v1/roaming-profiles/{roamingProfileId}:export-csv`** 返回与 import 相同列格式的 CSV（`mcc,mnc,country,network,ratePerMb`），供复制既有 `mccmncList`。
  - 新快照状态默认 `DRAFT`，发布后转 `PUBLISHED`（设置 `publishedAt`、`effectiveFrom`；**次月 1 日 UTC 生效**）；废弃时设置 `status=DEPRECATED` 与 **`deprecatedAt`**（与 `price_plans` 口径一致）。
  - **仅当**快照为 `PUBLISHED`，且**不存在**仍依赖该 `roamingProfileId` 的**任意**引用方，才允许 `POST /v1/roaming-profiles/{roamingProfileId}:deprecate`。**OOP 批价** **MUST** **仅** 经 **Package → Carrier** 解析；引用方 **MUST 至少** 包含 **Carrier Service（**状态非 `DEPRECATED`）**；存在引用时 **MUST** 拒绝废弃。
  - 引用方只绑定 `roamingProfileId`（快照 ID），不再使用内部 `version` 作为对外契约的一部分

**运营商业务（Carrier Service）**：
- RAT：3G/4G/5G/NB-IoT（缺省 4G）
- 业务类型：Data/Voice/SMS（缺省 Data）
- Roaming Profile：在 **Carrier Service** 中按 `roamingProfileId`（快照 ID）装配**；OOP 批价** **MUST** 使用**与**此**同一** `roamingProfileId`（**仅** 经 **Package → `carrierServiceId`** 得到**；** **MUST** **不得** 在 **Price Plan** 上**再** 存**一份** OOP 用 `roamingProfileId`）**；** **Covered 外** 的用量 **按** 该 **Roaming Profile** 的 **(MCC,MNC) 单价值** 等规则计**套外**（与 **`roaming_profile_entries`** 等**一致**）
- Roaming Profile 最小字段：mcc、mnc、ratePerMb（如 0.004096 USD/MB）
- APN：运营商 APN 
- MVP：每个 Data 产品包绑定 1 个默认 APN + 1 个 Roaming Profile
- APN/Roaming Profile 变更次月生效
- **Carrier Service 模块生命周期（与 APN Profile 对齐）**：
  - `POST /v1/carrier-services` 创建模块行，状态 **MUST** 为 `DRAFT`；所引用的 APN Profile / Roaming Profile **MUST** 已为 `PUBLISHED`（与「仅 PUBLISHED 可被引用」一致）。
  - `PUT /v1/carrier-services/{carrierServiceId}` **仅**允许修改 `DRAFT` 对象；`PUBLISHED` / `DEPRECATED` 上修改 MUST 失败（如 `409 INVALID_STATUS`）。
  - `POST /v1/carrier-services/{carrierServiceId}:publish` **仅**允许将 `DRAFT` 置为 `PUBLISHED`（设置 `publishedAt`、`effectiveFrom` 等口径与 APN Profile 发布一致）；对其它状态调用 MUST 失败。
  - `POST /v1/carrier-services/{carrierServiceId}:deprecate` **仅**允许将 **`PUBLISHED`** 置为 `DEPRECATED`，且 **MUST** 在不存在任一 **Package**（单表实体，其 `carrier_service_id` 或等价列指向该 `carrierServiceId`）时成功；存在引用时 MUST 失败（如 `409 RESOURCE_IN_USE`）并列出 `packageId`。
  - Package 在 `carrierServiceId` 绑定路径上 **MUST** 仅引用 `PUBLISHED` 的 Carrier Service；`POST .../packages/{packageId}:publish` **MUST** 再次校验 `pricePlanId`、`carrierServiceId` 及已绑定的可选模块均为 `PUBLISHED`，失败则阻断（与 APN/Roaming 发布前校验同级）。
- 数据模型：
  - `covered_network_profiles`（**或** 项目约定表名）：**CoveredNetworkProfile** 快照；**含** **(MCC,MNC)** 覆盖集**；** **被** `price_plans.covered_network_profile_id`（**或** `coveredNetworkProfileId` 列名）**引用**
  - `apn_profiles`：id, name, …, status, published_at, effective_from, deprecated_at, …
  - `roaming_profiles`：id, name, …, status, published_at, effective_from, deprecated_at, mccmnc_list (jsonb)
  - `package_network_policies`：package_id, apn_profile_id, roaming_profile_id, effective_from, effective_to, status(active/scheduled/expired)
- 校验来源：
  - APN 必须存在于上游供应商的可用目录或能力声明中
  - Roaming Profile 的 `mccmncList` 仅做格式与冲突校验，不要求出现在 `business_operators/operators` 中；每项可选 **`country` / `network`** 为展示注解（可空），不参与计费
  - `supplierId/operatorId` 仅用于 Profile 所有权归属校验，不用于限制漫游拜访地运营商列表
- 变更与回滚：
  - APN Profile、Roaming Profile 的新增、编辑、发布、引用与来源追溯等：**详见上文**「快照机制适配结论」「状态与引用口径」「APN Profile 快照规则」「Roaming Profile 快照规则」；本节不再重复。
  - 若上游下发失败，保持当前生效绑定不变并生成告警
  - 支持在生效前撤销已排期绑定，撤销后恢复上一个 active 绑定
- 反向关联查询（Web Portal 连接能力）：
  - 允许以 `roamingProfileId` 反查已绑定该 Profile 的 Carrier Service 列表（用于从 Id1 迁移到 Id2 前的影响面识别）
  - 允许以 `apnProfileId` 反查已绑定该 Profile 的 Carrier Service 列表
  - 查询结果需返回 `carrierServiceId`、`carrierServiceConfig`（内含 `supplierId` / `operatorId`）、`status`、`effectiveFrom`，用于页面联动修改

**商业条款（Commercial Terms）**：
- 生命周期与 API：与 Price Plan 对齐——`POST` 创建为 `DRAFT`；`PUT` 仅 `DRAFT` 可改；当前实现也支持 `POST /v1/commercial-terms/{id}/clone` 基于既有快照创建新草稿；`POST /v1/commercial-terms/{id}:publish` 仅 `DRAFT` → `PUBLISHED`；`POST /v1/commercial-terms/{id}:deprecate` 仅 `PUBLISHED` → `DEPRECATED`，且 **MUST** 在无任一 Package 仍绑定该 `commercialTermsId` 时成功（否则 `409` 并列出 `packageId`）。产品包若引用 Commercial Terms，**MUST** 仅绑定 `PUBLISHED` 快照。**`PUT /v1/commercial-terms/{id}` MUST NOT 修改模块的 `enterpriseId` 或 `resellerId`**（二者在创建时绑定，更新仅改 `name` 与 `commercialTerms` 内容；请求体若携带其它租户字段，实现 **MUST** 忽略且不视为错误，响应中的 `enterpriseId` / `resellerId` 始终以持久化行为准）。
- Test Period（测试期）
- Test Quota（测试期流量配额，MB 向上取整）
- Test Expiry Condition：PERIOD_ONLY / QUOTA_ONLY / PERIOD_OR_QUOTA（默认 PERIOD_OR_QUOTA）
- Test Expiry Action：ACTIVATED / DEACTIVATED（默认 ACTIVATED）
- Commitment Period（承诺期）

**控制策略（Control Policy）**：
- **数据模型边界（MUST 区分表名）**：**HTTP `/v1/control-policies` 系列 API** 所管理、且产品包通过 **`controlPolicyId`** 引用的 **Control Policy 模块快照**，持久化在表 **`control_policy_modules`**（主键 **`control_policy_id`**，策略正文为列 **`control_policy` JSONB**，含生命周期 `DRAFT` / `PUBLISHED` / `DEPRECATED`）。数据库中另存在表 **`control_policies`**（计费/用量域迁移），用于**企业级账单或用量侧开关类配置**，**与上述模块快照非同一资源**；**MUST NOT** 将二者混读、混写或混用 OpenAPI 契约。文档、数据模型与运维 SQL **MUST** 显式使用 **`control_policy_modules`** 指代产品包可选绑定的 Control Policy 模块。
- **JSON 契约（`controlPolicy` 正文）**：字段级冻结见 [clarifications/control-policy-module.md](./clarifications/control-policy-module.md)（`enabled`、`cutoff`、`throttling` / `tiers`、枚举 **DAILY** / **MONTHLY**、合法组合与废弃键）；OpenAPI 与实现 **MUST** 与此一致（演进见 tasks Phase 29 **T206** / **T210**）。
- 生命周期与 API：`POST` 创建为 `DRAFT`；`PUT` 仅 `DRAFT` 可改；当前实现也支持 `POST /v1/control-policies/{id}/clone` 基于既有快照创建新草稿；`POST /v1/control-policies/{id}:publish` 将 `DRAFT` 发布为 `PUBLISHED`；`POST /v1/control-policies/{id}:deprecate` 仅 `PUBLISHED` → `DEPRECATED`，且 **MUST** 在无任一 Package 仍绑定该 `controlPolicyId` 时成功（否则 `409` 并列出 `packageId`）。列表/详情返回 `status`、`publishedAt`、`effectiveFrom` 等字段，语义与 Network Profiles 域其它快照资源一致。产品包若引用 `controlPolicyId`，**MUST** 仅绑定 `PUBLISHED` 快照（与 Carrier Service / Price Plan 引用规则一致）。**对外 `resellerId` 语义**与 **FR-058** 一致（`tenants.tenant_id` / reseller tenant_id）。
- on/off 开关
- 达量断网规则（Cutoff Rules）：time_window（DAILY/MONTHLY）、thresholdMb、action=DEACTIVATED
- 达量限速规则（Throttling Rules）：time_window（DAILY/MONTHLY）、tiers[thresholdMb, downlinkKbps, uplinkKbps]
- time_window 到期自动恢复至初始速度：DAILY 次日 00:00，MONTHLY 下月 1 日 00:00
- 控制策略仅允许编辑 `DRAFT` 快照；基于已发布策略改版时通过 clone 或新建生成新的 `controlPolicyId`，历史快照不变
- 产品包引用 `controlPolicyId`（快照 ID）
- 未引用任何 ID 表示无控制（不停机，不限速）
- 删除保护：若被产品包引用，禁止物理删除（ON DELETE RESTRICT 或软删除）
- 优先级：DEACTIVATED/RETIRED 时不下发限速；Cutoff 以状态迁移为准
- 触发口径：
  - 统计来源为计费累计表（SIM + 账期/自然日维度），以 totalUsageMb 为准
  - DAILY 触发窗口为系统时区自然日，MONTHLY 触发窗口为系统时区自然月
  - TEST_READY/INVENTORY 状态不执行控制策略
- 执行规则：
  - 同一 SIM 同时命中限速与断网阈值时，断网优先
  - 达量断网执行为状态变更至 DEACTIVATED，并写入 audit log
  - 达量限速执行为下发速率策略，若下发失败重试并产生告警
  - 解除规则只按 time_window 到期自动恢复，人工恢复需显式操作

**Why this priority**: 产品包是连接 SIM 资产与计费的核心载体，计费规则与运营商能力的载体，企业订阅的对象。

**Technical Implementation**:

- **Package 单实体**：每个产品包对应**一行**主数据（单表），主键 **`packageId`**；V1.1 当前实现以 Price Plan + Carrier Service 为必备核心绑定，Commercial Terms + Control Policy 为可选快照绑定。
- 产品包以 ID 索引配置模块：`pricePlanId`、`carrierServiceId`、`controlPolicyId`、`commercialTermsId`（已提供的模块 ID 均必须指向已发布行的 UUID）。
- **Package 生命周期**：与上表「产品配置域统一生命周期」一致——`DRAFT` 创建与编辑；`POST /v1/packages/{packageId}:publish` 仅 `DRAFT`，且 `pricePlanId`、`carrierServiceId` 及已绑定的可选模块均为 `PUBLISHED`；`POST /v1/packages/{packageId}:deprecate` 仅 `PUBLISHED` 且无 `ACTIVE` / `PENDING` 订阅引用；`DEPRECATED` 对外只读。
- 产品包变更次月生效（仅对新订阅生效；已有订阅需通过订阅变更接口单独处理）
- APN 来源：运营商 APN 目录，供应商支持验证
- 反向引用查询能力：
  - Network Profiles 域支持通过 `apnProfileId` / `roamingProfileId` 查询 Carrier Service
  - Price Plans 域支持通过 `pricePlanId` / `commercialTermsId` / `controlPolicyId` 查询 Package
  - 反查结果默认仅返回当前操作者租户可见范围，且可按快照 `status`（`DRAFT` / `PUBLISHED` / `DEPRECATED`）过滤

- 模块创建依赖顺序：
  1. 先创建 APN Profile、Roaming Profile
  2. 再创建 Carrier Service（引用 APN Profile / Roaming Profile）
  3. 再创建 Control Policy、Commercial Terms、Price Plan
  4. 最后创建 Package（必选引用 Price Plan，发布前补齐 Carrier Service；Control Policy / Commercial Terms 按需引用）

- 各类型字段表（仅列出差异字段）：

| Price Plan 类型 | 字段 | 含义 | 约束/边界 |
|---|---|---|---|
| One-time | `oneTimeFee` | 一次性费用 | >= 0 |
| One-time | `quotaMb` | 包含额度 | >= 0（仅 `DATA`） |
| One-time | `validityDays` | 有效天数 | >= 1 |
| One-time | `expiryBoundary` | 到期边界 | ENUM: `CALENDAR_DAY_END`/`DURATION_EXCLUSIVE_END`，默认 `CALENDAR_DAY_END` |
| SIM Dependent Bundle | `monthlyFee` | 月租费 | >= 0 |
| SIM Dependent Bundle | `deactivatedMonthlyFee` | 停机保号费（按月） | >= 0 |
| SIM Dependent Bundle | `perSimQuotaMb` | 每 SIM 配额 | >= 0（仅 `DATA`） |
| SIM Dependent Bundle | `overageRatePerMb` | 套外单价 | >= 0（仅 `DATA`） |
| Fixed Bundle | `monthlyFee` | 月租费 | >= 0 |
| Fixed Bundle | `deactivatedMonthlyFee` | 停机保号费（按月） | >= 0 |
| Fixed Bundle | `totalQuotaMb` | 总池额度 | >= 0（仅 `DATA`） |
| Fixed Bundle | `overageRatePerMb` | 套外单价 | >= 0（仅 `DATA`） |
| Tiered Pricing | `monthlyFee` | 月租费 | >= 0 |
| Tiered Pricing | `deactivatedMonthlyFee` | 停机保号费（按月） | >= 0 |
| Tiered Pricing | `tiers[]` | 阶梯费率 | 按阈值升序；阈值单位 MB；费率单位 `currency/Mb` |

- API 接口：
  - 契约说明：对 APN Profile、Roaming Profile、Price Plan 等快照资源，`GET`/`POST` 响应中的 `status` **仅表示该快照行**的 `DRAFT` / `PUBLISHED` / `DEPRECATED`（与上文「状态与引用口径」及各自快照规则一致）；引用与排期以对应快照 UUID 为准，**不要求、不暴露**调用方依赖内部递增 `version` 作为生命周期或绑定依据。
  - `POST /v1/apn-profiles` 创建 APN Profile 草稿快照
  - `POST /v1/apn-profiles/{id}/clone` 基于已有 APN Profile 快照创建新草稿快照（返回新 `apnProfileId`）
  - `PUT /v1/apn-profiles/{id}` 仅允许更新 DRAFT 快照
  - `POST /v1/apn-profiles/{id}:publish` 发布快照
  - `POST /v1/apn-profiles/{id}:deprecate` 废弃快照（**仅 `PUBLISHED`**，且无 Carrier Service / Subscription Package 引用，见上文 APN Profile 快照规则）
  - `GET /v1/apn-profiles` 列表查询（展示字段：名称 + 发布时间 + 状态；名称允许重复）
  - `GET /v1/apn-profiles/{id}` 查询快照详情
  - `POST /v1/roaming-profiles` 创建 Roaming Profile 草稿快照
  - `POST /v1/roaming-profiles:import-csv` 自 CSV 批量创建**新** DRAFT 快照（与 JSON 创建等价）
  - `GET /v1/roaming-profiles/{id}:export-csv` 导出 `mccmncList` 为 CSV（列与 import 一致），用于复制/修订后 re-import
  - `PUT /v1/roaming-profiles/{id}` 仅允许更新 **DRAFT** 快照（名称与 entries）；**已发布行不可改**，修订请 export → import 新建
  - `POST /v1/roaming-profiles/{id}:publish` 发布快照
  - `POST /v1/roaming-profiles/{id}:deprecate` 废弃快照（**仅 `PUBLISHED`**，设置 `deprecatedAt`；且无 Carrier Service / Package 引用）
  - `GET /v1/roaming-profiles` 列表查询（展示字段：名称 + 发布时间 + 状态；名称允许重复）
  - `GET /v1/roaming-profiles/{id}` 查询快照详情（含 entries）
  - `POST /v1/carrier-services` 创建 Carrier Service（`DRAFT`）
  - `PUT /v1/carrier-services/{id}` 更新 Carrier Service（**仅 `DRAFT`**）
  - `POST /v1/carrier-services/{id}:publish` 发布 Carrier Service（**仅 `DRAFT` → `PUBLISHED`**）
  - `POST /v1/carrier-services/{id}:deprecate` 废弃 Carrier Service（**仅 `PUBLISHED`**，且无 Subscription Package 通过 `carrier_service_id` 引用）
  - `GET /v1/carrier-services` 列表；`GET /v1/carrier-services/{id}` 详情；`POST /v1/carrier-services:validate` 校验
  - `GET /v1/carrier-services?roamingProfileId={id}` 按 Roaming Profile 快照反查 Carrier Service 列表
  - `GET /v1/carrier-services?apnProfileId={id}` 按 APN Profile 快照反查 Carrier Service 列表
  - `POST /v1/control-policies` 创建 Control Policy 草稿快照
  - `POST /v1/control-policies/{id}/clone` 基于已有 Control Policy 快照创建新草稿快照（返回新 `controlPolicyId`）
  - `PUT /v1/control-policies/{id}` 仅允许更新 DRAFT 快照
  - `POST /v1/control-policies/{id}:publish` 发布快照（**仅 `DRAFT`**）
  - `POST /v1/control-policies/{id}:deprecate` 废弃快照（**仅 `PUBLISHED`**，且无 Package 绑定，见上文 Control Policy 条文）
  - `GET /v1/control-policies` 列表查询（展示字段：名称 + 发布时间 + 状态；名称允许重复）
  - `GET /v1/control-policies/{id}` 查询快照详情
  - **列表查询（`GET /v1/commercial-terms` 与 `GET /v1/control-policies`，规则一致）**：
    - 查询参数支持 `resellerId`（语义 **`tenants.tenant_id`**，与 **FR-058** / 模块表 `reseller_id` 一致）、`status`，以及分页 `page`、`pageSize`；返回对应模块对象的 `items` 与 `total`。V1.1 当前实现不提供 enterprise 维度筛选。
    - **经销商 JWT**（`reseller_admin` / `reseller_sales` / `reseller_sales_director`）：未带 `resellerId` 时默认返回当前 token 所属经销商下的模块行；若 Query 中提供 `resellerId`，**MUST** 与 token 所属经销商一致，否则返回 `403`。
    - **企业侧凭证**（如企业 JWT、客户 M2M `X-API-Key`+`X-API-Secret`）：**MUST NOT** 调用上述列表接口；**MUST** 返回 `403`。
    - **平台管理员**（含 `ADMIN_API_KEY` 等效平台身份）：可按 `resellerId`、`status` 组合筛选；未提供 `resellerId` 时可查询平台可见范围内的模块行（以 OpenAPI 与 RBAC 为准）。
  - `POST /v1/commercial-terms`、`PUT /v1/commercial-terms/{id}` 管理 Commercial Terms（**仅 `DRAFT` 可改**）；`POST /v1/commercial-terms/{id}:publish`；`POST /v1/commercial-terms/{id}:deprecate`（**仅 `PUBLISHED`**，且无 Package 绑定，见上文）
  - **Price Plan**（**仅**下列六类路由，**与** **[Price Plan HTTP 接口范围](#spec-price-plan-http-scope)** **一致**；**MUST NOT** 实现 **`POST …/price-plans:clone`**、**`POST …/price-plans/{id}/versions`** 等）：
    - `POST /v1/enterprises/{enterpriseId}/price-plans` 创建 Price Plan 草稿快照（**`resellerId` 规则**见 **「Price Plan 创建与列表」**）
    - `GET /v1/enterprises/{enterpriseId}/price-plans` 列表查询（展示字段：名称 + 发布时间 + 状态；名称允许重复）
    - `GET /v1/price-plans/{id}` 查询快照详情
    - `PUT /v1/price-plans/{id}` 仅允许更新 **DRAFT** 快照
    - `POST /v1/price-plans/{id}:publish` 发布快照
    - `POST /v1/price-plans/{id}:deprecate` 废弃已发布快照（`PUBLISHED` → `DEPRECATED`）；**仅当**当前无任何 Package（产品包）绑定该 `pricePlanId` 时成功；否则返回错误并在详情中给出引用方的 `packageId` 列表
  - `POST /v1/enterprises/{enterpriseId}/packages` 创建产品包（**`DRAFT`**；`pricePlanId` 必填且为 `PUBLISHED`；已提供的 `carrierServiceId` / `commercialTermsId` / `controlPolicyId` 均 **MUST** 为 `PUBLISHED`）
  - `GET /v1/packages/{packageId}` 产品包详情
  - `GET /v1/packages?pricePlanId={id}` 按 Price Plan 快照反查产品包列表
  - `GET /v1/packages?commercialTermsId={id}` 按 Commercial Terms 反查产品包列表
  - `GET /v1/packages?controlPolicyId={id}` 按 Control Policy 快照反查产品包列表
  - `PUT /v1/packages/{packageId}` 修改产品包（**仅 `DRAFT`**；已提供或已绑定的模块 ID **MUST** 指向 `PUBLISHED` 快照）
  - `POST /v1/packages/{packageId}:publish` 发布（**仅 `DRAFT`**；**MUST** 校验 `pricePlanId`、`carrierServiceId` 及已绑定的可选模块均为 `PUBLISHED`；请求体 **MUST** 提供 `externalProductId`）
  - `POST /v1/packages/{packageId}:deprecate` 废弃（**仅 `PUBLISHED`**；**MUST** 无 `ACTIVE` / `PENDING` 订阅引用，见「产品配置域统一生命周期」表中 Package 废弃附加条件）

- Roaming Profile 条文补充（speckit）：
  - 字段规则：
    - `name`：可重复，作为展示字段，不作为唯一键
    - 列表展示固定包含：`name`、`publishedAt`、`status`
    - `mcc`：3 位数字，必填
    - `mnc`：2~3 位数字，或 `*`（表示该 MCC 下全部运营商）
    - `ratePerMb`：必填，非负数
    - `mcc` 为空时必须报错
  - 冲突规则：
    - 同一快照内，`mcc+mnc` 组合唯一；重复组合返回 `409 CONFLICT`
    - 同一快照内，`mcc-*` 只能配置一条；重复配置返回 `409 CONFLICT`
  - 不可变规则：
    - `PUBLISHED` 快照不可修改（只读锁定）
    - `DRAFT` 快照可通过 `PUT /v1/roaming-profiles/{id}` 更新名称与 entries；对已发布 Profile 的改版采用 export CSV → 编辑 → import CSV 创建新 `roamingProfileId`（来源快照通过 `sourceRoamingProfileId` 追溯）
    - 新快照默认 `DRAFT`，仅发布后可被产品包引用
  - 操作流程（Web Portal）：
    - 步骤1：用户在列表中选择已存在 Profile（可按名称、发布时间、状态识别）
    - 步骤2：若目标仍为 `DRAFT`，直接更新；若目标已 `PUBLISHED`，先导出 CSV，编辑后通过 `POST /v1/roaming-profiles:import-csv` 创建新的 DRAFT 快照
    - 步骤3：用户发布新快照，后续产品包可切换绑定到新 ID；旧快照保持不变
  - 错误码：
    - `BAD_REQUEST`：字段格式错误、必填缺失、`mcc` 为空
    - `CONFLICT`：同一快照内出现重复 `mcc+mnc` 组合或重复 `mcc-*`
    - `INVALID_STATUS`：对非 DRAFT 快照执行更新，或对非 DRAFT/非合法状态执行发布
    - `RESOURCE_LOCKED`：目标快照已发布或已进入不可写状态，不允许修改 entries
  - 示例请求（创建 Roaming Profile 草稿）：
    - `{"name":"SEA roaming","resellerId":"<uuid>","supplierId":"<uuid>","operatorId":"<uuid>","mccmncList":[{"mcc":"460","mnc":"00","ratePerMb":0.0008},{"mcc":"460","mnc":"*","ratePerMb":0.0012}]}`
  - 改版流程示例：`GET /v1/roaming-profiles/{roamingProfileId}:export-csv` 导出后编辑 CSV，再调用 `POST /v1/roaming-profiles:import-csv` 创建新的 `DRAFT` 快照；`POST /v1/roaming-profiles/{id}/clone` 在 V1.1 中返回 `410 Gone`。

- APN / Control Policy / Price Plan 快照条文补充（speckit）：
  - APN Profile：
    - `name` 可重复，列表展示 `name + publishedAt + status`
    - `DRAFT` 快照可更新；`PUBLISHED` 快照不可修改，改版可通过 `POST /v1/apn-profiles/{id}/clone` 创建新 `apnProfileId`
  - Control Policy：
    - `name` 可重复，列表展示 `name + publishedAt + status`
    - `DRAFT` 快照可更新；`PUBLISHED` 快照不可修改，改版可通过 `POST /v1/control-policies/{id}/clone` 或新建创建新 `controlPolicyId`
    - cutoff 与 throttling 规则作为快照内容一并固化
  - Price Plan：
    - **对外 HTTP** **仅** **[六种能力](#spec-price-plan-http-scope)**；**MUST NOT** 提供 **Clone** / **versions** 等专用接口；衍生新行 **MUST** 走 **Get detail → Create**。
    - `name` 可重复，列表展示 `name + publishedAt + status`
    - `DRAFT` 快照可更新；`PUBLISHED` 快照不可修改，衍生新资费走 **Get detail → Create** 创建新 `pricePlanId`
    - 快照内固定 `type`（ONE_TIME/SIM_DEPENDENT_BUNDLE/FIXED_BUNDLE/TIERED_PRICING）与对应计费字段
    - **废弃（deprecate）**：仅允许对 `PUBLISHED` 快照调用 `POST /v1/price-plans/{pricePlanId}:deprecate`；服务端 MUST 先检查是否存在任一产品包仍绑定该 `pricePlanId`，若有则 MUST 失败且不写入 `deprecatedAt`。错误响应 MUST 能定位引用方，例如在错误消息或标准错误体扩展字段中返回 `packageId` 列表。建议 HTTP `409`，业务码与 OpenAPI 对齐（如 `CONFLICT` / `IN_USE` 等，以 OpenAPI 为准）。

**Independent Test**: 可通过创建不同类型的产品包并验证字段校验规则来独立测试。

**Acceptance Scenarios**:

1. **Given** 创建 SIM Dependent Bundle 产品包, **When** 月租=10, perSimQuotaMb=1024(1GB), 当月 3 张 SIM, **Then** 总配额=3GB, 月租=30
2. **Given** 创建 One-time 产品包(quota=10GB, validity=30天, expiry=CALENDAR_DAY_END), **When** 2026-02-01 10:00 生效, **Then** 到期时间 2026-03-02 23:59:59
3. **Given** 产品包绑定 APN=A, **When** 变更为 APN=B 发布为次月生效, **Then** 当月不影响，次月生效并下发上游
4. **Given** 已发布 Price Plan `P` 且某 Package 仍绑定 `P` 的 `pricePlanId`, **When** 调用 `POST .../price-plans/{P}:deprecate`, **Then** 请求失败且不修改 `P`；错误详情包含引用方 `packageId`。**Given** 无任何产品包绑定 `P`, **When** 再次 deprecate, **Then** 成功且 `P` 变为 `DEPRECATED`

---

### User Story 4 - 订阅关系管理 (Priority: P1)

管理 SIM 与产品包之间的订阅关系，支持创建、变更、退订等操作。

**订阅规则**：
- 生效时间精确到秒（TIMESTAMPTZ）
- 订阅状态：**PENDING / PROVISIONING / ACTIVE / CANCELLED / EXPIRED**（见 [subscription-provisioning-upstream-mapping.md](clarifications/subscription-provisioning-upstream-mapping.md)）
- 互斥校验：同一时间一张 SIM 仅允许 1 个主数据产品包，叠加包不限
- **上游开通（MUST）**：创建订阅 **MUST** 经异步 **`SUBSCRIPTION_PROVISION` Job** 调用上游供应商接口；同步 API **仅** 受理并入队，**MUST NOT** 在无上游确认时返回 `ACTIVE`
- **SIM ↔ Package 对齐（MUST）**：`sim.supplier_id` / `sim.operator_id` **MUST** 与 Package → Carrier Service 一致；Package **MUST** 为 `PUBLISHED` 且存在 **`vendor_product_mappings`**
- 变更限制：当前 V1.1 对 **ACTIVE MAIN** 仅允许 `NEXT_CYCLE` 切换；对未生效的 `PENDING MAIN`，在无 ACTIVE MAIN 冲突时可按 `IMMEDIATE` 策略切换
- 退订保护：当前 V1.1 对 **ACTIVE** 订阅拒绝立即取消（`immediate=true`），必须通过 `immediate=false` 排程到周期末或 ONE_TIME ADD_ON 到期时执行；`PENDING` 订阅可直接取消为 `CANCELLED`
- 每次订阅记录生效时间与承诺期，用于计算承诺期结束日
- 最早可拆机时间 = max(各订阅承诺期结束日)
- 主套餐/叠加包是订阅关系的语义，不限定资费类型；资费类型由产品包定义

**场景模板：东南亚主包 + 中国叠加包**
- 目标：东南亚为主流量低成本覆盖；中国为少量高成本按量计费
- 订阅配置：
  - 主套餐：东南亚七国 SIM Dependent Bundle（覆盖区域=SEA-7）
  - 叠加包：中国大陆 Tiered Pricing（覆盖区域=CN；历史 PAYG 表述已废弃）
- 用量匹配（与 Waterfall Logic 一致）：
  - visitedMccMnc 属于 CN：优先命中中国叠加包
  - visitedMccMnc 属于 SEA-7：命中主套餐
  - 无覆盖：Out-of-Profile（V1.1 按 Package -> Carrier Service -> Roaming Profile 的 OOP roaming rate 计费；未命中费率则记录 `UNCLASSIFIED`）
- 计费口径：
  - 主套餐月租与配额按 SIM Dependent Bundle 规则计算
  - 叠加包按 Tiered 规则计费，不影响主套餐配额
  - visitedMccMnc 必填，用于分摊到正确产品包

**订阅约束与变更策略（V1.1 当前实现）**：
- 变更（Switch）：`POST /v1/subscriptions:switch` 支持 `NEXT_CYCLE` 与 `IMMEDIATE`。**ACTIVE MAIN** 不允许立即切换，必须使用 `NEXT_CYCLE`；服务端会排程取消旧订阅，并创建未来生效的新 `PENDING` MAIN 订阅及其 `SUBSCRIPTION_PROVISION` Job。**PENDING MAIN** 可作为被切换对象；若仍存在 ACTIVE MAIN 且请求 `IMMEDIATE`，服务端拒绝。
- 退订（Cancel）：`POST /v1/subscriptions/{subscriptionId}:cancel` 为对外契约路径；Fastify 实现经 URL rewrite 落到 `/subscriptions/{subscriptionId}/cancel`。**ACTIVE** 订阅不允许 `immediate=true`，使用 `immediate=false` 时创建 `subscription_cancel_schedules` 排程：MAIN 与月度 ADD_ON 默认在下个自然月 1 日执行，ONE_TIME ADD_ON 若已有 `expiresAt` 则在该时间执行。**PENDING** 订阅直接改为 `CANCELLED`。**PROVISIONING**、已 `CANCELLED`、已 `EXPIRED` 的订阅取消请求返回冲突错误。

**计数口径**：订阅生效时间决定月初取数与月内新增计数。

**计费窗口**：以产品包定义的计费周期为准，用量归集窗口与计费窗口一致。

**Why this priority**: 订阅是 SIM 与产品包的连接桥梁，直接影响计费计算的准确性。

**Technical Implementation**:

- 产品包订阅语义：
  - **PROVISIONING**：已受理，上游开通 Job 排队或执行中；**尚未** 获得上游确认
  - **PENDING**：**仅** 表示尚未到达 **`effectiveAt`** 的预约订阅（到点后进入开通 Job / **PROVISIONING**）
  - **ACTIVE**：上游开通已成功且满足生效条件；当前账期生效
  - **CANCELLED**：撤销（当月计数与配额不回收）
  - **EXPIRED**：到期或被替换后归档
  - **上游失败**：**MUST** **删除** 本地 `subscriptions` 行（**不** 保留失败态订阅）；**MUST** 投递 **`JOB_FINISHED`（FAILED）** 及失败类订阅事件，并经 **Webhook** 通知 **下游客户系统**
- 月内取消订阅：当月仍按全额月租计费，配额保留至月底
- 取消队列：`subscription_cancel_schedules` 表存储已生效订阅的待执行取消；定时任务扫描并执行
- 开通 Job：详见 [subscription-provisioning-upstream-mapping.md](clarifications/subscription-provisioning-upstream-mapping.md)

- API 接口：
  - `GET /v1/subscriptions` 列表订阅（企业维度过滤等以 OpenAPI 为准）
  - `POST /v1/subscriptions` 创建订阅（单笔 ICCID）
  - `POST /v1/subscriptions:batch-create` **批量创建订阅**（多 ICCID、同一 `packageId`；见下文 **批量创建订阅（Batch Create Subscriptions）**）
  - `POST /v1/subscriptions:batch-export` **按筛选条件导出订阅 CSV**（与 `GET /v1/subscriptions:search` 同类过滤；见下文 **批量导出订阅（Batch Export Subscriptions）**）
  - `GET /v1/subscriptions:search` 跨企业/代理商/供应商/运营商等筛选查询（权限与范围以 OpenAPI 为准）
  - `GET /v1/enterprises/{enterpriseId}/subscriptions` 企业维度订阅查询（返回脱敏/企业视图字段）
  - `POST /v1/subscriptions:switch` 套餐切换（退订旧 MAIN + 创建新 MAIN；`ACTIVE` 仅支持 `NEXT_CYCLE`）
  - `POST /v1/subscriptions/{subscriptionId}:cancel`（对外路径；当前 ACTIVE 仅允许 `immediate=false` 排程取消）
  - `GET /v1/subscriptions/{subscriptionId}` 获取单条订阅详情（以 OpenAPI 为准）
  - `GET /v1/sims/{simId}/subscriptions` 查询某 SIM 订阅历史

**批量创建订阅（Batch Create Subscriptions）**

为运营/Portal 提供「一批 SIM 订阅**同一**已发布 Package」的能力：业务规则与单笔 `POST /v1/subscriptions` **逐条对齐**，差异仅在于 ICCID 输入载体与响应形态（**允许部分成功**，**逐 ICCID 返回结果**）。

**端点（契约真源以 OpenAPI 为准）**

- **`POST /v1/subscriptions:batch-create`**
- **Content-Type**：`multipart/form-data`（Swagger UI 可用「下拉 + 表单字段 + 选择文件」描述；脚本可用 `curl -F` 调用）。

**表单字段（与单笔创建语义一致）**

| 字段 | 必填 | 说明 |
|------|------|------|
| `enterpriseId` | 视身份而定 | 与 `POST /v1/subscriptions` 相同：**Admin key / Reseller** 必填；**Customer** 可省略或与 token 一致。 |
| `packageId` | 是 | 目标产品包 `package_id`（UUID）。**MUST** 仅允许状态为 **`PUBLISHED`** 的包；否则对该次调用中**每一条** ICCID 的创建逻辑与单笔接口一致（例如对不满足条件的行返回与单笔相同的业务码/语义，见下）。 |
| `kind` | 是 | `MAIN` \| `ADD_ON`，与单笔创建相同。 |
| `effectiveAt` | 是 | `date-time`（ISO 8601），与单笔创建相同；与「四种订阅方式」组合关系见下。 |
| `batchId` | 否 | 幂等键；不提供时使用上传文件内容 SHA-256。重复成功批次返回 `409 DUPLICATE_BATCH`。 |
| `file` | 是 | ICCID CSV 文件（见 **文件格式**）。 |

**四种订阅方式（与单笔 `POST /v1/subscriptions` / OpenAPI examples 对齐）**

Portal 侧以**下拉**等方式映射到同一组字段，**无需**单独增加第 5 个枚举入参：

1. **立即订阅 MAIN**：`kind=MAIN`，`effectiveAt` 为「当前或过去」的时刻（服务端以与单笔创建相同的判定界定「立即」）。
2. **下周期订阅 MAIN**：`kind=MAIN`，`effectiveAt` 为下一计费周期起点（与 OpenAPI 示例一致，如次月首日 UTC 等——**精确规则以 OpenAPI 与单笔实现为真源**）。
3. **立即订阅 ADD_ON**：`kind=ADD_ON`，`effectiveAt` 为「当前或过去」。
4. **下周期订阅 ADD_ON**：`kind=ADD_ON`，`effectiveAt` 为下一计费周期起点。

**文件格式（ICCID CSV）**

- **编码**：UTF-8；**MAY** 允许 UTF-8 BOM，实现 **SHOULD** 容忍并剥离 BOM。
- **内容**：当前 V1.1 实现要求 CSV 首行包含 **`iccid`** 表头列；可包含其它列（如 `imsi`、`msisdn`），服务端忽略非 `iccid` 列。
- **空行**：实现 **MUST** 忽略（跳过）。
- **行首尾空白**：实现 **MUST** trim 后再校验。
- **ICCID 语法**：与单笔创建及 OpenAPI `pattern` 一致（如 `^[0-9]{18,20}$`）；不合法行 **MUST** 在逐行结果中失败，**MUST NOT** 导致整请求无响应（除非触发**请求级**错误，见下）。
- **重复 ICCID**：同一文件内同一 ICCID 多次出现时，**MUST** 仅对**首次出现**执行订阅尝试；后续行 **MUST** 在 `results` 中标记失败，业务码建议 **`DUPLICATE_IN_FILE`**，**MUST NOT** 为同一 ICCID 创建多条相同逻辑的新订阅。

**请求级错误（不进入逐行处理，或处理为零行）**

下列情况 **MUST** 返回 **4xx**（具体 HTTP 码与 `code` 以 OpenAPI 为准），**MUST NOT** 使用 200 佯装成功：

- 未认证/无权限、enterprise 解析失败、multipart 缺必填字段、`file` 缺失或无法作为文本读取。
- CSV 缺少 `iccid` 表头列。
- 文件**在解析后**合法 ICCID **有效行数为 0**（如空文件、仅空行、或所有行均不满足 ICCID 格式）。
- **超出**产品声明的**单次上限**（见 **上限**）。

**上限（MUST 写入 OpenAPI）**

- **最大 ICCID 行数**：当前默认 `SUBSCRIPTION_BATCH_MAX_ICCID_LINES=5000`（环境变量可调）。
- **最大 multipart body size**：当前默认 `SUBSCRIPTION_BATCH_MAX_BYTES=10MB`（环境变量可调）；超限返回 `413 PAYLOAD_TOO_LARGE`。

**成功语义与 HTTP 状态（部分成功）**

- 只要请求通过**请求级**校验且服务端**已开始按行处理**，当前 V1.1 返回 **HTTP 201**（**即使**部分 ICCID 失败）。
- **MUST NOT** 仅因「部分行失败」而对整批返回 **5xx**。
- 响应体 **MUST** 包含汇总与逐行结果，使调用方可据此重试或展示（建议结构如下，字段名以实现与 OpenAPI schema 为准）：
  - **`summary`**：`total`（应处理条数，含失败行）、`succeeded`、`failed`。
  - **`results`**：数组；每项 **MUST** 含 `iccid`、**`ok`**（boolean）。  
    - `ok === true` 时 **MUST** 含与单笔创建等价的业务字段（如 `subscriptionId`、`state`、`effectiveAt`、`expiresAt`、`commitmentEndAt` 等——与 `POST /v1/subscriptions` 响应对齐）。  
    - `ok === false` 时 **MUST** 含 `code`、`message`（及可选 `details`），业务码 **SHOULD** 与单笔创建及现有错误码一致（如 `SIM_NOT_FOUND`、`FORBIDDEN`、`SIM_RETIRED`、`ENTERPRISE_SUSPENDED`、`PACKAGE_NOT_FOUND`、`MAIN_SUBSCRIPTION_EXISTS`、`BAD_REQUEST` 等），便于前端与脚本统一处理。
- **`batchId`**：响应返回实际使用的幂等键；调用方提供 `batchId` 时回显该值，否则为文件 SHA-256。

**业务规则（逐条）**

- 对 `results` 中每一个待处理 ICCID，服务端 **MUST** 复用与 `POST /v1/subscriptions` **相同**的校验与持久化规则（含：**Package `PUBLISHED`**、SIM 归属 enterprise、SIM `RETIRED`、企业非 ACTIVE、立即 MAIN 互斥等）。
- **无**跨 ICCID 的分布式事务要求：一行成功与另一行失败 **MUST** 可并存。

**审计**

- **MUST** 为**每条成功创建**的订阅写入与单笔创建**同级**的审计语义（或等价可追踪记录）。
- **MAY** 为整批增加一条摘要审计（附带 `batchId`、汇总统计）。

**批量导出订阅（Batch Export Subscriptions）**

为运营/Portal 提供「按筛选条件 → **下载 CSV**」的订阅视图导出：当前 V1.1 与 **`GET /v1/subscriptions:search`** 使用同类筛选、分页与租户范围语义；差异为响应为 `text/csv` 附件，且 `pageSize` 默认与上限更适合导出场景。

**端点（契约真源以 OpenAPI 为准）**

- **`POST /v1/subscriptions:batch-export`**
- **请求 Content-Type**：`application/json`（也可通过 query/body 传同名筛选参数；以 OpenAPI 为准）
- **成功响应**：**HTTP 200**，body 为 **CSV 文档**（**非 JSON**）；**`Content-Type: text/csv; charset=utf-8`**；**`Content-Disposition: attachment`**，**`filename`** 建议包含时间戳（如 `subscriptions-export-20260208T120000Z.csv`）。
- **幂等要求**：当前 V1.1 **`batchId` 必填**；重复 `batchId` 返回 `409 DUPLICATE_BATCH`。
- **分页**：`pageSize` 默认 **100**，最大 **1000**。

**输入参数**

| 字段 | 必填 | 说明 |
|------|------|------|
| `batchId` | 是 | 导出幂等键；重复成功导出返回 `409 DUPLICATE_BATCH`。 |
| `enterpriseId` | 视身份而定 | 与 `GET /v1/subscriptions:search` 相同；reseller/customer scope 按 token 校验。 |
| `resellerId` | 否 | reseller scope 下若提供必须与 token 匹配；customer scope 不允许。 |
| `departmentId` | 否 | 部门筛选；必须属于 `enterpriseId`。 |
| `iccid` | 否 | ICCID 前缀或完整值筛选；当前实现不是上传 ICCID 文件。 |
| `imsi` | 否 | IMSI 筛选。 |
| `state` | 否 | `PENDING` / `PROVISIONING` / `ACTIVE` / `CANCELLED` / `EXPIRED`；不传则不过滤状态。 |
| `kind` | 否 | `MAIN` / `ADD_ON`；不传则不过滤。 |
| `supplierId` / `operatorId` / `packageId` | 否 | 与 search API 一致的供应商、运营商、产品包筛选。 |
| `page` / `pageSize` | 否 | 导出当前页；`pageSize` 默认 100，最大 1000。 |

**CSV 列（建议集；列名与顺序以 OpenAPI 为真源）**

- 当前 V1.1 CSV 列为：`subscriptionId`、`enterpriseId`、`simId`、`iccid`、`kind`、`packageId`、`packageName`、`state`、`effectiveAt`、`expiresAt`、`cancelledAt`、`firstSubscribedAt`、`commitmentEndAt`。
- 因当前导出不是逐输入 ICCID 解释型导出，不输出 `rowStatus`、`INVALID_ICCID`、`SIM_NOT_FOUND`、`NO_SUBSCRIPTIONS` 等行级诊断列；无匹配记录时返回仅含表头的 CSV。

**格式与体验**

- **转义**：**MUST** 符合 **RFC 4180**（字段含逗号、引号时正确引用）。
- **Excel**：实现 **SHOULD** 使用带 **UTF-8 BOM** 的输出，减少中文环境乱码。
- **时间**：**MUST** 与现有 API 一致采用可解析的日期时间字符串（如 ISO 8601 UTC，栏注以 OpenAPI 为准）。

**请求级错误（返回 4xx + JSON 错误体，不返回 CSV）**

- 未认证/无权限、`enterpriseId` / `resellerId` / `departmentId` 等范围解析失败或越权、`batchId` 缺失、重复 `batchId`、筛选参数格式错误。

**上限**

- 导出 `pageSize` 最大 **1000**；更大数据量通过分页多次导出。

**审计**

- 当前实现写入一条 `SUBSCRIPTION_BATCH_EXPORT` Job 记录，包含 `batchId`、筛选条件、导出行数、文件名等摘要信息；**MUST** 遵守现有只读导出的合规策略。

**Independent Test**: 可通过为 SIM 创建订阅（单笔与批量）、按筛选条件批量导出 CSV、执行套餐切换、验证互斥规则来独立测试。

**Acceptance Scenarios**:

1. **Given** SIM 已有主套餐 A, **When** 尝试同时订阅主套餐 B, **Then** 系统拒绝（互斥）
2. **Given** 订阅生效时间 2026-02-10, **When** 计算 2026-02 账期, **Then** 计入 2026-02 订阅计数
3. **Given** 主套餐切换为次月生效, **When** 2026-02-15 提交, **Then** 2026-02 不受影响，2026-03 生效
4. **Given** 批量 CSV 中存在 `iccid` 表头，且部分 ICCID 合法可订阅、部分不满足条件（或格式错误、或文件中重复）, **When** 调用 `POST /v1/subscriptions:batch-create`, **Then** HTTP 201，`summary` 与 `results` 正确反映成功/失败条数，失败行含可区分业务码；合法行已创建订阅并入队 `SUBSCRIPTION_PROVISION` Job，失败行不创建订阅
5. **Given** 已有订阅数据, **When** 调用 `POST /v1/subscriptions:batch-export` 并提供唯一 `batchId` 与筛选条件, **Then** HTTP 200，响应为带 UTF-8 BOM 的 CSV 附件；列集合与当前 OpenAPI 一致，`pageSize` 默认 100 且最大 1000。**Given** 重复使用同一 `batchId`, **Then** 返回 `409 DUPLICATE_BATCH`

---

### User Story 5 - 计费引擎与月租费计算 (Priority: P1)

基于高水位计费原则和用量归集规则，实现计费引擎核心逻辑。

**权威源与计费原则**：
- SIM 状态轨迹以本系统 `sim_state_history` 为**月租费 / 高水位**判定输入；用量计费以已归一化落库的 `usage_daily_summary` / CDR 事实为输入。本地 SIM 状态异常（例如本系统仍为 `TEST_READY` 但上游已产生用量）不得单独阻断 usage rating，只能作为 metadata / 告警线索
- 上游 CMP / 供应商系统仍是原始事实来源，但 V1.1 计费引擎不包含供应商 API 拉取、SFTP 话单采集与清洗管道
- 仅实现资费_企业（零售资费），不实现资费_运营商
- 计费结果可追溯：`usage_daily_summary.input_ref` / SIM 状态轨迹 -> 订阅或 Default Fallback Package 映射 -> Package / Price Plan -> `rating_results` / `bill_line_items` / `calculationId`

**月租费计算规则（高水位 High-Water Mark）**：
- 基于 SIM 在自然月内的状态轨迹判定（非月底快照）
- 依据 `sim_state_history` 表（`start_time` / `end_time` / `after_status`）；若账期内无相关历史记录，使用 `sims.status` 兜底
- 计费优先级：ACTIVATED > DEACTIVATED > 其他

详细判定：
1. **全额月租费**：账期内曾处于 ACTIVATED（哪怕 1 秒）
2. **停机保号费**：未曾 ACTIVATED，但曾 DEACTIVATED
3. **无月租**：仅 INVENTORY 或 TEST_READY

- 月租费与停机保号费绝对互斥（同一 SIM 同一账期仅一项）

**用量归集与产品包匹配规则（Waterfall Logic）**：
1. 时间窗匹配：按 `usage_day` 查找 SIM 当日有效订阅（当前实现将 `ACTIVE` 与已到生效时间的 `PENDING` 纳入匹配）
2. 区域与优先级匹配：
   - 叠加包优先
   - 范围最小优先（Covered Network Profile / Roaming Profile 条目更少者优先）
   - 主套餐兜底
   - 无覆盖 -> Out-of-Profile
3. 计费处理：
   - In-Profile：扣减配额，配额耗尽后的处理按 Price Plan 类型决定；FIXED_BUNDLE / SIM_DEPENDENT_BUNDLE 使用 `overageRatePerMb`，ONE_TIME / TIERED 超过可承接上限时进入 Default Fallback Package 路径
   - Out-of-Profile：不扣减任何套餐配额；当前 V1.1 使用 **Package -> Carrier Service -> Roaming Profile** 的 OOP roaming rate 计费，并在 `rating_results.classification` / line item metadata 中标记 `OOP_ROAMING` 与 `OUT_OF_PROFILE_ROAMING`
   - V1.1 已移除 Price Plan 级 Zone PAYG 兜底；若未找到 CoveredNetworkProfile、OOP roaming rate 或其它可执行规则，则该 usage 可归入 `UNCLASSIFIED` 数据质量桶，不按不存在的费率扣费
   - 用量计费以 CDR / usage 事实为输入，本地 SIM 状态不应单独阻断用量批价。若本地 SIM 状态为 `TEST_READY` / `INVENTORY` / `DEACTIVATED`，但上游已产生用量，则仍应按当日有效订阅与产品包正常 Rating；本地状态异常必须写入 `rating_results` / line item metadata（如 `localSimStatus`、`LOCAL_STATUS_NOT_ACTIVE`）以供运营追踪
   - 若 SIM 在用量日期没有任何有效订阅，或当前有效订阅中的 Price Plan 已无能力继续承接该超额用量（例如 ONE_TIME 配额耗尽且无 MAIN 可承接、TIERED 超过最高 tier 上界），则进入 **Default Fallback Package** 路径。Waterfall 顺序必须是：先找有效订阅 Package；若找到，再判断 in-profile / out-of-profile / unclassified；若没有有效订阅或没有可承接 Package，才查 Default Fallback Package 映射；fallback 命中后按 fallback Package 的 Carrier Service / RoamingProfile 判断 out-of-profile 或 unclassified

**Default Fallback Package（无订阅但有用量兜底）**：
- 目的：解决“上游供应商侧 SIM 已 ACTIVE 并产生 CDR，但本系统无可承接产品包”的漏计费风险。典型原因包括接口调用失败、本地状态滞后、订阅开通回写失败、运营数据修复滞后，或当前订阅中的 ONE_TIME / TIERED Price Plan 已超过可承接上限。
- 管理口径：fallback package 本身应仍是普通 Package，沿用普通 Price Plan、CoveredNetworkProfile、Carrier Service、RoamingProfile、Package 的创建与发布流程；系统只需要额外维护一个默认映射，将指定普通 `packageId` 设置为某 enterprise 在某 reseller/supplier/operator 下的兜底产品包。
- 唯一粒度：每个 `enterpriseId + resellerId + supplierId + operatorId` **最多一条 ACTIVE default fallback package 映射**，即 `enterpriseId + resellerId + supplierId + operatorId -> packageId`。这避免 Rating 在无订阅场景下猜测产品包，也允许同一 reseller/supplier/operator 为不同 enterprise 使用不同兜底资费。
- 重复设置规则：若同一 `enterpriseId + resellerId + supplierId + operatorId` 已存在 `ACTIVE` 映射，`set-default` 必须失败（建议 `409 ACTIVE_FALLBACK_PACKAGE_EXISTS`），错误信息必须包含既有 `mappingId` 与 `packageId`，便于用户确认当前生效对象。更换 fallback package 必须先调用 `unset-default` 停用旧映射，再调用 `set-default` 创建新 ACTIVE 映射。
- 取消设置规则：`unset-default` 按同一 `enterpriseId + resellerId + supplierId + operatorId` 定位当前 ACTIVE 映射；若不存在 ACTIVE 映射，必须失败（建议 `404 ACTIVE_FALLBACK_PACKAGE_NOT_FOUND`），不得返回假成功。
- 配置建议：fallback package **MUST** 使用普通 `FIXED_BUNDLE` Price Plan，而非 `ONE_TIME` 或 `TIERED_VOLUME_PRICING`。它表达 enterprise 在某 reseller/supplier/operator 下的周期性兜底计费池，不要求为每张 SIM 单独订阅；当 Rating 发现无有效订阅 usage 或无可承接产品包的超额 usage 时，通过 fallback 映射自动归属到该 Package。fallback-compatible package 必须满足：`monthlyFee=0`、`deactivatedMonthlyFee=0`、`totalQuotaMb=0`，Price Plan 引用 `coverageMode=NONE` 且 `PUBLISHED` 的 CoveredNetworkProfile，Package 绑定 `PUBLISHED` Carrier Service，且 Carrier Service 必须引用 Roaming Profile。fallback package 不允许配置 in-profile 覆盖；命中 Roaming Profile OOP rate 时归入 `out_of_profile_mb`，未命中时归入 `unclassified_mb`，金额为 0。
- 最小管理接口：第一版可只提供“设置/取消默认 fallback package”的轻量接口，例如 `POST /rating-fallback-packages:set-default`（或等价命名），请求包含 `enterpriseId`、`resellerId`、`supplierId`、`operatorId`、`packageId`；校验 package 已 `PUBLISHED`、归属该 enterprise/reseller、绑定的 supplier/operator 与映射一致，并满足上述 fallback-compatible 约束。
- 查询参数规则：`GET /rating-fallback-packages` 使用 reseller token 时，`resellerId` 可省略并默认取 token reseller；若提供，必须是数据库中存在的 RESELLER tenant 且必须与 token 匹配。`enterpriseId` 可省略，表示查询该 reseller 下全部 enterprise 的 fallback mappings；若提供，必须是数据库中存在的 ENTERPRISE tenant 且归属当前 reseller，否则拒绝请求。`supplierId` / `operatorId` 均可省略，省略表示不按该维度筛选；若提供 `supplierId`，必须是数据库中存在的供应商且通过 `reseller_suppliers` 绑定当前 reseller；若提供 `operatorId`，可使用 `operators.operator_id` 或 `operators.business_operator_id`，必须能解析到数据库中存在的运营商行，且其 `supplier_id` 绑定当前 reseller；若二者同时提供，还必须满足该 `operatorId` 归属于该 `supplierId`。
- 分页规则：`GET /rating-fallback-packages` MUST 支持 `page` 与 `pageSize`；`page` 缺省为 `1`，`pageSize` 缺省为 `20` 且最大为 `20`。服务端 MUST 按 `(page - 1) * pageSize` 对查询结果分页，并在响应中返回 `items`、`total`、`page`、`pageSize`。
- Rating 行为：当某条 usage 找不到有效订阅 Package，或当前有效订阅 Package 已无能力继续承接该 usage 的超额部分时，Rating 按 `enterpriseId + resellerId + supplierId + operatorId` 查找唯一 ACTIVE fallback package 映射，并使用该 `packageId` 进入 fallback OOP rating 路径；这不是创建订阅，也不改变 SIM 的 subscription 状态。`rating_results.matched_subscription_id` 应为 `null`，`matched_package_id` 指向 fallback package。派生汇总中 fallback 场景没有真实订阅，`usage_package_daily_summary.subscription_id` 应为 `null`。
- 无映射与缺规则处理：若找不到 ACTIVE fallback 映射，则无法归属 Package，应进入 `unclassified_mb` 数据质量桶，并触发/记录“fallback package 未配置”类运营问题；若找到 fallback package 但无 OOP roaming rate，则该 usage 仍归属 fallback package，计入 `unclassified_mb`，金额为 0，并记录 unclassified metadata。
- 约束：fallback package 不贡献客户正常订阅配额，不产生月租费，不影响 SIM Dependent Bundle 高水位订阅数；它为无订阅 usage 提供可追溯的 Package 归属与分类（out-of-profile / unclassified）。fallback package 或 `quotaMb/totalQuotaMb/tierLimitMb=0` 不参与 `POOL_USAGE_HIGH` / `OUT_OF_PROFILE_SURGE` 等以配额为分母的百分比告警。

**SIM Dependent Bundle 计费**：
- 总配额 = activatedSimCount(高水位) × perSimQuotaMb
- 仅支付停机保号费的 SIM 不贡献配额
- 费用 = (activatedSimCount × monthlyFee) + (deactivatedSimCount × deactivatedMonthlyFee) + 套外费用

**Fixed Bundle 计费**：
- 固定总池额度，费用 = (activatedSimCount × monthlyFee) + (deactivatedSimCount × deactivatedMonthlyFee) + 套外费用

**Tiered Volume Pricing 计费**（分段累进；API 输入 `TIERED_PRICING` 会规范化为内部 `TIERED_VOLUME_PRICING`）：
- 0≤U≤T1: U×R1
- T1<U≤T2: T1×R1 + (U-T1)×R2
- 以此类推

**V1.1 用量输入边界**：
- 当前计费引擎读取 `usage_daily_summary`，按 `sim_id + usage_day + visited_mccmnc + total_mb + input_ref` 进行批价；批价完成后按 `rating_results.classification` 回写 `in_profile_mb`、`out_of_profile_mb`、`unclassified_mb` 与 `rated_at`
- 正常完成 Rating 的 usage **MUST** 尽量确定两个维度：一是 profile 分类（**in-profile** / **out-of-profile** / **unclassified**），二是产品包归属（有效订阅 Package、**Default Fallback Package**，或无可归属 Package）。Default Fallback Package 不是第三种 profile classification；fallback package 下的用量只能是 out-of-profile 或 unclassified。`in_profile_mb` 表示已被 rating 判定为 covered/in-profile 的用量，包括 `IN_PACKAGE`、covered `OVERAGE` 与 `TIERED_VOLUME`；`out_of_profile_mb` 表示 OOP roaming 等不属于 CoveredNetworkProfile 套内覆盖且有 RoamingProfile 规则归类的用量。
- `unclassified_mb` 用于尚未执行 Rating / Rollup、Rating 中断、缺少必要主数据导致无法解析 SIM / reseller / supplier / operator / package / fallback 映射，或已解析到 Package 但没有任何 Covered/OOP 规则命中的数据质量桶。它是显式可验收分类，金额通常为 0，不参与产品包百分比告警分母计算。
- 上述分类列是 Alerts、Reports、Dashboard 等模块的跨模块读取口径；`POOL_USAGE_HIGH` 应优先读取 `in_profile_mb`，只有历史数据缺失时才回退到 `rating_results` 或总用量兜底
- `total_mb <= 0` 的用量不产生费用，不扣减配额
- MCC/MNC 会规范化为 `mcc-mnc` 形式（例如 `23415` / `234-15` -> `234-015`）
- 供应商 API 拉取、SFTP 解析、迟到话单自动重算、异常用量风控审核属于后续采集/运营能力，不纳入 V1.1 US5 已实现范围

**用量聚合与批价派生流程（重要口径）**：
- **第一步：CDR / 上游用量同步 → `usage_daily_summary`**。上游 CDR 或 API 用量同步任务先将原始用量归一化为日级汇总，写入 `usage_daily_summary`。该表的业务粒度为 **SIM + usageDay + visitedMccMnc**；若同一 SIM 在同一天访问多个拜访地网络，则必须按 `visited_mccmnc` 形成多条汇总记录。该表只表达“这张 SIM 在某天某拜访网络用了多少”，不表达最终归属哪个 Package / Price Plan。
- **第二步：Billing / Rating → `rating_results`**。出账或重算时，Rating 模块读取 `usage_daily_summary`，结合订阅、Package、Price Plan、CoveredNetworkProfile、RoamingProfile 与 SIM 状态轨迹，生成 `rating_results`。该表是批价追溯明细，负责记录 `matched_subscription_id`、`matched_package_id`、`matched_price_plan_id`、`classification`、`charged_mb`、`amount`、`visited_mccmnc` 与 `calculation_id`。
- **第三步：Rating 派生聚合 → `usage_package_daily_summary`**。Rating 完成后，系统必须按 `rating_results` 聚合写入 `usage_package_daily_summary`。该表的业务粒度为 **SIM + usageDay + subscription + Package + PricePlan + visitedMccMnc**，保留 `visited_mccmnc` 以支持后续经营分析，例如 OOP 来源网络、国家/运营商成本异常、Package 使用结构与 CoveredNetworkProfile / RoamingProfile 优化。Default Fallback Package 场景下没有真实订阅，`subscription_id` 应为 `null`，并通过 `fallbackPackage=true` / `fallbackPackageId` / `fallbackReason` metadata 解释归属。它是 `rating_results` 的当前有效派生汇总，不由上游同步任务直接写入；同一粒度已存在时应覆盖/重算当前汇总，并用 `calculation_id`、`rated_at` 保留最近一次批价追溯。

**一份 usage 如何计入产品包（Billing / Usage Rollup 共用口径）**：
- Rating / Rollup 输入粒度为 `usage_daily_summary` 的 **SIM + usageDay + visitedMccMnc + totalMb**；该输入本身不携带 Package 归属，必须在 Rating 阶段结合当日有效订阅、Package 装配、Price Plan、CoveredNetworkProfile、RoamingProfile 与 SIM 状态轨迹解析。
- 订阅匹配使用 Waterfall Logic：先按 `usage_day` 找 SIM 当日有效订阅，再按叠加包优先、覆盖范围最小优先、主套餐兜底的顺序选择候选 Package；若无任一 Package 覆盖该 `visited_mccmnc`，则进入 out-of-profile 路径。
- `visited_mccmnc` 落入 Price Plan 所绑定 CoveredNetworkProfile 时，usage 计入该 Package 的 **in-profile** 产品包用量。`IN_PACKAGE`、covered `OVERAGE` 与 `TIERED_VOLUME` 均属于 covered / in-profile 用量：它们可能产生额外费用，但仍用于产品包配额消耗、使用率与 `POOL_USAGE_HIGH` 判断。
- `visited_mccmnc` 未落入 CoveredNetworkProfile 的用量，计入该 Package 的 **out-of-profile** 产品包用量。OOP 费率真源仍为 Package → Carrier Service → RoamingProfile；若缺少 OOP 规则且没有其它可执行归类，则应记录为 `UNCLASSIFIED`，金额为 0。
- 当 usage 找不到有效订阅，或有效订阅中的 Package 已无能力继续承接该 usage 的超额部分时，Rating 必须优先尝试 `enterpriseId + resellerId + supplierId + operatorId -> packageId` 的 Default Fallback Package 映射；命中后该 usage 的 `subscription_id` 为空、`package_id` 指向 fallback package，并按该 fallback package 的 Carrier Service / RoamingProfile 判断 `out_of_profile_mb` 或 `unclassified_mb`。只有普通 Package 与 fallback package 均无法解析时，才进入无 Package 归属的 `unclassified_mb` 数据质量桶。
- `ONE_TIME`：按单 SIM / 单 subscription / 单 Package 统计。covered 用量消耗该 SIM 订阅的 `quotaMb`；ONE_TIME 不定义 `overageRatePerMb`。若 ONE_TIME MAIN 的 `quotaMb` 耗尽，超出部分进入 Default Fallback Package 路径；若 ONE_TIME ADD_ON 的 `quotaMb` 耗尽，超出部分先尝试 MAIN Package 承接，MAIN 也无法承接时再进入 Default Fallback Package 路径。non-covered 用量按当前可承接 Package 的 OOP 规则处理。
- `SIM_DEPENDENT_BUNDLE`：按 Package 共享池统计。总配额必须使用账期内高水位激活 SIM 数计算：`totalQuotaMb = highWaterActiveSimCount * perSimQuotaMb`，而不是仅使用当前 active SIM 数。订阅该 Package 的所有 SIM 的 covered 用量汇总为 Package `in_profile_mb`；non-covered 用量汇总为 Package `out_of_profile_mb`。
- `FIXED_BUNDLE`：按 Package 固定共享池统计。总配额为 `totalQuotaMb`；订阅该 Package 的所有 SIM 的 covered 用量汇总为 Package `in_profile_mb`，non-covered 用量汇总为 Package `out_of_profile_mb`。
- `TIERED_PRICING` / `TIERED_VOLUME_PRICING`：按 Package 累进阶梯池统计。订阅该 Package 的所有 SIM 的 covered 用量进入 `in_profile_mb`，并按各 tier 上界分段产生 `TIERED_VOLUME` rating。最高 tier 应配置足够大的 `toMb`，使最后一档 `ratePerMb` 承担常规超额单价作用；若实际累计用量仍超过最高 tier `toMb`，超出部分进入 Default Fallback Package 路径。告警可按每一档 `tierLimitMb` 分别判断。
- `usage_package_daily_summary` 表达 Rating 后“当前有效”的产品包用量视图，不是原始 CDR 明细，也不是正式账单明细；它服务于产品包用量统计、Dashboard、经营分析和告警判断。

**产品包数据流量剩余配额**：
- 系统为后付费 CMP，不存在“SIM 金额余额”概念；SIM 用户不需要先充值再消费。因此 SIM 级 `balance` 不应表示账户现金余额，而应表示指定 ICCID 在当前或指定计费周期内，其有效订阅产品包的数据流量配额使用与剩余情况。
- 查询入口可使用 ICCID，但实际计算对象是该 ICCID 当前有效订阅所关联的 Package / PricePlan。对于共享池类型，返回的是“该 SIM 所属产品包共享池”的剩余配额，而不是该 SIM 独占配额。
- `ONE_TIME`：按单 SIM / 单 subscription / 单 Package 统计。配额来自 `price_plan_one_time.quota_mb`；已用量为该 SIM 在该 ONE_TIME Package 下的 `usage_package_daily_summary.in_profile_mb` 账期累计；剩余额度 `remainingMb = max(quotaMb - usedByThisSimMb, 0)`。ONE_TIME 不定义 `overageRatePerMb`，配额耗尽后的后续 covered 用量不应继续归属该 ONE_TIME。
- `SIM_DEPENDENT_BUNDLE`：按 Package 共享池统计。总配额为 `highWaterActiveSimCount * price_plan_sim_dependent_bundle.per_sim_quota_mb`；已用量为该 Package 下所有订阅 SIM 的 `in_profile_mb` 账期累计；剩余额度 `remainingMb = max(totalQuotaMb - usedByPackageMb, 0)`。对单 ICCID 展示时应同时返回 `usedByThisSimMb` 与 `usedByPackageMb`，避免误导为 SIM 独享剩余额度。
- `FIXED_BUNDLE`：按 Package 固定共享池统计。总配额来自 `price_plan_fixed_bundle.total_quota_mb`；已用量为该 Package 下所有订阅 SIM 的 `in_profile_mb` 账期累计；剩余额度 `remainingMb = max(totalQuotaMb - usedByPackageMb, 0)`。对单 ICCID 展示时同样应标记为共享池口径。
- `TIERED_PRICING` / `TIERED_VOLUME_PRICING`：不应返回单一固定 `remainingMb`。应返回当前阶梯信息，包括当前 `tierIndex`、`fromMb`、`toMb`、`ratePerMb`、`currentTierRemainingMb = max(currentTier.toMb - usedByPackageMb, 0)`、下一阶梯费率与是否已超过最高阶梯。该类型核心语义是“当前产品包用量处于哪个价格阶梯”，而不是固定套餐余量。
- 建议响应字段包含 `quotaScope`：`SIM_DEDICATED`（ONE_TIME）、`PACKAGE_SHARED`（SIM_DEPENDENT_BUNDLE / FIXED_BUNDLE）、`TIERED`（TIERED_PRICING）。通用字段包含 `subscriptionId`、`packageId`、`packageName`、`pricePlanId`、`pricePlanType`、`quotaMb`、`usedByThisSimMb`、`usedByPackageMb`、`remainingMb`、`usagePercent` 与阶梯相关字段。

**周期性 Rating / Usage Rollup（非出账任务）**：
- 系统需要独立的 **`USAGE_RATING_ROLLUP`** 任务，周期性刷新当前账期或指定日期范围内的 usage rating 与产品包用量视图。该任务复用 Billing/Rating 的归属与批价核心，但 **不**生成 `bills`、`bill_line_items`，也不执行账单状态流转或调账结算。
- `USAGE_RATING_ROLLUP` 默认处理当前 UTC 账期，也可通过 payload 指定 `period`、`fromDate` / `toDate`、`resellerId`、`enterpriseId` 与 `idempotencyKey`。`enterpriseId` 优先于 `resellerId`；platform 可全局运行，reseller 只能运行自身及下属 enterprise。
- 执行步骤：读取范围内 `usage_daily_summary` → 执行 Rating 归属与分类 → 写入可追溯的 `rating_results` → 回写 `usage_daily_summary` 的 `in_profile_mb` / `out_of_profile_mb` / `unclassified_mb` / `rated_at` → 覆盖写入 `usage_package_daily_summary` 当前有效汇总。`unclassified_mb` 可用于已完成 Rating 但无规则命中的显式分类；它不作为 `POOL_USAGE_HIGH` / `OUT_OF_PROFILE_SURGE` 的正常百分比来源。
- `calculation_id` 使用可区分前缀，例如 `USAGE_ROLLUP:{period}:{scope}:{runId}`；正式出账仍使用 `BILLING_GENERATE` 相关 calculationId。后续可增加 `calculation_type = USAGE_ROLLUP | BILLING_GENERATE` 字段进一步区分。
- 该任务是 Alerts、Reports、Dashboard 的前置刷新任务；`POOL_USAGE_HIGH` 与 `OUT_OF_PROFILE_SURGE` 不应等待正式出账后才获得当前账期产品包用量。

**漫游用量报表**：V1.1 通过 `rating_results` 与账单 L3 明细承载 SIM 粒度批价结果；最小追溯字段包括 `iccid`、`usage_day`、`visited_mccmnc`、`charged_mb`、`classification`、`amount`、`input_ref`、`calculation_id`。

**一致性与审计**：出账由 `BILLING_GENERATE` Job 驱动；批价结果写入 `rating_results`，账单明细写入 `bill_line_items`，账单生成写审计日志。迟到话单自动生成调账草稿不属于 V1.1 当前实现。

**Why this priority**: 计费是 CMP 的核心商业逻辑，直接关系到收入准确性。高水位计费和 Waterfall Logic 是系统的关键差异化能力。

**Technical Implementation**:

- 信控特殊说明：计费引擎仅认 SIM 实际状态轨迹，不直接处理企业状态
- 数据模型：
  - `sim_state_history`：SIM 全生命周期状态变更（Type 2 SCD）
  - `usage_daily_summary`：按 SIM + Day + visited MCC/MNC 预聚合，并保存 `total_mb` 及 rating 后的 in-profile / out-of-profile / unclassified MB 聚合
  - `rating_results`：保存每条用量批价分类、费率、金额与 `calculationId`
  - `usage_package_daily_summary`：由 `rating_results` 派生的 Package / Price Plan / visited MCC/MNC 日级经营分析与告警聚合表
  - `bill_line_items`：保存账单 L3 / package-level / adjustment 行项
- 执行路径：
  - `POST /v1/billing:generate` 受理已完结账期并创建 `BILLING_GENERATE` Job（支持 `idempotencyKey`）
  - Job 执行 `computeMonthlyCharges`，批量读取 SIM、订阅、用量与状态历史，避免逐 SIM N+1 查询
  - `runBillingGenerate` 写入 `bills`、`bill_line_items`、`rating_results`，并合并已审批调账单；是否自动发布由 billing schedule / `autoPublish` 决定
  - `USAGE_RATING_ROLLUP` Job 复用同一 rating core，只写 `rating_results` 与用量聚合表，不生成账单

- 多包场景示例：
  - SIM 订阅 Global 1GB(主) + France 500MB(叠加)
  - 事件 A（法国）：扣减 France 500MB
  - 事件 B（德国）：France 不覆盖，扣减 Global 1GB
  - 事件 C（古巴）：均不覆盖 -> Out-of-Profile；若 Package 的 Carrier Service Roaming Profile 有对应费率，则按 OOP roaming rate 计费，否则记录 `UNCLASSIFIED`

**Independent Test**: 可通过构造不同状态轨迹的 SIM 并执行计费计算，验证月租费判定规则和用量匹配逻辑。

**Acceptance Scenarios**:

1. **Given** SIM 02-10 ACTIVATED → 02-20 DEACTIVATED, **When** 计算月租, **Then** 收全额月租费
2. **Given** SIM 全月 DEACTIVATED, **When** 计算月租, **Then** 收停机保号费
3. **Given** SIM 全月 INVENTORY/TEST_READY, **When** 计算月租, **Then** 无月租项
4. **Given** SIM Dependent Bundle 月租=10, perSimQuota=1GB, activatedSims=3, 总用量≤3GB, **When** 计费, **Then** 费用=30(月租)
5. **Given** SIM 在法国产生用量, 订阅了 Europe 主套餐 + France 叠加包, **When** 用量匹配, **Then** 优先扣减 France 叠加包
6. **Given** SIM 产生未被任何订阅覆盖的漫游用量，且 Carrier Service Roaming Profile 存在对应费率, **When** 计费, **Then** `rating_results.classification=OOP_ROAMING` 且不扣减套餐配额

---

### User Story 6 - 账单与出账管理 (Priority: P1)

按账期生成企业账单，支持多层级展示、CSV 导出、手工核销、坏账核销、作废与调账下期结算。

**出账流程**：
1. 数据归集（Aggregation）：锁定用量记录与 SIM 状态快照
2. 批价与计费（Rating & Billing）：应用资费计划规则，得到 **ratingTotal**
3. 调账合并（Adjustment Settlement）：加载该企业 **APPROVED** 且币种一致的调账单，**nextTotal = ratingTotal + Σ(DEBIT) − Σ(CREDIT)**；写入调账行项；Note → **APPLIED**
4. 账单生成（Generation）：按企业/部门维度汇总，**total_amount = nextTotal**
5. 发布（Publish）：`GENERATED -> PUBLISHED`，记录 `published_at` 并投递 `BILL_PUBLISHED` 事件

**出账触发（V1.1 当前实现）**：
- 手工触发：`POST /v1/billing:generate` 受理已完结账期（`YYYY-MM` 且早于当前 UTC 月），创建 `BILLING_GENERATE` Job；支持 `idempotencyKey`
- 自动排队：worker 根据 `billing_config.auto_generate=true` 与 `bill_day` 为企业排队 `BILLING_GENERATE` Job；默认 T+3，可通过 `billing_config.bill_day` 配置
- 配置粒度：当前读取 enterprise/customer 级配置，并可回退 reseller 级配置；未配置时使用系统默认值
- `autoPublish=true` 时，出账 Job 生成账单后可自动执行 publish；否则停留在 `GENERATED` 等待手工发布

**账单结构**：
- L1 汇总账单（Account Summary）：企业维度总览，上期余额/本期费用/已付/应付/Due Date
- L2 分组汇总（Group Summary）：按部门 × 产品包交叉分组（每条 L2 行 = 1 个 department_id + 1 个 package_id 的费用小计），支持按部门展开或按产品包展开两种视角
- L3 费用明细（Line Items）：按 SIM 维度（ICCID/MSISDN/部门/产品包/月租/用量/套外/小计）

**账单状态（V1.1 当前实现）**：
- `GENERATED -> PUBLISHED`
- `PUBLISHED -> PAID / OVERDUE`
- `OVERDUE -> PAID / WRITTEN_OFF`
- `GENERATED / PUBLISHED / OVERDUE -> VOIDED`（需 reason，且受调账单状态约束）

**导出格式（V1.1 当前实现）**：
- 账单列表 CSV：`GET /v1/bills:csv`
- 单账单汇总 CSV（L1 + L2）：`GET /v1/bills/{billId}:csv`
- SIM 明细 CSV（L3）：`GET /v1/bills/{billId}/line-items:csv`
- V1.1 不提供 PDF / Excel 生成，也不提供旧式 `GET /v1/bills/{billId}/files`

**调账与差异处理**（细则见下节 **[调账业务流程](#adjustment-business-flow)** 与 [clarifications/adjustment-settlement.md](clarifications/adjustment-settlement.md)）：
- 已发布账单 **MUST NOT** 篡改 **`bills.total_amount`**
- Credit Note（贷项 / 减收）、Debit Note（借项 / 补收）
- **同一原账单 MAY 有多条** Adjustment Note（不同原因/类型/金额）；每条 **MUST** 独立 **`noteId`** 与审计链
- **`POST ...:adjust`** **MAY** 接受 **`idempotencyKey`**，在同一 **`billId`** 下 **MUST** 防重复提交（见 [billing-api.md](contracts/billing-api.md) §2.1）
- 审批通过的调账 **MUST** 计入**下一期**新账单结算；合并后 Note 状态 **APPLIED**，**MUST NOT** 重复计入后续账期

**迟到话单处理边界（V1.1 当前实现）**：
- V1.1 不实现“迟到话单自动重算并自动创建 Adjustment Note 草稿”的完整链路
- 已发布账单后的差异处理通过手工 `POST /v1/bills/{billId}:adjust` 创建 Credit / Debit Note；迟到话单可作为人工调账原因记录在 `reason` / `items` metadata 中
- 调账创建、审批、下期合并均记录事件与审计链路

<a id="adjustment-business-flow"></a>

### 调账业务流程 [V1.1 · Phase 39]

#### 设计原则

账单一旦 **PUBLISHED**（或进入 **OVERDUE**），系统 **MUST NOT** 修改该 **`bills`** 行的 **`total_amount`**。发现多收、少收、迟到话单差额等情况时，V1.1 通过**手工** **Credit / Debit Note（调账单）** 将差额记入**下一期新账单**，而非回头改写历史账单。这是 **FR-031** 的实现路径。

#### 两条入口

| 入口 | 触发方式 | 初始状态 |
|------|----------|----------|
| **手工调账** | `POST /v1/bills/{billId}:adjust` | **DRAFT** |
| **迟到话单差额** | V1.1 由运营/财务确认后通过手工 `:adjust` 录入；自动差额计算不纳入当前实现 | **DRAFT** |

手工调账前置条件：关联原账单状态 **MUST** 为 **PUBLISHED** 或 **OVERDUE**（**MUST NOT** 对 **GENERATED** / **PAID** / **WRITTEN_OFF** 创建 Note）。

#### 同一账单多次调账

- **MUST** 允许对同一 **`billId`** 多次调用 **`POST /v1/bills/{billId}:adjust`**（例如不同 CREDIT/DEBIT、不同 **`reason`**）。
- 省略 **`idempotencyKey`** 时，每次成功创建 **MUST** 对应**一条**独立的 **`adjustment_notes`** 行。
- 提供 **`idempotencyKey`** 时，相同 **`billId + idempotencyKey`** 重复提交 **MUST** 返回 **409** `IDEMPOTENCY_CONFLICT`，**MUST NOT** 重放旧 Note，也 **MUST NOT** 创建第二条 Note。
- **`GET /v1/adjustment-notes?billId=`** **SHOULD** 在发起新调账前供 reseller/platform 用户核对历史（含 **`reason`**、**`idempotencyKey`**、**`status`**）。

#### 幂等键（`idempotencyKey`）

与 SIM 生命周期、南向指令一致，Billing 写操作 **SHOULD** 支持客户端 **`idempotencyKey`**（见 **FR-038** 精神及 [billing-api.md](contracts/billing-api.md)）：

| 接口 | 键作用域 | 行为摘要 |
|------|----------|----------|
| **`POST /v1/bills/{billId}:adjust`** | **`(billId, idempotencyKey)`** | 相同键 → **409** `IDEMPOTENCY_CONFLICT`（不重复创建 Note） |
| **`POST /v1/billing:generate`** | **`(period, resellerId, enterpriseId, idempotencyKey)`** | 相同 scope + 键 → 返回已有 **Job**（**202**/**200**）；键跨 scope 复用 → **409** |

省略 **`idempotencyKey`** 时 **MUST** 保持「每次新建」的兼容行为。

#### CREDIT 与 DEBIT

调账单上的 **`total_amount` MUST** 恒为正数；方向由 **`type`（note_type）** 决定：

| 类型 | 业务含义 | 对下一期账单的影响 |
|------|----------|-------------------|
| **CREDIT** | 贷项（给客户减钱 / 抵扣） | 下期 **`total_amount` 减少** |
| **DEBIT** | 借项（补收） | 下期 **`total_amount` 增加** |

合并公式（出账时刻、同一企业、同一币种）：

```
netAdjustment   = Σ(APPROVED DEBIT) − Σ(APPROVED CREDIT)
下一期 total_amount = ratingTotal + netAdjustment
```

其中 **ratingTotal** 为当期批价引擎正常费用（月租 + 用量等），**不含**调账。

**示例**：ratingTotal = 1000；有一笔 **APPROVED** 的 CREDIT 200 与 DEBIT 50 → netAdjustment = −150 → 下期 **total_amount = 850**。

#### 调账单状态机

```
DRAFT ──:approve──► APPROVED ──billing:generate（下期出账）──► APPLIED
  │
  └──（作废关联原账 :void 时自动）──► CANCELLED
```

| 状态 | 含义 |
|------|------|
| **DRAFT** | 已创建，待审批；**尚未**影响任何账单金额 |
| **APPROVED** | 已审批，排队等待**下一次** `billing:generate` 合并 |
| **APPLIED** | 已并入某期新账单的 **`total_amount`**；**MUST NOT** 再次被计入 |
| **CANCELLED** | 已作废，不再参与审批或结算（当前由 **`POST ...:void`** 作废原账时，自动取消仍处 **DRAFT** 的关联 Note） |

被调账关联的原账单（PUBLISHED / OVERDUE）从头到尾 **`total_amount` 不变**。

#### 逐步业务流程

**1. 创建（DRAFT）** — `POST /v1/bills/{billId}:adjust`

- 权限：**`bills.adjust`**（reseller 侧）；**customer / department token MUST NOT** 调用（**403**）
- **`reason` MUST** 为非空字符串；空值返回 **400** `BAD_REQUEST`
- 写入 **`adjustment_notes`**（status=**DRAFT**）及 **`adjustment_note_items`**（可含 SIM 级明细）
- **`source_bill_id`**（实现列）**MUST** 指向关联原账单；**`idempotency_key`**（可选）与 **`source_bill_id`** 联合唯一
- 币种 **MUST** 继承原账单；Note 通过 **`source_bill_id`** 及 item metadata 关联 **`billId`**
- 若请求包含 **`items[].iccid`**：字段提供时 **MUST** 为非空字符串；空字符串返回 **400** `INVALID_ICCID`；ICCID 不存在或不属于原账单企业时返回 **404** `SIM_NOT_FOUND`
- 审计：**`BILL_ADJUSTMENT_NOTE_CREATED`**（含 **`actor_user_id`**，供审批时校验创建者）

**2. 查询** — `GET /v1/adjustment-notes?billId=&type=&status=...`

- 权限：**`bills.adjust.list`**
- **reseller token**：仅可见下属企业的 Note；**platform admin / admin API key** 不限
- 可按 billId / type / status 过滤；**billId** 越权 **404**
- 列表项 **SHOULD** 含 **`billId`**、**`reason`**、**`idempotencyKey`**（若曾提供）

**3. 审批（DRAFT → APPROVED）** — `POST /v1/adjustment-notes/{noteId}:approve`

- 权限：**`bills.adjust.approve`**
- 仅 **DRAFT** Note 可审批；其它状态返回 **409** `INVALID_STATUS`
- 审批前 **MUST** 重新校验已存 **`adjustment_note_items.metadata.iccid`** 仍属于该企业；不合法时返回与创建阶段一致的 `INVALID_ICCID` / `SIM_NOT_FOUND`
- 当创建事件记录了有效 **`BILL_ADJUSTMENT_NOTE_CREATED.actor_user_id`** 时，**创建者 MUST NOT** 审批自己创建的 Note → **403**
- **仍不修改**原账单金额
- 审计：**`BILL_ADJUSTMENT_NOTE_APPROVED`**

**4. 下期出账合并（APPROVED → APPLIED）** — `POST /v1/billing:generate` 或 worker 自动排队的 `BILLING_GENERATE` Job

- **`idempotencyKey`**：**SHOULD** 支持，避免重复提交出账 Job（见上节幂等表）
- 对每个企业、每个账期，出账引擎 **MUST**：

1. 批价 → **ratingTotal**
2. 加载该企业所有 **status=APPROVED** 且 **currency** 与当期账单一致的 Note
3. 计算 **finalTotal = ratingTotal + netAdjustment**
4. 插入新 **`bills`** 行（**`total_amount = finalTotal`**）
5. 写入 **`bill_line_items`**：**`ADJUSTMENT_CREDIT`** / **`ADJUSTMENT_DEBIT`**，**`metadata.noteId`** 指向源 Note
6. 将参与合并的 Note 批量更新为 **APPLIED**（幂等：仅 update **`status=APPROVED`** 的行）
7. 审计：**`BILL_ADJUSTMENT_NOTE_APPLIED`**

新账单 L1 汇总 **SHOULD** 含 **`adjustmentCreditTotal`** / **`adjustmentDebitTotal`**（自调账行项汇总）。HTTP 契约见 [contracts/billing-api.md](contracts/billing-api.md) §1.2、§2、§3.2。

**5. 客户可见结果**

- **旧账**：金额与明细与发布时一致（历史快照）
- **新账**：正常批价行 + 调账行；总额已含 CREDIT/DEBIT 净额
- 已 **APPLIED** 的 Note **MUST NOT** 再次进入再下一期

#### 权限与租户边界（摘要）

| 操作 | 授权主体 |
|------|----------|
| 创建 `:adjust` | reseller（**`bills.adjust`**）；customer **403** |
| 列表 | reseller / platform（**`bills.adjust.list`**） |
| 审批 | reseller / platform（**`bills.adjust.approve`**）；创建者本人 **403** |
| 出账合并 | 系统 / platform admin / reseller admin（**`billing:generate`**）；customer **403** |

**reseller MUST** 仅能操作、查看其下属企业范围内的 Note 与账单。

#### 端到端时间线示例

```
2 月账 PUBLISHED，total = 10,000
  ↓ 发现多收 200
POST :adjust（CREDIT 200）→ DRAFT
  ↓ 另一位 admin 审批
POST :approve → APPROVED（2 月账仍为 10,000）
  ↓ 3 月出账
billing:generate → ratingTotal = 8,000，netAdjustment = −200
  → 3 月新账 total = 7,800，含 ADJUSTMENT_CREDIT 行；Note → APPLIED
```

#### 与「直接改账单」的区别

| | 调账（Note） | 直接改 bill |
|--|-------------|-------------|
| 能否改 PUBLISHED 账的 total | **否** | **否**（设计上禁止） |
| 差额何时生效 | **下一期新账** | N/A |
| 审计 / 溯源 | Note + 事件 + line item **`noteId`** | 无此路径 |

**Canonical 运行时**：Fastify（`npm run build` → `npm run start:ts`）。实现入口：`src/routes/bills.ts`、`src/routes/billing.ts`、`src/routes/adjustmentNotes.ts`、`src/services/billingGenerate.ts`、`src/services/billStatusMachine.ts`、`src/services/billVoid.ts`、`src/services/adjustmentNote.ts`。

**Why this priority**: 账单是商业闭环的关键环节，直接影响收入确认和客户体验。

**Technical Implementation**:

- 账单层级：L1(企业) -> L2(部门/产品包) -> L3(SIM)
- 核销：V1.1 支持线下转账/财务确认后的手工 `mark-paid`；不实现在线支付回调自动核销
- 调账：仅 PUBLISHED/OVERDUE 状态可关联 Note
- 坏账核销：`OVERDUE -> WRITTEN_OFF`，需 `reason`
- 账单作废：`GENERATED` / `PUBLISHED` / `OVERDUE` 可作废为 `VOIDED`；若关联 `APPROVED` / `APPLIED` 调账单则阻断，关联 `DRAFT` 调账单会自动置为 `CANCELLED`

- API 接口：
  - `GET /v1/bills`（列表，按账期/状态/企业筛选）
  - `GET /v1/bills:csv`（账单列表 CSV）
  - `GET /v1/bills/{billId}`（详情）
  - `GET /v1/bills/{billId}:csv`（L1 + L2 汇总 CSV）
  - `GET /v1/bills/{billId}/line-items`（L3 SIM 明细分页）
  - `GET /v1/bills/{billId}/line-items:csv`（L3 SIM 明细 CSV；`pageSize` 最大 10000）
  - `POST /v1/bills/{billId}:publish`（发布 GENERATED 账单）
  - `POST /v1/bills/{billId}:mark-paid`（人工核销）
  - `POST /v1/bills/{billId}:write-off`（坏账核销，OVERDUE -> WRITTEN_OFF）
  - `POST /v1/bills/{billId}:void`（账单作废，→ **VOIDED**）
  - `POST /v1/bills/{billId}:adjust`（创建调账单，→ **DRAFT**）
  - `GET /v1/adjustment-notes`（调账单列表）
  - `POST /v1/adjustment-notes/{noteId}:approve`（审批，→ **APPROVED**）
  - `POST /v1/billing:generate`（出账；合并 **APPROVED** Note → **APPLIED**）

**Independent Test**: 可通过模拟一个完整账期的用量数据和 SIM 状态，运行计费引擎生成账单，验证各层级数据准确性。

**Acceptance Scenarios**:

1. **Given** 账期结束且 `usage_daily_summary` / `sim_state_history` 已就绪, **When** `POST /v1/billing:generate` 创建并执行 `BILLING_GENERATE` Job, **Then** 生成 GENERATED 状态账单并含 L1/L2/L3 明细
2. **Given** worker 扫描到 `billing_config.auto_generate=true` 且已到 `bill_day`, **When** 该企业当期未存在非失败出账 Job, **Then** 自动排队一个带 `AUTO_BILLING:{enterpriseId}:{period}` 幂等键的 `BILLING_GENERATE` Job
3. **Given** 调账单为 DRAFT 且审批人非创建者, **When** 调用 `:approve`, **Then** Note 变为 **APPROVED** 且原账单 **total_amount** 不变
4. **Given** 企业存在 **APPROVED** CREDIT Note, **When** 下一账期 `billing:generate`, **Then** 新账单 **total_amount** 减少相应净额且 Note 变为 **APPLIED**
5. **Given** 同一 `billId` 上两次 `:adjust` 使用不同 `idempotencyKey`, **When** 均审批通过, **Then** 下期出账 **netAdjustment** 为两笔净额之和
6. **Given** 相同 `billId` + 相同 `idempotencyKey` 重复 `:adjust`, **When** 无论请求体是否一致, **Then** **409** `IDEMPOTENCY_CONFLICT`，且不新建第二条 Note
7. **Given** 相同 scope + 相同 `idempotencyKey` 重复 `billing:generate`, **When** 首次 Job 未完成, **Then** 返回同一 **`jobId`**
8. **Given** 财务确认支付, **When** 标记为 PAID, **Then** 账单状态更新并记录审计
9. **Given** 账单为 OVERDUE, **When** 调用 `:write-off` 且提供 reason, **Then** 状态变为 **WRITTEN_OFF** 并记录 `BILL_WRITTEN_OFF` 事件
10. **Given** 账单为 GENERATED / PUBLISHED / OVERDUE 且无 APPROVED/APPLIED 调账单阻断, **When** 调用 `:void` 且提供 reason, **Then** 状态变为 **VOIDED**；若存在 DRAFT 调账单则自动取消

---

### User Story 7 - 企业欠费汇总与信用风险提示 (Priority: P2)

针对后付费模式，实现逾期账单识别与企业级欠费汇总，向 Reseller 提供直观的欠费金额、最早逾期账单与逾期天数；V1.1 不发送邮件/短信执行催缴，不自动变更企业状态，也不自动停复机。

**时间轴（V1.1 当前实现）**：
- 账单发布：账单进入 `PUBLISHED` 并具备 `due_date`
- 逾期识别：`due_date <= asOfDate` 且状态为 `PUBLISHED` / `OVERDUE` 的账单计入欠费汇总；worker 检查时会将到期的 `PUBLISHED` 账单转为 `OVERDUE`
- 宽限期：来自 `dunning_policies.grace_period_days`，默认 **3** 天
- 升级阈值：`suspend_after_days` 缺省时使用宽限期；`interruption_after_days` 默认 **15** 天

**欠费风险等级（V1.1 当前实现）**：
1. **NORMAL**：无逾期账单，或策略禁用
2. **WARNING**：已逾期但仍在警告阶段，或逾期金额未超过当前实现固定小额阈值 `0`
3. **HIGH**：超过 `suspend_after_days` 后进入较高欠费风险；仅作为汇总提示，不修改企业状态
4. **CRITICAL**：超过 `suspend_after_days + interruption_after_days` 后进入更高风险；仅作为管理提示，不自动停机

**状态恢复**：
- 对外不提供 `resolve` 类接口；欠费是否已恢复正常由账单状态实时计算或后台任务同步
- 企业状态恢复由代理商管理员手工执行；欠费汇总接口不会修改 `tenants.enterprise_status`
- 已停机 SIM 不自动复机，需管理员手动操作

**信控期间计费**：
- 计费持续，依 SIM 实际状态收费
- 复机无回溯补缴

**欠费结清顺序**：V1.1 不实现自动分账/自动清偿排序；财务核销仍通过账单 `mark-paid`、`write-off`、`void` 等账单动作处理。

**滞纳金与豁免阈值（V1.1 当前实现）**：
- `late_fee_rules` 支持企业级规则，并可回退到上级配置；`GET /v1/enterprises/{enterpriseId}/overdue-summary` 返回估算的 `lateFeeAmount`
- 滞纳金估算公式：`lateFeeAmount = overdueAmount * dayRate * max(0, daysOverdue - lateFeeRule.gracePeriodDays)`，其中 `PERCENTAGE` 规则的 `feeValue` 按百分比解释
- 当前 `lateFeeAmount` 仅为信控摘要字段，不自动生成账单行项、调账单或应收费用
- 欠费小额豁免阈值当前实现固定为 `0`，尚未实现 reseller/customer 可配置覆盖

**Why this priority**: 信控是降低坏账风险的关键机制，但可以在基础计费和账单功能完成后再实现。

**Technical Implementation**:

- 欠费识别核心服务：`src/services/dunning.ts`（内部命名沿用历史名称，对外 API 不使用 dunning 命名）
- Worker：`src/worker.js` 按 `DUNNING_CHECK_CRON` 周期执行 `runDunningCheck`；队列处理器也支持 `DUNNING_CHECK` 消息
- 持久化：`dunning_records` 保存每个逾期账单的内部风险状态，`dunning_actions` 保存状态变化记录
- 查询摘要：`GET /v1/enterprises/{enterpriseId}/overdue-summary` 计算逾期金额、最早逾期账单、逾期天数、风险等级、离线处理建议与 `lateFeeAmount`
- 对外废弃 `POST /v1/enterprises/{enterpriseId}/dunning:resolve`；V1.1 不暴露“催缴解除”业务动作
- V1.1 不实现邮件/短信自动催收、不自动变更企业状态、不自动批量停机/复机

**Independent Test**: 可通过模拟 `PUBLISHED` / `OVERDUE` 账单与 `dunning_policies` / `late_fee_rules`，运行 `runDunningCheck` 并验证 `dunning_records`、`dunning_actions`、账单 `OVERDUE` 转换与解除逻辑。

**Acceptance Scenarios**:

1. **Given** `PUBLISHED` 账单已到 `due_date`, **When** `runDunningCheck` 执行, **Then** 账单转为 `OVERDUE`，并按策略写入或更新 `dunning_records`
2. **Given** 账单逾期超过 `suspend_after_days`, **When** Dunning 检查执行, **Then** Dunning 状态变为 `SUSPENDED`，但不自动修改企业状态
3. **Given** 账单逾期超过 `suspend_after_days + interruption_after_days`, **When** Dunning 检查执行, **Then** Dunning 状态变为 `SERVICE_INTERRUPTED`，但不自动停机
4. **Given** 企业存在逾期账单, **When** 调用 `GET /v1/enterprises/{enterpriseId}/overdue-summary`, **Then** 返回企业级 `overdueAmount`、最早逾期账单、逾期天数与 `overdueRiskLevel`
5. **Given** 企业账单已通过 Billing 的 `mark-paid` / `write-off` / `void` 处理, **When** 再次查询欠费汇总, **Then** 汇总结果根据当前账单状态实时反映，不需要调用对外 resolve 接口

---

### User Story 8 - 上游对账与产品映射 (Priority: P2)

维护内部产品包与上游供应商产品包的映射关系，负责订阅等业务操作的 **上游开通同步**。

**产品映射模型**（真源：[subscription-provisioning-upstream-mapping.md](clarifications/subscription-provisioning-upstream-mapping.md)）：

- **一对一**：每个 **`PUBLISHED` Package** 绑定 **一条** 上游映射（`vendor_product_mappings` 上 **`UNIQUE(package_id)`**）
- **写入时机**：**标准路径** 为 `POST /v1/packages/{packageId}:publish` 请求体携带 **`externalProductId`**，与服务端推导的 **`supplier_id`**（来自 Package → Carrier Service）**一并** 写入映射表
- **字段**：`packageId`、`supplierId`（**推导，非客户端入参**）、`externalProductId`、`provisioningParameters`（可选）
- **约束**：Package 所服务网络上下文为 **单一 supplier + operator**；**MUST NOT** 将同一 Package 用于不同 supplier/operator 的 SIM

**开通同步机制（Provisioning Synchronization）**：

- 策略：**本地 Job 队列 + 上游执行**（与 `SIM_STATUS_CHANGE` 同构）
- 创建订阅：同步校验 → 写 `subscriptions`（`PROVISIONING` / `PENDING`）→ 入队 **`SUBSCRIPTION_PROVISION` Job** → **202** 响应含 `jobId`
- 场景 A（立即生效）：Job **立即** 调上游 → 成功 **`ACTIVE`** / 失败 **删除订阅行**；成功/失败均写入事件，后续是否通知下游客户由 Webhook 订阅与投递链路决定
- 场景 B（预约生效，V1.1 当前实现）：初始 **`PENDING`**；`SUBSCRIPTION_PROVISION` Job 在 `effectiveAt` 未来时保持 pending / running，不提前调用上游；到达 **`effectiveAt`** 后再转 **`PROVISIONING`** 并执行上游 `changePlan`
- 状态一致性：每日 Reconciliation 仍负责 SIM 清单/状态；**订阅开通** 以 Job 终态 + 事件为准

**对账差异处理（V1.1 当前实现）**：以上游为准，更新本地 SIM 状态并写入 `sim_state_history`；同时记录 `SIM_STATUS_CHANGED` 事件、`audit_logs` 与 `reconciliation_runs.mismatch_details`，用于稽核分析。V1.1 不在 reconciliation 中直接创建告警。

**Why this priority**: 上游对账与开通确保系统数据与真实网络状态一致，是数据可靠性的保障。

**Technical Implementation**:

- Job 类型：`SUBSCRIPTION_PROVISION`（或等价命名）
- 能力协商：适配器 `changePlan` / SPI（见 US10）；当前 future-dated 订阅由本地 Job 时间门控，不提前向上游提交预约变更
- 映射表：`vendor_product_mappings`（`supplier_id` 与 Carrier Service 对齐）
- Reconciliation：`src/routes/reconciliation.ts` 已接入 Fastify TS；worker 按 `RECONCILIATION_CRON` 为 active supplier 排队 `RECONCILIATION_RUN`
- 事件与 Webhook：订阅 Job 与 reconciliation 写入 events；是否投递给下游取决于 Webhook 订阅与投递链路，Job 本身不直接调用下游客户系统

**Independent Test**: 可通过模拟上游 API 交互，验证 **发布映射**、**订阅 Job**、**失败删除 + 事件记录** 与 reconciliation mismatch 处理逻辑。

**Acceptance Scenarios**:

1. **Given** 发布 Package 时提供 `externalProductId`, **When** 发布成功, **Then** Package 为 `PUBLISHED` 且映射存在，`supplier_id` 等于 Carrier Service
2. **Given** 创建订阅且 SIM 与 Package supplier/operator 一致, **When** API 受理, **Then** HTTP 202、`jobId` 非空、订阅为 `PROVISIONING` 或 `PENDING`
3. **Given** 上游 API 返回成功, **When** Worker 完成, **Then** 订阅为 `ACTIVE`，投递 `SUBSCRIPTION_CHANGED` + `JOB_FINISHED`
4. **Given** 上游 API 返回失败, **When** Worker 完成, **Then** **无** 该订阅行、`job.status=FAILED`，并记录 `SUBSCRIPTION_PROVISION_FAILED` + `JOB_FINISHED` 事件
5. **Given** 套餐次月变更且 `effectiveAt` 在未来, **When** Worker 早于生效时间轮询该 Job, **Then** Job 保持 pending / running 且不调用上游。**When** 到达 `effectiveAt`, **Then** 本地 Job 触发上游调用
6. **Given** 每日 Reconciliation 发现不一致, **When** 本地 ACTIVATED 上游 DEACTIVATED, **Then** 以上游为准更新本地状态，并记录 `sim_state_history`、`SIM_STATUS_CHANGED`、audit 与 mismatch 明细

---

### User Story 9 - 监控、诊断与可观测性 (Priority: P2)

构建统一监控、告警与推送体系，覆盖系统健康与业务用量异常，并为商用阶段灰度发布、横向扩展与审计追溯打基础。

**MVP 实现约束**：
- 数据采集与存储：Supabase（PostgreSQL + Realtime）记录指标与告警事件
- 规则计算：Vercel Cron + Serverless Functions 批量评估
- 查询与可视化：轻量管理后台 + CSV 导出
- 告警目录：V1.1 以 [alert-type-catalog.md](clarifications/alert-type-catalog.md) 的 7 个 `alertType` 为真源；未列入目录的监控项标记为商用阶段候选能力
- 告警配置：V1.1 支持 `PLATFORM` / `RESELLER` / `ENTERPRISE` 三层规则配置；SIM 可以是告警触发对象，但 **不**作为 V1.1 规则配置作用域

**V1.1 告警能力范围**：
- 数据管道：`CDR_DELAY` 监控 CDR/用量文件延迟，阈值以小时或延迟文件数配置
- 上游连接：`UPSTREAM_DISCONNECT` 监控 CMP 与每个 active 上游集成实例的 API 连接状态，默认通过 token API 探测连续失败次数触发
- Webhook 投递：`WEBHOOK_DELIVERY_FAILED` 监控下游 Webhook 连续投递失败
- 配额/流量池：`POOL_USAGE_HIGH` 监控产品包 in-profile 用量达到配置的配额百分比阈值
- 包外用量：`OUT_OF_PROFILE_SURGE` 监控当前计费周期内产品包 out-of-profile 用量达到配置的配额百分比阈值；默认级别为 P2，具体阈值由规则配置决定
- 沉默 SIM：`SILENT_SIM` 监控代理商售出后的 SIM 长期处于 `DEACTIVATED`，未进入可产生收入的活跃使用状态
- 异常漫游：`UNEXPECTED_ROAMING` 监控当前计费周期内 SIM 是否已经产生产品包未覆盖的 out-of-profile roaming 用量

**商用阶段候选能力（非 V1.1 必交付）**：
- API 可用性监控、任务耗时/积压监控、控制策略执行失败监控
- 配额耗尽后自动停机、单 SIM 日用量自动限速、测试期到期/测试期配额耗尽专项告警、计费周期内低用量/低配额消耗告警

**SIM 连接诊断接口 `GET /v1/sims/{iccid}/connectivity-status` 字段口径（V1.1 当前实现）**：
- 该接口用于连接故障诊断的第一屏信息展示，字段顺序应服务于运维排查流程：先看 SIM 生命周期状态，再看网络连接与最近用量事实。响应字段顺序为：`simStatus`、`simStatusChangedAt`、`onlineStatus`、`registrationStatus`、`lastActivityTime`、`visitedMccMnc`、`ratType`、`apn`。
- `simStatus`：直接读取本系统 `sims.status`，表示该 ICCID 在 CMP 当前记录的 SIM 生命周期状态。该字段是诊断优先级最高的本地权威字段，不从上游实时状态推断。
- `simStatusChangedAt`：读取该 SIM 在 `sim_state_history` 中最近一条状态变更记录的 `start_time`；若数据库表中没有该 SIM 的状态历史记录，返回 `null`。该字段用于判断当前 `simStatus` 已持续多久。
- `onlineStatus`：表示系统对 SIM 当前是否在线的判断，取值为 `ONLINE` / `OFFLINE`。若上游 adapter 在 `connectivityStatus` 能力下返回明确在线状态，则优先使用上游结果；若上游未返回或当前能力为本地拼装，则使用最近一次用量活动时间判断：`lastActivityTime` 在最近 7 天内视为 `ONLINE`，否则视为 `OFFLINE`。
- `registrationStatus`：表示 SIM 是否被判断为已注册到网络，取值为 `REGISTERED_HOME`、`REGISTERED_ROAMING`、`NOT_REGISTERED`、`DENIED`。若上游返回明确注册状态，则优先使用上游结果；否则先看 `onlineStatus`：当 `onlineStatus=OFFLINE` 时必须返回 `NOT_REGISTERED`，不得使用很久以前的拜访网络记录推断当前仍处于 `REGISTERED_ROAMING`；仅当 `onlineStatus=ONLINE` 时，才根据 `visitedMccMnc` 与 SIM 所属运营商 home PLMN 比较，匹配则为 `REGISTERED_HOME`，不匹配则为 `REGISTERED_ROAMING`，没有可用拜访网络则为 `NOT_REGISTERED`。
- `lastActivityTime`：从最近一条 `usage_daily_summary` 记录读取。优先使用该记录的 `created_at`；若 `created_at` 缺失，则用 `usage_day` 的 UTC 当日 00:00:00 作为兜底。该字段只表达“系统最近一次观测到该 SIM 有数据流量事实”的时间，不等同于上游实时会话开始时间。
- `visitedMccMnc`：从最近一条 `usage_daily_summary.visited_mccmnc` 读取，表示该 SIM 最近一次数据流量记录所在的拜访地网络。该字段替代旧的 `servingMccMnc` 命名，避免误导为实时服务小区信令。
- `ratType`：从最近一条 `usage_daily_summary.rat` 读取，表示最近一次用量记录中的 Radio Access Technology；上游返回可用 RAT 时可以作为补充，但 V1.1 页面诊断口径以本地最近用量事实为主。
- `apn`：优先从最近一条 `usage_daily_summary.apn` 读取；若最近用量记录没有 APN，则回退 `sims.apn`。该字段用于排查 APN 配置与实际用量记录是否一致。
- V1.1 当前不返回 `ipAddress`、`servingCellId`、`sessionUptime`。这些字段依赖实时核心网/会话信令，上游当前基本不可获得；为避免用户误解，不在该接口响应体中保留空字段。

**SIM 拜访网络接口 `GET /v1/sims/{iccid}/visited-network` 字段口径（V1.1 当前实现）**：
- 该接口用于查看指定 SIM 最近一次可识别的拜访地网络，不返回 GPS / 小区定位信息。V1.1 当前响应字段为：`iccid`、`lastActivityTime`、`visitedMccMnc`、`country`、`visitedOperator`。
- `iccid`：路径 ICCID 对应的 SIM 卡号，服务端会先按租户 scope 校验该 SIM 是否可访问。
- 该接口为 `LOCAL_ASSEMBLE` 本地拼装接口，不要求该 SIM 已配置可用的上游 integration；只要 SIM 在本地库存中且调用方有 scope 权限，即可根据本地 `events`、`usage_daily_summary` 与 `public_infos` 返回结果。
- `lastActivityTime`：最近一次该 SIM 使用数据流量的时间，优先读取最近一条 `usage_daily_summary.created_at`；若 `created_at` 缺失，则用 `usage_day` 的 UTC 当日 00:00:00 兜底。
- `visitedMccMnc`：优先从最近一条 `UPDATE_LOCATION` 事件 payload 中解析 `mcc + mncList`；如果没有可用事件，则使用最近一条 `usage_daily_summary.visited_mccmnc`。该字段表达“最近一次可识别的拜访地网络”，不是实时 serving cell。
- `country`：通过 `visitedMccMnc` 解析出的 MCC/MNC 查询 `public_infos.country`；若 `public_infos` 无对应公开运营商记录，则返回 `null`。
- `visitedOperator`：通过 `visitedMccMnc` 解析出的 MCC/MNC 查询 `public_infos.name`；若 `public_infos` 无对应记录，则返回 `null`。
- V1.1 当前不返回 `locationType`、`latitude`、`longitude`、`accuracy`、`timestamp`、`cellInfo`。这些字段会让用户误以为系统持有实时 GPS 或小区级定位事实；当前实现只表达公开运营商与最近用量/位置事件所能支持的拜访网络信息。

**SIM 拜访网络历史接口 `GET /v1/sims/{iccid}/visited-network-records` 字段口径（V1.1 当前实现）**：
- 该接口用于查看指定时间范围内的 SIM 拜访网络记录，查询参数 `from` / `to` 必填（也兼容 `startDate` / `endDate`），`page` 默认 1，`pageSize` 默认 20 且最大 20；分页使用 `offset = (page - 1) * pageSize`。
- 该接口同样为 `LOCAL_ASSEMBLE` 本地拼装接口，不要求上游 integration 存在；上游只影响 `connectivity-status` 中可用的实时/半实时字段，以及 `cancel-location` 是否可执行真实上游动作。
- 响应为分页对象：`items`、`total`、`page`、`pageSize`。每条 `items[]` 记录字段与当前拜访网络接口保持一致：`iccid`、`lastActivityTime`、`visitedMccMnc`、`country`、`visitedOperator`。
- 历史数据来源包括 `usage_daily_summary` 与 `events(UPDATE_LOCATION)`：用量记录按 `usage_day` 落入 `from` / `to` 的日期范围筛选；位置事件按 `occurred_at` 落入 `from` / `to` 的时间范围筛选。服务端将两类本地记录转换为统一 item 后按 `lastActivityTime` 倒序合并并分页。
- 对来自 `usage_daily_summary` 的记录，`lastActivityTime` 优先使用 `created_at`，否则用 `usage_day` UTC 当日 00:00:00；`visitedMccMnc` 来自 `usage_daily_summary.visited_mccmnc`。
- 对来自 `UPDATE_LOCATION` 事件的记录，`lastActivityTime` 优先使用 payload 中的 `eventTime`，否则使用 `events.occurred_at`；`visitedMccMnc` 从 payload 中的 `mcc + mncList` 解析。
- `country` 与 `visitedOperator` 的解析规则与 `visited-network` 一致，均通过 `visitedMccMnc -> public_infos(mcc,mnc)` 获取；无法匹配时返回 `null`。
- V1.1 当前历史记录同样不返回 `locationType`、`latitude`、`longitude`、`accuracy`、`timestamp`、`cellInfo`。

**统一告警引擎与推送**：
- 规则引擎集中管理启用状态、阈值、窗口、级别、抑制时间与投递设置；同规则在抑制窗口内不重复发送
- 支持抑制、合并、升级(P3→P2→P1→P0)与认领
- V1.1 告警投递通道：Portal 通过 `alerts` 列表呈现并在 `alert_deliveries` 中记录 `DELIVERED`；Webhook 复用 `events(ALERT_TRIGGERED)`、`webhook_subscriptions` 与 `webhook_deliveries`，用于实时运营通知。
- 告警事件写入 `alerts` 与 `events`，投递结果写入 `alert_deliveries`；新建告警写 `ALERT_TRIGGERED`，合并/确认/规则配置变更写内部事件 `ALERT_MERGED`、`ALERT_ACKNOWLEDGED`、`ALERT_RULE_CONFIG_CHANGED`，审计统一写 `audit_logs`

**告警级别与通知对象配置**：
| 级别 | 响应要求 | 通知对象 | 说明 |
|:--|:--|:--|:--|
| P0(紧急) | 15 分钟内响应 | 系统管理员、代理商管理员 | 需支持单规则级别与通知对象独立配置 |
| P1(高) | 2 小时内响应 | 代理商管理员 | V1.1 支持角色/邮箱路由；值班表为商用阶段扩展 |
| P2(中) | 24 小时内响应 | 代理商管理员 | 支持按 RESELLER / ENTERPRISE 规则覆盖 |
| P3(低) | 周期内优化 | 代理商销售总监 | 支持降级为站内消息 |

**告警类型目录**：V1.1 使用数据库表 **`alert_type_catalog`** 作为告警类型真源，记录系统支持的 `alertType`、允许配置的商业实体 scope、默认 severity、默认阈值单位、默认窗口/抑制策略、排序与说明。当前目录包含 `POOL_USAGE_HIGH`、`OUT_OF_PROFILE_SURGE`、`SILENT_SIM`、`UNEXPECTED_ROAMING`、`CDR_DELAY`、`UPSTREAM_DISCONNECT`、`WEBHOOK_DELIVERY_FAILED`；未列入目录的监控项标记为商用阶段候选能力。`alertType` 的触发条件、metadata 与业务语义见 [alert-type-catalog.md](clarifications/alert-type-catalog.md)。

| alertType | 可配置 scope | 默认 severity |
|:--|:--|:--|
| `POOL_USAGE_HIGH` | `PLATFORM` / `RESELLER` / `ENTERPRISE` | `P3` |
| `OUT_OF_PROFILE_SURGE` | `PLATFORM` / `RESELLER` / `ENTERPRISE` | `P3` |
| `SILENT_SIM` | `PLATFORM` / `RESELLER` / `ENTERPRISE` | `P3` |
| `UNEXPECTED_ROAMING` | `PLATFORM` / `RESELLER` / `ENTERPRISE` | `P3` |
| `CDR_DELAY` | `PLATFORM` / `RESELLER` | `P1` |
| `UPSTREAM_DISCONNECT` | `PLATFORM` / `RESELLER` | `P1` |
| `WEBHOOK_DELIVERY_FAILED` | `PLATFORM` / `RESELLER` | `P2` |

**`POOL_USAGE_HIGH` 配额百分比语义**：该告警的 `threshold_value` 使用百分比，`threshold_unit=PERCENT`，默认可配置为 `80` 表示“已消耗 80% 配额”。计算口径为产品包的 **in-profile** 用量除以该产品包当前适用配额；数据源应优先使用 `usage_package_daily_summary.in_profile_mb` 的当前账期累计，必要时才回退到 `rating_results` 或旧汇总口径：

- `ONE_TIME` PricePlan：按单 SIM / subscription 判断，若订阅该产品包的 SIM 的 in-profile 用量 `usedMb / quotaMb >= threshold%`，触发告警；metadata 记录 `packageId`、`pricePlanId`、`simId`、`quotaMb`、`usedMb`、`usageRatio`。
- `SIM_DEPENDENT_BUNDLE` / `FIXED_BUNDLE` PricePlan：按产品包共享池判断，若订阅该产品包的所有 SIM 的 in-profile 用量之和超过总池配额百分比，触发告警；其中 `SIM_DEPENDENT_BUNDLE` 的总池配额为 `perSimQuotaMb * highWaterActiveSimCount`，`FIXED_BUNDLE` 使用 `totalQuotaMb`。
- `TIERED_PRICING`（实现内部类型 `TIERED_VOLUME_PRICING`）：按产品包共享用量与每一档的上界/配额判断；当累计 in-profile 用量达到某一档上界的 `threshold%` 时，为该档触发一次告警。metadata 记录 `tierIndex`、`tierLimitMb`、`usedMb`、`usageRatio`，便于解释命中哪一档。

**`OUT_OF_PROFILE_SURGE` 账期累计百分比语义**：该告警不再表示 60 分钟短窗口突增；V1.1 将其定义为“当前计费周期内产品包 out-of-profile 用量达到配置配额比例”。`threshold_value` 使用百分比，`threshold_unit=PERCENT`，默认可配置为 `20` 表示“包外用量已达到适用配额的 20%”。数据源应优先使用 `usage_package_daily_summary.out_of_profile_mb` 的当前账期累计，并按 Price Plan 类型计算分母：

- `ONE_TIME` PricePlan：按单 SIM / subscription 判断，若订阅该产品包的 SIM 的 out-of-profile 用量 `outOfProfileMb / quotaMb >= threshold%`，触发告警；metadata 记录 `packageId`、`pricePlanId`、`simId`、`quotaMb`、`outOfProfileMb`、`usageRatio`。
- `SIM_DEPENDENT_BUNDLE` / `FIXED_BUNDLE` PricePlan：按产品包共享池判断，若订阅该产品包的所有 SIM 的 out-of-profile 用量之和超过总池配额百分比，触发告警；其中 `SIM_DEPENDENT_BUNDLE` 的总池配额为 `perSimQuotaMb * highWaterActiveSimCount`，`FIXED_BUNDLE` 使用 `totalQuotaMb`。
- `TIERED_PRICING`（实现内部类型 `TIERED_VOLUME_PRICING`）：按产品包共享 out-of-profile 用量与每一档上界判断；当累计 out-of-profile 用量达到某一档上界的 `threshold%` 时，为该档触发一次告警。metadata 记录 `tierIndex`、`tierLimitMb`、`outOfProfileMb`、`usageRatio`。
- 该告警依赖 `USAGE_RATING_ROLLUP` 或正式 Billing/Rating 已刷新 `usage_package_daily_summary`；若当前账期尚未完成 rollup，evaluator 应跳过或以 metadata 标记数据未就绪，避免基于日汇总总量误判。

**`SILENT_SIM` 长期停机语义**：该告警 **不** 表示 `ACTIVATED` SIM 长时间无 CDR / 无流量。由于核心网为已激活 SIM 建立 PDN Connection 等控制面过程也可能产生 CDR 或少量流量，使用“已激活但无活动”作为商业告警口径意义较弱。V1.1 将 `SILENT_SIM` 定义为：SIM 已销售/分配给企业后，长期停留在 `DEACTIVATED` 状态，未进入可创造收入的活跃使用状态。默认阈值为 `threshold_value=4320`、`threshold_unit=HOURS`（约 180 天 / 6 个月）；判断依据优先使用 SIM 最近状态变更时间（如 `last_status_change_at`），缺失时才退回创建/激活等可用时间字段。metadata 应记录 `simId`、`status=DEACTIVATED`、`deactivatedSince`、`inactiveHours` 与阈值。

**`UNEXPECTED_ROAMING` 未覆盖漫游发现语义**：该告警 **不** 表示“SIM 是否离开归属运营商本地网络”。运营商发行的 SIM 只要在非本地网络使用就处于 roaming，但 roaming 本身并不一定异常。V1.1 将 `UNEXPECTED_ROAMING` 定义为：当前计费周期内，某 SIM 在订阅产品包 / CoveredNetworkProfile 未覆盖的拜访地网络上产生了 out-of-profile roaming 用量。该告警是 SIM-level 的“事件发现型”告警，只要当前账期 `usage_package_daily_summary.out_of_profile_mb > 0` 即可触发；`OUT_OF_PROFILE_SURGE` 则是“用量规模型”告警，只有 out-of-profile 用量达到产品包配额百分比阈值（例如 20%）才触发。metadata 应记录 `outOfProfileMb`、`packageIds`、`pricePlanIds`、`usageDays` 与可用的 `visitedMccMncs`。

**`CDR_DELAY` reseller 归属语义**：该告警是 Reseller-level 数据管道告警，不绑定 Enterprise 或 SIM。CDR 接收与 Integration 模块一致，应按 `resellerId + supplierId + operatorId` 的集成实例接收文件（每个 `supplierId` 至多绑定一个 Reseller，见 **FR-042a**）。触发条件仍为 `cdr_files.received_at <= now - thresholdHours` 且 `cdr_files.ingested_at IS NULL`。告警归属优先来自 CDR 文件接收集成写入的 `cdr_files.reseller_id`；若文件级归属缺失，则使用文件接收后尽早解析出的轻量索引 `cdr_file_sim_refs(cdr_file_id, iccid, sim_id, reseller_id, enterprise_id)`，通过 `reseller_id` 或 `enterprise_id -> tenants.parent_id` 解析 Reseller。metadata 应记录 `delayedFiles`、`cdrFileIds`、`affectedIccidCount`、`sampleIccids`、`supplierIds`、`operatorIds` 与 `thresholdUnit`；`currentValue` 表示该 Reseller 当前命中的延迟 CDR 文件数。

**`UPSTREAM_DISCONNECT` 上游 API 连接语义**：该告警是 Reseller-level 上游集成健康告警，不绑定 Enterprise 或 SIM，也不再依据 SIM 的 `upstream_status=DISCONNECTED/OFFLINE` 触发。系统应针对每个 active `upstream_integrations(reseller_id, supplier_id, operator_id)` 实例周期性执行轻量 API 探测，默认使用供应商 token/login API；建议调度周期为 2 小时。探测成功时连接状态为 `CONNECTED`，连续失败达到配置阈值时状态为 `DISCONNECTED` 并触发 `UPSTREAM_DISCONNECT`。默认阈值为 `threshold_value=3`、`threshold_unit=ATTEMPTS`、默认 severity 为 `P1`。探测状态写入 `upstream_integration_health_checks`，`runAlertEvaluation()` 消费该状态表创建告警。`currentValue` 表示连续 token probe 失败次数；metadata 应记录 `integrationId`、`supplierId`、`operatorId`、`probeApi=TOKEN`、`failureCount`、`lastSuccessAt`、`lastFailureAt`、`lastErrorCode`、`lastErrorMessage` 与 `thresholdUnit`。

**`WEBHOOK_DELIVERY_FAILED` Webhook 投递失败语义**：该告警不由 `runAlertEvaluation()` 扫描触发，而是在 `src/services/webhook.js` 的 webhook 投递流程中即时触发。Webhook event 匹配订阅后，系统创建 `webhook_deliveries`，初始 `attempt=1`、`status=PENDING`，并立即尝试投递。若投递失败，系统按指数退避计算 `next_retry_at`，保持 delivery 为 `PENDING`；worker 后续扫描 `webhook_deliveries.status=PENDING` 且 `next_retry_at <= now` 的记录，并调用 `retryWebhookDelivery()` 继续投递。当本次失败后的 `nextAttempt > maxAttempts` 时，delivery 标记为 `FAILED`，同时创建 `WEBHOOK_DELIVERY_FAILED` 告警。当前默认 `maxAttempts=3`，默认 severity 为 `P2`，默认阈值为 `threshold_value=3`、`threshold_unit=ATTEMPTS`。`currentValue` 记录失败时的 attempt 次数；metadata 应记录 `webhookId`、`deliveryId`、`eventId`、`url`、`responseCode`、`responseBody`、`maxAttempts` 与 `thresholdUnit`。该告警表示下游企业/代理商 webhook endpoint 可能不可达、签名校验失败、TLS/网络异常、HTTP 错误或处理超时。

**告警配置表对象模型（ABC 三表）**：系统将告警配置视为多份逻辑上的「配置表」：一份 **PLATFORM 默认配置表**、每个 **RESELLER 独立配置表**、以及每个允许覆盖的 **ENTERPRISE 配置表**。V1.1 采用与 Integration 模块相似的对象 + 明细设计，而不是用单行同时表达 scope 与 alertType。

- **A. `alert_type_catalog`（告警类型目录）**：每个 `alertType` 一行，定义该告警是否可配置、允许的 `scope_type`、默认 severity、默认 threshold/window/suppress/delivery，以及文案和排序。该表只定义“系统支持什么告警、谁可以配置”，不承载某个 reseller/enterprise 的实际配置值。
- **B. `alert_config_profiles`（告警配置表对象）**：记录某个商业实体的一份配置表对象。关键字段包括 `config_profile_id`、`scope_type`、`reseller_id`、`enterprise_id`、`status`（`ACTIVE` / `INACTIVE`）、`version`、`created_by`、`created_at`、`updated_at`。同一 `PLATFORM`、同一 `RESELLER`、同一 `ENTERPRISE` 同时最多只有一份 `ACTIVE` 配置表；允许保留历史或停用版本用于审计与回滚。
- **C. `alert_config_items`（告警配置明细项）**：记录某份配置表中的具体告警项。关键字段包括 `config_item_id`、`config_profile_id`、`alert_type`、`enabled`、`severity`、`threshold_value`、`threshold_unit`、`window_minutes`、`suppress_minutes`、`delivery_channels`、`delivery_targets`、`threshold_config`、`created_at`、`updated_at`；同一 `config_profile_id + alert_type` 唯一。写入时必须校验 `alert_type_catalog.allowed_scope_types`，例如 `UPSTREAM_DISCONNECT` 不能被 `ENTERPRISE` 配置表覆盖。

**有效配置解析**：系统评估候选告警时，根据候选告警的 `resellerId` 与可选 `enterpriseId` 自动解析有效配置：先查 ENTERPRISE 的 `ACTIVE alert_config_profiles` 及其 `alert_config_items`，再查 RESELLER 配置表，再查 PLATFORM 默认配置表，最后使用内置兜底；更具体 scope 的 `enabled=false` 会阻止更上层配置继续生效。配置内容覆盖：是否启用、severity、threshold 值与单位、评估窗口、抑制窗口、投递渠道与投递目标。

**按代理商/企业独立生效规则**：每个 Reseller、每个 Enterprise 都可以拥有独立的 `alert_config_profiles` 与对应 `alert_config_items`。对于支持 `ENTERPRISE` scope 的告警（`POOL_USAGE_HIGH`、`OUT_OF_PROFILE_SURGE`、`SILENT_SIM`、`UNEXPECTED_ROAMING`），系统按 `ENTERPRISE item -> RESELLER item -> PLATFORM item -> built-in fallback` 解析最终配置，因此每个企业可以独立决定某一告警项是否启用、severity、阈值、窗口/抑制时间与投递渠道。对于 Reseller-level 告警（`CDR_DELAY`、`UPSTREAM_DISCONNECT`、`WEBHOOK_DELIVERY_FAILED`），告警不绑定企业/SIM，只按 `RESELLER item -> PLATFORM item -> built-in fallback` 解析，企业级配置不作用于这些告警。若更具体 scope 的 item 存在且 `enabled=false`，该告警在该 scope 下被显式关闭，并阻断上层 RESELLER/PLATFORM 配置继续生效。

**触发算法边界**：ABC 三表管理的是告警配置，不定义每个告警类型的检测算法。`POOL_USAGE_HIGH`、`OUT_OF_PROFILE_SURGE`、`SILENT_SIM`、`UNEXPECTED_ROAMING`、`CDR_DELAY`、`UPSTREAM_DISCONNECT` 的扫描与判断仍由 `runAlertEvaluation()` 实现；`WEBHOOK_DELIVERY_FAILED` 由 Webhook 投递/重试流程在 retry 耗尽并标记 delivery 为 `FAILED` 时即时触发。新增告警类型时，除了写入 `alert_type_catalog` 与默认配置，还必须在 evaluator 或对应业务服务中实现触发逻辑。

**Swagger / API 模块边界**：
- **Alerts** 模块只保留已经产生的告警实例查询与处理接口：`GET /alerts`、`GET /alerts:csv`、`GET /alerts/{alertId}`、`POST /alerts/{alertId}:acknowledge`、`GET /alerts/summary`、`GET /alerts/trends`。这些接口面向运营查询、导出、确认、统计和趋势分析，不负责规则配置管理。
- **Alert Configurations** 模块用于告警类型目录与告警配置表管理，承载 `alert_type_catalog`、`alert_config_profiles`、`alert_config_items` 的管理接口。该模块与 Integration 模块风格一致：先管理一个配置表对象，再管理其订阅/配置明细项。

**告警类型目录管理接口（Platform only）**：`alert_type_catalog` 由 platform admin 管理，以下接口仅允许平台管理员访问。V1.1 不鼓励仅通过 API 动态新增未实现算法的告警类型；目录接口主要用于查看和维护 7 个 canonical alertType 的启用状态、默认配置、可配置 scope、说明与排序。
- `GET /alert-types`：查询告警类型目录，支持按启用状态、scope、alertType 过滤；单个告警类型也通过该接口的 `alertType` 查询参数获取，Swagger UI 不再单独暴露重复的 `GET /alert-types/{alertType}`
- `PATCH /alert-types/{alertType}`：更新目录项的默认 severity、默认阈值/窗口/抑制、允许 scope、说明、排序或启用状态；Swagger UI 中 path `alertType` 仅作为兼容路由占位，不使用枚举下拉，实际更新目标以 request body 的 `alertType` 为准；不得绕过 evaluator 算法边界新增不可执行的告警类型

**告警配置表管理接口（Platform / Reseller Admin）**：Alert Configurations 模块应将 `alert_config_profiles` 与 `alert_config_items` 作为一份完整“告警配置表”管理，避免让前端或 Swagger UI 用户逐行维护 item。V1.1 后续接口收敛为以下主接口：
- `GET /alert-config-profiles`：查询告警配置文件列表，只读取 `alert_config_profiles`；platform 可查询全部，reseller 只能查询自身及下属 enterprise 的配置文件
- `GET /alert-config-profiles/{profileId}`：按 `profileId` 查询配置文件详情，返回 profile 基本信息与该 profile 下全部 `alert_config_items`
- `POST /alert-config-profiles`：创建一份完整配置文件；`scopeType`、`resellerId`、`enterpriseId` 由 query 参数独立提供，request body 只提交 profile 元数据与该 scope 允许的全部告警项明细；服务端校验 `alert_type_catalog.allowed_scope_types`、阈值单位、投递渠道、唯一 ACTIVE 约束后，同时写入 `alert_config_profiles` 与多条 `alert_config_items`
- `PUT /alert-config-profiles/{profileId}`：全量更新一份完整配置文件；`scopeType`、`resellerId`、`enterpriseId` 由 query 参数独立提供且必须与已有 profile 归属匹配，request body 只提交 profile 元数据与该 scope 允许的全部告警项明细；服务端校验后，在同一事务语义下更新 `alert_config_profiles` 并整体替换 / upsert 对应 `alert_config_items`
- `GET /alert-config-profiles/effective`：只读调试接口，按 `alertType` + `resellerId` + 可选 `enterpriseId` 解析最终生效配置，用于解释“为什么触发/未触发”

Alert Configurations 模块所有接口仅允许 platform admin 与 reseller admin 访问；enterprise/customer token 不允许访问目录、profile 列表、profile 详情、整表创建/更新或 effective 调试接口。

`scopeType` 在 Swagger UI 中应为下拉枚举：`PLATFORM` / `RESELLER` / `ENTERPRISE`。创建 ENTERPRISE profile 时必须提供匹配的 `enterpriseId` 与 `resellerId`；创建 RESELLER profile 时 `enterpriseId` 必须为空，`resellerId` 必填且 reseller admin token 只能写自身 reseller；PLATFORM profile 不应提供 `resellerId` / `enterpriseId`。

旧的 item 级接口 `GET /alert-config-profiles/{profileId}/items`、`PUT /alert-config-profiles/{profileId}/items/{alertType}`、`PATCH /alert-config-profiles/{profileId}/items/{alertType}` 不再保留，也不进入 Swagger UI；后端路由应移除，客户端统一使用 profile 级全量创建/更新接口。创建/更新时，“提交所有告警项”指在 body.items 中提交该 scope 允许的全部 alert types：ENTERPRISE profile 不应提交 `CDR_DELAY`、`UPSTREAM_DISCONNECT`、`WEBHOOK_DELIVERY_FAILED`；RESELLER / PLATFORM profile 可提交全部允许 RESELLER / PLATFORM scope 的告警项。

旧的单行规则接口 `GET/POST/PATCH /alert-configs` 与 `GET /alert-configs/effective` 属于 `alert_rule_configs` 单表模型；迁移到 ABC 三表后，应从 Swagger UI 的 **Alerts** 模块移除，改由 **Alert Configurations** 模块的 profile 级整表接口替代，避免同时暴露两套配置模型造成歧义。

**推送管理**：
- Webhook：支持企业级开关与事件类型过滤
- Portal 站内消息：操作提示、状态变更仅在用户登录 Web Portal 时展示

**可配置事件模板**：
| 事件类型 | 示例模板 | 可用变量 |
|:--|:--|:--|
| 配额余量监控 | 你的前向流量池{{package_name}}已使用{{used_mb}}流量，剩余不足1-{{used_pct}}。 | package_name, used_mb, used_pct |

**配置与运维**：
- 规则配置由 `alert_type_catalog`、`alert_config_profiles`、`alert_config_items` 管理；配置变更影响后续评估，不要求回写历史告警；Alert Configurations 管理接口写 `ALERT_RULE_CONFIG_CHANGED` 内部事件与 `audit_logs`
- V1.1 配置解析顺序：ENTERPRISE 覆盖 → RESELLER 配置 → PLATFORM 默认 → 内置兜底
- Fastify canonical runtime 中，告警实例接口归属 **Alerts** 模块；告警目录与配置表接口归属 **Alert Configurations** 模块。配置变更接口写 `ALERT_RULE_CONFIG_CHANGED` 内部事件与 `audit_logs`；配置表状态或明细变更不回写历史告警

**验收与测试**：
- V1.1 测试覆盖 alert configuration 继承/禁用、Fastify Alerts list/ack/summary/trends scope、Alert Configurations profile/item scope、worker 自动评估、Webhook failed 告警与 dist sync smoke；整体覆盖率门槛作为持续质量目标

**Independent Test**: 可通过构造模拟指标、触发阈值、查看告警事件与推送记录来独立测试。

**Acceptance Scenarios**:
1. **Given** Reseller 级 CDR 文件延迟超过配置阈值, **When** 扫描 `cdr_files` 与 `cdr_file_sim_refs`, **Then** 按 Reseller 触发 `CDR_DELAY` 并记录 `delayedFiles`、`cdrFileIds`、`affectedIccidCount` 与阈值单位
2. **Given** 某 Reseller 的 active 上游集成 token API 连续探测失败达到配置阈值, **When** 告警评估读取 `upstream_integration_health_checks`, **Then** 按 Reseller 触发 `UPSTREAM_DISCONNECT`，且 `enterpriseId` 与 `simId` 均为空
3. **Given** Webhook delivery 初始投递失败并按 `next_retry_at` 进入指数退避重试, **When** worker 调用 `retryWebhookDelivery()` 后本次失败导致 `nextAttempt > maxAttempts`, **Then** delivery 标记为 `FAILED`，即时触发 `WEBHOOK_DELIVERY_FAILED` 并保留 `webhookId`、`deliveryId`、`eventId`、`responseCode`、`responseBody`、`maxAttempts`
4. **Given** 产品包 in-profile 用量达到配额百分比阈值, **When** 余量批算执行, **Then** 触发 `POOL_USAGE_HIGH` 并提供 packageId、pricePlanId、quotaMb、usedMb、usageRatio 与 thresholdPercent
5. **Given** 当前账期产品包 out-of-profile 用量达到配置的配额百分比阈值, **When** `USAGE_RATING_ROLLUP` 刷新产品包用量视图且告警评估执行, **Then** 触发 `OUT_OF_PROFILE_SURGE` 并提供 packageId、pricePlanId、quotaMb/tierLimitMb、outOfProfileMb、usageRatio 与 thresholdPercent
6. **Given** SIM 长期处于 `DEACTIVATED` 且超过静默阈值, **When** 静默扫描执行, **Then** 触发 `SILENT_SIM` 并记录 `deactivatedSince` / `inactiveHours`
7. **Given** 当前账期 SIM 已产生产品包未覆盖的 out-of-profile roaming 用量, **When** `USAGE_RATING_ROLLUP` 刷新产品包用量视图且告警评估执行, **Then** 触发 `UNEXPECTED_ROAMING` 并记录 `outOfProfileMb`、`packageIds`、`pricePlanIds`、`usageDays`
8. **Given** ENTERPRISE 规则禁用某 alertType, **When** 同一候选告警命中 RESELLER/PLATFORM 默认规则, **Then** 更具体的禁用配置生效且不触发告警
9. **Given** 同一规则在抑制窗口内重复触发, **When** 告警引擎处理, **Then** 仅合并或更新已有告警，不重复发送通知
10. **Given** 告警规则配置了 Portal/Webhook 投递通道, **When** 新告警创建, **Then** 按有效配置投递并记录投递结果

**交付物清单**：
- 领域模型与数据库表设计说明
- `alert_type_catalog` / `alert_config_profiles` / `alert_config_items` 规则配置与默认种子说明；配置中心版本回滚规范作为商用阶段扩展
- 告警引擎与调度器源码实现说明
- V1.1 告警推送适配器说明（Portal、Webhook）
- 统一查询与可视化接口定义（含告警趋势/统计）
- 冒烟测试报告
- 上线手册与回滚方案

---

### User Story 10 - 多供应商虚拟化层与集成 (Priority: P2)

建立 V1.1 当前实现范围内的上游集成框架：以 `wxzhonggeng` 作为首个真实适配器，通过 SPI / Adapter Registry 屏蔽上游调用细节，并支撑订阅开通、SIM 诊断、入站 Webhook 与产品映射。完整多供应商适配、SFTP/S3 CDR 管道与复杂协议转换作为商用阶段扩展。

**V1.1 南向集成范围**：
- 架构：`src/vendors/spi.ts` 定义 SPI，`src/vendors/registry.ts` 负责根据 `supplierId + operatorId` 加载上游集成配置并创建 Adapter
- 首个适配器：`wxzhonggeng`，当前唯一受支持的 `adapterType`
- SPI 定义：
  - `ProvisioningSPI`：`activateSim`、`suspendSim`、`changePlan`
  - `UsageSPI`：`getDailyUsage`、`fetchCdrFiles`（当前 WX 适配器的 CDR 文件抓取返回 `NOT_SUPPORTED`）
  - `CatalogSPI`：`mapVendorProduct`
- 差异化能力管理：Adapter 暴露 `supportsFutureDatedChange`、`supportsRealTimeUsage`、`supportsSftp`、`supportsWebhookNotification`、`supportedOperations` 等能力；V1.1 主要用于能力声明、诊断能力解析与后续扩展预留
- 上游集成配置：`/v1/upstream-integrations` 管理 `supplierId`、`operatorId`、`adapterType`、`apiEndpoint`、认证凭据、`webhookKey`、启用状态与入站 Webhook 订阅；敏感密钥加密存储
- 产品映射：`vendor_product_mappings` 将 Package 映射到上游 `externalProductId`，订阅开通 Job 使用该映射调用上游 `changePlan`
- 入站 Webhook：`/v1/suppliers/{supplierId}/operators/{operatorId}/webhooks/{adapterType}/{eventKey}` 按集成配置、`webhookKey` 与订阅关系校验后，分发到对应 Adapter 事件处理器

**上游技术标准**：
- 指令：V1.1 通过 Adapter 调用上游 REST/JSON 能力；本地 Job / 批处理层记录 `idempotencyKey`，但不承诺所有上游 API 都原生支持幂等键
- 数据交付：V1.1 以 API 查询与本地 `usage_daily_summary` 为主；SFTP/S3 CDR 文件接入、Checksum、补传与重放作为商用阶段数据管道能力

**北向集成**：
- RESTful API over HTTPS (JSON)，OpenAPI 3.0 文档
- 版本控制：URI 版本化 `/v1/...`
- 认证：API Key（M2M）+ OAuth2/OIDC（Web/第三方）
- RBAC 细粒度鉴权
- TLS 1.2+
- Rate Limiting：Token Bucket，按租户+接口，超限 429
- Webhook：HMAC-SHA256 签名，指数退避重试

**数据同步**：
- SIM 状态：本地生命周期仍由 CMP API / Job 驱动；上游状态可通过诊断接口、对账或入站 Webhook 更新 `upstream_status` / 事件记录
- 订阅开通：`SUBSCRIPTION_PROVISION` Job 根据订阅、SIM、Package 与 Vendor Mapping 调用上游 `changePlan`；成功后本地订阅转为 `ACTIVE`，失败时记录 `SUBSCRIPTION_PROVISION_FAILED`
- 未来生效：当 `effectiveAt` 在未来，开通 Job 在到期前保持 pending，不提前调用上游；到期后再执行上游开通/套餐变更
- 入站 Webhook：当前 WX 事件包括 `update-location`、`sim-status-changed`、`traffic-alert`、`subscription`，处理后写入 `events` 与 `audit_logs`，并对重复事件做幂等识别
- 用量同步：V1.1 存在 API/worker 方式写入 `usage_daily_summary` 的基础能力；不把完整 CDR 文件采集、解析与补传作为 US10 验收范围

**话单/用量数据最小字段**：V1.1 已使用字段以 `usage_daily_summary` 为准，包括 supplierId、enterpriseId、simId、ICCID、usageDay、visitedMccMnc、uplink/downlink/total usage、apn、rat、inputRef 等；recordId、fileId、lineNo、Checksum 与完整时区归一化作为后续 CDR 管道增强。

**SFTP 交付**：非 V1.1 必交付。`fetchCdrFiles` 保留在 SPI 中用于后续供应商文件管道扩展。

**话单时区**：V1.1 计费按已入库的日汇总 / 状态历史数据计算；供应商文件时区配置、换算、重放与自然月归集属于后续 CDR 管道能力。

**Why this priority**: 上游集成层是订阅开通、SIM 诊断、状态回写与供应商扩展的基础；V1.1 先以单供应商真实适配器验证框架，再扩展多供应商。

**Technical Implementation**:

- Adapter Registry：当前仅支持 `wxzhonggeng`，未知 `adapterType` 返回 adapter not found
- Capability Negotiation：`negotiateChangePlanStrategy()` 可识别未来生效且上游不支持预约变更的场景；当前订阅开通 Job 先按 `effectiveAt` pending，避免提前调用上游
- 上游集成 DB 化：`upstream_integrations` 存储 `resellerId`、endpoint、adapterType、加密凭据、webhookKey、status、config 与订阅信息；同一 `resellerId + supplierId + operatorId` 只允许一个 ACTIVE/INACTIVE 集成
- 入站 Webhook 目录：`GET /v1/upstream-webhook-events` 可按 `adapterType` 返回该适配器支持的入站事件
- 诊断集成：SIM 诊断通过 `supplierId + operatorId` 解析上游集成与 adapter capabilities，当前支持 WX 诊断相关能力
- 网元直连、SMPP/SMSC 封装、SOAP/XML 协议转换、多供应商 adapter SDK、SFTP/S3 文件管道均为商用阶段扩展

**Independent Test**: 可通过创建 WX 上游集成、配置 Vendor Mapping、触发订阅开通 Job、调用 SIM 诊断接口与模拟入站 Webhook 来独立验证。

**Acceptance Scenarios**:

1. **Given** 平台管理员（JWT 或 ADMIN_API_KEY）创建 `adapterType=wxzhonggeng` 的上游集成, **When** 提供合法 `resellerId`、`supplierId`、`operatorId`、endpoint、凭据与 `webhookKey`，且该 Supplier 已绑定该 Reseller, **Then** 系统加密保存敏感字段并可按 `resellerId + supplierId + operatorId` 加载 Adapter
2. **Given** Package 已配置 Vendor Product Mapping, **When** 订阅开通 Job 执行, **Then** 系统使用映射的 `externalProductId` 调用上游 `changePlan`，并根据结果更新订阅状态或记录失败事件
3. **Given** 订阅 `effectiveAt` 在未来, **When** `SUBSCRIPTION_PROVISION` Job 被 worker 扫描, **Then** Job 保持 pending，不提前调用上游；到期后再执行上游开通/套餐变更
4. **Given** 已启用 WX 入站 Webhook 订阅, **When** 上游发送合法事件且 `webhookKey` 匹配, **Then** 系统校验事件类型、去重并写入 `events` / `audit_logs`
5. **Given** 用户查询 `/v1/upstream-webhook-events?adapterType=wxzhonggeng`, **When** 目录已初始化, **Then** 返回该 Adapter 支持的入站事件列表
6. **Given** API 调用超过租户限额, **When** 继续请求, **Then** 返回 429 Too Many Requests
7. **Given** Supplier 已绑定 Reseller A, **When** 尝试 `POST /v1/resellers/{resellerB}/suppliers` 绑定同一 `supplierId`, **Then** 返回 **409** `SUPPLIER_BOUND_TO_OTHER_RESELLER`

---

### User Story 11 - 事件驱动架构与可观测性基础设施 (Priority: P2)

建立 V1.1 当前实现范围内的事件目录、事件查询、审计日志、Webhook 投递记录与基础指标能力，支撑系统的可追踪、可定位、可审计。

**V1.1 事件目录（Event Catalog）**：

- 事件类型目录真源由 `src/utils/eventTypeCatalog.ts` 维护，并通过 `GET /v1/events/catalog` 暴露给 Swagger UI / 客户端
- 出站 Webhook 可订阅事件包括：`SIM_STATUS_CHANGED`、`JOB_FINISHED`、`SUBSCRIPTION_CHANGED`、`BILL_PUBLISHED`、`PAYMENT_CONFIRMED`、`ALERT_TRIGGERED`、`ENTERPRISE_STATUS_CHANGED`
- 查询层支持 `eventCategory` + `eventType` 两层过滤；`eventCategory` 当前包含 `webhook`、`billing`、`sim`、`inbound`、`subscription`
- 入站上游 Webhook 事件统一归入 `inbound` 分类，当前包含 `UPDATE_LOCATION`、`INBOUND_SIM_STATUS_CHANGED`、`TRAFFIC_ALERT`、`SUBSCRIPTION`
- 计费、调账、SIM 批量、订阅开通失败等内部事件可进入 `events` 查询，但不全部属于出站 Webhook 白名单

**可观测性**：
- 链路关联：`requestId`（HTTP 请求）、`jobId`（异步任务）、`eventId`（事件记录）、`idempotencyKey`（部分南向/批量任务）
- 事件查询：`GET /v1/events` 支持按 token scope、`resellerId`、`enterpriseId`、时间、`eventCategory`、`eventType`、`iccid` 查询；`GET /v1/events:csv` 支持相同过滤条件导出 CSV
- 审计查询：`GET /v1/audit-logs` 与 `GET /v1/audit-logs:csv` 输出 `requestId`、`before`、`after`、`sourceIp`、`actorEmail`、`actorLabel`
- Webhook 可观测性：`webhook_deliveries` 记录投递 attempt、status、responseCode、responseBody、nextRetryAt，并支持人工重投
- 基础指标：`GET /metrics` 输出 HTTP 请求总数、5xx、429、认证失败、P50/P95/P99、按 method/route/status 聚合的请求指标，以及最近窗口内的告警/`ALERT_TRIGGERED` 指标

**Why this priority**: 事件和可观测性是运维保障的基础，但核心业务逻辑完成后再完善。

**Technical Implementation**:

- 事件通用字段：`eventId`、`eventType`、`occurredAt`、`enterpriseId`、`resellerId`、`actorUserId`、`requestId`、`jobId`、`payload`
- `events` 表 V1.1 使用 `enterprise_id` / `reseller_id` 表达租户作用域；旧 `tenant_id` 不作为事件查询与新写入的契约字段
- `emitEvent()` 负责事件写入、payload 大小限制、常见事件去重与出站 Webhook 分发；部分历史路径直接写入 `events` 时，也必须写入 `enterprise_id` / `reseller_id`
- 出站 Webhook 以 `webhook_subscriptions.event_types` 过滤事件，以 `webhook_deliveries.event_id` 关联投递记录；失败重试超过上限后触发 `WEBHOOK_DELIVERY_FAILED` 告警
- 计费重算链路通过 `rating_results` / 相关结果数据保留 `inputRef`、`ruleVersion` / `rule_version_id`、`calculationId` 等可追溯字段

**Independent Test**: 可通过触发业务操作并验证事件产生和日志记录来独立测试。

**Acceptance Scenarios**:

1. **Given** SIM 状态变更, **When** 操作完成, **Then** 产生 SIM_STATUS_CHANGED 事件含完整 payload
2. **Given** `POST /v1/sims/{iccid}:deactivate` 触发停机, **When** 生命周期 Job 完成, **Then** 审计日志含 requestId/before/after，并可通过事件与 Job 记录追踪处理结果
3. **Given** 计费重算, **When** 完成, **Then** 可关联 inputRef + ruleVersion + calculationId
4. **Given** 用户查询事件, **When** 提供 eventCategory/eventType/iccid/resellerId/enterpriseId 条件, **Then** `GET /v1/events` 返回符合 token scope、租户权限和过滤规则的事件列表
5. **Given** 用户导出事件, **When** 调用 `GET /v1/events:csv`, **Then** 使用与 `GET /v1/events` 相同的过滤与权限规则导出 CSV
6. **Given** 已配置出站 Webhook 订阅, **When** 命中订阅事件产生, **Then** 生成 `webhook_deliveries` 记录并按 HMAC 签名投递
7. **Given** Webhook 投递连续失败超过重试上限, **When** 投递状态变为 FAILED, **Then** 记录失败明细并触发 `WEBHOOK_DELIVERY_FAILED`
8. **Given** 运维访问 `/metrics`, **When** 服务运行中, **Then** 返回 HTTP 请求、错误、限流、延迟与告警窗口指标

---

### 报表模块（Reports）

Reports 模块用于面向运营、代理商和企业用户提供轻量统计报表。V1.1 当前报表接口不生成新的业务事实数据，而是读取现有的用量汇总、告警、SIM 状态历史等表，在请求时按日期范围与租户作用域进行聚合计算。报表数据的准确性依赖前置的用量归集、Rating/Rollup、告警评估与 SIM 生命周期事件写入。

**通用输入与租户判断**：

- 4 个 Reports 接口均使用 `startDate`、`endDate` 表示查询日期范围，格式为 `YYYY-MM-DD`；两者均为必填，且 `startDate <= endDate`
- 对 `usage_daily_summary.usage_day` 这类 date 字段，按 `startDate <= usage_day <= endDate` 闭区间过滤
- 对 `alerts.window_start`、`sim_state_history.start_time` 这类 timestamp 字段，按 `startDate 00:00:00.000Z` 到 `endDate 23:59:59.999Z` 闭区间过滤
- `admin/platform` 不传 `enterpriseId` 时查询全平台；传入时必须是 `tenants` 中存在的 `tenant_type = ENTERPRISE` 记录，否则返回错误
- `reseller` token 不传 `enterpriseId` 时查询该 reseller 下所有企业；传入时必须先确认企业存在，再确认 `tenants.parent_id = resellerId`，否则返回不在 reseller 范围内
- `customer` token 不传 `enterpriseId` 时查询 token 自身企业；传入时必须确认企业存在且与 token 企业一致，否则返回企业不存在或不在 customer 范围内
- Reports 接口读取使用服务端权限访问数据库，但返回数据必须严格受上述 token scope 和 `enterpriseId` 校验约束

**`GET /v1/reports/usage-trend` — 用量趋势报表**：

- 用途：展示指定日期范围内的数据用量趋势，用于运营观察流量增长、异常波动和企业用量走势
- 数据来源：`usage_daily_summary`
- 过滤逻辑：按 `usage_day` 过滤 `startDate` / `endDate`，并按 `enterprise_id` 应用租户范围
- 聚合逻辑：读取 `usage_day,total_mb`；`granularity=day` 时按天汇总，`granularity=month` 时按月汇总
- 输出：`granularity`、`startDate`、`endDate`、`items[]`；每个 item 包含 `period` 与 `totalMb`

**`GET /v1/reports/top-sims` — Top SIM 用量排行**：

- 用途：展示指定日期范围内用量最高的 SIM 列表，用于定位大流量 SIM、异常消耗和重点客户支持场景
- 数据来源：`usage_daily_summary`
- 过滤逻辑：按 `usage_day` 与租户范围过滤
- 聚合逻辑：读取 `iccid,total_mb`，按 `iccid` 汇总总用量后按 `totalMb` 降序排序
- 分页逻辑：使用 `page` + `pageSize` 分页，`page` 默认 1；`pageSize` 默认 20，最大 50；`total` 表示聚合后 SIM 记录总数
- 输出：`startDate`、`endDate`、`total`、`page`、`pageSize`、`items[]`；每个 item 包含 `iccid` 与 `totalMb`

**`GET /v1/reports/anomaly-sims` — 异常 SIM 报表**：

- 用途：展示指定日期范围内产生告警的 SIM 聚合列表，用于运营排查异常漫游、高用量、WebHook 失败等告警相关 SIM
- 数据来源：`alerts`，并通过关系读取 `sims(iccid)`
- 过滤逻辑：按 `alerts.window_start` 过滤日期范围；企业范围使用 `customer_id = enterpriseId`，reseller 范围使用 `reseller_id = resellerId`
- 聚合逻辑：按 `sim_id` 分组，统计 `alertCount`；选取最近一次告警作为该 SIM 的最新告警摘要
- 分页逻辑：使用 `page` + `pageSize` 分页，`page` 默认 1；`pageSize` 默认 20，最大 20；`total` 表示聚合后异常 SIM 记录总数
- 输出：`startDate`、`endDate`、`total`、`page`、`pageSize`、`items[]`；每个 item 包含 `iccid`、`alertCount`、`latestAlertType`、`latestSeverity`、`latestStatus`、`lastSeenAt`；不对外返回内部 `simId`
- 该接口不重新判定异常，只基于已生成的 `alerts` 做报表汇总

**`GET /v1/reports/deactivation-reasons` — 停机原因报表**：

- 用途：统计指定日期范围内 SIM 被停机的原因分布，用于分析客户主动停机、批量停机、生命周期任务或系统流程造成的停机结构
- 数据来源：先读取租户范围内的 `sims`，再读取这些 SIM 对应的 `sim_state_history`
- 过滤逻辑：`sim_state_history.after_status = DEACTIVATED`，`start_time` 落在 `startDate` / `endDate` 范围内，且 `sim_id` 属于目标 SIM 集合
- 聚合逻辑：使用 `sim_state_history.source` 作为停机原因，按 source 计数；source 为空时归为 `UNKNOWN`
- 停机原因取值来自状态历史写入方，常见包括：`api:deactivate`（单卡 API 停机）、`api:batch-deactivate`（批量停机 API）、`job:SIM_STATUS_CHANGE`（SIM 状态变更任务）、`upstream:webhook`（上游 Webhook 同步）、`SYSTEM`（系统流程写入）、`UNKNOWN`（历史记录 source 为空）
- 输出：`startDate`、`endDate`、`items[]`；每个 item 包含 `reason` 与 `count`

**验收口径**：

1. **Given** admin/platform 调用 Reports 接口且不传 `enterpriseId`, **When** 日期范围合法, **Then** 返回全平台范围内的聚合结果
2. **Given** admin/platform 传入不存在的 `enterpriseId`, **When** 调用 Reports 接口, **Then** 返回企业不存在错误
3. **Given** reseller token 不传 `enterpriseId`, **When** 调用 Reports 接口, **Then** 返回该 reseller 下所有企业范围内的聚合结果
4. **Given** reseller token 传入不属于自身的 `enterpriseId`, **When** 调用 Reports 接口, **Then** 返回不在 reseller 范围内
5. **Given** customer token 不传 `enterpriseId` 或传入自身企业 ID, **When** 调用 Reports 接口, **Then** 正常返回该企业范围内的聚合结果
6. **Given** customer token 传入不存在或不匹配自身的 `enterpriseId`, **When** 调用 Reports 接口, **Then** 返回企业不存在或不在 customer 范围内
7. **Given** `startDate` / `endDate` 缺失、格式错误或 `startDate > endDate`, **When** 调用 Reports 接口, **Then** 返回 `BAD_REQUEST`

---

### Edge Cases

- **SIM 02-01 00:00:01 ACTIVATED → 02-01 00:00:02 DEACTIVATED**：收全额月租费（出现过 ACTIVATED，哪怕 1 秒）
- **企业 SUSPENDED 但 SIM 漏停机仍 ACTIVATED**：收全额月租 + 用量计费照常（计费只认 SIM 状态）
- **SIM 处于 TEST_READY / INVENTORY / DEACTIVATED 但仍产生用量**：用量计费以 CDR / usage 事实为输入。若 SIM 当日存在有效订阅和产品包，仍按产品包正常 Rating；本地状态异常仅作为 metadata / 告警线索记录，不应单独阻断计费。若没有有效订阅，则进入 Default Fallback Package 路径。
- **SIM 处于 RETIRED 仍有 CDR/用量**：V1.1 不提供独立异常队列；若记录已进入 `usage_daily_summary`，计费结果通过 rating classification、`inputRef` 与 metadata 暴露异常线索。若有有效订阅或 fallback package 可解析 OOP 费率，可生成可追溯费用；若无费率则记录 `UNCLASSIFIED`。
- **visitedMccMnc 不在 Covered Network Profile 内**：先按 Package → Carrier Service → Roaming Profile 查找 OOP roaming rate；命中则记录 `OOP_ROAMING`，未命中则记录 `UNCLASSIFIED`。Zone PAYG / Price Plan PAYG 不属于 V1.1 当前实现
- **话单落在已发布账期窗口**：`lateCdr` 服务路径可清洗补充用量、重算账期差额并生成 `DRAFT` 调账单；该能力不是默认自动扫描入口，调账单仍需按调账流程审批与下期结算
- **上游通知乱序/重复**：入站 Webhook 按 `uuid` / `transactionId` 等 payload 字段做重复识别；V1.1 记录事件、审计和部分本地上游状态，不承诺完整“以上游最终回执为准”的跨供应商状态机
- **月内取消订阅后立即终止**：当月仍按全额月租计费，配额保留至月底
- **企业 SUSPENDED 时 SIM 未能成功停机**：继续按全额月租收取
- **拆机门槛校验**：`RETIRE` 会检查该 SIM 相关订阅的最大 `commitment_end_at`；未过承诺期且未显式 `commitmentExempt` 时返回 `COMMITMENT_NOT_MET`
- **APN / Roaming / Covered Network 配置变更**：V1.1 采用 `DRAFT` / `PUBLISHED` / `DEPRECATED` 快照生命周期；已发布配置只读，变更需新建或克隆 DRAFT 后发布并重新绑定，不提供在线版本回退机制
- **未知 visitedMccMnc / 规则缺失**：计费结果保留 `visited_mccmnc`、`input_ref`、`calculation_id`、classification 与 metadata，供账单核查和人工处理；不承诺独立待处理队列

## Clarifications

### Session 2026-04-20

- Q: 所有 enterprise 外键与 reseller 外键是否统一指向 `tenants.tenant_id`？ → A: **是**。企业类外键 **MUST** `REFERENCES tenants(tenant_id)` 且引用 **`tenant_type = ENTERPRISE`** 行；代理商类外键 **MUST** `REFERENCES tenants(tenant_id)` 且引用 **`tenant_type = RESELLER`** 行。详见 User Story 1「企业 / 代理商外键统一」与 **FR-061**。
- Q: Price Plan、APN Profile、Roaming Profile、Carrier Service、Commercial Terms、Control Policy、Package 七类资源配置的规则如何收口？ → A: **统一生命周期与 ID 管理**——对外 OpenAPI **不出现** Package 的 `packageVersion` / `version`；Package **内部收敛单表/单实体**，不以 `package_versions` 为契约真源。新建均为 **`DRAFT`**；**发布**仅 **`DRAFT`**；Package 发布时 **`pricePlanId`** 与 **`carrierServiceId`** 必须均已 `PUBLISHED`，若绑定 `commercialTermsId` / `controlPolicyId`，也必须为 `PUBLISHED`。**创建/编辑 `DRAFT` Package** 时，已提供的模块 ID 必须均指向 `PUBLISHED` 快照。**废弃**仅 **`PUBLISHED`**；Package 废弃额外要求无 `ACTIVE` / `PENDING` 订阅引用。**`DEPRECATED`** 对外 **只读**（Commercial Terms / Control Policy 等与 Package 一致，含发布/废弃 API）。详见正文 User Story 3「产品配置域统一生命周期与引用规则」表及 **FR-060**。

### Session 2026-03-24

- Q: 需要独立表记录 3GPP 运营商公开信息，与核心业务无逻辑耦合，支持按名称模糊、按 MCC/MNC 精确查询，返回名称/国家/MCC/MNC/频段；仅系统管理员可写入，其余用户只读。如何与现有数据模型对齐？ → A: 采用现有 Supabase 表 **`public.public_infos`**（迁移 `20260311100004_sim_connectivity.sql` 已创建；兼容视图 `public.carriers`）。产品定位：**辅助查阅**，不参与计费/订阅等业务判定。权限：**platform_admin** 可 INSERT/UPDATE/DELETE；**其他已认证用户**（reseller/customer 等）仅只读查询 API 或直接受 RLS 约束的 SELECT。查询语义：**name 模糊** + **mcc+mnc 精确**（AND 组合）。
- Q: `public_infos` 与 `business_operators`、`operator_id` 必须无任何关系。 → A: `public_infos` 与 `business_operators`、`operators.operator_id` 链路**零关联**——禁止外键、禁止业务 JOIN。若历史迁移中 `operators.carrier_id` 曾 FK 至 `public_infos`，V1.1 **必须 `DROP COLUMN operators.carrier_id`**（物理删列，硬性验收）。详见 FR-057。
- Q: Phase 24 中 `customers.reseller_id` 迁移策略？ → A: `customers` 对外与租户作用域以 `reseller_tenant_id` FK→`tenants(tenant_id)` 为准；`reseller_id` 仅作为历史/域表兼容字段，不作为 V1.1 对外身份。`reseller_suppliers` 属于代理商-供应商授权关系域表，若保留 `resellers.id` 作为内部域表主键引用，必须与对外 `resellerId = tenants.tenant_id` 语义区分清楚。
- Q: KB→MB 单位统一的兼容策略？ → A: V1.1 对外计费、账单与主查询口径统一使用 MB 字段与 `ratePerMb` / `rate_per_mb`；历史清洗、late CDR、legacy/兼容路径中可能仍出现 KB 字段，进入计费主路径前必须归一化到 MB 口径。
- Q: Price Plan 快照模式重构迁移失败时的回滚策略？ → A: **停机迁移 + 备份回滚** — 迁移前 `pg_dump` 全量备份，迁移脚本在事务中执行，失败还原备份。需在 staging 充分验证后再上 production。
- Q: Phase 24 部署时旧 JWT 兼容？ → A: V1.1 不承诺旧 JWT 兼容；涉及身份字段语义、角色或 token claim 变更时，部署后要求用户重新登录并重新签发 token。
- Q: 对外 API 与 JWT 中 `resellerId` 应使用哪一种 UUID？ → A: **统一为 `tenants` 表中 RESELLER 行的 `tenant_id`（reseller tenant_id）**。**路径** `/v1/resellers/{tenantId}/…` 使用参数名 **`tenantId`**，**查询/Body/JWT** 仍常用字段名 **`resellerId`**，语义相同。所有**输入**、**权限与租户树判断**、**输出**（JSON `resellerId`、事件/审计中的代理商作用域）均按此语义；`resellers.id` 仅作域表内部主键，不作为默认对外标识。详见正文「User Story 1 — 代理商对外身份约定」与 **FR-058**。
- Q: Phase 23 RBAC DB 驱动是否需要功能开关？ → A: **不加功能开关，依赖测试覆盖**。V1.1 已引入 `permissions` / `roles` / `role_permissions` seed 与 RBAC middleware；部分默认权限与 legacy 兼容逻辑仍可作为兜底，但新能力验收应以 DB 权限种子和路由 RBAC 为准。
- Q: T141（SIM 上游状态同步）单任务是否足够？ → A: **拆分为 3 个子任务** — T141a：适配器路由逻辑；T141b：幂等与重试策略；T141c：无上游能力处理（`UPSTREAM_NOT_SUPPORTED`）。

### Session 2026-03-12

- Q: 角色访问权限如何配置？禁止 enterprise 访问 bills？ → A: V1.1 以 `permissions` / `roles` / `role_permissions` 数据种子和路由 RBAC middleware 为主；`customer` / `department` 不授予 `bills.*` 权限。`defaultPermissionsByRoleScope` 等 legacy/default 逻辑仅作为兼容兜底，不作为新权限规格真源。

### Session 2026-02-08

- Q: 主要开发语言？ → A: TypeScript (Node.js)
- Q: 主数据库？ → A: Supabase (PostgreSQL)
- Q: MVP 交付形态？ → A: API-first；V1.1 以 Fastify TS 服务、OpenAPI / Swagger UI 和脚本化测试为主要交付与验证入口，轻量 Portal / 管理后台不作为当前后端验收前提
- Q: 币种策略？ → A: 按代理商固定币种（企业继承）
- Q: 部署环境？ → A: Node.js Fastify 服务；canonical runtime 为 `npm run build` 后运行 `dist/server.js`。Vercel / Serverless / Cron 属于部署形态选项或后续运维能力，不作为当前规格的唯一运行时假设

## Requirements *(mandatory)*

### Functional Requirements

**租户与权限**：
- **FR-001**: 系统 MUST 支持"代理商 -> 企业 -> 部门/项目"租户层级；供应商、运营商与上游集成作为平台主数据和业务关联，不作为 `tenants` 租户树节点
- **FR-002**: 系统 MUST 实现 RBAC 权限模型（系统管理员/代理商角色/企业角色），数据默认最小可见最小可操作
- **FR-003**: 系统 MUST 支持基础代理商品牌配置（Logo、主色、自定义域名等 branding 字段的保存与查询）；完整白标 Portal 运行时不作为 V1.1 后端验收前提
- **FR-004**: 系统 MUST 维护供应商-运营商多对多关联，禁止创建未关联运营商的供应商
- **FR-005**: 系统 MUST 对关键操作记录审计日志（组织/权限/SIM/资费/数据操作）

**企业管理**：
- **FR-006**: 系统 MUST 支持企业三态管理（ACTIVE/INACTIVE/SUSPENDED），状态变更实时生效并触发事件通知
- **FR-007**: 系统 MUST 保留企业 `autoSuspendEnabled` 配置（默认 Disabled，当前版本不用于自动状态控制）

**SIM 生命周期**：
- **FR-008**: 系统 MUST 以 ICCID 为唯一索引管理 SIM 卡
- **FR-009**: 系统 MUST 实现 5 状态主生命周期（INVENTORY/TEST_READY/ACTIVATED/DEACTIVATED/RETIRED）；过渡 **MUST** 用 `lifecycle_sub_status` 表达，过渡期间 **MUST NOT** 将 `status` 预写为目标稳态
- **FR-009a**: 系统 MUST 支持全方向过渡子状态：`activating` / `activation_failed`、`deactivating` / `deactivation_failed`、`reactivating` / `reactivation_failed`、`retiring` / `retire_failed`，及 `normal`
- **FR-010**: 系统 MUST 保持 SIM **稳态** `status` 与上游 CMP 对齐；本地 outbound **MUST** 经供应商适配器确认后再落稳态
- **FR-010a**: `SIM_STATUS_CHANGE` Job 的 `SUCCEEDED` **MUST** 表示上游已确认且本地已落稳态；首包 202 **MUST NOT** 返回 `job.status=SUCCEEDED`
- **FR-010b**: 供应商适配器 **MUST** 按供应商独立实现 `pending` 完成路径（轮询/回调/混合）；CMP 核心状态机不全局二选一
- **FR-011**: 系统 MUST 禁止 ACTIVATED 直接到 RETIRED（必须先 DEACTIVATED）
- **FR-011a**: 当 `lifecycle_sub_status` 为进行中（`*ing`）时，系统 MUST 拒绝其它方向生命周期操作（`409 LIFECYCLE_IN_PROGRESS`）
- **FR-012**: 系统 MUST 支持批量 SIM 导入（异步 job，上限 10 万条）
- **FR-013**: 系统 MUST 在企业 SUSPENDED 时禁止企业用户复机
- **FR-014**: 系统 MUST 支持拆机承诺期门槛校验
- **FR-014a**: 系统 MUST 对 `jobs.type=SIM_STATUS_CHANGE` 拒绝 `:cancel`（`409 JOB_NOT_CANCELLABLE`）；失败后 **MUST** 以新的生命周期 API 重试，而非 cancel Job
- **FR-014b**: 系统 MUST 在 `SIM_STATUS_CHANGE` Job 终态（SUCCEEDED/FAILED）向已订阅方投递 **`JOB_FINISHED`** Webhook；在稳态 `status` 变更后投递 **`SIM_STATUS_CHANGED`**

**产品包与资费**：
- **FR-015**: 系统 MUST 支持 4 种资费计划类型（One-time/SIM Dependent Bundle/Fixed Bundle/Tiered Pricing）
- **FR-016**: 系统 MUST 产品包以**单一实体、单一 `packageId`** 绑定配置模块；V1.1 当前实现中 Price Plan 为创建必备，Carrier Service 为发布前必备，Control Policy 与 Commercial Terms 为可选绑定；**MUST NOT** 在对外 API / OpenAPI 中要求或暴露 `packageVersion`、产品包维度 `version` 作为引用真源；内部 **MUST** 收敛为单表/单实体，不得以独立 `package_versions` 作为契约层真源。
- **FR-017**: 系统 MUST 产品包变更次月生效
- **FR-018**: V1.1 当前实现 **MUST** 使用 Package -> Carrier Service -> Roaming Profile 的 OOP roaming rate 作为 Out-of-Profile 计费来源；Price Plan 级 Zone-based PAYG 兜底已移出 V1.1
- **FR-019**: 系统 MUST 支持 Control Policy 配置模块的创建、更新、查询、发布、废弃与 Package 绑定；自动限速、达量断网等执行闭环作为后续控制策略运行时能力

**订阅管理**：
- **FR-020**: 系统 MUST 支持 SIM 订阅 1 个主数据产品包 + N 个叠加包（主套餐同一时间段互斥）
- **FR-021**: 系统 MUST 支持主套餐切换；V1.1 当前实现中 **ACTIVE MAIN** 仅允许 `NEXT_CYCLE` 切换，旧订阅排程取消，新订阅以未来 `effectiveAt` 创建并进入 `PENDING` / `SUBSCRIPTION_PROVISION` 流程
- **FR-022**: 系统 MUST 支持退订；V1.1 当前实现中 **ACTIVE** 订阅拒绝立即取消，仅支持 `immediate=false` 排程取消；**PENDING** 订阅可直接取消为 `CANCELLED`
- **FR-062**: 系统 MUST 提供 **`POST /v1/subscriptions:batch-create`**：以 **`multipart/form-data`** 提交与单笔创建相同的 **`enterpriseId` / `packageId` / `kind` / `effectiveAt`**、可选 **`batchId`** 及 **ICCID CSV 文件**；文件 **MUST** 为 UTF-8，首行 **MUST** 包含 `iccid` 表头列；**MUST** 允许**部分成功**，成功与失败 **MUST** 在响应体的 **`results`** 中**逐 ICCID** 给出；当前成功请求返回 **HTTP 201**；**MUST** 对每一行复用单笔 **`POST /v1/subscriptions`** 的业务规则（含 **`PUBLISHED`** Package、上游映射、SIM supplier/operator 对齐等）；请求级非法（CSV 缺 `iccid` 列、合法 ICCID 为 0、超上限、缺字段等）**MUST** 返回 **4xx** 且不冒充整批成功。详细字段、上限与错误码 **MUST** 与 OpenAPI 及本文 User Story 4「批量创建订阅」一致。
- **FR-063**: 系统 MUST 提供 **`POST /v1/subscriptions:batch-export`**：以 **JSON/query 参数**按与 **`GET /v1/subscriptions:search`** 同类筛选条件导出订阅；**`batchId` 必填**，重复成功导出返回 **409 DUPLICATE_BATCH**；**成功响应** **MUST** 为 **HTTP 200** 且 body 为 **`text/csv`** 下载（**`Content-Disposition: attachment`**），**MUST NOT** 以 JSON 包装 CSV；`pageSize` 缺省 **100**、最大 **1000**。当前 V1.1 **不**上传 ICCID 文件、**不**提供 `scope=CURRENT/ALL`、**不**输出 `rowStatus` 逐输入行诊断；CSV 列集、BOM、RFC 4180 与 **`filename`** 约定 **MUST** 与 OpenAPI 及本文 User Story 4「批量导出订阅」一致。

**计费引擎**：
- **FR-023**: 系统 MUST 基于高水位原则计算月租费（ACTIVATED > DEACTIVATED > 其他）
- **FR-024**: 系统 MUST 实现 Waterfall Logic 用量匹配（叠加包优先 -> 范围最小优先 -> 主套餐兜底 -> Out-of-Profile）
- **FR-025**: 系统 MUST 对 Out-of-Profile 用量不扣减任何套餐配额；V1.1 当前实现按 OOP roaming rate 独立计费，未命中费率时记录 `UNCLASSIFIED`
- **FR-026**: 系统 MUST 支持 SIM Dependent Bundle 动态累加池额度（高水位 activatedSimCount × perSimQuotaMb）
- **FR-027**: 系统 MUST 阶梯流量计费采用分段累进（Progressive）；V1.1 内部类型为 `TIERED_VOLUME_PRICING`
- **FR-028**: 系统 MUST 计费结果可追溯（`input_ref` + matched package / price plan + `calculation_id`）

**账单与出账**：
- **FR-029**: 系统 MUST 支持手工出账与 worker 自动排队出账；V1.1 当前实现通过 `billing_config.auto_generate` / `bill_day` 为企业排队 `BILLING_GENERATE` Job，默认 T+3
- **FR-029a**: **`POST /v1/billing:generate`** **SHOULD** 支持 **`idempotencyKey`**；相同出账 scope + 键 **MUST NOT** 重复创建并发 Job（返回已有 Job）
- **FR-030**: 系统 MUST 支持三级账单结构（企业汇总/分组/SIM 明细）
- **FR-031**: 系统 MUST 已发布账单不可篡改，差异通过 Credit/Debit Note 处理（流程见 [调账业务流程](#adjustment-business-flow)）
- **FR-031a**: 同一 **PUBLISHED/OVERDUE** 原账单 **MAY** 关联多条 Adjustment Note；每条 **MUST** 独立存储与审计
- **FR-031b**: **`POST /v1/bills/{billId}:adjust`** **SHOULD** 支持 **`idempotencyKey`**；在相同 **`billId`** 下 **MUST** 拒绝重复键（**409** `IDEMPOTENCY_CONFLICT`），不重复创建 Note
- **FR-032**: 系统 MUST 支持手工 Credit / Debit Note 调账；V1.1 当前实现不自动识别迟到话单并生成调账草稿，迟到话单差额由运营/财务通过 `POST /v1/bills/{billId}:adjust` 录入，审批后计入下期结算

**信控与催收**：
- **FR-033**: 系统 MUST 实现 Dunning 状态计算与记录（`NORMAL` / `OVERDUE_WARNING` / `SUSPENDED` / `SERVICE_INTERRUPTED`），并可将到期 `PUBLISHED` 账单转为 `OVERDUE`；V1.1 当前实现不发送邮件/短信催收、不自动变更企业状态、不自动停机
- **FR-034**: 系统 MUST 支持在无逾期账单时解除 Dunning 记录；V1.1 当前实现仅清除 `dunning_records`，不自动恢复企业状态，也不自动批量复机

**集成**：
- **FR-035**: 系统 MUST 提供 RESTful API over HTTPS (JSON) + OpenAPI 3.0 文档
- **FR-036**: 系统 MUST 支持 API Key + Bearer JWT 认证；V1.1 当前实现支持本地 HS256 token，并可在配置 `OIDC_ISSUER` / `OIDC_AUDIENCE` / `OIDC_JWKS_URL` 后校验 OIDC JWKS token，不承诺完整 OAuth2 授权服务器流程
- **FR-037**: 系统 MUST 实现可扩展供应商适配层（SPI + Adapter Pattern）；V1.1 当前首个真实 adapter 为 `wxzhonggeng`，其他供应商适配作为扩展能力
- **FR-038**: 系统 MUST 在本地南向 Job / 批处理层支持幂等（`idempotencyKey`）；不承诺所有上游供应商 API 原生接收或执行相同幂等键

**可观测性**：
- **FR-039**: 系统 MUST 实现统一事件目录（SIM_STATUS_CHANGED/SUBSCRIPTION_CHANGED/BILL_PUBLISHED/PAYMENT_CONFIRMED/ALERT_TRIGGERED/ENTERPRISE_STATUS_CHANGED）；事件向下游 Webhook 投递与重试见 [clarifications/webhook-delivery.md](clarifications/webhook-delivery.md)

**实体建模（CMP.xlsx 对齐）**：
- **FR-040**: 系统 MUST 使用独立表建模（resellers、customers、suppliers、`public_infos`、business_operators、operators），`tenants` 表作为统一身份标识与层级查询基础表保留，与独立域表并存
- **FR-041**: 系统 MUST 维护 **`business_operators`** 作为业务运营商字典（全局唯一 PLMN/品牌）；**`operators`** 作为 **供应商—运营商商业关联**，**MAY** 多行共享同一 **`business_operator_id`**（不同 **`supplier_id`**）；**UNIQUE(`supplier_id`, `business_operator_id`)**（非空时）。产品库表 FK **`operator_id` MUST** 指向 **`operators.operator_id`（行 PK）**。对外 API 统一字段 **`operatorId`**：**MAY** 传入字典 ID 或行 PK；服务端 **MUST** 双路径解析（先 `operators.operator_id`，再 `operators.business_operator_id`，且 **SHOULD** 配合 **`supplierId`**）；响应 **SHOULD** 优先回显字典 ID。细则见 [clarifications/operator-identity-model.md](clarifications/operator-identity-model.md)。
- **FR-042**: 系统 MUST 维护 **`upstream_integrations`**（**业务唯一：`UNIQUE(reseller_id, supplier_id, operator_id)`** 于 ACTIVE/INACTIVE；`operator_id` FK→**`operators.operator_id`**；`reseller_id` FK→**`tenants.tenant_id` RESELLER**），含 **`adapter_type`**（有限枚举，V1.1 初值 **`wxzhonggeng`**）、API 端点、**`api_secret_encrypted`**（AES-256-GCM BYTEA）、**`webhook_key`**（加密存储推荐）、CDR/扩展配置；Platform Admin **MUST** 提供 CRUD API，且 **MUST** 同时接受 **platform_admin JWT** 与 **`ADMIN_API_KEY`（`X-API-Key`）**。创建集成时 **MUST** 要求请求体 **`resellerId`**，且 **MUST** 校验该 `supplierId` 已通过 **`reseller_suppliers` 绑定到该 `resellerId`**。凭证加密 **MUST** 使用 env **`INTEGRATION_SECRET_KEY`**（应用 master key，**非**上游凭证）。细则见 [clarifications/upstream-integration-config.md](clarifications/upstream-integration-config.md) §9–§10。
- **FR-042a**: 系统 MUST 保证 **每个 `suppliers.supplier_id` 至多绑定一个 Reseller**（`reseller_suppliers` 上 **`supplier_id` UNIQUE**）。绑定入口为 **`POST /v1/resellers/{resellerId}/suppliers`**；**`POST /v1/suppliers` MUST NOT** 要求或写入 `resellerId`。若 `supplierId` 已绑定其他 Reseller，绑定 MUST 失败（建议 **`409 SUPPLIER_BOUND_TO_OTHER_RESELLER`**）。
- **FR-064**: 生产配置 **MUST** 以 **`upstream_integrations`** 中按 **`(resellerId, supplierId, 解析后的 operators.operator_id)`** 加载的集成行为准；**`adapter_type` MUST** 显式存储，**MUST NOT** 仅凭 **`supplierId`** 推断适配器实现。`.env` 中的上游 URL / API Key / Secret / Webhook Key fallback 仅允许作为本地开发或 legacy 兼容路径，不作为生产验收路径。
- **FR-065**: Vendor 适配器与南向 Worker（含 **`SUBSCRIPTION_PROVISION`**、SIM 状态变更、诊断与用量同步）**MUST** 优先接受 **`supplierId` + `operatorId`**（及可用时的 **`resellerId`**）上下文并加载对应集成行；全局默认 adapter 仅可作为本地/legacy 兼容兜底，不作为 V1.1 生产主路径。
- **FR-066**: 入站供应商 Webhook **MUST** 通过 **`/v1/suppliers/{supplierId}/operators/{operatorId}/webhooks/{adapterType}/{eventKey}`** 定位验签密钥（**`adapterType` MUST** 与 **`upstream_integrations.adapter_type`** 一致）；路径 **`operatorId` MUST** 按 **FR-041** 解析；**MUST NOT** 依赖单一全局 Webhook Key 或 **`/v1/wx/webhook/*`**。

**入站 Webhook 目录与集成订阅** — 真源：[upstream-inbound-webhook-catalog.md](clarifications/upstream-inbound-webhook-catalog.md)（**已评审**；实现 **Phase 38**）。V1.1 **`wxzhonggeng`** 初值四条 **`event_key`**：`subscription`（Subscription；非旧名 `product-order`）、`update-location`（Update Location；非旧名 `sim-online`）、`sim-status-changed`、`traffic-alert`；对应 HTTP 路径后缀与目录一致。入站 **`subscription`** 写入 **`events.event_type = SUBSCRIPTION`**、**`audit_logs.action = WX_WEBHOOK_SUBSCRIPTION`**。入站 **`update-location`** 写入 **`events.event_type = UPDATE_LOCATION`**；**`audit_logs.action`** 为 **`WX_WEBHOOK_SIM_ONLINE`**。

- **FR-067**: 系统 **MUST** 维护 **入站** Webhook **事件目录**（表 **`upstream_inbound_webhook_events`**，平台级 **`event_key`**）；目录行 **MUST** 由迁移种子 + 发版维护，**MUST NOT** 由 Platform Admin 无发版新增 `event_key`；**MUST NOT** 与出站 **FR-039** 目录混表；**MUST NOT** 将 CDR/SFTP 定时拉取冒充入站 `event_key`（见 catalog §2.5）。
- **FR-068**: 每个 **`adapter_type` MUST** 在代码中声明其支持的入站 **`event_key`** 子集；**`upstream_integration_webhook_subscriptions`** **MUST NOT** 超出该子集或目录 `ACTIVE` 项。
- **FR-069**: 每条 **`upstream_integrations` MUST** 经 **`upstream_integration_webhook_subscriptions`** 配置订阅（**`event_key` + `enabled`**）；**新建集成 MUST 默认无任何 enabled 订阅**；管理 API **MUST** 支持逐条启用，且 **SHOULD** 在集成详情返回 **`webhookEndpoints`**；**`webhook_key` MUST** 为集成级单密钥（全事件共用）。
- **FR-070**: 入站请求 **MUST** 校验：集成存在且 enabled、事件已订阅、adapter 支持、验签通过；未订阅或未启用 **MUST** 返回 **`403`**、code **`WEBHOOK_EVENT_NOT_SUBSCRIBED`**。成功处理的入站业务事件 **MUST** 写入 `events` / `audit_logs`；失败 gate 的审计记录可作为后续安全审计增强。

**RBAC 权限（CMP.xlsx 对齐）**：
- **FR-043**: 系统 MUST 实现 RBAC 三表模型（permissions + roles + role_permissions），含 38+ 权限码覆盖 8 个功能模块
- **FR-044**: 系统 MUST 支持 7 种预置角色（platform_admin、reseller_admin、reseller_sales_director、reseller_sales、reseller_finance、customer_admin、customer_ops），按 scope (platform/reseller/customer) 层级隔离

**SIM 卡扩展（CMP.xlsx 对齐）**：
- **FR-045**: 系统 MUST 支持 SIM 卡形态分类（form_factor ENUM: consumer_removable / industrial_removable / consumer_embedded / industrial_embedded / automotive_grade_embedded / other）
- **FR-046**: 系统 MUST 支持多 IMSI（primary + 3 secondary），用于 eUICC / Multi-IMSI 场景
- **FR-047**: 系统 MUST 支持 IMEI 锁定（imei_lock_enabled），绑定首次上报设备，变更需管理员解锁并审计
- **FR-048**: 系统 MUST 维护 SIM 四方归属链（supplier_id + operator_id + **reseller 租户 `tenants.tenant_id`（RESELLER）** + **企业租户 `tenants.tenant_id`（ENTERPRISE）**），全链路可追溯；其中代理商 / 企业两环的外键定义 **MUST** 符合 **FR-061**

**企业 M2M 认证（CMP.xlsx 对齐）**：
- **FR-049**: 系统 MUST 支持企业 API Key 认证（api_key + api_secret_hash），与 JWT 认证并行，用于 M2M 集成场景
- **FR-050**: 系统 SHOULD 支持 SM-DP+ 系统基础配置建模（如名称、baseUrl、authType、credentials 等）；完整 host_fqdn / oid / environment 安全分发与远程编排不作为 V1.1 canonical Fastify 主路径验收项
- **FR-051**: 系统 SHOULD 支持 eSIM Profile 轻量独立建模与同步状态管理（ICCID、EID、SM-DP+ 引用、activationCode、remark、状态流转）；完整 matching_id + eid 安全校验、SM-DP+ 远程状态跟踪与下载编排不作为 V1.1 canonical Fastify 主路径验收项
- **FR-052**: 系统 MUST 在 Network Profiles 域提供 Carrier Service 与 Control Policy 的创建、更新、查询能力
- **FR-053**: 系统 MUST 在 Price Plans 域提供 Commercial Terms 的创建、更新、查询、发布（`DRAFT`→`PUBLISHED`）、废弃（`PUBLISHED`→`DEPRECATED`，且无 Package 引用）能力，生命周期与 Price Plan 对齐
- **FR-060**: 系统 MUST 使 **Package** 与 Price Plan、APN Profile、Roaming Profile、Carrier Service、Commercial Terms、Control Policy 遵循统一的行级生命周期语义：**新建 `DRAFT`**；**发布**仅针对 `DRAFT`；Package 发布时 `pricePlanId` 与 `carrierServiceId` **MUST** 均为 `PUBLISHED`，若绑定 `commercialTermsId` / `controlPolicyId`，也 **MUST** 为 `PUBLISHED`；**创建/编辑 `DRAFT` Package 时**，已提供的模块 ID **MUST** 均已 `PUBLISHED`；**废弃**仅针对 `PUBLISHED`，且 V1.1 Package 废弃 **MUST** 在无 `ACTIVE` / `PENDING` 订阅引用时成功；**`DEPRECATED`** 对象对外 **MUST** 只读（除平台明示的运维例外）

**3GPP 公共运营商目录（辅助）**：
- **FR-054**: 系统 MUST 在 `public.public_infos` 中维护 3GPP 公开运营商参考数据（至少含名称、国家、MCC、MNC、频段字段），**不得**将其作为计费、订阅或 SIM 状态机的决策输入；仅用于用户查阅与展示。
- **FR-055**: 系统 MUST 提供只读查询能力：支持按**名称**模糊匹配、按 **MCC 与 MNC** 精确匹配（联合精确）；结果返回名称、国家、MCC、MNC、频段等等价字段。
- **FR-056**: 系统 MUST 限制写权限：**仅 platform_admin** 可对 `public_infos` 执行插入与更新（删除仅用于数据纠错，同属管理员写权限）；**所有其他用户**仅允许读取。
- **FR-057**: 系统 MUST 保证 `public_infos` 与 **`business_operators`** 及业务 **`operator_id`** 体系**无任何关联**：不得定义外键/触发器/批处理同步；不得在依赖 `operator_id` 的 API 或服务中 JOIN、引用或校验 `public_infos`。若数据库中仍存在 `operators.carrier_id` → `public_infos` 的外键或应用层依赖，MUST 在 V1.1 迁移与代码中**移除**；且 **`operators.carrier_id` 列 MUST 物理删除（`DROP COLUMN`）**，不得以「仅删除外键、保留可空列」作为终态，使业务运营商数据与 3GPP 公开目录彻底解耦（验收见 `tasks.md` **T153**）。

**代理商身份与 API 契约（V1.1 / Phase 24）**：
- **FR-058**: 系统 MUST 在**对外 REST API、JWT/OIDC/密码登录签发的 reseller 作用域、企业 API Key 所解析的代理商维度**中，将 **`/v1/resellers/{tenantId}/…` 的路径参数 `tenantId`**、字段名 **`resellerId`**（及文档中等价的「当前/归属代理商」UUID）**唯一解释为** `tenants` 表中 **RESELLER** 类型行的 **`tenant_id`（reseller tenant_id）**：
  - **输入**：路径（`tenantId`）/查询/请求体/JWT claim 中上述含义的 UUID MUST 按 reseller tenant_id 校验与解析；不得默认接受 `resellers.id` 作为唯一合法值而不转换、不注明。
  - **判断**：与企业 `parent_id`、分配表、多租户过滤等**租户树或 FK→`tenants(tenant_id)`** 的比对 MUST 使用 reseller tenant_id。
  - **输出**：响应、事件、Webhook、审计中名为 `resellerId` 且表示代理商作用域的字段 MUST 为 reseller tenant_id；若需暴露 `resellers.id`，MUST 使用**不同字段名**（如 `resellerRecordId`）。
  - **文档**：OpenAPI MUST 对相关参数与属性注明本语义。本条与 **FR-040** 不冲突：`resellers` 独立表保留，仅统一对外标识符。**详细分款与例外**见 User Story 1「代理商对外身份约定」。
- **FR-061**: 系统 MUST 使所有表示**企业归属**的数据库外键列 **`REFERENCES public.tenants(tenant_id)`**，且被引用行 **`tenant_type = ENTERPRISE`**；所有表示**代理商租户归属**的数据库外键列 **`REFERENCES public.tenants(tenant_id)`**，且被引用行 **`tenant_type = RESELLER`**。**禁止**将 `customers(id)` 或 `resellers(id)` 作为上述语义在产品表中的 FK 目标终态（域表主键仅用于域内与非租户语义）。**范围**：不含供应商、运营商、SM-DP+、3GPP 目录等非租户实体上的 FK。本条与 **FR-040**、**FR-058** 一致；**详细分款**见 User Story 1「企业 / 代理商外键统一」。
- **FR-059**: 系统 MUST 在废弃 Price Plan 快照（`POST /v1/price-plans/{pricePlanId}:deprecate`）前同时满足：**(1)** 目标快照状态为 `PUBLISHED`；**(2)** 不存在任一 Package（产品包）引用该 `pricePlanId`。若存在引用，MUST 拒绝执行废弃（不得设置 `deprecatedAt`），且 MUST 在错误详情中列出全部引用方的 **`packageId`**，便于调用方与 Portal 展示「被哪些产品包占用」。

### Key Entities

- **Supplier（供应商）**: 独立表 `suppliers`，上游 CMP 对接对象，UUID ID，name UNIQUE，status (active/suspended)；**创建时不携带 `resellerId`**；经 **`POST /v1/resellers/{resellerId}/suppliers`** 绑定，且 **每个 `supplier_id` 至多一个 Reseller**（**FR-042a**）
- **Public Info（3GPP 公开参考）**: 物理表 `public.public_infos`（视图 `carriers` 兼容旧列名 `carrier_id`），E.212 MCC+MNC、国家、名称、LTE 频段等；**辅助只读目录**；与 `business_operators`、`operator_id` 业务链**零关联**（见 FR-054～FR-057）
- **Business Operator（业务运营商）**: 独立表 **`business_operators`**，业务运营商字典（**`operator_id` PK** + mcc/mnc + name），**全局唯一**；**与 `public_infos` 无表级或流程级关系**。同一字典运营商 **MAY** 经多个 **`suppliers`** 销售（见 **Operator**）。API 读路径 **`operatorId` SHOULD** 优先展示本表 ID。见 [operator-identity-model.md](clarifications/operator-identity-model.md)。
- **Operator（供应商—运营商关联）**: 独立表 **`operators`**，**非**字典本身；每行 = 某 **`supplier_id`** 下可售的某字典运营商（**`business_operator_id` FK**）。**行 PK `operators.operator_id`** 为 SIM、Package、**`upstream_integrations`** 等 **DB 外键真源**。**UNIQUE(`supplier_id`, `business_operator_id`)**（非空时）。
- **Upstream Integration（上游集成）**: 独立表 **`upstream_integrations`**，**业务唯一 `UNIQUE(reseller_id, supplier_id, operator_id)`**（ACTIVE/INACTIVE），`operator_id`→**`operators.operator_id`**，`reseller_id`→**RESELLER `tenants.tenant_id`**；含 API 端点/密钥/**`webhook_key`**/**`adapter_type`** 与 CDR/扩展配置预留；Platform Admin CRUD **MUST** 接受 **platform_admin JWT** 与 **`ADMIN_API_KEY`**。V1.1 **MUST** 为适配器、API endpoint 与 Webhook 凭证生产配置真源（**FR-042**、**FR-042a**、**FR-064**～**FR-066**）。见 [upstream-integration-config.md](clarifications/upstream-integration-config.md)。
- **SM-DP+ System**: 独立表 `smdp_systems`，V1.1 为 eSIM Profile 关联的轻量 SM-DP+ 基础配置（name、baseUrl、authType、credentials 等）；完整环境/状态管理与远程分发编排不作为当前验收项
- **Reseller（代理商）**: 独立表 `resellers`（内部主键 `id`），与 **`tenants` 中 tenant_type=RESELLER 的行 1:1 桥接**；**对外 API / JWT / 权限边界**中：嵌套路径形如 **`/v1/resellers/{tenantId}/…`** 的路径段、以及 JSON/JWT/查询中的 **`resellerId`**，MUST 指该租户行的 **`tenant_id`（reseller tenant_id）**，见 User Story 1「代理商对外身份约定」与 **FR-058**。**产品库表中**凡表示代理商租户归属的外键 **MUST** 指向该 **`tenant_id`**（**FR-061**）。status (active/deactivated/suspended)，含 contact_email/contact_phone
- **Customer（企业客户）**: 独立表 `customers`，核心租户对象，与 **`tenants` 中 `tenant_type=ENTERPRISE` 行 1:1 桥接**；**企业归属**在产品库表中的外键 **MUST** 指向该租户行的 **`tenant_id`**（**FR-061**），而非 `customers.id`。归属代理商以 **`reseller_tenant_id` FK→`tenants(tenant_id)`（RESELLER）** 为准（`reseller_id` 迁移完成后弃用）。status (ACTIVE/INACTIVE/SUSPENDED)，含 api_key/api_secret_hash/webhook_url 用于 M2M 认证
- **Department（部门）**: 企业下一级组织/分组维度，可用于用户或 SIM 归属、查询过滤与账单分组；企业仍是 V1.1 出账主主体
- **Permission（权限）**: 独立表 `permissions`，code UNIQUE，38+ 权限码覆盖 8 个模块
- **Role（角色）**: 独立表 `roles`，code UNIQUE，7 种预置角色，scope (platform/reseller/customer)
- **User（用户）**: 独立表 `users`，email 唯一；角色由 `user_roles.role_name` 记录，权限可由 `roles` / `role_permissions` / `permissions` 或 `roleScope` 默认权限解析
- **SIM Card（SIM 卡）**: 独立表 `sims`，ICCID UNIQUE，5 主状态 + `lifecycle_sub_status`，form_factor，multi-IMSI，IME Lock，归属链包含 supplier/operator/reseller/enterprise（reseller / enterprise 均为 `tenants.tenant_id`，见 **FR-048**、**FR-061**)
- **eSIM Profile**: 独立表 `esim_profiles`，V1.1 支持轻量 Profile 管理、备注与同步状态更新；完整 SM-DP+ 远程编排不作为当前验收项
- **Package（产品包）**: **单表单实体**，主键 **`packageId`**；计费规则与运营商能力的载体，以 ID 绑定 **PUBLISHED** 的 Price Plan、Carrier Service，并可选绑定 Commercial Terms、Control Policy；状态 `DRAFT` / `PUBLISHED` / `DEPRECATED`；对外 **无** `packageVersion` / 产品包 `version` 契约字段
- **Price Plan（资费计划）**: 定义计费类型与规则，4 种类型
- **Subscription（订阅）**: SIM 与产品包的实例化，包含生效时间/状态/首次订阅时间
- **Bill（账单）**: 按账期生成的费用汇总，三级结构，状态流转
- **Adjustment Note（调账单）**: Credit Note / Debit Note；**不可篡改已发布账单**的替代机制。状态 **DRAFT → APPROVED → APPLIED**，也可 **CANCELLED**；**APPROVED** 于下期出账合并进新账单 **`total_amount`**；同一原账 **MAY** 多条 Note；可选 **`idempotencyKey`** 防重复创建（见 [调账业务流程](#adjustment-business-flow)）
- **Job（异步任务）**: 异步操作与批量操作载体，含 jobId/type/status/progress/requestId/idempotencyKey/result/error，用于 SIM 生命周期、订阅 provisioning、批量导入、出账等流程追踪
- **Event（事件）**: 统一事件目录中的业务事件，含 eventId/eventCategory/eventType/tenant scope/payload/requestId/jobId；支持按 token scope、resellerId、enterpriseId、iccid 等查询与 CSV 导出
- **Audit Log（审计日志）**: 独立表 `audit_logs`，记录关键 API 与后台操作的 actor、action、target、requestId、before/after、tenant_id 等信息；查询接口支持 `actorEmail` 解析与租户范围校验，并支持 CSV 导出
- **Alert（告警）**: 独立表 `alerts`，记录系统检测到的异常与运营风险，含 alertType/severity/status/reseller/customer/sim/window/threshold/currentValue/metadata；V1.1 支持告警生成、查询、确认、统计、worker 评估，以及 `alert_type_catalog` / `alert_config_profiles` / `alert_config_items` 三表配置解析
- **Webhook Subscription / Delivery（出站 Webhook 订阅与投递）**: `webhook_subscriptions` 定义代理商或企业订阅的出站事件类型、URL、secret 与启用状态；`webhook_deliveries` 记录投递尝试、状态、响应与重试计划
- **Inbound Webhook Catalog / Subscription（入站 Webhook 目录与集成订阅）**: `upstream_inbound_webhook_events` 维护平台支持的入站供应商事件目录；`upstream_integration_webhook_subscriptions` 维护每条上游集成已启用的入站事件订阅，默认无 enabled 订阅

### 高频定时任务（Scheduler）
- 时区口径：V1.1 worker 使用系统时区执行 cron（可由 `SYSTEM_TIME_ZONE` / `TZ` 配置）；不支持按 reseller/customer 独立时区调度
- Job 轮询：`JOB_POLL_INTERVAL_MS` 默认 5 秒，处理 `jobs` 中的 `QUEUED` 任务，并可恢复 `SIM_STATUS_CHANGE` / `SUBSCRIPTION_PROVISION` 的 `RUNNING` pending 任务
- 上游用量同步（API）：`SYNC_USAGE_CRON` 默认 `0 * * * *`，按小时执行；当前写入/更新 `usage_daily_summary`，WXZHONGGENG 路径尝试调用 adapter，非正式供应商路径可保留 demo fallback
- 用量 Rating Rollup：`USAGE_RATING_ROLLUP_CRON` 建议默认 `10 * * * *`，在上游用量同步后周期性排队 `USAGE_RATING_ROLLUP` Job；该 Job 刷新当前账期或指定范围的 `rating_results`、`usage_daily_summary` 分类列与 `usage_package_daily_summary`，不生成账单
- 告警评估：`ALERT_EVAL_CRON` 默认 `*/15 * * * *`，调用 alerting worker 评估阈值、去重/抑制并写入 `alerts`；通知投递不作为独立 V1.1 scheduler 承诺
- 出站 Webhook 投递重试：`WEBHOOK_DELIVERY_CRON` 默认 `*/1 * * * *`，排队并处理 `WEBHOOK_DELIVERY` Job
- 订阅排程取消：`SUBSCRIPTION_CANCEL_CRON` 默认 `*/5 * * * *`，执行到期的 `subscription_cancel_schedules`
- Dunning 检查、自动出账排队、供应商对账排程为低频 cron 任务，见下方日级/月级任务说明
- Control Policy 自动限速/达量断网、SFTP 话单下载、按供应商频率全量 SIM 状态同步不作为 V1.1 当前主路径验收项

### 日级任务（Daily Scheduler）
- Dunning 检查：`DUNNING_CHECK_CRON` 默认 `30 2 * * *`，计算并维护 `dunning_records`，可将到期 `PUBLISHED` 账单转为 `OVERDUE`；V1.1 不自动发送催收通知、不自动变更企业状态或停机
- 测试期到期检查：`TEST_EXPIRY_CHECK_CRON` 默认 `0 3 * * *`，worker 可检查 `TEST_READY` SIM 的测试期并记录状态变化、事件与审计；该能力属于 worker 自动任务，不改变 Fastify API 对测试期规则的主契约
- 自动出账排队检查：`AUTO_BILLING_CRON` 默认 `15 3 * * *`，按 `billing_config.auto_generate` / `bill_day` 为上一账期排队 `BILLING_GENERATE` Job，并通过 idempotencyKey 防止重复排队
- 供应商对账排程：`RECONCILIATION_CRON` 默认 `45 4 * * *`，按 active suppliers 排队 `RECONCILIATION_RUN` Job；实际 SIM 状态差异处理以 reconciliation service / inbound webhook / lifecycle job 为准
- 日级原始用量数据不是单独“每日凌晨汇总”任务，而由上游用量同步任务持续 upsert `usage_daily_summary`；产品包维度用量视图由 `USAGE_RATING_ROLLUP` 在 Rating 后派生刷新
- 每日恢复限速、每日承诺期到期标记不作为 V1.1 当前主路径验收项；拆机承诺期在 `RETIRE` 操作时通过 `commitment_end_at` / `commitmentExempt` 校验

### 月级任务（Monthly Scheduler）
- 计费出账不固定为“每月 1 日直接生成”；V1.1 由每日 `AUTO_BILLING_CRON` 检查企业 `billing_config.bill_day`，满足条件后为上一账期排队 `BILLING_GENERATE` Job
- 月租费、用量费、调账单合并与账单状态流转由 `BILLING_GENERATE` Job / billing service 执行；是否自动发布由 `billing_config.auto_publish` 控制
- 主套餐变更不由月级批处理直接“月末取消、月初订阅”；V1.1 当前通过订阅 API 创建未来 `PENDING` 订阅、排队 `SUBSCRIPTION_PROVISION`，并由 worker 在有效期到达后推进
- 月级用量汇总、月度恢复限速、月度恢复断网不作为 V1.1 当前主路径验收项；Control Policy 执行闭环为后续能力

## 非功能需求（NFR）与技术架构

### 技术栈约束
- 主要开发语言：TypeScript (Node.js)
- 运行时：Node.js（LTS 版本）；canonical HTTP runtime 为 Fastify，`npm run build` 后运行 `dist/server.js`
- 主数据库：Supabase（托管 PostgreSQL + Auth / REST）；应用通过 Supabase REST 与 service role 执行业务读写
- 异步运行时：`src/worker.js` 使用 node-cron + `jobs` 表轮询处理异步任务；构建产物需与 TS 源码保持同步
- 部署形态：Vercel / Serverless / 容器 / VM 均可作为部署选项；V1.1 规格不将 Vercel Serverless 作为唯一运行时假设
- 币种策略：按代理商固定币种（企业继承）

### 可扩展性与性能
- 架构形态：API-first modular monolith，按 `routes` / `services` / `vendors` / `middleware` 分层；资源域、计费域、客户域、集成域通过模块边界隔离
- SIM 状态轨迹表（`sim_state_history`）：记录生命周期状态变化与可追溯历史
- 用量预聚合表（`usage_daily_summary`）：V1.1 计费与查询主输入之一，按 ICCID + 日期 + visitedMccMnc 聚合
- 异步任务：`jobs` 表 + worker 轮询/cron 是 V1.1 主路径；独立消息队列、Supabase Edge Functions、pg_cron 可作为后续部署/扩展选项
- 数据分区、冷归档、独立缓存层不作为 V1.1 当前主路径验收项；后续可按数据量引入 PostgreSQL 分区、归档表或外部缓存

### 高并发与 I/O 模型
- HTTP I/O：Fastify 提供 API 路由、认证、RBAC、限流、OpenAPI/Swagger UI 与 metrics 暴露
- 数据 I/O：业务读写通过 Supabase REST/PostgreSQL 表完成；长耗时或可重试流程通过 `jobs` 表异步化
- 任务 I/O：worker 通过 node-cron 调度低频任务，并按 `JOB_POLL_INTERVAL_MS` 轮询 `jobs`；部分任务用 `idempotencyKey` 防重复排队
- 事件驱动：V1.1 以 `events` 表、出站 Webhook delivery 与入站 Webhook handler 作为事件集成主路径；Kafka/RabbitMQ、Supabase Realtime、Database Webhooks 为后续扩展选项

### 高可用与容灾
- 数据层依赖 Supabase 托管 PostgreSQL 的备份与高可用能力；应用层部署方式由具体环境决定
- Supabase REST 客户端支持超时、重试与熔断配置（如 `SUPABASE_TIMEOUT_MS`、`SUPABASE_RETRY_MAX`、`SUPABASE_CB_FAILURE_THRESHOLD`、`SUPABASE_CB_COOLDOWN_MS`）
- 上游供应商调用通过 adapter/registry 隔离能力差异；失败时通过 Job 状态、重试、告警、事件与审计保留可追溯性
- RPO/RTO、跨区容灾与多实例 worker 协调属于运维目标；未作为 V1.1 功能验收指标
- 降级原则：优先保证查询、审计、事件、账单可追溯；上游同步、Webhook 投递、告警评估、计费出账可异步重试

### 安全与合规
- TLS 1.2+ 全链路
- API Key + Bearer JWT / OIDC JWKS 校验、RBAC middleware 与租户范围校验共同构成 API 权限边界
- 上游集成密钥等敏感字段使用 AES-256-GCM 加密存储，master key 来自 `INTEGRATION_SECRET_KEY`
- 关键业务操作写入 `audit_logs`，并通过 `requestId`、actor、before/after、tenant_id 等字段支持追溯；WORM 存储不作为 V1.1 当前实现承诺
- GDPR/数据最小化以匿名化与保留策略为目标；V1.1 提供服务与文档基础，不声明完整合规认证
- PCI-DSS / 支付网关 Tokenization 不属于 V1.1 当前后端主路径

### 数据保留
- 话单/用量、审计日志、账单、事件、SIM 状态历史均应按业务合规策略保留；V1.1 当前以数据库表持久化与可追溯为主
- 账单、调账单、rating results、事件与审计日志属于财务/运营追溯链路，不应被普通业务删除直接破坏
- GDPR/被遗忘权处理应对用户/企业 PII 做匿名化或最小化保留，同时保留计费、审计和合规所需的业务关联键
- “在线 6 个月、归档 5 年、审计 2 年、账单 10 年”等为建议保留策略目标；自动归档、冷存储与分区清理不作为 V1.1 当前主路径验收项

### 量化目标
- 连接规模、日均话单量、TPS、SLA、P95 延迟等为容量规划与压测目标，不作为 V1.1 功能验收已达成声明
- V1.1 验收重点为 API 合约、租户隔离、计费正确性、事件/审计可追溯、worker 异步流程与 OpenAPI/Swagger UI 可测性
- `GET /metrics` 输出 HTTP 请求数、错误数、429、认证失败、延迟分位与按路由聚合指标，用于后续压测与容量评估

### 非目标（本期不做）
- 物理卡片物流管理
- 核心网元功能（HLR/HSS/PGW）
- 实时流控（硬实时）
- C 端用户计费

## MVP 范围

V1.1 当前验收范围：以 REST API、OpenAPI/Swagger UI、Fastify TS 服务与 worker 为主，交付可测试的后端闭环。

- 交付形态：RESTful API（OpenAPI 3.0）+ Swagger UI + worker 异步任务；前端 Portal / 内部管理后台不作为 V1.1 后端验收前提
- 租户与用户：代理商/企业/用户/RBAC/审计/租户范围校验；对外 `resellerId` 统一为 reseller tenant_id
- SIM：批量导入、查询、备注、生命周期 Job、`lifecycle_sub_status`、承诺期拆机校验、事件/审计追踪
- 产品与订阅：Price Plan、Network Profile、Package、Subscription、批量订阅创建/导出、未来生效 provisioning、上游产品映射
- 用量与计费：`usage_daily_summary`、高水位月租、Waterfall 用量匹配、OOP roaming、rating results、账单生成、发布、支付、write-off、void
- 调账与催收：Credit/Debit Adjustment Note 手工创建/审批/应用；Dunning 记录与 overdue 计算，不自动催收通知、不自动停机
- 事件、审计、告警、Webhook：Events/Audit Logs 查询与 CSV 导出，Alerts 查询/确认/统计/worker 评估，出站 Webhook 投递与重试，入站供应商 Webhook gate/catalog/subscription
- 南向集成：SPI + Adapter Registry，V1.1 首个真实 adapter 为 `wxzhonggeng`；支持 upstream integrations、vendor mappings、订阅 provisioning、SIM diagnostics/reconciliation、入站 webhook

## 计费黄金用例集（Golden Test Cases）

**统一约定**：
- 计费周期：自然月（CALENDAR_MONTH）
- 流量单位：MB 向上取整
- 用量维度：`iccid + visitedMccMnc + eventTime`
- 用量命中：叠加包优先 -> 范围最小优先 -> 主套餐兜底 -> Out-of-Profile
- Out-of-Profile：不扣减任何套餐配额；优先按套餐 `carrier_service_config.roamingProfileId` 对应漫游画像的 `mccmnc_list.ratePerMb`（OOP_ROAMING）计费；价目不再承载分区 PAYG，无可用单价时记录 `UNCLASSIFIED`
- 月租费：高水位口径
- 迟到话单：`lateCdr` 服务路径可生成 `DRAFT` 调账单；不作为全局自动触发动作，调账单仍需审批后进入后续账单
- 自动化范围：`fixtures/golden_cases.json` 当前覆盖 U-01～U-08 rating 子集；下方 M/C/A/O 用例为业务验收口径，未全部等同于自动化 fixture

### 基础用例（用量匹配与扣减）

| Case | 前置订阅 | visitedMccMnc | 用量 | 期望命中 | 期望扣减/计费 | 期望告警 |
|---|---|---|---:|---|---|---|
| U-01 | 主：Global 1GB（覆盖全球） | 234-15 | 100MB | 主套餐 | 扣减主套餐配额 100MB | 无 |
| U-02 | 主：Europe 1GB；叠加：France 500MB | 208-01 | 100MB | 叠加（France） | 扣减 France 配额 100MB | 无 |
| U-03 | 主：Europe 1GB；叠加：France 500MB | 262-02 | 100MB | 主套餐（Europe） | France 不覆盖，扣减 Europe 配额 100MB | 无 |
| U-04 | 主：Europe 1GB；叠加：France 500MB；叠加：EU+UK 800MB | 208-01 | 100MB | 叠加（France） | 多叠加覆盖时范围更小优先 | 无 |
| U-05 | 主：Europe 1GB（不含 424-02）；套餐挂载漫游画像含 424-02 @ 20.48 USD/MB | 424-02 | 10MB | Out-of-Profile | 不扣减套餐；OOP_ROAMING（漫游画像单价） | 异常漫游 |
| U-06 | 主：Europe 1GB；OOP roaming 未覆盖 999-99 | 999-99 | 10MB | Out-of-Profile | 不扣减；`UNCLASSIFIED`，amount=0，保留 visitedMccMnc/inputRef/calculationId 供运营修复 | 异常漫游+规则缺失 |
| U-07 | 主：Global 1GB（配额已耗尽）；overageRate=10.24/MB | 234-15 | 10MB | 主套餐 | 按套外单价计费 | 可选 |
| U-08 | 主：Europe 1GB（第二路 SIM）；OOP 资费与 U-05 相同 | 424-02 | 10MB | Out-of-Profile | 不扣减套餐；OOP_ROAMING | 异常漫游 |

> **说明**：`fixtures/golden_cases.json` 中 **U-08**（第二路 SIM、424-02）与上表 **U-05** 同为 OOP 漫游路径；下方 **U-09/U-11** 为本地状态异常 / 无订阅但有用量业务验收用例，当前未纳入 `fixtures/golden_cases.json` 自动化子集。

### 本地状态异常 / 无订阅用量（异常/漏控）

| Case | SIM 状态 | 用量来源 | 期望处理 | 期望告警 |
|---|---|---|---|---|
| U-09 | TEST_READY / INVENTORY / DEACTIVATED，且当日有有效订阅 | CDR/API 汇总 | 按有效订阅 Package 正常 Rating；metadata 标记 `LOCAL_STATUS_NOT_ACTIVE` / `localSimStatus` | 运营异常提示，必要时叠加 `UNEXPECTED_ROAMING` |
| U-10 | TEST_READY / INVENTORY / DEACTIVATED，且无有效订阅 | CDR/API 汇总 | 使用 `enterpriseId + resellerId + supplierId + operatorId` 的 Default Fallback Package 走 OOP Rating；metadata 标记 `fallbackPackage=true`、`fallbackReason=NO_ACTIVE_SUBSCRIPTION` | 无订阅用量 / 漏开通告警 |
| U-11 | RETIRED | CDR/API 汇总 | 若有有效订阅或 fallback package 可解析费率，则生成可追溯 Rating；否则记录 `UNCLASSIFIED` 与 metadata，供账单/运营审核 | 高优先级异常用量告警 |

### 月租费黄金用例（高水位）

| Case | 账期内状态轨迹 | 期望月租项 |
|---|---|---|
| M-01 | 02-10 ACTIVATED → 02-20 DEACTIVATED | 全额月租费 |
| M-02 | 全月 DEACTIVATED | 停机保号费 |
| M-03 | 全月 INVENTORY 或 TEST_READY | 无月租项 |
| M-04 | 02-01 00:00:01 ACTIVATED → 02-01 00:00:02 DEACTIVATED | 全额月租费（1 秒也收） |

### 信控联动用例

| Case | 企业状态 | SIM 状态轨迹 | 期望计费 |
|---|---|---|---|
| C-01 | SUSPENDED | 当月曾 ACTIVATED 后被批量停机 | 全额月租 |
| C-02 | SUSPENDED | 全月 DEACTIVATED | 停机保号费 |
| C-03 | SUSPENDED | 漏停机 SIM 持续 ACTIVATED | 全额月租+用量照常 |

### 迟到话单与调账用例

| Case | 话单落账期 | 账单状态 | 期望动作 |
|---|---|---|---|
| A-01 | 2026-02（已出账） | PUBLISHED | `lateCdr` 服务路径可生成 Adjustment Note 草稿；或运营/财务手工创建，审批后下期结算 |
| A-02 | 2026-02（未出账） | GENERATED | 进入当期归集计费 |

### Job/审计/可追溯用例

| Case | 操作 | 期望产物 |
|---|---|---|
| O-01 | `POST /v1/sims/{iccid}:deactivate` 触发停机 | jobId + 审计日志(requestId/before/after) + `SIM_STATUS_CHANGED` / `JOB_FINISHED` 事件 |
| O-02 | 计费重算 | 关联 inputRef + matched package/price plan + calculationId + classification/metadata |

## 决策记录（Decision Log）

- [x] 租户层级：代理商 -> 企业 -> 部门/项目；供应商/运营商/上游集成为平台主数据
- [x] 白标能力：V1.1 支持基础 branding 配置（Logo、主色、自定义域名等字段）；完整白标 Portal 运行时不作为后端验收前提
- [x] 计费主体：企业为出账主主体；部门/项目作为组织、查询过滤与账单分组维度
- [x] 计费模式：支持 one-time, SIM Dependent Bundle, Fixed Bundle, Tiered Pricing
- [x] 资费分层：V1.1 以企业零售 Price Plan / Package 为计费真源；不实现供应商批发价结算
- [x] 阶梯计费口径：分段累进（Progressive），非全量按档
- [x] 共享池口径：按产品包计费规则定义
- [x] 异步任务：支持 jobId + 查询进度；出站 Webhook delivery/retry 是 V1.1 事件投递能力
- [x] SIM 资产标识：ICCID 唯一索引；IMEI Lock 默认关闭
- [x] SIM 状态机：5 稳态 + 全方向 lifecycle_sub_status + SIM_STATUS_CHANGE Job / JOB_FINISHED（[V1.1] 见 US2）
- [x] SIM 状态同步：通过 SIM lifecycle Job、入站供应商 webhook、diagnostics 与 reconciliation 共同保持可追溯；不承诺固定频率全量同步
- [x] 测试期配置：保留 PERIOD_ONLY / QUOTA_ONLY / PERIOD_OR_QUOTA；worker 可执行测试期检查任务，但不作为 Fastify API 主契约
- [x] 订阅计数口径：订阅生效时间决定计数；月内变更次月生效
- [x] 用量归集与时区：V1.1 计费主输入为 `usage_daily_summary`，按 usage_day / 账期归属；完整 CDR 时区换算与跨月切分为后续数据管道能力
- [x] 话单交付：V1.1 以 API/worker 同步与本地汇总表为主；SFTP/S3 CDR 文件管道作为后续扩展
- [x] 数据保留：账单、调账、rating results、事件、审计与 SIM 状态历史需保留可追溯链路；归档年限属于策略目标，不作为当前自动归档实现承诺
- [x] 北向：REST API + 出站 Webhook；认证为 API Key + Bearer JWT，可配置 OIDC JWKS 校验，不承诺完整 OAuth2 授权服务器流程
- [x] 南向：SPI + Adapter Registry；异步指令通过本地 Job 层幂等，不承诺所有上游供应商原生接收相同 `idempotencyKey`
- [x] 容量规划：日均事件、TPS、连接规模为压测与商用规划目标，不作为 V1.1 已验证能力声明
- [x] SLA：可用性与 P95 延迟为运维/压测目标；V1.1 验收以 API 合约、租户隔离、计费正确性、可追溯与 worker 流程为主
- [x] 批量处理：单次 10 万级
- [x] V1.1 交付形态：API-first；以 Fastify TS 服务、OpenAPI/Swagger UI、worker 与脚本化测试为主要交付和验证入口
- [x] D-23 计费时区：GMT+0。月初 = 每月 1 日 00:00:00 GMT+0，月末 = 月末最后一天 23:59:59 GMT+0
- [x] D-24 高水位采样粒度：按状态变更事件（sim_state_history）。当月出现过 ACTIVATED 状态（哪怕 1 秒）即按全额月租费计
- [x] D-25 Fixed Bundle 共享池超额：totalQuotaMb 为共享池，超额后按 Price Plan `overageRatePerMb` 计费；套餐覆盖外用量走 Package -> Carrier Service -> Roaming Profile 的 OOP roaming rate，未知规则记录 `UNCLASSIFIED`
- [x] D-26 零用量出账：月租费按 SIM 高水位状态决定（活跃→全额月租费、停机→停机保号费、不满足条件→不收）；流量费 = 0
- [x] D-27 跨月用量归属：V1.1 按 `usage_daily_summary.usage_day` 与账期归属；原始 CDR 跨月会话切分与重放为后续采集管道能力
- [x] D-28 V1.1 范围收敛：以当前已实现 API、worker、计费、事件/审计、Webhook、上游集成与告警基础能力为准；未实现能力不放入 V1.1 验收范围
- [x] D-29 V1.1 不做前端 Portal：后端验证以 Swagger UI、OpenAPI、脚本化测试与 API 调用为主
- [x] D-30 ENUM 命名规范：所有 ENUM 值统一使用大写（与 sim_status 一致）；reseller_status = ACTIVE/DEACTIVATED/SUSPENDED
- [x] D-31 产品配置域七类资源（Price Plan / APN & Roaming Profile / Carrier Service / Commercial Terms / Control Policy / Package）：**仅用 ID + `DRAFT`/`PUBLISHED`/`DEPRECATED` 管理**；Package **单实体**、对外无 `packageVersion`；Package **废弃**受 `ACTIVE` / `PENDING` 订阅引用约束；**创建/发布 Package** 时 `pricePlanId`、`carrierServiceId` 及已绑定的可选模块必须 `PUBLISHED`

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: V1.1 后端可通过 `npm run build` 生成 Fastify TS runtime，并以 `dist/server.js` + worker 完成 API / Swagger UI / 异步任务演示闭环
- **SC-002**: OpenAPI / Swagger UI 覆盖 V1.1 主接口；关键查询接口的筛选、分页、CSV 导出与错误码可通过 Swagger UI 或脚本化测试验证
- **SC-003**: 多租户数据隔离在 Events、Audit Logs、SIM、Subscription、Billing 等关键 API 中可验证；reseller/customer token 越权访问返回明确错误或空结果
- **SC-004**: 计费引擎通过当前自动化 golden rating 子集（`fixtures/golden_cases.json` U-01～U-08），并按业务验收用例覆盖高水位月租、OOP roaming、`UNCLASSIFIED`、非活跃用量与调账边界
- **SC-005**: 出账流程由 `BILLING_GENERATE` Job 驱动，生成 bills、bill_line_items、rating_results，并保留 inputRef、classification、matched package/price plan、calculationId 等可追溯字段
- **SC-006**: 已发布/逾期账单不可直接篡改；Credit/Debit Adjustment Note 支持 DRAFT / APPROVED / APPLIED / CANCELLED 流程，并在后续出账中合并
- **SC-007**: SIM 生命周期操作通过 Job、`lifecycle_sub_status`、事件与审计记录可追踪；进行中状态拒绝并发生命周期操作，拆机承诺期校验可验证
- **SC-008**: 异步任务（Job）可查询状态、进度、requestId、结果或错误；SIM 状态变更、订阅 provisioning、批量订阅、出账、Webhook delivery 等流程使用 Job 或 worker 可追踪
- **SC-009**: 关键操作（Provisioning、Billing、权限/租户、SIM 生命周期、入站 Webhook 等）写入审计或事件记录，并可通过 Events / Audit Logs 查询与 CSV 导出追溯
- **SC-010**: Alerts 支持 worker 评估、去重/抑制、查询、确认与统计；告警通知渠道成功率不作为 V1.1 当前验收指标
- **SC-011**: 出站 Webhook 支持订阅、投递记录、失败重试与 `WEBHOOK_DELIVERY_FAILED` 告警；入站供应商 Webhook 支持 catalog、subscription gate、验签、去重与事件/审计记录
- **SC-012**: 上游集成通过 SPI / Adapter Registry、`upstream_integrations`、vendor mappings 支撑 `wxzhonggeng` 订阅 provisioning、SIM diagnostics/reconciliation 与入站 webhook；多供应商完整适配作为扩展目标
- **SC-013**: Dunning worker 可识别逾期账单、维护 `dunning_records`、将到期 `PUBLISHED` 账单转为 `OVERDUE`，并支持无逾期时解除记录；不自动催收通知、不自动变更企业或 SIM 状态
- **SC-014**: `/metrics` 暴露请求数、错误数、429、认证失败、延迟分位和按路由聚合指标；10 万 SIM、TPS、P95、99.9% SLA 等作为容量规划/压测目标，不作为 V1.1 功能验收已达成声明
