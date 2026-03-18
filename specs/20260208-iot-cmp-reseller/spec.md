# Feature Specification: IoT CMP Reseller System

**Feature**: `iot-cmp-reseller`
**Created**: 2026-02-08
**Status**: Draft
**Input**: User description: "根据现有的需求文档重建SPEC /Users/yangzong.exe/Downloads/04_Project_CMP1/CMP_Requirements_Workshop.md"

## User Scenarios & Testing *(mandatory)*

<!--
  CRITICAL - Completeness Guarantee: spec.md MUST be a superset of user input (spec.md >= user input).
  Every line of information from user input must be traceable in spec.md.
  Source: CMP_Requirements_Workshop.md (1523 lines)
-->

### User Story 1 - 多租户与角色权限管理 (Priority: P1)

系统必须实现"供应商 -> 代理商 -> 企业"三级租户层级，企业下支持部门/项目组织结构。支持 RBAC 权限模型，包含以下角色：

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
- 采用**独立表**建模策略，废弃通用 tenants 表
- `resellers` 表：id（系统生成，唯一）、name（非空且全局唯一）、status（ACTIVE/DEACTIVATED/SUSPENDED，默认 ACTIVE）、contact_email、contact_phone、created_by、created_at、updated_at。created_by 保留审计引用（用户被删除不影响记录）。
- `customers` 表：id、reseller_id (FK)、name、status (active/overdue/terminated)、api_key (UNIQUE)、api_secret_hash (BYTEA)、webhook_url、created_by、created_at、updated_at。UNIQUE(reseller_id, name)。terminated 为终态。
- `suppliers` 表：id（系统生成，唯一）、name（非空且全局唯一）、status（ACTIVE/SUSPENDED，默认 ACTIVE）、created_by、created_at、updated_at。created_by 保留审计引用（用户被删除不影响记录）。
- `public_infos` 表：公共信息目录（E.212 MCC+MNC + 国家/频段），用于公共参考与兜底，不参与业务逻辑。
- `business_operators` 表：业务运营商字典（operator_id、mcc、mnc、name），业务侧查询与过滤使用，不与公共目录强绑定。
- `operators` 表：供应商-运营商关联（supplier_id + operator_id 唯一），承载供应商可用运营商范围，业务逻辑使用 operator_id。

**RBAC 三表模型**（CMP.xlsx 对齐）：
- `permissions` 表：id、code (UNIQUE)、name、description、category。38+ 权限码覆盖 8 个模块（商业实体、用户管理、SIM 库存、SIM 生命周期、产品包、订阅、使用量、监控告警）。
- `roles` 表：id、code (UNIQUE)、name、description、scope (platform/reseller/customer)。7 种预置角色。
- `role_permissions` 表：role_id + permission_id 复合主键。
- `users` 表：id、email、name、password_hash、role_id (FK)、reseller_id (nullable FK)、customer_id (nullable FK)、status

**上游集成**（CMP.xlsx 对齐）：
- `upstream_integrations` 表：id、supplier_id (FK)、operator_id (FK)、api_endpoint、api_key、api_secret_encrypted (BYTEA)、cdr_enabled、cdr_method (sftp/api)、cdr_endpoint、cdr_username、cdr_password_encrypted、cdr_path、cdr_file_pattern、enabled、created_by、created_at、updated_at。UNIQUE(supplier_id, operator_id)。

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
- **SUSPENDED**：被冻结（如安全事故），代理商用户登录提示“账户已停用”并拒绝登录，停止该代理商所有任务（包含但不限于同步上游 SIM、计费任务）
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
- 供应商：UUID ID、名称、关联运营商（多对多）、禁止创建未关联运营商的供应商、加密存储、变更留痕
- 业务运营商：`business_operators`（E.212 MCC+MNC + name），业务侧主数据，不依赖公共目录
- 公共信息目录（public infos）：`public_infos`，系统管理员维护，字段包含国家（英文）、运营商名称（英文）、MCC、MNC、4G/LTE 频段；用于 SIM 归属兜底与能力校验
- 查询能力：支持按国家精确查询、按 MCC 查询、按 MCC+MNC 组合查询、按运营商名称模糊匹配查询

**供应商商业模式与业务规则**：
- 商业模式 a：当供应商即运营商 CMP 时，体系仍显式创建供应商（该运营商）与运营商实体，关系保持一致（UNIQUE(mcc, mnc) 与多对多）
- 商业模式 b：供应商为独立实体，供应商侧对接一个或多个运营商 CMP；Reseller 直接对接供应商 CMP
- 创建：名称唯一，状态缺省 ACTIVE
- 更新：可改名称与状态（ACTIVE/SUSPENDED）
- 查询：系统管理员可查询全部供应商
- 状态管理：
  - **ACTIVE**：允许业务开通与上游交互
  - **SUSPENDED**：禁止导入该供应商提供的 SIM、禁止向其关联的上游系统发送任何 API 请求、且不再接受其推送的 Webhook 通知（忽略处理）；状态变更实时生效并记录审计

**操作审计**：组织与权限、SIM 生命周期、资费与订阅、数据操作等必须记录审计日志。审计日志最小字段：actor、actorRole、tenantScope、action、target、before/after、requestId、timestamp、sourceIp。

**Why this priority**: 租户与权限是整个系统的基础，所有其他功能模块都依赖于租户隔离和权限控制。没有正确的多租户支持，系统无法为多个代理商和企业提供安全隔离的服务。

**Technical Implementation**:

- 租户层级：供应商 -> 代理商 -> 企业 -> 部门/项目
- 兼容两种模式：
  - 模式 a：运营商 CMP(供应商) -> Reseller -> 企业
  - 模式 b：运营商 CMP -> 供应商 CMP -> Reseller -> 企业
- 统一模式：供应商 -> Reseller -> 企业

```text
                  （模式 a）
   运营商CMP(供应商) ─────────► Reseller System ─────────► 企业 Portal/API

                  （模式 b）
   运营商CMP(底层) ─► 供应商CMP(对接对象) ─► Reseller System ─► 企业 Portal/API

                  （统一模式）
        供应商CMP(对接对象) ───────────────► Reseller System ─────────► 企业 Portal/API
        └─ 可聚合多个运营商网络（MCC/MNC），用于SIM归属、话单来源与稽核对账
```

- 关系模型：
  - 供应商 -> SIM Profile 批次：一对多
  - 供应商 <-> 运营商：多对多
  - SIM Profile 批次 -> 产品包：一对多
  - 产品包 -> 资费计划：一对一
  - 代理商 -> 企业：一对多
  - 代理商 -> 上游供应商/运营商：一对多（通过 upstream_integrations 关联）
  - 企业 -> 产品包：一对多
  - SIM -> 产品包：1 个主数据产品包 + N 个叠加包
  - eSIM Profile -> 产品包：1 个主数据产品包 + N 个叠加包
- SM-DP+ 系统 -> eSIM Profile：一对多（逻辑关系）

- API 接口：
  - `POST /v1/resellers` 创建代理商
  - `POST /v1/resellers/{resellerId}/users` 创建用户
  - `POST /v1/enterprises` 创建企业
  - `POST /v1/enterprises/{enterpriseId}/departments` 创建部门

**Independent Test**: 可通过创建代理商、企业、用户并验证权限隔离来独立测试，验证不同角色只能访问授权范围内的数据。

**Acceptance Scenarios**:

1. **Given** 系统管理员已登录, **When** 创建代理商并初始化管理员账号, **Then** 代理商管理员可登录并创建企业
2. **Given** 代理商管理员已创建企业, **When** 销售角色尝试访问未分配的企业数据, **Then** 系统返回权限拒绝
3. **Given** 企业状态为 ACTIVE, **When** 代理商管理员将其设置为 SUSPENDED, **Then** 企业侧管理操作被禁止并触发 `ENTERPRISE_STATUS_CHANGED` 事件
4. **Given** 供应商需要创建, **When** 未关联任何运营商（MCC+MNC）, **Then** 系统拒绝创建并返回错误

---

### User Story 2 - SIM 卡与 eSIM Profile 资产入库与生命周期管理 (Priority: P1)

系统分别管理物理 SIM 卡与 eSIM Profile 的完整生命周期，唯一索引采用 ICCID。

**SIM 卡数据模型（物理 SIM）**（CMP.xlsx 对齐）：
- 表名：`sim_cards`（原 sims 重命名）
- SIM 号码：ICCID (UNIQUE)、imsi_primary、imsi_secondary_1、imsi_secondary_2、imsi_secondary_3、MSISDN
- SIM 卡形态：`form_factor` ENUM（consumer_removable / industrial_removable / consumer_embedded / industrial_embedded / automotive_grade_embedded / other）
- 四方归属链：supplier_id (FK)、operator_id (FK)、reseller_id (FK)、customer_id (FK nullable)
- SIM 状态：INVENTORY / TEST_READY / ACTIVATED / DEACTIVATED / RETIRED
- SIM 子状态：`lifecycle_sub_status`（normal / activating / activation_failed），用于标识激活过程中的中间态与失败态
- 上游状态：`upstream_status`（供应商原始状态），`upstream_status_updated_at`
- 产品包订阅：primary_product_package_id (FK nullable)
- 数据统计：total_data_usage_kb (BIGINT DEFAULT 0)
- 设备绑定：imei (VARCHAR(15) nullable)、imei_lock_enabled (BOOLEAN DEFAULT false)
- 审计字段：imported_by、imported_at、activated_at、deactivated_at、retired_at、updated_at

**eSIM Profile 数据模型**：
- 表名：`esim_profiles`
- SIM Profile 信息：
  - ICCID（UNIQUE，必填）
  - IMSI：imsi_primary、imsi_secondary_1/2/3（可选）
  - MSISDN（可选）
  - eSIM 形态：`esim_form_factor`（esim_profile / other）
  - matching_id（明文存储，例如 MCH-1234567890ABCDEF）
  - activation_code（例如 LPA:1$SMDP.EXAMPLE.COM$04386-AGYFT-A74Y8-3F815）
  - smdp_profile_status（created / downloaded / enabled / disabled / deleted）
  - profile_order_id（关联内部 eSIM 订单系统）
- 设备信息：eid（设备 eID，必填）、imei（可选）、imei_lock_enabled（默认 false）
- 归属信息：supplier_id、operator_id、smdp_system_id、reseller_id、customer_id（分配后填充）
- eSIM 状态与订阅：
  - status：INVENTORY / TEST_READY / ACTIVATED / DEACTIVATED / RETIRED
  - primary_product_package_id（主计费产品包）
  - total_data_usage_kb（按 KB 向上取整展示；汇总口径以上游 CMP 话单/用量为准）
- 规则：eid 与 matching_id 必须成对出现，缺失任一字段则不允许下发 Profile 下载

**生命周期状态机**（5 状态）：

- **INVENTORY**（库存，初始状态）：导入系统默认进入；允许分配/销售给企业
- **TEST_READY**（测试期）：由产品包 Commercial Terms 定义测试期与配额；到期条件（PERIOD_ONLY/QUOTA_ONLY/PERIOD_OR_QUOTA 默认）
  - 迁移：INVENTORY -> TEST_READY（销售/分配）、TEST_READY -> ACTIVATED（到期自动或手工提前激活）、TEST_READY -> DEACTIVATED（手工停机）
  - 子状态：
    - normal：可用且未发起激活
    - activating：已发起激活，等待上游回执
    - activation_failed：上游拒绝/失败/超时
- **ACTIVATED**（活跃）：可正常使用产品包服务；按 Control Policy 自动状态变更（如达量断网）
  - 禁止 ACTIVATED -> RETIRED（必须先停机）
- **DEACTIVATED**（停机）：暂停服务，保留配置与历史
  - 拆机限制：仅代理商可执行，需二次确认，满足承诺期门槛 max(首次订阅时间_i + 承诺期_i)
  - 豁免拆机：代理商管理员或系统管理员可执行，需二次确认，跳过承诺期校验，必须记录原因
- **RETIRED**（拆机/退网，终态）：永久退出，禁止回退，保留审计数据

**数据保留与合规（RETIRED）**：
- 审计数据保留 2 年
- RETIRED 超过 2 年仍保留通信元数据（ICCID/IMSI/激活日期/用量/产品包 ID/状态变更日志）
- 企业处于 SUSPENDED 超过 2 年清理个人身份信息（客户名称、联系人邮箱、地址、关联 IP），保留企业 ID 与业务关联键

**状态对齐**：SIM 状态以上游 CMP（供应商侧）为准；收到上游通知时更新本系统状态；本地触发变更时调用上游 API 下发指令，以上游回执为准。系统需记录每张 SIM 的上游原始状态，并在供应商适配器中维护“上游状态 → 本地状态”的映射规则。

**状态漂移与冲突标记**：当本地状态与上游状态不一致时，标记 status_sync_conflict=true；对上游执行重试，超过最大次数仍失败则触发告警并冻结状态变更操作，直至人工或自动修复完成。

**状态变更幂等与异步确认**：所有状态变更 API 必须幂等；本地发起变更时先进入过渡子状态（如 deactivating/activating/reactivating/retiring），收到上游成功回执后再切换为目标状态；超时/失败则回滚或标记冲突。

**激活容错与重试**：
- activateSim 发起后，若上游返回 pending 或超时，保持 TEST_READY + sub_status=activating
- 上游返回拒绝/失败，保持 TEST_READY + sub_status=activation_failed，并记录失败原因与时间戳
- 进入 activation_failed 的 SIM 可由任务重试或人工重试触发；重试仍遵循幂等与最大重试次数

**企业状态 vs SIM 状态**：
- 独立性：SIM 状态是客观物理状态，企业状态是业务层级
- 单向驱动：企业 SUSPENDED（由代理商管理员手工设置） -> 可发起异步批量停机
- 计费原则：计费引擎只认 SIM 状态

**批量与异步任务**：
- 单次批量上限 10 万条
- Job 状态：QUEUED/RUNNING/SUCCEEDED/FAILED/CANCELLED
- 幂等：批量导入用 batchId/fileHash，南向指令用 idempotencyKey
- 重试：指数退避 + 最大 3 次

**SIM 入库**：仅代理商 Portal 开放，不对企业开放导入接口。必填：supplier_id、operator_id、ICCID、imsi_primary、APN。可选：form_factor、imsi_secondary_1/2/3、msisdn、imei。导入时自动分配 reseller_id（当前操作者所属代理商）。

**IMEI 锁定**（CMP.xlsx 对齐）：
- `imei_lock_enabled=true` 时，SIM 绑定首次上报的 IMEI，更换设备需管理员解锁
- 变更 IMEI 需审计记录

**Why this priority**: SIM 是 CMP 的核心管理对象，所有计费、监控、诊断功能都围绕 SIM 展开。SIM 生命周期管理是系统的基础能力。

**Technical Implementation**:

- 状态迁移触发：手工操作、自动规则（阈值）、网元回调、上游通知
- 默认策略：测试期结束动作可配置，缺省为自动激活（TEST_READY → ACTIVATED）
- 信控约束：企业 SUSPENDED 时禁止企业用户复机，仅代理商管理员可操作
- 拆机门槛计算：对该 SIM 所有订阅记录计算 commitmentEndAt = effectiveAt + commitmentPeriod，取 max(commitmentEndAt)
- 订阅切换生成新订阅记录，历史记录参与拆机门槛计算
- commitmentPeriod 为空视为 0
- 事件通知：`SIM_STATUS_CHANGED`

- API 接口：
  - `POST /v1/sims/import-jobs` 创建导入任务
  - `GET /v1/jobs/{jobId}` 查询进度
  - `POST /v1/sims` 单张手动录入
  - `POST /v1/sims/{simId}:activate`
  - `POST /v1/sims/{simId}:deactivate`
  - `POST /v1/sims/{simId}:reactivate`
  - `POST /v1/sims/{simId}:retire`（仅代理商管理员；前置：DEACTIVATED）

**Independent Test**: 可通过导入 SIM 卡、执行状态变更操作、验证状态机约束来独立测试。

**Acceptance Scenarios**:

1. **Given** 代理商管理员上传 SIM 文件, **When** ICCID 全局唯一且字段校验通过, **Then** SIM 导入为 INVENTORY 状态并返回 jobId
2. **Given** SIM 处于 ACTIVATED, **When** 尝试直接 RETIRE, **Then** 系统拒绝（必须先 DEACTIVATED）
3. **Given** SIM 处于 TEST_READY 且测试期到期, **When** Test Expiry Condition 满足, **Then** 自动转为 ACTIVATED
4. **Given** 企业状态为 SUSPENDED, **When** 企业运维尝试复机 SIM, **Then** 系统拒绝操作
5. **Given** SIM 处于 TEST_READY 且触发激活, **When** 上游返回拒绝或超时, **Then** 保持 TEST_READY 且 sub_status=activation_failed 或 activating
6. **Given** 2026-01-01 订阅 A（承诺期 12 个月）且 2026-06-01 切换到 B（承诺期 6 个月）, **When** 计算最早拆机时间, **Then** 最早拆机时间为 2027-01-01
7. **Given** 本地已停机但上游仍为 ACTIVE, **When** 同步重试超过最大次数仍失败, **Then** 标记 status_sync_conflict 并触发告警，冻结状态变更操作
8. **Given** 测试期到期且 Test Expiry Action=DEACTIVATED, **When** 到期条件满足, **Then** 自动进入 DEACTIVATED
9. **Given** SIM 处于 DEACTIVATED 且申请豁免拆机, **When** 代理商管理员或系统管理员确认原因, **Then** 跳过承诺期校验并进入 RETIRED

---

### User Story 3 - 产品包与资费计划配置 (Priority: P1)

系统由代理商管理员为企业定制产品包；每个产品包版本由 4 个模块组成：资费计划（Price Plan）、运营商业务、商业条款、控制策略。

**产品包模块组成**：
1. **资费计划（Price Plan）**：四选一（One-time / SIM Dependent Bundle / Fixed Bundle / Tiered Pricing）
2. **运营商业务（Carrier Service）**：供应商/运营商、RAT、APN/APN Profile、Roaming Profile
3. **商业条款（Commercial Terms）**：测试期、测试配额、测试到期条件、测试到期动作、承诺期
4. **控制策略（Control Policy）**：开关、达量断网、达量限速

**模块管理域归类（MVP）**：
- **Network Profiles 域**：APN Profile、Roaming Profile、Carrier Service、Control Policy
- **Price Plans 域**：Price Plan、Commercial Terms
- Carrier Service、Control Policy、Commercial Terms 均提供独立管理能力（至少包含创建、更新、查询）
- 快照机制适配结论：
  - APN Profile、Roaming Profile、Control Policy、Price Plan 均可采用“不可变快照 + 新 ID”机制
  - 对已存在对象的编辑不做原地覆盖，统一创建新快照 ID；原对象保持不变
  - 仅 `PUBLISHED` 快照可被产品包引用；`DRAFT` 快照用于编辑
  - 快照列表统一支持按“名称 + 发布时间 + 状态”展示，其中名称允许重复

**资费计划类型**：
1. **One-time（一次性）**：购买即收，含额度与有效时长，到期边界支持 CALENDAR_DAY_END / DURATION_EXCLUSIVE_END，取消不退款
2. **SIM Dependent Bundle（前向流量池，monthly recurring）**：按卡动态累加池额度；总配额 = activatedSimCount(高水位) × perSimQuotaKb
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
- 流量单位：KB，向上取整
- 生效时间：TIMESTAMPTZ，按系统时区解释
- 每个 Price Plan 仅针对一种电信业务类型（DATA/VOICE/SMS）
- 计费周期：支持自然月 (CALENDAR_MONTH) 与自定义周期 (CUSTOM_RANGE)

**通用字段**：serviceType、currency、billingCycleType、firstCycleProration（NONE/DAILY_PRORATION）、prorationRounding

**分摊算法**（DAILY_PRORATION 时）：
- `perDayFee = monthlyFee / daysInBillingMonth`
- `activeDays = countDaysInclusive(startDay, endDay)`
- `chargedMonthlyFee = round(perDayFee * activeDays, 2)`

**分区标准资费（Zone-based PAYG Rates）**：
- 适用所有 Price Plan 类型（兜底费率）
- 字段：`paygRates[]`（zoneCode、countries[MCC+MNC 或 MCC 通配]、ratePerKb）
- 匹配优先级：MCC+MNC 精确 > MCC 通配
- 冲突处理：同级冲突视为配置错误，发布校验阶段阻断
- 缺省行为：未配置则默认阻断（直接停机/断网，不产生费用）
- Price Plan 快照规则：
  - 对 Price Plan 的编辑始终生成新的 `pricePlanId`（快照 ID），来源链路通过 `sourcePricePlanId` 追溯
  - 新快照状态默认 `DRAFT`，发布后转 `PUBLISHED`
  - 产品包引用 `pricePlanId`（快照 ID），不再使用内部 `version`

**运营商业务（Carrier Service）**：
- RAT：3G/4G/5G/NB-IoT（缺省 4G）
- 业务类型：Data/Voice/SMS（缺省 Data）
- Roaming Profile：按 `roamingProfileId`（快照 ID）索引；用于计费兜底，当产品包的 Price Plan 未覆盖 SIM 拜访地时按该 Profile 定价
- Roaming Profile 最小字段：mcc、mnc、ratePerKb（如 0.000004 USD/KB）
- APN：运营商 APN 
- MVP：每个 Data 产品包绑定 1 个默认 APN + 1 个 Roaming Profile
- APN/Roaming Profile 变更次月生效
- 数据模型：
  - `apn_profiles`：id, name, apn, auth_type, username, password_ref, reseller_id, supplier_id, operator_id, status(draft/published/deprecated), published_at, source_apn_profile_id
  - `roaming_profiles`：id, name, reseller_id, supplier_id, operator_id, status(draft/published/deprecated), published_at, source_roaming_profile_id
  - `roaming_profile_entries`：id, roaming_profile_id, mcc, mnc, rate_per_kb
  - `package_network_policies`：package_id, apn_profile_id, roaming_profile_id, effective_from, effective_to, status(active/scheduled/expired)
- 校验来源：
  - APN 必须存在于上游供应商的可用目录或能力声明中
  - Roaming Profile 的 `mccmncList` 仅做格式与冲突校验，不要求出现在 `business_operators/operators` 中
  - `supplierId/operatorId` 仅用于 Profile 所有权归属校验，不用于限制漫游拜访地运营商列表
- 变更与回滚：
  - 对已存在 APN Profile 的修改始终生成新的 `apnProfileId`（新快照），原 Profile 保持不变
  - APN 快照发布后才可被产品包引用；历史已发布快照可继续被已有产品包使用
  - 对已存在 Profile 的修改始终生成新的 `roamingProfileId`（新快照），原 Profile 保持不变
  - 新快照发布后才可被产品包引用；历史已发布快照可继续被已有产品包使用
  - 若上游下发失败，保持当前生效绑定不变并生成告警
  - 支持在生效前撤销已排期绑定，撤销后恢复上一个 active 绑定
- 反向关联查询（Web Portal 连接能力）：
  - 允许以 `roamingProfileId` 反查已绑定该 Profile 的 Carrier Service 列表（用于从 Id1 迁移到 Id2 前的影响面识别）
  - 允许以 `apnProfileId` 反查已绑定该 Profile 的 Carrier Service 列表
  - 查询结果需返回 `carrierServiceId`、`supplierId`、`operatorId`、`status`、`effectiveFrom`，用于页面联动修改

**商业条款（Commercial Terms）**：
- Test Period（测试期）
- Test Quota（测试期流量配额，KB 向上取整）
- Test Expiry Condition：PERIOD_ONLY / QUOTA_ONLY / PERIOD_OR_QUOTA（默认）
- Test Expiry Action：ACTIVATED / DEACTIVATED（默认 ACTIVATED）
- Commitment Period（承诺期）

**控制策略（Control Policy）**：
- on/off 开关
- 达量断网规则（Cutoff Rules）：time_window（DAILY/MONTHLY）、thresholdMb、action=DEACTIVATED
- 达量限速规则（Throttling Rules）：time_window（DAILY/MONTHLY）、tiers[thresholdMb, downlinkKbps, uplinkKbps]
- time_window 到期自动恢复至初始速度：DAILY 次日 00:00，MONTHLY 下月 1 日 00:00
- 控制策略编辑创建新 `controlPolicyId`（快照 ID），历史快照不变
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

- 产品包版本由四个模块共同组成：Price Plan + Carrier Service + Commercial Terms + Control Policy
- 产品包以 ID 索引四个模块：`pricePlanId`、`carrierServiceId`、`controlPolicyId`、`commercialTermsId`
- 产品包变更次月生效
- APN 来源：运营商 APN 目录，供应商支持验证
- 停机保号费与月租费互斥
- 反向引用查询能力：
  - Network Profiles 域支持通过 `apnProfileId` / `roamingProfileId` 查询 Carrier Service
  - Price Plans 域支持通过 `pricePlanId` / `commercialTermsId` / `controlPolicyId` 查询 Package
  - 反查结果默认仅返回当前操作者租户可见范围，且可按 `status`（DRAFT/PUBLISHED）过滤

- 模块创建依赖顺序：
  1. 先创建 APN Profile、Roaming Profile
  2. 再创建 Carrier Service（引用 APN Profile / Roaming Profile）
  3. 再创建 Control Policy、Commercial Terms、Price Plan
  4. 最后创建 Package（引用 Carrier Service / Control Policy / Commercial Terms / Price Plan）

- 各类型字段表（仅列出差异字段）：

| Price Plan 类型 | 字段 | 含义 | 约束/边界 |
|---|---|---|---|
| One-time | `oneTimeFee` | 一次性费用 | >= 0 |
| One-time | `quotaKb` | 包含额度 | >= 0（仅 `DATA`） |
| One-time | `validityDays` | 有效天数 | >= 1 |
| One-time | `expiryBoundary` | 到期边界 | ENUM: `CALENDAR_DAY_END`/`DURATION_EXCLUSIVE_END`，默认 `CALENDAR_DAY_END` |
| SIM Dependent Bundle | `monthlyFee` | 月租费 | >= 0 |
| SIM Dependent Bundle | `deactivatedMonthlyFee` | 停机保号费（按月） | >= 0 |
| SIM Dependent Bundle | `perSimQuotaKb` | 每 SIM 配额 | >= 0（仅 `DATA`） |
| SIM Dependent Bundle | `overageRatePerKb` | 套外单价 | >= 0（仅 `DATA`） |
| Fixed Bundle | `monthlyFee` | 月租费 | >= 0 |
| Fixed Bundle | `deactivatedMonthlyFee` | 停机保号费（按月） | >= 0 |
| Fixed Bundle | `totalQuotaKb` | 总池额度 | >= 0（仅 `DATA`） |
| Fixed Bundle | `overageRatePerKb` | 套外单价 | >= 0（仅 `DATA`） |
| Tiered Pricing | `monthlyFee` | 月租费 | >= 0 |
| Tiered Pricing | `deactivatedMonthlyFee` | 停机保号费（按月） | >= 0 |
| Tiered Pricing | `tiers[]` | 阶梯费率 | 按阈值升序；阈值单位 KB；费率单位 `currency/Kb` |

- API 接口：
  - `POST /v1/apn-profiles` 创建 APN Profile 草稿快照
  - `POST /v1/apn-profiles:clone` 基于已有 APN Profile 快照创建新草稿快照（返回新 `apnProfileId`）
  - `PUT /v1/apn-profiles/{id}` 仅允许更新 DRAFT 快照
  - `POST /v1/apn-profiles/{id}:publish` 发布快照
  - `GET /v1/apn-profiles` 列表查询（展示字段：名称 + 发布时间 + 状态；名称允许重复）
  - `GET /v1/apn-profiles/{id}` 查询快照详情
  - `POST /v1/roaming-profiles` 创建 Roaming Profile 草稿快照
  - `POST /v1/roaming-profiles:clone` 基于已有 Profile 快照创建新草稿快照（返回新 `roamingProfileId`）
  - `PUT /v1/roaming-profiles/{id}` 仅允许更新 DRAFT 快照（名称与 entries）
  - `POST /v1/roaming-profiles/{id}:publish` 发布快照
  - `GET /v1/roaming-profiles` 列表查询（展示字段：名称 + 发布时间 + 状态；名称允许重复）
  - `GET /v1/roaming-profiles/{id}` 查询快照详情（含 entries）
  - `POST /v1/carrier-services`、`PUT /v1/carrier-services/{id}` 管理 Carrier Service
  - `GET /v1/carrier-services?roamingProfileId={id}` 按 Roaming Profile 快照反查 Carrier Service 列表
  - `GET /v1/carrier-services?apnProfileId={id}` 按 APN Profile 快照反查 Carrier Service 列表
  - `POST /v1/control-policies` 创建 Control Policy 草稿快照
  - `POST /v1/control-policies:clone` 基于已有 Control Policy 快照创建新草稿快照（返回新 `controlPolicyId`）
  - `PUT /v1/control-policies/{id}` 仅允许更新 DRAFT 快照
  - `POST /v1/control-policies/{id}:publish` 发布快照
  - `GET /v1/control-policies` 列表查询（展示字段：名称 + 发布时间 + 状态；名称允许重复）
  - `GET /v1/control-policies/{id}` 查询快照详情
  - `POST /v1/commercial-terms`、`PUT /v1/commercial-terms/{id}` 管理 Commercial Terms
  - `POST /v1/price-plans` 创建 Price Plan 草稿快照
  - `POST /v1/price-plans:clone` 基于已有 Price Plan 快照创建新草稿快照（返回新 `pricePlanId`）
  - `PUT /v1/price-plans/{id}` 仅允许更新 DRAFT 快照
  - `POST /v1/price-plans/{id}:publish` 发布快照
  - `GET /v1/price-plans` 列表查询（展示字段：名称 + 发布时间 + 状态；名称允许重复）
  - `GET /v1/price-plans/{id}` 查询快照详情
  - `POST /v1/enterprises/{enterpriseId}/packages` 创建产品包
  - `GET /v1/packages?pricePlanId={id}` 按 Price Plan 快照反查产品包列表
  - `GET /v1/packages?commercialTermsId={id}` 按 Commercial Terms 反查产品包列表
  - `GET /v1/packages?controlPolicyId={id}` 按 Control Policy 快照反查产品包列表
  - `PUT /v1/packages/{packageId}` 修改产品包
  - `POST /v1/packages/{packageId}:publish` 发布

- Roaming Profile 条文补充（speckit）：
  - 字段规则：
    - `name`：可重复，作为展示字段，不作为唯一键
    - 列表展示固定包含：`name`、`publishedAt`、`status`
    - `mcc`：3 位数字，必填
    - `mnc`：2~3 位数字，或 `*`（表示该 MCC 下全部运营商）
    - `ratePerKb`：必填，非负数
    - `mcc` 为空时必须报错
  - 冲突规则：
    - 同一快照内，`mcc+mnc` 组合唯一；重复组合返回 `409 CONFLICT`
    - 同一快照内，`mcc-*` 只能配置一条；重复配置返回 `409 CONFLICT`
  - 不可变规则：
    - `PUBLISHED` 快照不可修改（只读锁定）
    - 对已存在 Profile 的编辑必须创建新 `roamingProfileId`（来源快照通过 `sourceRoamingProfileId` 追溯）
    - 新快照默认 `DRAFT`，仅发布后可被产品包引用
  - 操作流程（Web Portal）：
    - 步骤1：用户在列表中选择已存在 Profile（可按名称、发布时间、状态识别）
    - 步骤2：提交编辑内容后，后端创建新的 DRAFT 快照 ID，并复制来源快照 entries 后应用差异
    - 步骤3：用户发布新快照，后续产品包可切换绑定到新 ID；旧快照保持不变
  - 错误码：
    - `BAD_REQUEST`：字段格式错误、必填缺失、`mcc` 为空
    - `CONFLICT`：同一快照内出现重复 `mcc+mnc` 组合或重复 `mcc-*`
    - `INVALID_STATUS`：对非 DRAFT 快照执行更新，或对非 DRAFT/非合法状态执行发布
    - `RESOURCE_LOCKED`：目标快照已发布或已进入不可写状态，不允许修改 entries
  - 示例请求（创建 Roaming Profile 草稿）：
    - `{"name":"SEA roaming","resellerId":"<uuid>","supplierId":"<uuid>","operatorId":"<uuid>","mccmncList":[{"mcc":"460","mnc":"00","ratePerKb":0.0008},{"mcc":"460","mnc":"*","ratePerKb":0.0012}]}`
  - 示例请求（克隆并编辑为新快照）：
    - `{"sourceRoamingProfileId":"<uuid>","name":"SEA roaming","operations":[{"op":"UPSERT","mcc":"454","mnc":"12","ratePerKb":0.0015},{"op":"DELETE","mcc":"460","mnc":"00"}]}`

- APN / Control Policy / Price Plan 快照条文补充（speckit）：
  - APN Profile：
    - `name` 可重复，列表展示 `name + publishedAt + status`
    - `PUBLISHED` 快照不可修改；编辑必须创建新 `apnProfileId`
  - Control Policy：
    - `name` 可重复，列表展示 `name + publishedAt + status`
    - `PUBLISHED` 快照不可修改；编辑必须创建新 `controlPolicyId`
    - cutoff 与 throttling 规则作为快照内容一并固化
  - Price Plan：
    - `name` 可重复，列表展示 `name + publishedAt + status`
    - `PUBLISHED` 快照不可修改；编辑必须创建新 `pricePlanId`
    - 快照内固定 `type`（ONE_TIME/SIM_DEPENDENT_BUNDLE/FIXED_BUNDLE/TIERED_PRICING）与对应计费字段

**Independent Test**: 可通过创建不同类型的产品包并验证字段校验规则来独立测试。

**Acceptance Scenarios**:

1. **Given** 创建 SIM Dependent Bundle 产品包, **When** 月租=10, perSimQuotaKb=1048576(1GB), 当月 3 张 SIM, **Then** 总配额=3GB, 月租=30
2. **Given** 创建 One-time 产品包(quota=10GB, validity=30天, expiry=CALENDAR_DAY_END), **When** 2026-02-01 10:00 生效, **Then** 到期时间 2026-03-02 23:59:59
3. **Given** 产品包绑定 APN=A, **When** 变更为 APN=B 发布为次月生效, **Then** 当月不影响，次月生效并下发上游

---

### User Story 4 - 订阅关系管理 (Priority: P1)

管理 SIM 与产品包之间的订阅关系，支持创建、变更、退订等操作。

**订阅规则**：
- 生效时间精确到秒（TIMESTAMPTZ）
- 订阅状态：PENDING / ACTIVE / CANCELLED / EXPIRED
- 互斥校验：同一时间一张 SIM 仅允许 1 个主数据产品包，叠加包不限
- 变更限制：主套餐变更次月生效
- 退订保护：默认到期退订（服务至月底）；立即退订需二次确认，不退费
- 每次订阅记录生效时间与承诺期，用于计算承诺期结束日
- 最早可拆机时间 = max(各订阅承诺期结束日)
- 主套餐/叠加包是订阅关系的语义，不限定资费类型；资费类型由产品包定义

**场景模板：东南亚主包 + 中国叠加包**
- 目标：东南亚为主流量低成本覆盖；中国为少量高成本按量计费
- 订阅配置：
  - 主套餐：东南亚七国 SIM Dependent Bundle（覆盖区域=SEA-7）
  - 叠加包：中国大陆 Tiered Pricing 或 PAYG（覆盖区域=CN）
- 用量匹配（与 Waterfall Logic 一致）：
  - visitedMccMnc 属于 CN：优先命中中国叠加包
  - visitedMccMnc 属于 SEA-7：命中主套餐
  - 无覆盖：Out-of-Profile（按 paygRates 计费并告警）
- 计费口径：
  - 主套餐月租与配额按 SIM Dependent Bundle 规则计算
  - 叠加包按 Tiered/PAYG 规则计费，不影响主套餐配额
  - visitedMccMnc 必填，用于分摊到正确产品包

**订阅约束与变更策略**：
- 变更（Switch）：默认次月生效，本月旧套餐全额月租，下月新套餐，无补差价
- 退订（Cancel）：
  - 模式 A（默认）：到期退订（Expire at End）
  - 模式 B（可选）：立即退订（Terminate Now），当月月租不退

**计数口径**：订阅生效时间决定月初取数与月内新增计数。

**计费窗口**：以产品包定义的计费周期为准，用量归集窗口与计费窗口一致。

**Why this priority**: 订阅是 SIM 与产品包的连接桥梁，直接影响计费计算的准确性。

**Technical Implementation**:

- 产品包订阅语义：
  - PENDING：创建后尚未到达生效时间（次月生效场景）
  - ACTIVE：当前账期生效
  - CANCELLED：撤销（当月计数与配额不回收）
  - EXPIRED：到期或被替换后归档
- 月内取消订阅：当月仍按全额月租计费，配额保留至月底

- API 接口：
  - `POST /v1/subscriptions` 创建订阅
  - `POST /v1/subscriptions:switch` 套餐切换（原子：退订旧+订购新，默认次月）
  - `POST /v1/subscriptions/{subscriptionId}:cancel`（支持 `immediate=true/false`）
  - `GET /v1/sims/{simId}/subscriptions` 查询订阅历史

**Independent Test**: 可通过为 SIM 创建订阅、执行套餐切换、验证互斥规则来独立测试。

**Acceptance Scenarios**:

1. **Given** SIM 已有主套餐 A, **When** 尝试同时订阅主套餐 B, **Then** 系统拒绝（互斥）
2. **Given** 订阅生效时间 2026-02-10, **When** 计算 2026-02 账期, **Then** 计入 2026-02 订阅计数
3. **Given** 主套餐切换为次月生效, **When** 2026-02-15 提交, **Then** 2026-02 不受影响，2026-03 生效

---

### User Story 5 - 计费引擎与月租费计算 (Priority: P1)

基于高水位计费原则和用量归集规则，实现计费引擎核心逻辑。

**权威源与计费原则**：
- SIM 状态、数据使用量、话单均以上游 CMP 为准
- 仅实现资费_企业（零售资费），不实现资费_运营商
- 计费结果可追溯：用量明细 -> 产品包/资费计划版本 -> 计算结果

**月租费计算规则（高水位 High-Water Mark）**：
- 基于 SIM 在自然月内的状态轨迹判定（非月底快照）
- 依据 `sim_state_history` 表（start_time/end_time/status）
- 计费优先级：ACTIVATED > DEACTIVATED > 其他

详细判定：
1. **全额月租费**：账期内曾处于 ACTIVATED（哪怕 1 秒）
2. **停机保号费**：未曾 ACTIVATED，但曾 DEACTIVATED
3. **无月租**：仅 INVENTORY 或 TEST_READY

- 月租费与停机保号费绝对互斥（同一 SIM 同一账期仅一项）

**用量归集与产品包匹配规则（Waterfall Logic）**：
1. 时间窗匹配：查找 SIM 在该时刻所有有效订阅
2. 区域与优先级匹配：
   - 叠加包优先
   - 范围最小优先（如"法国包"优先于"欧洲包"）
   - 主套餐兜底
   - 无覆盖 -> Out-of-Profile（Zone-based PAYG 独立计费 + 异常漫游告警）
3. 计费处理：
   - In-Profile：扣减配额，配额耗尽按套外单价
   - Out-of-Profile：不扣减任何套餐配额，按 paygRates 计费，触发告警
   - 非活跃状态用量：默认 Out-of-Profile 处理

**SIM Dependent Bundle 计费**：
- 总配额 = activatedSimCount(高水位) × perSimQuotaKb
- 仅支付停机保号费的 SIM 不贡献配额
- 费用 = (activatedSimCount × monthlyFee) + (deactivatedSimCount × deactivatedMonthlyFee) + 套外费用

**Fixed Bundle 计费**：
- 固定总池额度，费用 = (activatedSimCount × monthlyFee) + (deactivatedSimCount × deactivatedMonthlyFee) + 套外费用

**Tiered Pricing 计费**（分段累进）：
- 0≤U≤T1: U×R1
- T1<U≤T2: T1×R1 + (U-T1)×R2
- 以此类推

**用量数据采集**：
- 目标：统一接入多供应商用量数据，清洗、归一化、归属到 SIM 与产品包，作为计费引擎权威输入
- 数据拉取与解析：
  - 主：供应商 API（RESTful/SOAP），每 15~30 分钟拉取 SIM 级汇总
  - 备：SFTP 话单（CSV/JSON），会话级明细解析与聚合
  - 主备方式与频次可配置
- 字段标准化：上游字段映射到本系统字段，按 `supplierId + iccid + 账期 + visitedMccMnc` 对齐
- 完整性校验失败直接丢弃并告警，不入计费库：
  - iccid 不存在于本地 SIM 库
  - visited_mcc_mnc 无法解析（非数字）
  - total_kb < 0（负数视为上游异常数据）
  - billing_cycle_id 与当前计费窗口不匹配
- total_kb = 0：允许入库但不计费，不触发配额扣减，可用于统计保活/信令类用量
- 幂等入库：按幂等键去重，避免重复计费
- 异常处理与运维保障：
  - API 调用失败：重试 3 次 → 切换 SFTP 源 → 告警
  - SFTP 文件缺失：标记待补录 → 次日重试 → 7 天未补 → 人工介入
  - 用量突增（>10x 均值）：标记异常用量 → 触发风控审核
  - MCC/MNC 未知：归为 Out-of-Profile + 发送“未知漫游地”告警
  - 迟到话单：允许重算最近 2 个账期 → 生成 adjustment 记录

**漫游用量报表**：按 SIM 粒度记录，最小字段 iccid/supplierId/visitedMccMnc/totalBytes/periodStart/periodEnd。

**一致性与审计**：幂等入库、迟到话单可重算保留痕迹、记录 inputRef/ruleVersion/calculationId。

**Why this priority**: 计费是 CMP 的核心商业逻辑，直接关系到收入准确性。高水位计费和 Waterfall Logic 是系统的关键差异化能力。

**Technical Implementation**:

- 信控特殊说明：计费引擎仅认 SIM 实际状态轨迹，不直接处理企业状态
- 数据模型：
  - `sim_state_history`：SIM 全生命周期状态变更（Type 2 SCD）
  - `usage_daily_summary`：按 SIM + Day + Zone 预聚合

- 多包场景示例：
  - SIM 订阅 Global 1GB(主) + France 500MB(叠加)
  - 事件 A（法国）：扣减 France 500MB
  - 事件 B（德国）：France 不覆盖，扣减 Global 1GB
  - 事件 C（古巴）：均不覆盖 -> Out-of-Profile（PAYG + 告警）

**Independent Test**: 可通过构造不同状态轨迹的 SIM 并执行计费计算，验证月租费判定规则和用量匹配逻辑。

**Acceptance Scenarios**:

1. **Given** SIM 02-10 ACTIVATED → 02-20 DEACTIVATED, **When** 计算月租, **Then** 收全额月租费
2. **Given** SIM 全月 DEACTIVATED, **When** 计算月租, **Then** 收停机保号费
3. **Given** SIM 全月 INVENTORY/TEST_READY, **When** 计算月租, **Then** 无月租项
4. **Given** SIM Dependent Bundle 月租=10, perSimQuota=1GB, activatedSims=3, 总用量≤3GB, **When** 计费, **Then** 费用=30(月租)
5. **Given** SIM 在法国产生用量, 订阅了 Europe 主套餐 + France 叠加包, **When** 用量匹配, **Then** 优先扣减 France 叠加包

---

### User Story 6 - 账单与出账管理 (Priority: P1)

按账期自动生成、发布企业账单，支持多层级展示、调账与导出。

**出账流程**：
1. 数据归集（Aggregation）：锁定用量记录与 SIM 状态快照
2. 批价与计费（Rating & Billing）：应用资费计划规则
3. 账单生成（Generation）：按企业/部门维度汇总
4. 发布与通知（Notification）：PUBLISHED + 邮件/站内信

**出账触发**：账期结束后 T+N 日自动（N 默认 3，可配置）。
- 配置粒度：reseller 级默认值，可在 customer 级覆盖；MVP 不支持 product/package 级别
- 覆盖规则：customer 配置优先生效，缺省回退到 reseller；未配置使用系统默认 N=3
- 手工触发：系统管理员可按企业+账期手动触发，不受 N 限制

**账单结构**：
- L1 汇总账单（Account Summary）：企业维度总览，上期余额/本期费用/已付/应付/Due Date
- L2 分组汇总（Group Summary）：按部门、按产品包
- L3 费用明细（Line Items）：按 SIM 维度（ICCID/MSISDN/部门/产品包/月租/用量/套外/小计）

**账单状态**：GENERATED -> PUBLISHED -> PAID / OVERDUE / WRITTEN_OFF

**导出格式**：汇总 PDF（品牌化），明细 CSV/Excel（支持百万级行数据）。

**调账与差异处理**：
- 已发布账单不可篡改
- Credit Note（退款/抵扣）、Debit Note（补收）
- 调账金额计入下期结算

**迟到话单处理**：
- 判定：话单落在已发布账期窗口内
- 动作：自动生成 Adjustment Note 草稿（含 inputRef/calculationId），待审核，下期结算
- 审计：草稿生成/审核/发布均记录

**Why this priority**: 账单是商业闭环的关键环节，直接影响收入确认和客户体验。

**Technical Implementation**:

- 账单层级：L1(企业) -> L2(部门/产品包) -> L3(SIM)
- 支持线下转账人工核销 + 在线支付回调自动核销
- 调账：仅 PUBLISHED/OVERDUE 状态可关联 Note

- API 接口：
  - `GET /v1/bills`（列表，按账期/状态/企业筛选）
  - `GET /v1/bills/{billId}`（详情）
  - `GET /v1/bills/{billId}/files`（下载 PDF/CSV）
  - `POST /v1/bills/{billId}:mark-paid`（人工核销）
  - `POST /v1/bills/{billId}:adjust`（调账）

**Independent Test**: 可通过模拟一个完整账期的用量数据和 SIM 状态，运行计费引擎生成账单，验证各层级数据准确性。

**Acceptance Scenarios**:

1. **Given** 账期结束且话单归集完成, **When** T+3 日触发出账, **Then** 生成 GENERATED 状态账单并含 L1/L2/L3 明细
2. **Given** 账单状态为 PUBLISHED, **When** 收到迟到话单, **Then** 生成 Adjustment Note 草稿
3. **Given** 财务确认支付, **When** 标记为 PAID, **Then** 账单状态更新并记录审计

---

### User Story 7 - 欠费管控与信用流程 (Priority: P2)

针对后付费模式，实现自动化催收与管控等级管理（Dunning Process），不自动变更企业状态。

**时间轴**：
- 账单日（T）：PUBLISHED
- 到期日（T+N）：合同约定最晚付款日（如 T+30，可按企业配置）
- 宽限期（M 天）：逾期缓冲（默认 3 天，可配置）
- 管控触发点：当前时间 > (到期日 + 宽限期)

**管控等级**：
1. **逾期提醒（Overdue Warning）**：超过到期日，每日催收邮件/短信
2. **触发管控（Suspend）**：超过宽限期且欠费 > 豁免阈值，提升催收强度并标记风险等级
3. **服务阻断（Service Interruption）**：高风险提醒与操作建议，仅供代理商管理员手工决策

**复机/恢复**：
- 企业状态恢复由代理商管理员手工执行
- 已批量停机的 SIM 不自动复机，需管理员手动批量复机

**信控期间计费**：
- 计费持续，依 SIM 实际状态收费
- 复机无回溯补缴

**欠费结清顺序**：最早逾期账单 > 滞纳金 > 当前账单

**欠费豁免阈值与滞纳金**：
- 欠费豁免阈值：可在 reseller 级配置，customer 可覆盖；缺省为 0
- 触发口径：逾期金额 > 豁免阈值才进入 Suspend 建议与升级流程
- 滞纳金口径：对逾期未结清金额按日计收（dayRate），从到期日次日开始计算
- 计算公式：`penalty = overdueAmount * dayRate * daysOverdue`

**Why this priority**: 信控是降低坏账风险的关键机制，但可以在基础计费和账单功能完成后再实现。

**Technical Implementation**:

- `autoSuspendEnabled` 保留字段，默认 Disabled，当前版本不参与自动状态控制
- Dunning Process 仅维护催收等级与通知，不触发企业状态变更与批量停机
- 复机：不自动批量复机，防止瞬间大额流量

**Independent Test**: 可通过模拟账单逾期场景，验证催收通知与管控等级变化，不触发企业状态自动变更。

**Acceptance Scenarios**:

1. **Given** 账单逾期且超过宽限期, **When** 欠费>阈值, **Then** Dunning 等级变为 SUSPENDED 且不自动修改企业状态
2. **Given** Dunning 等级为 SUSPENDED 超 15 天, **When** 代理商管理员评估风险, **Then** 可手工调整企业状态并按需批量停机
3. **Given** 企业缴清欠费, **When** 代理商管理员手工恢复 ACTIVE, **Then** 已停机 SIM 不自动复机，需手动操作

---

### User Story 8 - 上游对账与产品映射 (Priority: P2)

维护内部产品包与上游供应商产品包的映射关系，负责业务操作的上游同步。

**产品映射模型**：
- 一一对应：每个基础产品包绑定上游 `externalProductId`
- 字段：supplierId、externalProductId、provisioningParameters

**开通同步机制（Provisioning Synchronization）**：
- 策略："本地调度 + 上游执行"
- 场景 A（立即生效）：记录 PROVISIONING_IN_PROGRESS -> 调用上游 API -> 成功更新 ACTIVE / 失败回滚 PROVISIONING_FAILED
- 场景 B（预约生效）：创建 Pending Order
  - 上游支持预约：立即调用带生效时间，标记 SCHEDULED_ON_SUPPLIER
  - 上游仅支持立即：本地调度器在生效时间窗口触发，标记 SCHEDULED_LOCALLY
- 状态一致性：每日全量/增量同步 Reconciliation，不一致触发差异告警

**对账差异处理**：以上游为准，Reseller System 记录差异用于稽核分析。

**Why this priority**: 上游对账确保系统数据与真实网络状态一致，是数据可靠性的保障。

**Technical Implementation**:

- Pending Order 模型：记录期望生效时间、调度策略
- 能力协商：适配器声明能力（如 supportsFutureDatedChange）
- 每日 Reconciliation 任务

**Independent Test**: 可通过模拟上游 API 交互，验证产品映射、开通同步和差异处理逻辑。

**Acceptance Scenarios**:

1. **Given** 创建订阅需同步上游, **When** 上游 API 返回成功, **Then** 本地状态更新为 ACTIVE
2. **Given** 套餐次月变更且上游不支持预约, **When** 到达生效时间, **Then** 本地调度器触发上游调用
3. **Given** 每日 Reconciliation 发现不一致, **When** 本地 ACTIVATED 上游 DEACTIVATED, **Then** 以上游为准更新并触发告警

---

### User Story 9 - 监控、诊断与可观测性 (Priority: P2)

构建统一监控、告警与推送体系，覆盖系统健康与业务用量异常，支持灰度发布、横向扩展与审计追溯。

**MVP 实现约束**：
- 数据采集与存储：Supabase（PostgreSQL + Realtime）记录指标与告警事件
- 规则计算：Vercel Cron + Serverless Functions 批量评估
- 查询与可视化：轻量管理后台 + CSV 导出
- 大规模流式计算、搜索与可视化（Kafka/Flink/Elasticsearch/Prometheus/Grafana）标记为商用阶段能力

**系统监控告警子系统**：
- API 可用性监控：采集返回码、响应时间、SSL 握手耗时，1 分钟粒度写入时序表；可用率 < `api.avail.threshold`(默认 95) 且持续 `api.avail.duration`(默认 30 分钟) 触发 P1 告警，附 20 条失败明细；支持按供应商+API 组阈值配置，5 分钟内生效；对外提供告警事件订阅 API
- 任务执行监控：监听 `task.execution` 事件流，计算耗时；单任务耗时 > `task.duration.threshold`(默认 30 分钟) 触发 P2 告警；支持按业务线/任务类型/Worker Group 阈值与降级策略
- 数据延迟监控：扫描 `cdr_file_sync` 比对应到与实际到达时间；延迟 > `cdr.delay.threshold`(默认 96 小时) 触发 P1 告警并自动补采
- 控制策略执行监控：统计 `policy_execute_log` 24 小时窗口失败数；失败 > `policy.fail.count`(默认 10) 且窗口 ≤ `policy.fail.window`(默认 24 小时) 触发 P0 告警并冻结策略下发，记录审计并支持一键重试/忽略

**业务用量监控告警子系统**：
- 配额余量监控：每 15 分钟批算 Fixed Bundle 与 SIM Dependent Bundle 用量占比；占比 ≥ `quota.remain.threshold`(默认 80%) 触发 P2 告警，附剩余流量(MB)与预估耗尽时间；支持账户/套餐/SIM 阈值模板继承与覆盖
- 配额耗尽监控：实时监听计费累计表，remaining ≤ 0 触发 P1 告警并停机，停机接口幂等，告警到停机延迟 < 30 秒
- 超额使用量监控：按自然日累计单 SIM 用量；用量 > `sim.daily.usage`(默认 10GB) 触发 P2 告警并限速至 128kbps；支持全局或单卡白名单
- Out of Profile 占比监控：实时流计算 SIM 漫游用量；占比 > `oop.ratio.threshold`(默认 10%) 触发 P3 告警，附 Top3 异常国家码；支持按产品/区域/漫游伙伴下钻并导出 CSV
- 漫游异常监控：对比在线会话 MCC/MNC 与 Roaming Profile；拜访地不在 Profile 内触发 P2 告警并发送位置更新短信；支持 Profile 快照回溯
- 测试期到期监控：每日 08:00 触发到期告警(P1)并自动切换正式套餐；支持批量延期 API（最多 90 天）
- 测试期配额耗尽监控：实时检测测试期累计用量耗尽，触发 P1 告警并停机，复用配额耗尽停机接口

**统一告警引擎与推送**：
- 规则引擎集中管理阈值、窗口、级别与升级策略；同规则 5 分钟内不重复发送
- 支持抑制、合并、升级(P3→P2→P1→P0)与认领
- 推送通道：邮件、钉钉群机器人、企业微信、Webhook；支持按级别/业务组/值班表路由
- 告警事件采用 CloudEvents 1.0 输出，写入 Elasticsearch 保留 90 天并提供检索/导出

**告警级别与通知对象配置**：
| 级别 | 响应要求 | 通知对象 | 说明 |
|:--|:--|:--|:--|
| P0(紧急) | 15 分钟内响应 | 系统管理员、代理商管理员 | 需支持单规则级别与通知对象独立配置 |
| P1(高) | 2 小时内响应 | 代理商管理员 | 需支持按业务组/值班表路由 |
| P2(中) | 24 小时内响应 | 代理商管理员 | 支持按企业/套餐/SIM 维度覆盖 |
| P3(低) | 周期内优化 | 代理商销售总监 | 支持降级为站内消息 |

**推送管理**：
- Webhook：支持企业级开关与事件类型过滤
- 邮件通知：账单、告警、到期通知发送至代理商用户与客户邮箱
- Portal 站内消息：操作提示、状态变更仅在用户登录 Web Portal 时展示

**可配置事件模板**：
| 事件类型 | 示例模板 | 可用变量 |
|:--|:--|:--|
| 配额余量监控 | 你的前向流量池{{package_name}}已使用{{used_mb}}流量，剩余不足1-{{used_pct}}。 | package_name, used_mb, used_pct |

**配置与运维**：
- 参数接入配置中心，30 秒内广播到节点，支持版本对比与回滚
- Prometheus + Grafana 大盘：告警延迟 < 1 分钟、推送成功率 ≥ 99.9%、规则加载耗时 < 200ms
- 灰度发布：按供应商→省份→套餐→SIM 逐级放量，支持实时关闭任意维度

**验收与测试**：
- 单测覆盖率 ≥ 80%，核心规则 ≥ 90%；集成测试覆盖 14 条告警场景
- 压测目标：Kafka 5w QPS、Flink 30w records/s、规则 1k 条 99th < 500ms

**Independent Test**: 可通过构造模拟指标、触发阈值、查看告警事件与推送记录来独立测试。

**Acceptance Scenarios**:
1. **Given** 上游 API 可用率 90% 持续 30 分钟, **When** 监控扫描, **Then** 触发 P1 告警并包含 20 条失败明细
2. **Given** 单任务耗时 35 分钟, **When** 任务事件进入队列, **Then** 触发 P2 告警并记录积压
3. **Given** CDR 延迟 100 小时, **When** 扫描落地表, **Then** 触发 P1 告警并补采
4. **Given** 24 小时策略失败次数 12, **When** 窗口统计完成, **Then** 触发 P0 告警并冻结策略
5. **Given** 配额剩余 15%, **When** 余量批算执行, **Then** 触发 P2 告警并提供耗尽时间
6. **Given** remaining=0, **When** 计费累计更新, **Then** 30 秒内告警并停机
7. **Given** 单 SIM 当日用量 12GB, **When** 日累计更新, **Then** 告警并自动限速
8. **Given** out of profile 占比 12%, **When** Flink 输出, **Then** 触发 P3 告警并给出 Top3 国家码
9. **Given** 漫游地不在 Profile, **When** 会话对比, **Then** 触发 P2 告警并发送位置短信
10. **Given** 测试期到期且到期日当天 08:00, **When** 批任务执行, **Then** 触发 P1 告警并切换正式套餐
11. **Given** 测试期配额耗尽, **When** 用量实时更新, **Then** 触发 P1 告警并停机
12. **Given** 同一规则 5 分钟内重复触发, **When** 告警引擎处理, **Then** 仅合并不重复发送
13. **Given** 推送失败 3 次, **When** 进入重试机制, **Then** 记录失败并可人工重投
14. **Given** 灰度关闭某供应商, **When** 告警引擎路由, **Then** 该供应商不再触发告警

**交付物清单**：
- 领域模型与数据库表设计说明
- 配置中心参数模板与版本回滚规范
- 告警引擎与调度器源码实现说明
- 多通道推送适配器说明（邮件、钉钉、企微、Webhook）
- 统一查询与可视化接口定义（含告警趋势/统计）
- 冒烟与压测报告（含指标与结论）
- 上线手册与回滚方案

---

### User Story 10 - 多供应商虚拟化层与集成 (Priority: P2)

构建统一的虚拟化适配层，屏蔽上游供应商差异，支持南向（上游）与北向（客户系统）集成。

**南向集成 - 多供应商虚拟化层**：
- 架构：Adapter Pattern + Facade
- SPI 定义：
  - `ProvisioningSPI`：activateSim, suspendSim, changePlan
  - `UsageSPI`：getDailyUsage, fetchCdrFiles
  - `CatalogSPI`：mapVendorProduct
- 适配器：针对不同厂商（Jasper, Ericsson 等）独立实现，协议转换（REST/SOAP/XML）、状态映射
- 差异化能力管理（Capability Negotiation）：适配器声明能力集（如 supportsFutureDatedChange、supportsRealTimeUsage），核心层动态决定执行策略

**上游技术标准**：
- 指令：RESTful API（JSON），异步+回调或同步+查询，幂等（idempotencyKey）
- 数据交付：SFTP/S3 批量文件（CSV/JSON + Checksum）为主，API 按需

**北向集成**：
- RESTful API over HTTPS (JSON)，OpenAPI 3.0 文档
- 版本控制：URI 版本化 `/v1/...`
- 认证：API Key（M2M）+ OAuth2/OIDC（Web/第三方）
- RBAC 细粒度鉴权
- TLS 1.2+
- Rate Limiting：Token Bucket，按租户+接口，超限 429
- Webhook：HMAC-SHA256 签名，指数退避重试

**数据同步**：
- SIM 状态权威源：上游 CMP
- 用量/话单权威源：上游 CMP（SFTP 批量为主，API 为辅）
- 指令闭环：下发 -> 受理回执 -> 最终确认

**话单/用量数据最小字段**：supplierId、visitedMccMnc、ICCID、eventTime+eventTimeZone、uplinkBytes/downlinkBytes/totalBytes、apn、rat、recordId/fileId+lineNo

**SFTP 交付**：幂等入库、补传、重放（以幂等键去重）

**话单时区**：按供应商配置，换算到系统时区，按自然月归集。

**Why this priority**: 虚拟化层是系统与上游对接的桥梁，但可以先实现单供应商适配再扩展多供应商。

**Technical Implementation**:

- "虚拟预约模式"：上游不支持预约变更时，本地调度器代替
- 网元直连非 MVP：通过供应商 CMP 代理
- SMSC：通过供应商 API 或 SMPP 封装 HTTP

**Independent Test**: 可通过实现一个供应商适配器并验证 SPI 调用来独立测试。

**Acceptance Scenarios**:

1. **Given** 供应商不支持预约变更, **When** 核心层请求次月生效, **Then** 系统自动切换虚拟预约模式
2. **Given** SFTP 文件重复投递, **When** 系统处理, **Then** 幂等去重不重复计费
3. **Given** API 调用超过租户限额, **When** 继续请求, **Then** 返回 429 Too Many Requests

---

### User Story 11 - 事件驱动架构与可观测性基础设施 (Priority: P2)

建立统一的事件目录、链路追踪和日志体系，支撑系统的可追踪、可定位、可审计。

**事件目录（Event Catalog）**：

| eventType | 触发条件 | payload 最小字段 | 去重键 |
|---|---|---|---|
| `SIM_STATUS_CHANGED` | SIM 状态变更 | simId, iccid, beforeStatus, afterStatus, supplierId | resellerId+simId+afterStatus+occurredAt(1min) |
| `SUBSCRIPTION_CHANGED` | 订阅创建/变更/退订 | subscriptionId, simId, packageId, beforeState, afterState, effectiveAt | resellerId+subscriptionId+afterState+effectiveAt |
| `BILL_PUBLISHED` | 账单发布 | billId, customerId, period, totalAmount, dueDate | customerId+billId |
| `PAYMENT_CONFIRMED` | 支付确认 | billId, customerId, paidAmount, paidAt, paymentRef | customerId+billId+paymentRef |
| `ALERT_TRIGGERED` | 告警触发 | alertType, customerId, simId, threshold, currentValue, windowStart | resellerId+simId+alertType+windowStart |
| `ENTERPRISE_STATUS_CHANGED` | 企业状态变更 | customerId, beforeStatus, afterStatus, reason | customerId+afterStatus+occurredAt(1min) |

**可观测性**：
- 链路关联：requestId（API Gateway）、jobId（批量操作）、eventId（事件总线）、idempotencyKey（南向指令）
- 日志：结构化 JSON（resellerId, customerId, requestId, jobId, simId, supplierId, level, code, message）
- 指标：北向 P95/P99/429/5xx，南向成功率/超时率/重试，数据侧 CDR 迟到/解析失败
- 追踪：北向到核心服务+适配器，异步任务到 MQ 消费+执行结果

**Why this priority**: 事件和可观测性是运维保障的基础，但核心业务逻辑完成后再完善。

**Technical Implementation**:

- 事件通用字段：eventId, eventType, occurredAt, tenantScope, actor, payload, requestId, jobId
- 消费者按 eventId 幂等
- Webhook/Email 按去重键抑制

**Independent Test**: 可通过触发业务操作并验证事件产生和日志记录来独立测试。

**Acceptance Scenarios**:

1. **Given** SIM 状态变更, **When** 操作完成, **Then** 产生 SIM_STATUS_CHANGED 事件含完整 payload
2. **Given** PATCH /sims/{iccid} 触发停机, **When** 操作完成, **Then** 审计日志含 requestId/before/after
3. **Given** 计费重算, **When** 完成, **Then** 可关联 inputRef + ruleVersion + calculationId

---

### Edge Cases

- **SIM 02-01 00:00:01 ACTIVATED → 02-01 00:00:02 DEACTIVATED**：收全额月租费（出现过 ACTIVATED，哪怕 1 秒）
- **企业 SUSPENDED 但 SIM 漏停机仍 ACTIVATED**：收全额月租 + 用量计费照常（计费只认 SIM 状态）
- **SIM 处于 DEACTIVATED 但仍产生话单**：按 Out-of-Profile 处理（独立计费+告警）
- **SIM 处于 RETIRED 仍有 CDR**：进入异常队列，不生成对企业可见的正常扣费（需人工稽核）
- **同一 visitedMccMnc 命中多个 PAYG 候选项**：选择最具体规则（MCC+MNC 优先）；同级冲突为配置错误
- **话单落在已发布账期窗口**：生成调账单草稿，下期结算
- **上游通知乱序/重复**：幂等处理，以上游最终回执为准
- **月内取消订阅后立即终止**：当月仍按全额月租计费，配额保留至月底
- **企业 SUSPENDED 时 SIM 未能成功停机**：继续按全额月租收取
- **拆机门槛校验**：max(首次订阅时间_i + 承诺期_i)，未过门槛则禁止拆机
- **APN 变更影响现网**：需提示风险并支持版本回退
- **未知 visitedMccMnc / 规则缺失**：输出可定位错误并进入待处理队列

## Clarifications

### Session 2026-02-08

- Q: 本系统的主要开发语言是什么？ → A: TypeScript (Node.js)
- Q: 系统主数据库采用哪种方案？ → A: Supabase (PostgreSQL)
- Q: MVP 阶段系统的交付形态是什么？ → A: API + 轻量管理后台（仅内部运营用简易管理界面）
- Q: 系统的币种支持策略是什么？ → A: 按代理商固定币种（每个代理商配置一种结算币种，企业继承）
- Q: MVP 阶段的部署环境是什么？ → A: Vercel (Serverless Functions)

### Session 2026-02-08 (CMP.xlsx 对齐)

- Q: 实体建模策略 — 独立表 vs 通用租户表？CMP.xlsx 将代理商（resellers）、企业客户（customers）建模为独立表，各有专属字段和状态机；当前 spec.md 使用通用 tenants 表（tenant_type 区分）。采用哪种方案？ → A: 采用 CMP.xlsx 方案 — 独立表（resellers、customers、operators、suppliers 各自独立建表，废弃通用 tenants 表）
- Q: RBAC 权限模型 — CMP.xlsx 定义了完整的 permissions/roles/role_permissions 三表结构（38+ 权限码、7 种角色含 scope 层级 platform/reseller/customer），而当前 spec.md 仅使用 user_roles.role_name 文本字段。是否采用完整 RBAC 三表模型？ → A: 采用 CMP.xlsx 完整 RBAC 三表模型（permissions + roles + role_permissions），含 38+ 权限码和 7 种角色（platform_admin, reseller_admin, reseller_sales_director, reseller_sales, reseller_finance, customer_admin, customer_ops）
- Q: 上游集成与运营商建模 — CMP.xlsx 构建了 operators 表（MCC/MNC 唯一、deprecation 工作流）和 upstream_integrations 表（关联 supplier+operator，含 API/CDR 配置），而当前 spec.md 缺少。是否采用？ → A: 采用 CMP.xlsx 方案 — 新增 operators 表（MCC/MNC 唯一约束、status=active/deprecated/error、replaced_by_id）和 upstream_integrations 表（supplier_id + operator_id 唯一约束，含 api_endpoint、api_secret_encrypted、cdr_method/endpoint/path/file_pattern）
- Q: SIM 卡表扩展 — CMP.xlsx 定义了 sim_cards 表含 form_factor ENUM、多 IMSI（primary + 3 secondary）、IMEI 锁定、四方归属链。是否采用？ → A: 完整采用 CMP.xlsx 方案 — sims 表重命名为 sim_cards，新增 form_factor ENUM (consumer_removable/industrial_removable/consumer_embedded/industrial_embedded)、imsi_secondary_1/2/3、imei + imei_lock_enabled、四方归属链 (supplier_id + operator_id + reseller_id + customer_id)
- Q: 企业 M2M 认证与 Webhook — CMP.xlsx 为企业客户定义了 api_key、api_secret_hash、webhook_url 字段。是否新增企业 API Key 认证能力？ → A: 采用 CMP.xlsx 方案 — customers 表新增 api_key (UNIQUE)、api_secret_hash (BYTEA)、webhook_url 字段，支持企业 M2M API Key 认证与 JWT 认证并行

## Requirements *(mandatory)*

### Functional Requirements

**租户与权限**：
- **FR-001**: 系统 MUST 支持"供应商 -> 代理商 -> 企业 -> 部门/项目"四级组织层级
- **FR-002**: 系统 MUST 实现 RBAC 权限模型（系统管理员/代理商角色/企业角色），数据默认最小可见最小可操作
- **FR-003**: 系统 MUST 支持白标能力（代理商自定义品牌/域名/Logo）
- **FR-004**: 系统 MUST 维护供应商-运营商多对多关联，禁止创建未关联运营商的供应商
- **FR-005**: 系统 MUST 对关键操作记录审计日志（组织/权限/SIM/资费/数据操作）

**企业管理**：
- **FR-006**: 系统 MUST 支持企业三态管理（ACTIVE/INACTIVE/SUSPENDED），状态变更实时生效并触发事件通知
- **FR-007**: 系统 MUST 保留企业 `autoSuspendEnabled` 配置（默认 Disabled，当前版本不用于自动状态控制）

**SIM 生命周期**：
- **FR-008**: 系统 MUST 以 ICCID 为唯一索引管理 SIM 卡
- **FR-009**: 系统 MUST 实现 5 状态生命周期（INVENTORY/TEST_READY/ACTIVATED/DEACTIVATED/RETIRED）
- **FR-010**: 系统 MUST 保持 SIM 状态与上游 CMP 对齐（上游为权威源）
- **FR-011**: 系统 MUST 禁止 ACTIVATED 直接到 RETIRED（必须先 DEACTIVATED）
- **FR-012**: 系统 MUST 支持批量 SIM 导入（异步 job，上限 10 万条）
- **FR-013**: 系统 MUST 在企业 SUSPENDED 时禁止企业用户复机
- **FR-014**: 系统 MUST 支持拆机承诺期门槛校验

**产品包与资费**：
- **FR-015**: 系统 MUST 支持 4 种资费计划类型（One-time/SIM Dependent Bundle/Fixed Bundle/Tiered Pricing）
- **FR-016**: 系统 MUST 产品包以 ID 绑定四模块（Price Plan、Carrier Service、Control Policy、Commercial Terms）
- **FR-017**: 系统 MUST 产品包变更次月生效
- **FR-018**: 系统 MUST 支持 Zone-based PAYG Rates 作为兜底费率
- **FR-019**: 系统 MUST 支持控制策略（限速/达量断网）

**订阅管理**：
- **FR-020**: 系统 MUST 支持 SIM 订阅 1 个主数据产品包 + N 个叠加包（主套餐同一时间段互斥）
- **FR-021**: 系统 MUST 主套餐变更次月生效
- **FR-022**: 系统 MUST 支持退订（到期退订/立即退订），当月不退费

**计费引擎**：
- **FR-023**: 系统 MUST 基于高水位原则计算月租费（ACTIVATED > DEACTIVATED > 其他）
- **FR-024**: 系统 MUST 实现 Waterfall Logic 用量匹配（叠加包优先 -> 范围最小优先 -> 主套餐兜底 -> Out-of-Profile）
- **FR-025**: 系统 MUST 对 Out-of-Profile 用量不扣减任何套餐配额，独立按 PAYG 计费并触发告警
- **FR-026**: 系统 MUST 支持 SIM Dependent Bundle 动态累加池额度（高水位 activatedSimCount × perSimQuotaKb）
- **FR-027**: 系统 MUST 阶梯计费采用分段累进（Progressive）
- **FR-028**: 系统 MUST 计费结果可追溯（inputRef + ruleVersion + calculationId）

**账单与出账**：
- **FR-029**: 系统 MUST 支持自动出账（T+N 日触发，N 可配置）
- **FR-030**: 系统 MUST 支持三级账单结构（企业汇总/分组/SIM 明细）
- **FR-031**: 系统 MUST 已发布账单不可篡改，差异通过 Credit/Debit Note 处理
- **FR-032**: 系统 MUST 对迟到话单自动生成调账单草稿

**信控与催收**：
- **FR-033**: 系统 MUST 实现 Dunning Process（逾期提醒与风险等级），不自动变更企业状态
- **FR-034**: 系统 MUST 支持复机恢复但不自动批量复机

**集成**：
- **FR-035**: 系统 MUST 提供 RESTful API over HTTPS (JSON) + OpenAPI 3.0 文档
- **FR-036**: 系统 MUST 支持 API Key + OAuth2/OIDC 认证
- **FR-037**: 系统 MUST 实现多供应商虚拟化适配层（SPI + Adapter Pattern）
- **FR-038**: 系统 MUST 南向指令支持幂等（idempotencyKey）

**可观测性**：
- **FR-039**: 系统 MUST 实现统一事件目录（SIM_STATUS_CHANGED/SUBSCRIPTION_CHANGED/BILL_PUBLISHED/PAYMENT_CONFIRMED/ALERT_TRIGGERED/ENTERPRISE_STATUS_CHANGED）

**实体建模（CMP.xlsx 对齐）**：
- **FR-040**: 系统 MUST 使用独立表建模（resellers、customers、suppliers、business_operators、operators），废弃通用 tenants 表
- **FR-041**: 系统 MUST 维护 business_operators 表用于业务运营商主数据；operators 维护 supplier_id + operator_id 关联与 operator_id 业务索引
- **FR-042**: 系统 MUST 维护 upstream_integrations 表（supplier_id + operator_id 唯一约束），含 API 端点和加密凭证、CDR 配置

**RBAC 权限（CMP.xlsx 对齐）**：
- **FR-043**: 系统 MUST 实现 RBAC 三表模型（permissions + roles + role_permissions），含 38+ 权限码覆盖 8 个功能模块
- **FR-044**: 系统 MUST 支持 7 种预置角色（platform_admin、reseller_admin、reseller_sales_director、reseller_sales、reseller_finance、customer_admin、customer_ops），按 scope (platform/reseller/customer) 层级隔离

**SIM 卡扩展（CMP.xlsx 对齐）**：
- **FR-045**: 系统 MUST 支持 SIM 卡形态分类（form_factor ENUM: consumer_removable / industrial_removable / consumer_embedded / industrial_embedded / automotive_grade_embedded / other）
- **FR-046**: 系统 MUST 支持多 IMSI（primary + 3 secondary），用于 eUICC / Multi-IMSI 场景
- **FR-047**: 系统 MUST 支持 IMEI 锁定（imei_lock_enabled），绑定首次上报设备，变更需管理员解锁并审计
- **FR-048**: 系统 MUST 维护 SIM 四方归属链（supplier_id + operator_id + reseller_id + customer_id），全链路可追溯

**企业 M2M 认证（CMP.xlsx 对齐）**：
- **FR-049**: 系统 MUST 支持企业 API Key 认证（api_key + api_secret_hash），与 JWT 认证并行，用于 M2M 集成场景
- **FR-050**: 系统 MUST 支持 SM-DP+ 系统配置（含 host_fqdn、oid、environment、status 与 eSIM 安全分发所需字段）
- **FR-051**: 系统 MUST 支持 eSIM Profile 独立建模与状态管理（含 matching_id + eid 成对校验与 SM-DP+ 远程状态跟踪）
- **FR-052**: 系统 MUST 在 Network Profiles 域提供 Carrier Service 与 Control Policy 的创建、更新、查询能力
- **FR-053**: 系统 MUST 在 Price Plans 域提供 Commercial Terms 的创建、更新、查询能力

### Key Entities

- **Supplier（供应商）**: 独立表 `suppliers`，上游 CMP 对接对象，UUID ID，name UNIQUE，status (active/suspended)
- **Public Info（公共信息）**: 独立表 `public_infos`，公共信息目录，含 MCC/MNC、国家、频段  
- **Business Operator（业务运营商）**: 独立表 `business_operators`，业务运营商字典（operator_id + mcc/mnc + name）
- **Operator（供应商运营商关联）**: 独立表 `operators`，供应商-运营商关联与业务 operator_id 索引
- **Upstream Integration（上游集成）**: 独立表 `upstream_integrations`，(supplier_id, operator_id) UNIQUE，含 API 端点/密钥/CDR 配置
- **SM-DP+ System**: 独立表 `smdp_systems`，eSIM Profile 生成/分发系统，status (active/deactivated/suspended)，environment (test/production)
- **Reseller（代理商）**: 独立表 `resellers`，运营平台主体，status (active/deactivated/suspended)，含 contact_email/contact_phone
- **Customer（企业客户）**: 独立表 `customers`，核心租户对象，reseller_id FK，status (active/overdue/terminated)，含 api_key/api_secret_hash/webhook_url 用于 M2M 认证
- **Department（部门）**: 企业下一级组织，计费主体最小粒度
- **Permission（权限）**: 独立表 `permissions`，code UNIQUE，38+ 权限码覆盖 8 个模块
- **Role（角色）**: 独立表 `roles`，code UNIQUE，7 种预置角色，scope (platform/reseller/customer)
- **User（用户）**: 独立表 `users`，email 唯一，关联 role_id + 可选 reseller_id/customer_id
- **SIM Card（SIM 卡）**: 独立表 `sim_cards`（原 sims），ICCID UNIQUE，5 状态生命周期，form_factor ENUM，multi-IMSI，IMEI 锁定，四方归属链 (supplier+operator+reseller+customer)
- **eSIM Profile**: 独立表 `esim_profiles`，ICCID UNIQUE，matching_id + eid 成对校验，SM-DP+ 远程状态跟踪，四方归属链 (supplier+operator+reseller+customer)
- **Subscription Package（产品包）**: 计费规则与运营商能力的载体，绑定一个 Price Plan
- **Price Plan（资费计划）**: 定义计费类型与规则，4 种类型
- **Subscription（订阅）**: SIM 与产品包的实例化，包含生效时间/状态/首次订阅时间
- **Bill（账单）**: 按账期生成的费用汇总，三级结构，状态流转
- **Adjustment Note（调账单）**: Credit Note / Debit Note，不可篡改已发布账单的替代机制
- **Job（异步任务）**: 批量操作载体，含 jobId/status/progress
- **Event（事件）**: 统一事件目录中的业务事件，含 eventId/eventType/payload

### 高频定时任务（Scheduler）
- 时区口径：所有定时任务按系统时区执行（MVP 不支持按 reseller/customer 独立时区调度）
- 上游用量拉取（API）：按供应商配置频率执行，默认每 30 分钟，拉取 SIM 级用量
- 达量断网/达量限速检查：每 10 分钟执行，触发断网或限速
- SFTP 话单下载：按供应商配置频率执行，默认每 60 分钟
- 用量预警通知：可配置频率，默认每 2 小时
- SIM 状态同步：按供应商配置频率执行，默认每 5 分钟，拉取最新 SIM 状态

### 日级任务（Daily Scheduler）
- 生成日级用量汇总：每日凌晨汇总当日用量，更新 `usage_daily_summary`
- 恢复日限速：每日凌晨解除上一日执行的日限速策略
- 检查测试期到期：每日凌晨处理测试期到期 SIM 状态
- 检查承诺期到期：每日凌晨标记可拆机 SIM，供 Portal 展示最早可拆机日

### 月级任务（Monthly Scheduler）
- 生成月级用量汇总：每月 1 日凌晨汇总上月用量，更新相应数据库表
- 恢复月限速：每月 1 日凌晨解除上月执行的月限速策略
- 恢复月断网：每月 1 日凌晨解除上月达量断网策略导致的停机
- 执行主套餐变更：月末取消当前主套餐；次月 1 日凌晨订阅目标主套餐
- 计费出账：每月 1 日凌晨冻结上月用量，生成企业账单

## 非功能需求（NFR）与技术架构

### 技术栈约束
- 主要开发语言：TypeScript (Node.js)
- 运行时：Node.js（LTS 版本）
- 主数据库：Supabase（托管 PostgreSQL + Auth + Realtime + Storage）
- 部署平台：Vercel（Serverless Functions）
- 币种策略：按代理商固定币种（企业继承）

### 可扩展性与性能
- 微服务架构（DDD）：资源域/计费域/客户域/集成域（以 Serverless Functions 模块化实现）
- SIM 状态轨迹表（`sim_state_history`）：Type 2 SCD
- 用量预聚合表（`usage_daily_summary`）：SIM + Day + Zone
- 数据分片：话单按 SupplierID+账期 或 ICCID 分表（PostgreSQL 分区表）
- 归档：在线 6 个月，冷存储归档
- 缓存：Supabase 内置缓存 + Vercel Edge Cache（替代独立 Redis，MVP 阶段简化）
- 异步任务：Supabase Edge Functions / Vercel Cron Jobs / pg_cron 替代传统消息队列（MVP 阶段）

### 高并发与 I/O 模型
- Serverless Functions：Vercel 按需扩缩，天然支持并发
- 事件驱动：Supabase Realtime（基于 PostgreSQL LISTEN/NOTIFY）+ Database Webhooks 替代独立 Kafka/RabbitMQ（MVP 阶段）
- 批量任务：Vercel Cron Jobs 触发 + Supabase pg_cron 调度
- 未来扩展：商用阶段可引入独立消息队列（Kafka/RabbitMQ）和容器化服务

### 高可用与容灾
- Vercel 全球边缘网络 + Supabase 托管高可用 PostgreSQL
- RPO < 5 分钟，RTO < 30 分钟（依赖 Supabase 自动备份策略）
- 熔断器（Circuit Breaker）：上游 API 防级联故障（应用层实现）
- 降级：优先保证连接可用，计费可延迟

### 安全与合规
- TLS 1.2+ 全链路
- AES-256 敏感字段存储加密
- GDPR：支持被遗忘权（删除/匿名化个人身份信息，保留业务统计与合规所需最小元数据）
- 审计日志 WORM 存储
- PCI-DSS：支付网关 Tokenization

### 数据保留
- 话单/用量明细：在线 6 个月，归档 5 年
- 审计日志：保留 2 年
- 账单数据：永久保留（或至少 10 年）
- RETIRED 通信元数据：永久保留（ICCID/IMSI/激活日期/用量/产品包 ID/状态变更日志）
- 被遗忘权处理：对企业/用户 PII 做不可逆匿名化；保留 ICCID/IMSI 等合规必需字段与计费审计链路
- 企业 SUSPENDED 超过 2 年：清理个人身份信息，保留企业 ID 与业务关联键

### 量化目标
- 连接规模：首期 10 万 SIM（12 个月），未来 100 万
- 日均话单量：500 万条/日，峰值 1000 TPS
- SLA：可用性 99.9%，核心接口 P95 延迟 300ms
- 上线里程碑：PoC（T+1月）/ 内测（T+3月）/ 商用（T+5月）

### 非目标（本期不做）
- 物理卡片物流管理
- 核心网元功能（HLR/HSS/PGW）
- 实时流控（硬实时）
- C 端用户计费

## MVP 范围

MVP 目标：8 周内交付最小闭环。

- 交付形态：RESTful API（OpenAPI 3.0）+ 轻量内部管理后台（非客户可见）
- 租户与用户：企业创建、RBAC、审计
- SIM：入库导入、激活/停机、查询详情
- 用量：查询当月汇总
- 账务：余额/套餐余量展示
- 诊断：连接状态查询、重置连接

## 计费黄金用例集（Golden Test Cases）

**统一约定**：
- 计费周期：自然月（CALENDAR_MONTH）
- 流量单位：KB 向上取整
- 用量维度：`iccid + visitedMccMnc + eventTime`
- 用量命中：叠加包优先 -> 范围最小优先 -> 主套餐兜底 -> Out-of-Profile
- Out-of-Profile：不扣减任何套餐配额，按 paygRates 计费 + 异常漫游告警
- 月租费：高水位口径
- 迟到话单：生成调账单草稿下期结算

### 基础用例（用量匹配与扣减）

| Case | 前置订阅 | visitedMccMnc | 用量 | 期望命中 | 期望扣减/计费 | 期望告警 |
|---|---|---|---:|---|---|---|
| U-01 | 主：Global 1GB（覆盖全球） | 234-15 | 100MB | 主套餐 | 扣减主套餐配额 100MB | 无 |
| U-02 | 主：Europe 1GB；叠加：France 500MB | 208-01 | 100MB | 叠加（France） | 扣减 France 配额 100MB | 无 |
| U-03 | 主：Europe 1GB；叠加：France 500MB | 262-02 | 100MB | 主套餐（Europe） | France 不覆盖，扣减 Europe 配额 100MB | 无 |
| U-04 | 主：Europe 1GB；叠加：France 500MB；叠加：EU+UK 800MB | 208-01 | 100MB | 叠加（France） | 多叠加覆盖时范围更小优先 | 无 |
| U-05 | 主：Europe 1GB（不含阿联酋）；PAYG Zone4=0.02 USD/KB | 424-02 | 10MB | Out-of-Profile | 不扣减套餐；按 PAYG 计费 | 异常漫游 |
| U-06 | 主：Europe 1GB；PAYG 未覆盖 999-99 | 999-99 | 10MB | Out-of-Profile | 不扣减；默认阻断或高价告警 | 异常漫游+规则缺失 |
| U-07 | 主：Global 1GB（配额已耗尽）；overageRate=0.01/KB | 234-15 | 10MB | 主套餐 | 按套外单价计费 | 可选 |

### 非活跃状态用量（异常/漏控）

| Case | SIM 状态 | 用量来源 | 期望处理 | 期望告警 |
|---|---|---|---|---|
| U-08 | DEACTIVATED | CDR | 按 Out-of-Profile 独立计费 | 异常用量 |
| U-09 | RETIRED | CDR | 进入异常队列，不生成正常扣费 | 高优先级异常 |

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
| A-01 | 2026-02（已出账） | PUBLISHED | 生成 Adjustment Note 草稿，下期结算 |
| A-02 | 2026-02（未出账） | GENERATED | 进入当期归集计费 |

### Job/审计/可追溯用例

| Case | 操作 | 期望产物 |
|---|---|---|
| O-01 | PATCH /sims/{iccid} 触发停机 | jobId + 审计日志(requestId/before/after) + SIM_STATUS_CHANGED 事件 |
| O-02 | 计费重算 | 关联 inputRef(fileId/lineNo) + ruleVersion + calculationId |

## 决策记录（Decision Log）

- [x] 租户层级：供应商 -> 代理商 -> 企业；企业支持部门/项目
- [x] 白标能力：代理商自定义品牌/域名/Logo
- [x] 计费主体最小粒度：企业/部门（两级）
- [x] 计费模式：支持 one-time, SIM Dependent Bundle, Fixed Bundle, Tiered Pricing
- [x] 资费分层：取消两层资费；本期仅实现资费_企业，不实现资费_运营商
- [x] 阶梯计费口径：分段累进（Progressive），非全量按档
- [x] 共享池口径：按产品包计费规则定义
- [x] 异步任务：支持 jobId + 查询进度；企业侧 webhook 非 MVP 必需
- [x] SIM 资产标识：ICCID 唯一索引；IMEI Lock 默认关闭
- [x] SIM 状态机：INVENTORY/TEST_READY/ACTIVATED/DEACTIVATED/RETIRED
- [x] SIM 状态同步：上游 Notification + 下发 CMP API
- [x] 测试期到期：支持 PERIOD_ONLY / QUOTA_ONLY / PERIOD_OR_QUOTA（默认）
- [x] 订阅计数口径：订阅生效时间决定计数；月内变更次月生效
- [x] 用量归集与时区：配置供应商话单时区并换算；按系统时区自然月归集
- [x] 话单交付：SFTP 批量为主，API 为辅
- [x] 数据保留：话单归档 5 年；在线查询 6 个月
- [x] 北向：REST API + Webhook（HMAC）；API Key + OAuth2
- [x] 南向：适配层模式；异步指令 + 幂等
- [x] 容量规划：日均 500 万事件，峰值 1000 TPS
- [x] SLA：可用性 99.9%，P95 < 300ms
- [x] 批量处理：单次 10 万级
- [x] MVP 周期：8 周
- [x] D-23 计费时区：GMT+0。月初 = 每月 1 日 00:00:00 GMT+0，月末 = 月末最后一天 23:59:59 GMT+0
- [x] D-24 高水位采样粒度：按状态变更事件（sim_state_history）。当月出现过 ACTIVATED 状态（哪怕 1 秒）即按全额月租费计
- [x] D-25 Fixed Bundle 共享池超额：totalQuotaKb 为共享池，超额后走套外计费（Out-of-Profile PAYG），有专门资费定义（overageRatePerKb / paygRates），不存在并发扣减问题
- [x] D-26 零用量出账：月租费按 SIM 高水位状态决定（活跃→全额月租费、停机→停机保号费、不满足条件→不收）；流量费 = 0
- [x] D-27 跨月用量归属：CDR 跨月数据会话的用量归属到会话开始所在月份（算上个月）
- [x] D-28 MVP 范围裁剪：MVP 仅实现 3 个角色（platform_admin / reseller_admin / customer_admin）、2 种资费类型（Fixed Bundle / One-time）、L1+L3 账单结构；白标/Dunning/多供应商 SPI/告警去重 推迟至 V1.1
- [x] D-29 MVP 不做前端 Portal：8 周全部投入后端 API + 计费引擎，前端用 Swagger UI + Postman Collection 代替
- [x] D-30 ENUM 命名规范：所有 ENUM 值统一使用大写（与 sim_status 一致）；reseller_status = ACTIVE/DEACTIVATED/SUSPENDED

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 系统支持 10 万张 SIM 管理，核心接口 P95 延迟 < 300ms
- **SC-002**: 计费引擎准确实现高水位月租费计算，通过全部 Golden Test Cases（U-01~U-09, M-01~M-04, C-01~C-03, A-01~A-02, O-01~O-02）
- **SC-003**: 多租户数据隔离 100% 有效（跨租户数据不可见）
- **SC-004**: SIM 状态与上游 CMP 保持一致（Reconciliation 差异率 < 0.1%）
- **SC-005**: 账单生成准确率 > 99.99%（基于用量/状态轨迹/资费规则的可追溯验证）
- **SC-006**: 系统可用性达到 99.9%
- **SC-007**: 单次批量导入支持 10 万条 SIM
- **SC-008**: 异步任务（Job）可查询进度且结果完整
- **SC-009**: 所有关键操作（Provisioning/Billing/权限变更）100% 记录审计日志
- **SC-010**: 告警投递成功率 > 99%（含重试）
- **SC-011**: 迟到话单 100% 通过调账单机制处理
- **SC-012**: PAYG 计费 100% 触发异常漫游告警
- **SC-013**: Dunning Process 按时间轴准确触发状态流转
- **SC-014**: MVP 在 8 周内交付可演示最小闭环
