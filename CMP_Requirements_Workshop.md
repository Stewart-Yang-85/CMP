# CMP 需求澄清工作坊（讨论用）

本文件用于把“粗需求”快速落到可开发的范围：明确角色、边界、关键流程、约束与验收口径。我们每讨论一项，就在对应位置补齐结论，并把未决项写入“问题清单”。

## 0. 背景与目标

### 0.1 业务背景

- 平台定位：Reseller System（面向代理商运营与企业自助）
- 上游集成：对接上游供应商 CMP（供应商侧部署；向 Reseller System 提供 API、Web Portal、SFTP 等接口）
- 下游服务：Reseller System 向企业提供 API 接口与 Web Portal
- 目标客户：代理商的下游企业（含其部门/项目，如需要）
- 业务模式：代理商转售（代理商通过 Reseller System 向企业提供连接管理服务）

- 名词约定（结论）：
  - 供应商（Supplier）：对外提供 CMP 能力的上游集成方（对接对象）
  - 运营商（Carrier/MNO）：网络归属与结算主体（以 MCC/MNC 识别）；可能与供应商为同一主体，也可能由供应商聚合多个运营商网络
  - 数据要求（结论）：无论模式 a/b，系统必须完整记录“运营商-供应商”的关联关系；供应商创建时必须至少关联一个运营商（MCC+MNC 有效）

- 业务模式（两种原始模式）：
  - 模式 a（当前已覆盖）：运营商 CMP -> Reseller -> 企业
  - 模式 b（需要新增）：运营商 CMP -> 供应商 -> Reseller -> 企业

- 统一模式（结论）：供应商 -> Reseller -> 企业
  - 兼容模式 a：当供应商即运营商 CMP 时，统一模式退化为“运营商 CMP（供应商）-> Reseller -> 企业”
  - 兼容模式 b：当供应商为独立实体时，Reseller 直接对接供应商 CMP；供应商侧负责对接一个或多个运营商 CMP

- 统一模式架构图（结论）：

```text
                  （模式 a）
   运营商CMP(供应商) ─────────► Reseller System ─────────► 企业 Portal/API

                  （模式 b）
   运营商CMP(底层) ─► 供应商CMP(对接对象) ─► Reseller System ─► 企业 Portal/API

                  （统一模式）
        供应商CMP(对接对象) ───────────────► Reseller System ─────────► 企业 Portal/API
        └─ 可聚合多个运营商网络（MCC/MNC），用于SIM归属、话单来源与稽核对账
```

- 业务角色：
  - 供应商（多个）：Reseller 从多个供应商采购 SIM Profile 与数据业务资源，并通过其 CMP 接口交付能力与数据
  - 运营商（多个）：底层网络归属方（MCC/MNC）；在模式 a 中与供应商重合，在模式 b 中由供应商聚合
  - 代理商（我们）：运营商能力/资源整合、产品包定制、企业侧交付与运营
  - 企业（多个）：拥有定制产品包与资费计划、已开通 SIM 卡列表、月度费用与账单
- 资源采购与转售：
  - 从供应商采购：SIM Profile；数据业务（按批发费率或产品包形式）
  - 向企业销售：SIM 卡；产品包
- 主要网络制式：4G / 5G / NB-IoT / Cat.1 / 其他：

### 0.4 系统边界与集成概览（先定边界，避免需求发散）

- Reseller System：企业侧统一入口（门户/API）、多租户与权限、业务编排、对账出账、告警/报表、审计、异步任务
- 供应商 CMP（上游 CMP）：上游资源与网元能力的提供方（开通/停复机/套餐变更/状态查询/话单/用量等），通过 API/Web/SFTP 提供数据与操作能力
- 关键设计点：
  - “权威数据源”归属（SIM 状态、用量、话单、资费）
  - 同步/异步与一致性（操作回执、结果确认、重试幂等）
  - 数据落库范围（仅缓存/全量镜像/审计留痕）

### 0.5 关系模型（结论）

- 供应商 -> SIM Profile 批次：一个供应商可提供多批 SIM Profile 给 Reseller
- 供应商 <-> 运营商（结论）：多对多关联；供应商可聚合一个或多个运营商网络（MCC/MNC），用于 SIM 归属与对账口径
- SIM Profile 批次 -> 产品包：每一批 SIM Profile 可订阅多个不同的产品包
- 产品包 -> 资费计划（Price Plan）：每个产品包绑定且仅绑定一个资费计划
- 代理商 -> 企业：代理商可向多个企业销售产品包
- 企业 -> 产品包：每个企业可订阅多个不同的产品包
- SIM -> 产品包（结论）：每张 SIM 可订阅 **1 个主数据产品包（Main Plan）** 与 **N 个叠加包（Add-on）**；同一时间段内主数据产品包互斥
- 计费聚合口径：同一企业下订阅同一产品包的所有 SIM，按该产品包计费规则统一计费（企业维度聚合）

- 关联约束（结论）：
  - 每个 SIM Profile（ICCID）必须关联一个运营商（Carrier，MCC+MNC）
  - 每个 SIM Profile 批次必须关联一个供应商（Supplier，对接对象）
  - 每笔上游数据业务资源交易必须记录供应链路径（运营商 -> 供应商 -> 代理商），用于审计与对账

### 0.2 目标（必须可量化）

- 连接规模：首期约 10 万张 SIM（12 个月），未来支持平滑扩展至 100 万
- 日均话单量 / 用量事件量：初期预估 500 万条/日（按每卡每日 50 次交互测算），峰值支持 1000 TPS
- 关键 SLA（默认建议，可调整）：可用性 99.9%，核心接口 P95 延迟 300 ms
- 上线里程碑：PoC（T+1月）/ 内测（T+3月）/ 商用（T+5月）

#### 0.2.1 默认建议（可调整）

- 可用性：99.9%
- 核心接口 P95 延迟：300ms

### 0.3 非目标（本期不做）

- **物理卡片物流管理**：不包含 SIM 卡实体的仓储、发货与物流追踪（仅管理逻辑库存）
- **核心网元功能**：不提供 HLR/HSS、PGW/GGSN 等核心网元功能，不直接承载信令或数据流量
- **实时流控（硬实时）**：不承诺毫秒级会话阻断（依赖上游 CMP 能力，本系统侧重准实时计费与管控）
- **C 端用户计费**：系统面向 B2B（代理商与企业），不支持直接面向个人消费者的充值/计费体系
## 1. 角色与租户模型

### 1.1 租户层级

- 结论：必须支持“供应商 -> 代理商 -> 企业”三级；企业下支持再分部门/项目（用于权限与成本归集）
  - 兼容：当供应商=运营商 CMP 时，等价于原“运营商 -> 代理商 -> 企业”
- 背景：当前业务模式为代理商转售（Reseller System 对接上游供应商 CMP，并向企业提供门户/API）
- 结论：支持白标（代理商自定义品牌/域名/Logo）
- 结论：计费主体最小粒度为企业/部门（两级）

### 1.2 用户角色（RBAC）

- 系统管理员：平台级超级管理员（仅内部）；用于租户初始化、全局配置、运维与审计
- 供应商侧角色：本期不定义（供应商仅作为上游资源/能力提供方，通过 CMP 接口交互）
- 代理商：管理员 / 销售总监 / 销售 / 财务
- 企业：管理员 / 运维

### 1.3 权限边界（必须写清）

- 结论：平台按“系统管理员 / 代理商组织 / 企业组织 / 部门”分层隔离与授权，数据默认最小可见、最小可操作

- 系统管理员（平台级，仅内部）：
  - 权限范围：
    - 全局访问权限（所有供应商/运营商、所有代理商、所有企业）
    - 无任何数据隔离限制
  - 主要操作：
    - 代理商管理：创建代理商账户，维护代理商基础信息
    - 权限分配：为代理商设置初始管理员账户并分配权限
    - 系统配置：维护全局系统参数与业务规则
    - 运维监控：系统运行状态监控与异常处理
    - 审计日志：查看所有操作日志与安全审计

- 代理商组织内角色：
  - 管理员：
    - 权限范围：
      - 该代理商组织及其下属所有企业的完整权限
      - 可访问代理商组织内所有业务数据
    - 主要操作：
      - 用户管理：创建销售总监、销售、财务等内部用户账户
      - 企业接入：新增企业并创建企业管理员账户
      - 销售分配：将企业分配给指定的销售总监
      - 产品管理：设计产品包与资费计划
      - SIM 卡管理：SIM 卡库存管理与分配
      - 订阅管理：为企业 SIM 卡订阅产品包
  - 销售总监：
    - 权限范围：
      - 仅限被分配的企业集合
      - 可管理下属销售用户（在本代理商组织范围内）
    - 主要操作：
      - 销售团队管理：分配企业给下属销售
      - 业务监控：查看所辖企业的业务数据报表
      - 销售支持：协助销售处理企业需求
  - 销售：
    - 权限范围：
      - 仅限被分配的企业集合
      - 无跨企业访问权限
    - 主要操作：
      - SIM 卡分配：为企业分配可用 SIM 卡
      - 产品订阅：为企业 SIM 卡开通产品包
      - 客户服务：处理企业日常业务请求（在授权范围内）
  - 财务：
    - 权限范围：
      - 代理商组织维度的财务数据（只读）
      - 无修改权限
    - 主要操作：
      - 财务报表：生成代理商维度的收支报表
      - 账单管理：查看企业缴费记录
      - 资金监控：代理商账户余额监控

- 企业组织内角色：
  - 管理员：
    - 权限范围：
      - 该企业及其所有部门的完整权限
      - 可访问企业所有业务数据
    - 主要操作：
      - 部门管理：创建与维护企业部门结构
      - 用户管理：创建部门运维用户
      - SIM 卡管理：查看与管理企业所有 SIM 卡
      - 权限分配：为部门运维分配操作权限
  - 运维：
    - 权限范围：
      - 仅限所属部门分配的 SIM 卡
      - 按授权清单限制操作类型
    - 主要操作：
      - SIM 卡管理：部门 SIM 卡状态监控
      - 故障处理：SIM 卡异常处理
      - 日常运维：执行授权的 SIM 卡操作

- 供应商侧：本期不作为“使用系统的业务用户”，仅作为上游能力与数据提供方（不定义供应商侧 RBAC）

- 代理商对企业数据可见性（结论）：代理商侧需要访问所辖企业的用量明细/话单明细与账单（用于客服、对账与运营）；财务角色仅访问汇总报表

- 操作审计（结论）：以下操作必须记录审计日志
  - 组织与权限：加载企业、企业分配（销售总监/销售）、创建/变更用户与角色、部门创建与人员归属
  - SIM 生命周期：入库导入、激活、停机、复机、销户
  - 资费与订阅：产品包/资费计划创建与变更、SIM 订阅/取消订阅、APN/限速策略变更
  - 数据操作：导入导出、账单生成与导出、对账差异处理

### 1.4 上游主数据录入与关联（供应商/运营商）（结论）

- 业务模式关联要求（结论）：
  - 系统必须维护“运营商-供应商”的双向关联（多对多），用于覆盖模式 a 与模式 b
  - 在统一模式（供应商 -> Reseller -> 企业）中，所有上游集成以“供应商”为对接对象，同时保留到底层“运营商（MCC/MNC）”的归属与结算口径

- 供应商（Supplier）信息录入标准（结论）：
  - 必填字段：
    - 供应商 ID：系统自动生成 UUID（不可变）
    - 供应商名称：营业执照全称
  - 关联约束：禁止创建未关联运营商记录的供应商；供应商至少关联 1 个运营商（MCC+MNC 有效）
  - 存储要求：供应商主数据加密存储；保留历史变更记录（可追溯到变更前后值与操作人）

- 运营商（Carrier/MNO）信息录入标准（结论）：
  - 必填字段：
    - 运营商 ID：符合 ITU-T E.212（建议用 MCC+MNC 作为主键表达，例如 46000/460001）
    - 运营商名称：官方注册名称
    - MCC：3 位数字，符合 ITU-T E.212
    - MNC：2-3 位数字，符合 ITU-T E.212
  - 验证要求：运营商 MCC/MNC 必须通过 GSMA 分配表校验（允许系统管理员在紧急场景下人工覆写，但必须审计）

- 数据关联规则（结论）：
  - SIM Profile：必须绑定运营商（MCC+MNC）与供应商（对接对象）
  - 数据业务资源交易：必须记录完整供应链路径（运营商 -> 供应商 -> 代理商）
  - 关联索引：必须支持按“运营商-供应商-代理商”快速检索（用于对账、追溯与审计）

- 数据完整性约束（结论）：
  - 所有业务操作必须验证运营商 MCC/MNC 组合有效性（存在于运营商主数据且通过 GSMA 校验）
  - 数据修改需触发关联数据同步更新机制（例如变更供应商-运营商关联后，影响范围内的 SIM/产品包/对账归属需重算或标记待核对）

### 1.5 企业对象（Tenant）属性（建议字段）

企业是平台核心租户对象（代理商的下游客户组织），拥有独立的用户、部门/项目、SIM 资产、产品包与账单。

- 基础信息：
  - 企业 ID：平台内唯一标识
  - 企业名称：展示名
  - 企业状态：**ACTIVE** (正常) / **INACTIVE** (冻结) / **SUSPENDED** (欠费管控)
  - `autoSuspendEnabled`：是否允许自动信控（`true`=允许，`false`=豁免）
  - 归属代理商 ID：该企业属于哪个代理商组织
  - 创建时间、创建人（审计）

#### 1.5.1 企业状态（ACTIVE/INACTIVE/SUSPENDED）业务规则（结论）

- 创建默认值：代理商管理员在 Web Portal 创建新企业时，企业状态缺省为 ACTIVE

- **ACTIVE（正常可用）**：
  - 允许分配新 SIM 卡、创建新产品包订阅
  - 企业侧所有功能（管理/运维/查询）正常可用

- **INACTIVE（停止销售/冻结）**：
  - 场景：业务调整、合同到期不续签（但旧卡继续服务）
  - 限制：**禁止分配新 SIM 卡**、**禁止新增产品包订阅**
  - 允许：已分配的 SIM 卡仍可正常使用；企业仍可管理既有 SIM 卡（停复机/变更）与查询历史数据
  - 触发：仅代理商管理员可人工设置

- **SUSPENDED（欠费管控/风控）**：
  - 场景：信用额度耗尽、账单逾期未付、触发安全风控
  - 限制：
    - **禁止分配新 SIM 卡**、**禁止新增产品包订阅**
    - **禁止企业侧管理操作**（无法执行停复机/变更套餐，API 拒绝请求）
  - 连带动作（可配置）：
    - 默认：仅锁定操作，SIM 保持当前状态（防止误杀）
    - 强控模式：系统自动对该企业下所有 SIM 下发 **停机（Deactivate）** 指令
  - 触发：系统自动触发（信控/风控规则）或代理商管理员人工设置
  - 恢复：缴清欠费或解除风控后，恢复为 ACTIVE

- **状态转换**：
  - 状态变更实时生效
  - 必须记录操作日志（操作人/系统、时间、变更前后状态、原因）
  - 必须触发事件通知（事件类型：`ENTERPRISE_STATUS_CHANGED`），以便下游系统（如计费、网关）同步阻断或恢复服务

- 实现要求（结论）：
  - 数据库需持久化企业状态字段（枚举/约束）
  - Web Portal 提供清晰状态标识与启用/停用按钮
  - 所有状态相关操作需进行权限验证（仅代理商管理员）

- 组织结构：
  - 部门：企业下一级组织（计费主体最小粒度为企业/部门）
  - 项目：企业下可选维度（用于管理与归集；是否参与出账由后续规则决定）

- 企业管理员初始化：
  - 企业管理员用户：由代理商管理员加载企业时创建（或后续邀请）
  - 默认角色模板：企业管理员/运维（部门范围）

- 商业与出账信息（用于账单/发票）：
  - 账单抬头/企业名称（发票抬头）
  - 税号（可选）
  - 账单地址（可选）
  - 账单接收邮箱/联系人（可选）
  - 账单粒度偏好：企业汇总 / 按部门 / 按 SIM 明细（与 3.4 账单粒度保持一致）

- 业务资产关联（关系口径）：
  - 企业下 SIM 列表：企业已采购/归属的 SIM 卡集合
  - 企业产品包目录：为该企业定制的产品包与资费计划集合
  - 企业账单：按自然月/账期生成的账单与对账结果

## 2. SIM/连接资产与生命周期

### 2.1 资产对象与标识

- 管理对象：SIM 卡（包含实体 SIM 与 eSIM Profile）
- 结论：唯一索引采用 ICCID
  - 原因：无论实体 SIM（单 SIM Profile 单 IMSI / 单 SIM Profile 多 IMSI）、或 eSIM Profile，均有唯一 ICCID
- 设备绑定：IMEI Lock 非必须，缺省不启用设备绑定

#### 2.1.1 SIM 卡清单（大列表）字段定义（结论）

SIM 卡清单用于运营与企业自助查询，需支持大规模分页检索与导出。

- SIM Profile 信息：
  - ICCID：该 SIM 卡的唯一标识
  - IMSI：Primary IMSI；Secondary IMSI 1/2/3（可选）
  - MSISDN（可选）
  - SIM 卡形态（三选一）：SIM 实体卡 / SIM 实体卡（多 IMSI）/ eSIM 卡
  - Activation Code：仅适用于 eSIM 卡
- 供应商信息（必填）：供应商 ID、供应商名称（对接对象）
- 运营商信息（必填）：运营商 ID（E.212）、运营商名称、MCC、MNC
- SIM 状态：INVENTORY / TEST_READY / ACTIVATED / DEACTIVATED / RETIRED
- 企业归属：企业 ID（标识该 SIM 已销售/归属的企业）
- 产品包订阅：主计费产品包 ID（Data 业务主订阅；该 SIM 的全部产品包订阅列表在 SIM 详情页/接口中查看）
- 累计数据使用量：从该产品包计费周期开始至当前的累计用量（按 KB 向上取整展示；汇总口径以上游 CMP（供应商侧）话单/用量为准）
- 设备信息：当前服务设备 IMEI（可选；IMEI Lock 默认关闭但可用于展示与诊断）

### 2.2 生命周期状态机（结论写这里）

- 必需状态：INVENTORY, TEST_READY, ACTIVATED, DEACTIVATED, RETIRED
- 不需要：PRE_ACTIVATED（预激活）、QUARANTINED（风险隔离/风控锁定）、TRANSFERRED（租户迁移中）
- 状态迁移触发：
  - 手工操作
  - 自动规则（阈值）
  - 网元回调（开通/停机结果）
  - 上游通知（结论）：供应商 CMP 通过 API Notification 推送的状态变更

#### 2.2.1 状态定义与迁移规则（结论）

- INVENTORY（库存，初始状态）：
  - 触发来源：
    - 供应商通过批发渠道将 SIM Profile 提供给 Reseller
    - 代理商将该批 SIM 导入系统时，默认自动进入 INVENTORY
  - 允许操作：
    - 分配/销售给企业（进入 TEST_READY）
    - 支持批量操作与单 SIM 操作
    - 需记录审计日志（操作人、时间、目标企业等）

- TEST_READY（测试期）：
  - 测试期定义：
    - 由该 SIM 订阅的产品包 Commercial Terms 的 Test Period 定义
    - 测试期内可获得特定量的 Test Quota 数据配额（仅在测试期内有效，过期清零）
    - 测试期到期判定：由产品包 Commercial Terms 的 Test Expiry Condition 配置决定（默认 a 或 b 任一满足即到期）
      - a：Test Period 到期
      - b：Test Quota 完全耗尽
  - 迁移规则：
    - INVENTORY -> TEST_READY：
      - 触发条件：代理商通过 Web Portal 执行销售/分配操作
      - 需关联目标企业信息
      - 系统自动记录分配时间作为测试期开始时间
    - TEST_READY -> ACTIVATED：测试期到期自动触发（依据 Test Expiry Condition）
    - TEST_READY -> ACTIVATED：用户可通过 Web Portal/API 手工提前激活（需验证操作权限）
    - TEST_READY -> DEACTIVATED：用户可通过 Web Portal/API 手工停机（需验证操作权限）

- ACTIVATED（活跃）：
  - 功能定义：
    - SIM 可正常使用其订阅的产品包服务
    - 实时监控使用量与状态
  - 自动规则：按产品包 Control Policy 执行自动状态变更
    - 示例：达量断网（Cutoff）在月累计使用量到达阈值时，将 SIM 转换为 DEACTIVATED
  - 手工操作：
    - 用户可通过 Web Portal/API 将 ACTIVATED 转换为 DEACTIVATED
    - 禁止直接拆机/销户：不允许 ACTIVATED -> RETIRED，必须先停机（ACTIVATED -> DEACTIVATED）再拆机（DEACTIVATED -> RETIRED）
    - 所有操作需通过权限验证并记录审计日志

- DEACTIVATED（停机）：
  - 功能限制：
    - SIM 暂停使用其订阅的产品包服务
    - 保留所有配置信息与历史数据
  - 手工操作：
    - 用户可通过 Web Portal/API 将 DEACTIVATED 转换为 ACTIVATED
  - 拆机限制（结论）：
    - 仅代理商用户可在 Web Portal 上将 DEACTIVATED 转换为 RETIRED
    - 需二次确认并记录完整拆机审计信息
    - 判定条件：取该 SIM 所有产品包订阅中的“最大承诺期门槛”作为拆机门槛
      - 门槛计算：max(首次订阅时间_i + 承诺期_i)，遍历该 SIM 当前/历史订阅过的所有产品包
      - 允许拆机：当前时间 > 门槛

- RETIRED（拆机/退网，终态）：
  - 最终状态定义：
    - SIM 永久退出服务生命周期
    - 禁止所有业务操作与状态回退
    - 保留历史数据供后续审计查询
  - 系统处理：
    - 释放所有关联资源
    - 标记 SIM 为不可用状态

#### 2.2.2 状态对齐与上游通知（结论）

- 权威源：SIM 状态以上游 CMP（供应商侧）为准
- 对齐规则：Reseller System 内所有 SIM 状态需与上游 CMP（供应商侧）状态保持一致
- 同步机制：当收到上游 CMP（供应商侧）通过 API 下发的通知（Notification）时，根据通知中的状态变更更新本系统 SIM 状态，并记录审计日志

- 下发机制（结论）：当 Reseller System 内触发 SIM 状态变更（手工操作/自动规则）时，需调用上游 CMP（供应商侧）API 下发对应的状态变更指令
  - 状态变更指令的结果以上游 CMP（供应商侧）回执/通知为准；本系统需据此进行最终状态对齐

- 事件通知（结论）：SIM 状态变更（含 TEST_READY 到期）需触发事件通知机制（事件类型建议：SIM_STATUS_CHANGED）

#### 2.2.4 核心概念辨析：SIM 状态 vs 企业状态（结论）

为了避免混淆，需明确区分“企业状态”与“SIM 状态”的边界与交互逻辑。

- **1. 定义与作用域**
  - **企业状态（Enterprise Status）**：
    - **层级**：租户/合同层级（Business Level）。
    - **核心关注**：客户信誉、欠费情况、账户权限。
    - **状态集**：`ACTIVE`（正常）、`SUSPENDED`（欠费管控）、`INACTIVE`（冻结/流失）。
    - **影响**：决定了“能不能操作”（权限）、“能不能新购”。
  
  - **SIM 状态（SIM Status）**：
    - **层级**：资产/网元层级（Asset/Network Level）。
    - **核心关注**：网络连接能力、计费模式。
    - **状态集**：`INVENTORY`、`TEST_READY`、`ACTIVATED`、`DEACTIVATED`、`RETIRED`。
    - **影响**：决定了“能不能上网”（网络功能）、“收多少钱”（月租/停机保号）。

- **2. 交互逻辑（联动而非绑定）**
  - **独立性**：SIM 状态是客观物理状态（以运营商侧为准）。即使企业处于 `SUSPENDED`，若系统未能成功执行停机指令，SIM 仍可能处于 `ACTIVATED`（并产生费用）。
  - **单向驱动**：
    - **场景**：企业欠费 -> 企业状态变更为 `SUSPENDED`。
    - **动作**：系统（Dunning Process）检测到 `SUSPENDED` -> 触发异步任务 -> 批量调用 SPI 对名下 SIM 执行 `deactivateSim`。
    - **结果**：SIM 状态变更为 `DEACTIVATED`。
  - **计费原则**：计费引擎**只认 SIM 状态**。
    - 若企业 `SUSPENDED` 但 SIM 仍 `ACTIVATED`（例如漏停机）：收全额月租。
    - 若企业 `SUSPENDED` 且 SIM 已 `DEACTIVATED`：收停机保号费。

### 2.3 批量与异步任务

- 批量规模（默认建议，可调整）：单次导入/批量操作上限 10 万条
- 异步任务的期望：
  - 必须返回 jobId 并可查询进度
  - 默认建议：企业侧不做 webhook 回调，采用 jobId 轮询查询结果
  - 可选增强：如需 webhook，则要求签名校验（HMAC）、重试（指数退避）、幂等（eventId/jobId）

#### 2.3.1 默认建议（可调整）

- 单次导入/批量操作上限：10 万条

#### 2.3.2 Job 状态与重试（结论）

- Job 状态：QUEUED / RUNNING / SUCCEEDED / FAILED / CANCELLED
- 查询字段：jobId、status、progress（processed/total）、createdAt、startedAt、finishedAt、errorSummary（如失败）
- 幂等（结论）：
  - 批量导入：同一批次导入需有 batchId（或文件 hash）用于去重，保证重复提交不产生重复数据
  - 南向指令：对上游 CMP（供应商侧）的变更指令需带 requestId/idempotencyKey，避免重复下发导致多次变更
- 重试（结论）：
  - 可重试错误：网络超时、5xx、限流等“可恢复错误”
  - 不重试错误：参数校验失败、权限不足等“业务不可恢复错误”
  - 策略：指数退避 + 最大重试次数（建议 3 次），并记录每次尝试的回执/错误

#### 2.3.3 审计与事件（结论）

- 审计日志最小字段：actor（用户/系统）、actorRole、tenantScope（代理商/企业/部门）、action、target（对象类型+ID）、before/after（关键字段差异）、requestId、timestamp、sourceIp
- 事件最小字段：eventId、eventType、occurredAt、actor、tenantScope、payload（含对象ID与状态前后值）
- 事件投递（默认建议）：先实现站内事件（可查询/可重放）；企业侧 webhook 作为可选增强

### 2.4 常见操作清单（功能模块版，结论）

本章节按“可交付的功能模块”整理常见操作。每个模块均需明确：操作权限、业务校验、操作日志、异常处理、相关 API。

#### 2.4.1 组织与用户管理

- 操作权限说明：
  - 系统管理员：创建/维护代理商；为代理商初始化管理员账号与权限
  - 代理商管理员：创建代理商组织内用户（销售总监/销售/财务）；加载企业并创建企业管理员；分配企业给销售总监/销售
  - 企业管理员：创建部门；创建部门运维用户并分配部门
- 业务规则校验：
  - 账号唯一性（邮箱/手机号/用户名）、强密码策略、角色合法性
  - 用户归属必须在当前操作者可见组织范围内（不可跨代理商/跨企业创建）
- 操作日志记录：
  - 记录组织与权限相关审计（创建用户/变更角色/企业分配/部门变更等）
- 异常处理流程：
  - 校验失败返回可定位的字段级错误；重复提交需幂等
  - 权限不足返回拒绝且审计
- 相关 API 接口规范：
  - `POST /v1/resellers`（系统管理员）创建代理商
  - `POST /v1/resellers/{resellerId}/users`（代理商管理员）创建用户并分配角色
  - `POST /v1/enterprises`（代理商管理员）创建企业并初始化企业管理员
  - `POST /v1/enterprises/{enterpriseId}/departments`（企业管理员）创建部门

#### 2.4.2 SIM 卡入库管理

- 渠道边界（结论）：SIM 入库/批量导入能力仅对“代理商侧 Portal”开放；不对企业/第三方开放导入接口，避免大规模误操作
- 操作权限说明：仅代理商组织“管理员”可执行
- 业务规则校验：
  - 必填：供应商 ID、运营商 ID（E.212）或 MCC+MNC、ICCID、Primary IMSI、APN
  - 可选：Secondary IMSI 1/2/3、MSISDN
  - ICCID 全局唯一；同一 ICCID 下 Primary IMSI 必须存在
  - 运营商 MCC/MNC 必须有效（存在于运营商主数据且通过 GSMA 校验）
  - 供应商必须已关联该运营商（供应商-运营商关联存在）
  - APN 由运营商信息规定：APN 必须来自该运营商的 APN 目录；同时需验证该供应商支持该 APN
  - 导入成功默认状态：INVENTORY
- 操作日志记录：
  - 记录导入批次 batchId/fileHash、成功/失败条数、失败原因聚合、操作者与时间
- 异常处理流程：
  - 大批量导入以异步 job 处理；返回 jobId 并可查询进度/结果
  - 失败行可下载错误明细；允许修正后重试（幂等去重）
- 相关 API 接口规范：
  - 说明：以下接口仅供 Web Portal 调用（不对第三方/企业侧开放）
  - `POST /v1/sims/import-jobs` 创建导入任务，返回 jobId
  - `GET /v1/jobs/{jobId}` 查询进度与结果
  - `POST /v1/sims` 单张 SIM 手动录入（Portal 表单提交；受权限与校验约束）

#### 2.4.3 SIM 卡状态全生命周期管理

- 操作权限说明：
  - 企业管理员/运维：可对授权范围内 SIM 执行激活/停机/复机（企业处于 SUSPENDED 状态时禁止操作）
  - 代理商管理员：除上述外，可执行拆机/销户（RETIRED）；可不受企业 SUSPENDED 状态限制执行管理操作
- 业务规则校验：
  - 状态迁移必须符合状态机定义（见 2.2 生命周期状态机，含 TEST_READY 到期、Cutoff 自动停机等）
  - **信控约束**：若企业状态为 `SUSPENDED`，禁止企业用户执行复机（ACTIVATED）操作；仅允许代理商管理员执行或待企业恢复 `ACTIVE` 后操作。
  - 拆机/销户仅允许从 DEACTIVATED 进入 RETIRED，且必须满足承诺期门槛：max(首次订阅时间_i + 承诺期_i)
  - 禁止 ACTIVATED -> RETIRED：必须先执行停机再拆机（ACTIVATED -> DEACTIVATED -> RETIRED）
  - “销户清除数据”口径（结论）：销户后释放业务资源并禁止恢复，但保留历史数据用于审计与对账
- 操作日志记录：
  - 记录每次状态变更的 before/after、requestId、来源（手工/规则/上游通知）
- 异常处理流程：
  - 本地触发变更需下发上游 CMP 指令；若上游失败则回滚/保持原状态并提示原因
  - 上游通知乱序/重复需幂等处理，最终以上游回执/通知为准
- 相关 API 接口规范：
  - `POST /v1/sims/{simId}:activate`
  - `POST /v1/sims/{simId}:deactivate`
  - `POST /v1/sims/{simId}:reactivate`
  - `POST /v1/sims/{simId}:retire`（仅代理商管理员；前置条件：当前状态必须为 DEACTIVATED）

#### 2.4.4 产品包配置管理

- 操作权限说明：仅代理商组织“管理员”可创建/修改企业产品包
- 业务规则校验：
  - 产品包必须绑定且仅绑定一个 Price Plan
  - 产品包变更次月生效，不影响当月订阅计数与用量累计
  - APN 由运营商信息规定：APN 必须来自产品包归属运营商的 APN 目录；同时需验证该供应商支持该 APN
  - 计费字段校验：如启用停机保号费（`deactivatedMonthlyFee`），必须为非负数；与月租费互斥（按 3.0.2 的状态过滤与互斥规则计费）
- 操作日志记录：
  - 记录产品包版本、变更前后差异、操作者与生效时间
- 异常处理流程：
  - 若变更影响现网（例如 APN/限速策略），需提示风险并支持撤销（以版本回退表达）
- 相关 API 接口规范：
  - `POST /v1/enterprises/{enterpriseId}/packages` 创建产品包
  - `PUT /v1/packages/{packageId}` 修改产品包（生成新版本）
  - `POST /v1/packages/{packageId}:publish` 发布并设置生效时间

#### 2.4.5 订阅关系管理

- 操作权限说明：
  - 代理商管理员/销售/企业管理员：可对授权企业的 SIM 创建/变更订阅
- 业务规则校验：
  - 订阅生效时间为 TIMESTAMPTZ（秒级），默认按系统时区解释
  - **互斥校验**：同一时间段内，一张 SIM 仅允许订阅一个“主数据产品包”；叠加包（Add-on）不限。
  - **变更限制**：主套餐变更必须遵循“次月生效”原则，防止当月用量与配额计算冲突。
  - **退订保护**：默认执行“到期退订”（服务至月底）；“立即退订”需二次确认，提示不退费且可能产生套外费用。
  - 订阅状态：PENDING/ACTIVE/CANCELLED/EXPIRED
- 操作日志记录：
  - 记录订阅创建/变更/撤销，包含生效时间、目标产品包、影响 SIM 列表
- 异常处理流程：
  - 批量订阅变更走异步 job；失败支持按 SIM 维度回滚/重试
- 相关 API 接口规范：
  - `POST /v1/subscriptions` 创建订阅（可指定生效时间）
  - `POST /v1/subscriptions:switch` 套餐切换（原子操作：退订旧+订购新，默认次月生效）
  - `POST /v1/subscriptions/{subscriptionId}:cancel` 取消订阅（支持 `immediate=true/false`）
  - `GET /v1/sims/{simId}/subscriptions` 查询订阅历史

#### 2.4.6 连接状态监控与操作

- 操作权限说明：企业管理员/运维可查询；强制操作按授权清单控制（默认企业管理员）
- 业务规则校验：
  - 状态查询需限流；数据来源需标注（上游查询/缓存/近实时）
  - 轨迹与定位数据属于敏感信息，需最小可见与审计
- 操作日志记录：
  - 记录每次查询与强制操作（重置连接/唤醒），包含目标 SIM、操作者与时间
- 异常处理流程：
  - 上游查询超时/限流需返回可重试提示并记录失败原因
- 相关 API 接口规范：
  - `GET /v1/sims/{simId}/connectivity-status`
  - `POST /v1/sims/{simId}:reset-connection`
  - `GET /v1/sims/{simId}/location`（当前国家/运营商网络）
  - `GET /v1/sims/{simId}/location-history`（历史位置）

#### 2.4.7 账单与支付管理

- **操作权限说明**：
  - 代理商财务/管理员：可查看所有下属企业账单；执行“确认支付/核销”操作；可发起调账（Credit/Debit Note）。
  - 企业管理员/财务：仅可查看与下载本企业账单。
- **业务规则校验**：
  - 账单状态流转：`GENERATED` (生成中) -> `PUBLISHED` (已发布/待付) -> `PAID` (已付) / `OVERDUE` (逾期) / `WRITTEN_OFF` (坏账核销)。
  - 支付确认：支持线下转账后的“人工核销”（标记为 PAID）；若接入在线支付网关，则由回调自动触发核销。
  - 调账限制：仅 `PUBLISHED` / `OVERDUE` 状态账单可关联 Credit/Debit Note；已结清账单通常不直接修改，而是通过新账单调整。
- **操作日志记录**：
  - 记录支付确认/取消、调账操作（包含操作人、金额、备注）。
- **相关 API 接口规范**：
  - `GET /v1/bills`（列表查询，支持按账期/状态/企业筛选）
  - `GET /v1/bills/{billId}`（账单详情与汇总数据）
  - `GET /v1/bills/{billId}/files`（下载 PDF/CSV 文件）
  - `POST /v1/bills/{billId}:mark-paid`（人工核销/确认支付）
  - `POST /v1/bills/{billId}:adjust`（发起调账，生成 Note）

## 3. 资费、计费与出账口径

### 3.0 权威源与计费原则（结论）

- 权威源（Source of Truth）：SIM 状态、数据使用量、话单均以上游 CMP（供应商侧）为准
- Reseller System 的责任：
  - 镜像关键数据用于审计、报表、企业侧展示（以上游 CMP（供应商侧）为准，可记录差异）
  - 基于上游 CMP（供应商侧）提供的用量/话单与“企业资费规则（产品包/资费计划）”执行计费、出账
  - 上游费用：不在系统内建模与计算（不要求代理商提交“资费_运营商/批发资费”等机密商务条款）

### 3.0.1 资费模型（结论：仅实现资费_企业）

- 资费_企业（零售资费）：Reseller 对企业的销售资费/套餐/结算规则，用于对企业累计费用、出账与收费
- 资费_运营商（批发资费）：本期不在系统内建模与计算（机密且商务条款复杂，系统无法保证计算准确性）
- 要求：计费结果必须可追溯（用量明细 -> 产品包/资费计划版本 -> 计算结果），并可重算留痕

#### 3.0.1.1 SIM 月度数据使用量采集（结论）

- 主方案：通过供应商/运营商侧标准化 API 拉取用量（按 SIM 粒度，可按时间范围）
- 备用方案：解析话单（CDR）聚合得到用量（当 API 缺失或用于对账校验）
- 数据校验机制（结论）：
  - API 用量与 CDR 聚合值应可对齐（允许存在“迟到话单/重放”导致的短期差异，但最终需收敛）
  - 对齐方式：按 `supplierId + iccid + 账期 + visitedMccMnc` 维度比对差异，并记录差异原因（迟到/缺失/重复/上游修正）

#### 3.0.1.2 漫游用量报表（企业计费与运营）（结论）

- 记录粒度：按 SIM 粒度记录漫游用量（按拜访地运营商维度拆分）
- 最小数据结构（结论）：
  - `iccid`
  - `supplierId`
  - `visitedMccMnc`（拜访地运营商，MCC+MNC）
  - `totalBytes`（或统一折算到 KB）
  - `periodStart` / `periodEnd`
- 查询要求：支持按时间范围、按企业/部门、按 SIM、按拜访地运营商聚合查询

#### 3.0.1.4 用量归集与产品包匹配规则（新增）

由于 SIM 卡允许订阅一个主数据产品包（互斥）及多个叠加包（Add-ons），用量与产品包的关联遵循**“叠加包优先、范围最小匹配优先”**原则：

1.  **时间窗匹配（Time-based Association）**：
    - 对于每条用量记录，查找该 SIM 卡在该时刻**所有有效（ACTIVE）的订阅列表**（含主套餐与叠加包）。

2.  **区域与优先级匹配（Zone & Priority Matching）**：
    - 遍历所有有效订阅，筛选出 `RoamingProfile` 白名单包含该记录 `visitedMccMnc` 的候选订阅。
    - **优先级排序（Waterfall Logic）**：
      1.  **叠加包（Add-on）优先**：优先使用用户额外购买的叠加包。
      2.  **范围最小优先**：若有多个叠加包（如“法国包”与“欧洲包”），优先扣减范围更小（Targeted）的那个。
      3.  **主套餐（Main Plan）兜底**：若无叠加包覆盖，则由主套餐承担。
      4.  **无覆盖（No Match）**：若无任何订阅覆盖该区域，标记为 **Out-of-Profile**（独立计费/告警）。

3.  **计费处理（Billing Action）**：
    - **In-Profile（命中某套餐）**：
      - 扣减该套餐的剩余配额（Quota）。
      - 若配额耗尽：按该套餐定义的“套外单价”计费（或触发自动停机/降速，视策略而定）。
    - **Out-of-Profile（未命中任何套餐/覆盖区域外的漫游）**：
      - **处理原则**：**坚决不扣减**任何现有套餐的配额（保护正常资产），防止“天价漫游”消耗掉用户的正常流量包。
      - **计费逻辑（Zone-based PAYG）**：
        - 系统依据该 SIM 订阅的主资费计划（Main Price Plan）中定义的 **`paygRates`（分区标准资费表）** 进行计费。
        - 根据 `visitedMccMnc` 匹配 `paygRates` 中的对应区域（Zone），按该区域定义的单价进行独立计费（Pay-As-You-Go）。
        - **说明**：由于 Price Plan 是由“代理商”为特定“企业”定制，并绑定了特定“供应商/运营商”的资源，因此该费率表天然具备了 `(供应商, 运营商, 企业)` 的完整上下文。
        - **示例**：用户仅订阅了“欧洲包”，但在“阿联酋”产生了流量。
          - 行为：不扣减欧洲包配额。
          - 计费：在主资费计划的 `paygRates` 中查找“阿联酋”所在的区域（如 Zone 4），按 Zone 4 单价计费。
      - **风控**：此类流量通常单价较高，必须触发**“异常漫游（Unexpected Roaming）”告警**，并建议配置较低的金额阈值（如累计达 50 USD 即自动停机），防止账单休克（Bill Shock）。
    - **非活跃状态（Deactivated）用量处理**：
      - 若 SIM 处于 `DEACTIVATED` 状态（含信控停机）但仍产生了话单（漏控/延迟话单）：
      - 默认按 **Out-of-Profile** 处理（独立计费+告警），除非产品包显式配置了“允许停机使用”（极少见）。
      - 理由：停机期间不应有流量，若有则视为异常或违规，不应消耗正常套餐配额。

4.  **多包场景示例**：
    - 场景：SIM 订阅了 `Global 1GB` (主) + `France 500MB` (叠加)。
    - 事件 A（在法国使用）：优先扣减 `France 500MB`；耗尽后，自动转扣 `Global 1GB`。
    - 事件 B（在德国使用）：`France` 包不覆盖，直接扣减 `Global 1GB`。
    - 事件 C（在古巴使用）：两者均不覆盖 -> Out-of-Profile (按 Zone-based PAYG 计费 + 告警)。

#### 3.0.1.3 一致性、审计与追溯（结论）

- 数据一致性：幂等入库（重复投递不重复计费）、迟到话单可重算且保留重算痕迹
- 可审计：必须记录 `inputRef`（原始记录/文件/行号）、`ruleVersion`（产品包/资费计划版本）、`calculationId`
- 可追溯：支持对任意账期重放计算（输入快照 + 规则快照），并可导出对账差异报告
- 异常处理：对未知 visitedMccMnc、上游数据缺失/不一致、规则缺失/版本不匹配等情况输出可定位错误并进入待处理队列

### 3.0.2 月租费计算规则（结论）

- **适用范围**：SIM Dependent Bundle / Fixed Bundle / Tiered Volume Pricing（monthly recurring）
- **核心原则**：**高水位计费（High-Water Mark）**。基于 SIM 卡在自然月账期内的**状态轨迹（State Trajectory）**判定，而非仅看月底快照。
  - **数据源**：依据 2.2.3 节定义的 `sim_state_history` 表（记录 start_time/end_time/status），精确回溯账期内每一秒的状态。
- **计费优先级**：`ACTIVATED` > `DEACTIVATED` > 其他
- **详细判定规则**：
  1.  **全额月租费（Full Monthly Fee）**：
      - **条件**：只要 SIM 卡在该账期内**曾经处于** `ACTIVATED` 状态（哪怕仅 1 秒）。
      - **场景**：
        - 整月均为 ACTIVATED。
        - 月中由 TEST_READY/INVENTORY/DEACTIVATED 变更为 ACTIVATED。
        - 月中由 ACTIVATED 变更为 DEACTIVATED/RETIRED。
        - 频繁切换（A->D->A...）：只要出现过 A，即收全额月租。
      - **信控特殊说明**：若企业因欠费被 `SUSPENDED`，且系统自动触发了 SIM 批量停机（变更为 `DEACTIVATED`），则：
        - 若当月在停机前曾是 `ACTIVATED` -> 收全额月租。
        - 若整月都在 `SUSPENDED`（且 SIM 保持 `DEACTIVATED`） -> 收停机保号费。
        - **原则**：计费引擎仅认 SIM 实际状态轨迹，不直接对企业状态（SUSPENDED）进行特殊逻辑处理。这避免了“企业状态与 SIM 实际状态不一致”导致的收入流失。
  2.  **停机保号费（Deactivated Monthly Fee）**：
      - **条件**：SIM 卡在该账期内**从未**处于 `ACTIVATED` 状态，但**曾经处于** `DEACTIVATED` 状态。
      - **场景**：
        - 整月均为 DEACTIVATED（含因欠费被 SUSPENDED 导致的停机）。
        - 月中由 TEST_READY 变更为 DEACTIVATED。
        - 月中由 DEACTIVATED 变更为 RETIRED（且未经过 ACTIVATED）。
  3.  **无月租（No Charge）**：
      - **条件**：SIM 卡在该账期内从未处于 `ACTIVATED` 或 `DEACTIVATED` 状态。
      - **场景**：
        - 整月均为 INVENTORY 或 TEST_READY。
        - TEST_READY -> RETIRED（直接报废，未激活也未停机）。
- **互斥性（结论）**：
  - 月租费与停机保号费**绝对互斥**。同一张 SIM 在同一账期仅会产生其中一项费用（优先收月租费）。
- **最小验收标准（示例）**：
  - Case 1 (A -> D)：10号激活，20号停机。结论：**收全额月租费**（因为出现过 ACTIVATED）。
  - Case 2 (D -> A)：10号停机，20号激活。结论：**收全额月租费**。
  - Case 3 (D only)：整月停机。结论：**收停机保号费**。
  - Case 4 (T -> D)：5号由测试变为停机。结论：**收停机保号费**。

### 3.1 产品包与计费规则（结论）

- 计费规则归属：计费规则以“产品包”为载体，不是“运营商级”的单一概念
- 上游产品：每个供应商可向 Reseller 销售多个产品（产品A/B/C），每个产品绑定各自的计费规则与周期
- 下游产品：企业购买的是 Reseller 为其定制的“产品包”（绑定企业资费计划），用于企业侧计费与出账

### 3.2 计量单位与舍入规则（结论）

- 流量计费单位：KB
- 舍入规则：向上取整

### 3.3 计费周期（结论）

- 周期类型：支持自然月与自定义周期两种形态，均由产品包定义
- 自定义周期示例：10月5日 00:00:00 至 11月4日 23:59:59（需明确边界包含/不包含规则）

### 3.4 共享池（结论）

- 共享池是产品包的一种形态：企业购买共享池产品包后，所有订阅该产品包的 SIM 共享同一池额度

### 3.5 对账差异处理（结论）

- 以上游 CMP（供应商侧）/上游出账为准；Reseller System 记录差异并用于稽核分析（不自动冲正上游侧）

### 3.6 产品包（Subscription Package）定义（结论）

产品包是计费规则与运营商能力的载体；企业侧订阅的对象是产品包。

#### 3.6.1 供应商信息（CSP Info）

- 供应商对象（结论）：供应商为平台主数据对象（非业务租户），由系统管理员维护；用于上游对接、话单归集与产品包归属
  - 兼容：当供应商=运营商 CMP 时，供应商与运营商为同一主体

- 存储与审计要求（结论）：供应商主数据加密存储；任何变更需保留历史版本并可追溯到操作人、时间与变更前后值

- 基础标识：
  - 供应商 ID：系统自动生成 UUID（不可变；供产品包、SIM、话单归属引用）
  - 供应商名称：营业执照全称
  - 运营商网络归属（必填）：关联一个或多个运营商（Carrier，MCC+MNC）；禁止创建未关联运营商的供应商

- 上游 CMP 对接信息：
  - 上游供应商 CMP 标识（如有）：用于与供应商侧对象关联
  - 集成方式：API / Web Portal / SFTP（可组合）
  - API 基础地址：Base URL
  - 认证信息引用：密钥/证书的配置引用（不在文档中落明文）
  - 回调/通知：供应商向 Reseller System 推送 Notification 的接入配置（如回调地址、签名校验方式）

- 话单与用量归集：
  - 话单来源时区：可配置（用于将话单时间换算到 Reseller System 时区）
  - 话单交付参数：SFTP 路径/文件命名规则/频率/补传机制（如供应商支持）

- 供应商能力与目录（可选）：
  - APN 目录：按运营商维度维护的 APN 列表（运营商定义；供应商提供/同步并声明支持范围）
  - 网络制式：4G/5G/NB-IoT/Cat.1 等能力标记（如需）
  - 上游 SIM 状态映射：上游状态到本系统状态（INVENTORY/TEST_READY/ACTIVATED/DEACTIVATED/RETIRED）的映射规则

#### 3.6.2 资费计划（Price Plan）

- 资费类型（四选一）：
  - One-time（一次性）
  - SIM Dependent Bundle（monthly recurring，前向流量池，按月自动续约）
  - Fixed Bundle（monthly recurring，后向流量池，按月自动续约）
  - Tiered Volume Pricing（monthly recurring，阶梯计费）

- 业务范围（结论）：每个 Price Plan 仅针对一种电信业务类型（Data / Voice / SMS）；若 Price Plan 为数据业务计费，则仅包含数据业务额度/计费规则

- 类型语义（结论）：
  - SIM Dependent Bundle（前向流量池）：按卡动态累加；每新增一张订阅该产品包的 SIM，池总额度按规则增加
  - Fixed Bundle（后向流量池）：固定总池额度；不随订阅 SIM 数量变化

- 规则说明（结论）：每一种 Price Plan 类型都有独立的计费/控制规则；以下字段、默认值与边界为 MVP 可实现口径

##### 3.6.2.1 字段、默认值与边界（结论）

通用规则：
- 金额精度：币种最小货币单位（如 USD=0.01）；金额计算结果按四舍五入保留 2 位小数
- 流量单位：计费引擎内部统一以 KB 计量，向上取整（见 3.2）
- 生效时间：订阅与规则生效时间均为 TIMESTAMPTZ，按 Reseller System 时区解释与展示

通用字段（所有 Price Plan 共享）：

| 字段 | 含义 | 类型/约束 | 默认值 |
|---|---|---|---|
| `serviceType` | 业务类型 | ENUM: `DATA`/`VOICE`/`SMS` | `DATA` |
| `currency` | 币种 | ISO 4217 | 继承产品包 |
| `billingCycleType` | 计费周期类型 | ENUM: `CALENDAR_MONTH`/`CUSTOM_RANGE` | `CALENDAR_MONTH` |
| `firstCycleProration` | 首月是否分摊 | ENUM: `NONE`/`DAILY_PRORATION` | `NONE` |
| `prorationRounding` | 分摊舍入 | ENUM: `ROUND_HALF_UP_2DP` | `ROUND_HALF_UP_2DP` |

分摊算法（当 `firstCycleProration=DAILY_PRORATION` 时，结论）：
- `perDayFee = monthlyFee / daysInBillingMonth`
- `activeDays` 计算：将订阅生效时间换算到系统时区，取 `startDay = date(effectiveAt)`；取 `endDay = date(periodEnd - 1s)`；`activeDays = countDaysInclusive(startDay, endDay)`
- `chargedMonthlyFee = round(perDayFee * activeDays, 2)`
- `daysInBillingMonth`：按计费周期所在自然月天数（仅 `CALENDAR_MONTH` 下启用该算法；自定义账期暂不支持分摊）

各类型字段（仅列出差异字段）：

| Price Plan 类型 | 字段 | 含义 | 约束/边界 |
|---|---|---|---|
| One-time | `oneTimeFee` | 一次性费用 | >= 0 |
| One-time | `quotaKb` | 包含额度 | >= 0（仅 `DATA`） |
| One-time | `validityDays` | 有效天数 | >= 1 |
| One-time | `expiryBoundary` | 到期边界 | ENUM: `CALENDAR_DAY_END`/`DURATION_EXCLUSIVE_END`；默认 `CALENDAR_DAY_END` |
| SIM Dependent Bundle | `monthlyFee` | 月租费 | >= 0 |
| SIM Dependent Bundle | `deactivatedMonthlyFee` | 停机保号费（按月） | >= 0 |
| SIM Dependent Bundle | `perSimQuotaKb` | 每 SIM 配额 | >= 0（仅 `DATA`） |
| SIM Dependent Bundle | `overageRatePerKb` | 套外单价 | >= 0（仅 `DATA`） |
| Fixed Bundle | `monthlyFee` | 月租费 | >= 0 |
| Fixed Bundle | `deactivatedMonthlyFee` | 停机保号费（按月） | >= 0 |
| Fixed Bundle | `totalQuotaKb` | 总池额度 | >= 0（仅 `DATA`） |
| Fixed Bundle | `overageRatePerKb` | 套外单价 | >= 0（仅 `DATA`） |
| Tiered Volume Pricing | `monthlyFee` | 月租费 | >= 0 |
| Tiered Volume Pricing | `deactivatedMonthlyFee` | 停机保号费（按月） | >= 0 |
| Tiered Volume Pricing | `tiers[]` | 阶梯费率 | 按阈值升序；阈值单位 KB；费率单位 `currency/Kb` |

**新增：分区标准资费（Zone-based PAYG Rates）**
- **适用范围**：所有 Price Plan 类型（作为兜底费率）
- **字段定义**：
  - `paygRates[]`：分区费率列表
    - `zoneCode`：区域代码（如 Zone1, Zone2）
    - `countries`：覆盖范围（推荐优先使用 `MCC+MNC`；也可使用 `MCC` 作为国家级通配）
    - `ratePerKb`：单价（`currency/Kb`）
- **作用**：当 SIM 漫游至 Price Plan 包含的 Bundle 范围之外（Out-of-Profile）时，按此表定义的单价计费。
- **缺省行为**：若未配置 PAYG Rates 或某区域未定义，默认阻断或按系统级高价告警。

- **匹配与冲突规则（结论）**：
  - **匹配键**：以用量记录的 `visitedMccMnc` 进行匹配。
  - **优先级**：`MCC+MNC` 精确匹配 > `MCC` 通配匹配。
  - **冲突处理**：若同一 `visitedMccMnc` 命中多个候选项，选择“最具体”的规则（`MCC+MNC` 优先）；同级冲突视为配置错误，需在产品包发布校验阶段阻断并给出可定位错误。

##### 3.6.2.2 最小验收标准（结论）

One-time：
- Given：购买 one-time 产品包（quota=10GB，validity=30 天，expiry=CALENDAR_DAY_END）
- When：在 `2026-02-01 10:00` 生效
- Then：到期时间为 `2026-03-02 23:59:59`（系统时区），取消订阅不退款

SIM Dependent Bundle（不分摊）：
- Given：月租 `10`，每 SIM 配额 `1GB`，当月订阅 SIM=3
- When：账期结束计算
- Then：月租= `3 * 10`；若总用量<=总配额则无套外费

SIM Dependent Bundle（分摊）：
- Given：月租 `10`，生效日为当月第 10 天，`firstCycleProration=DAILY_PRORATION`
- When：计算首月
- Then：月租按 `activeDays/daysInMonth` 分摊并按 2 位小数四舍五入

Fixed Bundle：
- Given：月租 `10`，总池 `100GB`
- When：总用量 `120GB`
- Then：费用 = `SIM数*月租 + (120-100)*overageRate`

Tiered Volume Pricing（Progressive）：
- Given：阈值与费率：`0-10GB`=R1，`10-20GB`=R2
- When：总用量 `15GB`
- Then：流量费 = `10GB*R1 + 5GB*R2`

##### One-time（一次性）规则（结论）

- 触发时点：购买即收
- 包含额度（Quota）：X MB/GB（以产品包配置为准；计费引擎内部按 KB 向上取整；仅针对该 Price Plan 对应的业务类型）
- 有效时长：例如 30 天（自然日）
- 有效期起始：允许指定生效日期；若未指定则按购买时间起算
- 到期边界（结论）：需要提供两种选择（由产品包配置决定）
  - CALENDAR_DAY_END：到期日 23:59:59 到期
  - DURATION_EXCLUSIVE_END：起始时间 + N*24 小时，到期点为右开区间（[start, end)）
- 退款/撤销：取消订阅/撤销不退款

##### SIM Dependent Bundle（前向流量池，monthly recurring）规则（结论）

- 自动续约：按自然月自动续约
- 首次订阅是否分摊（结论）：支持按产品包配置
  - 缺省：不分摊（即月内新增订阅按整月收取月租费）
  - 分摊：按 3.6.2.1 的日粒度分摊算法执行（仅自然月账期）
- 币种：按资费计划配置
- 月租费：XXX / 月（按资费计划配置）
- 每 SIM 流量配额（Quota）：按资费计划配置
- 套外资费：YYY / KB（按资费计划配置）

- **总体配额公式（高水位）**：
  - 流量池总体配额 = `activatedSimCount`（按 3.0.2 高水位口径） * 每 SIM 卡流量配额
  - **规则说明**：凡是按“全额月租费”计费的 SIM（即账期内只要出现过 ACTIVATED 状态），无论月底是否停机，均贡献**全额配额**进入当月流量池。这确保了“付费即得（Pay for Value）”的公平性。
  - 注：仅支付“停机保号费”的 SIM 不贡献配额。

- 计费与计量规则：
  - 月基本费用：按 3.0.2 的 `activatedSimCount` 与 `deactivatedSimCount` 计算（高水位）
  - 实时更新流量池总体配额（基于高水位计数）
  - 汇总“订阅该产品包的 SIM”的总使用量（按 KB 计费、向上取整），与流量池总体配额比较
    - 若总使用量 ≤ 总体配额：费用 = (`activatedSimCount` × 月租费) + (`deactivatedSimCount` × 停机保号费)
    - 若总使用量 > 总体配额：费用 = (`activatedSimCount` × 月租费) + (`deactivatedSimCount` × 停机保号费) + (总使用量 - 总体配额) * 套外资费

- 月内取消订阅/退订（结论）：
  - 取消订阅（Cancel）：默认次月生效，不影响当月配额与费用。
  - 立即终止（Terminate Now）：如强制立即终止，该 SIM 当月仍按“全额月租”计费（因已发生），故其配额**仍保留在当月池中**，直到月底失效。

##### Fixed Bundle（后向流量池，monthly recurring）规则（结论）

- 自动续约：按自然月自动续约
- 首次订阅是否分摊：缺省不分摊（如启用则按 3.6.2.1 的日粒度分摊算法执行，仅自然月账期）
- 币种：按资费计划配置
- 月租费：XXX / 月（按资费计划配置）
- 总流量配额（Total Volume）：YYY GB（按资费计划配置；计费引擎内部按 KB 向上取整）
- 套外资费：ZZZ / KB（按资费计划配置）

- 计费与计量规则：
  - 月基本费用：按 3.0.2 的 `activatedSimCount` 与 `deactivatedSimCount` 计算
  - 月底统计所有订阅该产品包的 SIM 卡的总使用量（按 KB 计费、向上取整）
    - 若总使用量 ≤ 总流量配额：费用 = (`activatedSimCount` × 月租费) + (`deactivatedSimCount` × 停机保号费)
    - 若总使用量 > 总流量配额：费用 = (`activatedSimCount` × 月租费) + (`deactivatedSimCount` × 停机保号费) + (总使用量 - 总流量配额) * 套外资费

##### Tiered Volume Pricing（阶梯计费，monthly recurring）规则（结论）

- 自动续约：按自然月自动续约
- 首次订阅是否分摊：缺省不分摊（如启用则按 3.6.2.1 的日粒度分摊算法执行，仅自然月账期）
- 币种：按资费计划配置
- 月租费：XXX / 月（按资费计划配置）
- 流量阶梯最大档位数：按资费计划配置
- 流量阶梯定义：按阈值（Threshold）升序配置，每档包含（阈值_i，费率_i）
  - 示例：
    - 阈值1，费率1
    - 阈值2，费率2
    - 阈值3，费率3

- 计费与计量规则：
  - 月基本费用：按 3.0.2 的 `activatedSimCount` 与 `deactivatedSimCount` 计算
  - 月底统计所有订阅该产品包的 SIM 卡的总使用量（按 KB 计费、向上取整）
  - 总月租费 = `activatedSimCount` × 月租费
  - 总停机保号费 = `deactivatedSimCount` × 停机保号费
  - 总流量费用（分段累进，按增量计费）：
    - 若 0 ≤ U ≤ T1：流量费 = U * R1
    - 若 T1 < U ≤ T2：流量费 = T1 * R1 + (U - T1) * R2
    - 若 T2 < U ≤ T3：流量费 = T1 * R1 + (T2 - T1) * R2 + (U - T2) * R3
    - 以此类推，直到最高阈值
  - 总费用 = 总月租费 + 总停机保号费 + 总流量费用

- 说明：阶梯计费口径已确定为分段累进（Progressive）：每一段用量按该段费率计费（按增量计费）

##### 订阅取消/撤销（说明）

- 取消订阅/撤销是对“产品包订阅（Subscription Package Subscription）”进行操作，不是对 Price Plan 本体进行操作

#### 3.6.3 运营商业务（Carrier Service）

- RAT（移动接入类型）：3G / 4G / 5G / NB-IoT（缺省 4G）
- 电信业务类型：Data / Voice / SMS（缺省 Data）
- Roaming Profile（漫游配置）：允许漫游拜访地列表（精细到 MNC；按 MCC+MNC 列表表达，如 460-00、520-xx）
- APN：支持多个 APN（APN 列表）

- 产品包绑定规则（结论）：
  - 每个产品包必须绑定 1 个电信业务类型（Data/Voice/SMS），并选择与之匹配的 Carrier Service
  - MVP：每个 Data 产品包绑定 1 个默认 APN（单选）与 1 个 Roaming Profile
  - APN 来源：APN 由运营商信息规定（来自归属运营商的 APN 目录）；同时需验证供应商支持该 APN
- 变更规则（结论）：
  - APN/Roaming Profile 变更：次月生效（避免影响当月订阅计数与用量归集），并需要发布新版本
  - 生效后对现网：对订阅该产品包的 SIM，下发上游 CMP 指令更新对应配置（需具备幂等与回执对齐）

- 最小验收标准（结论）：
  - Given：产品包绑定 APN=A 与 RoamingProfile=R1
  - When：将 APN 变更为 B 并发布为次月生效
  - Then：当月不影响计数与用量归集；次月起新订阅与续约按 APN=B 生效并下发到上游 CMP

#### 3.6.4 商业条款（Commercial Terms）

- Test Period（测试期）：定义订阅该产品包的 SIM 在 TEST_READY 状态下的有效时长
- Test Quota（测试期流量配额）：定义订阅该产品包的 SIM 在 TEST_READY 状态下可使用的测试期流量额度（仅适用于数据业务）；计量单位为 KB，向上取整
- Test Expiry Condition（测试期到期判定条件，结论）：用于判断 TEST_READY 何时到期并触发 TEST_READY -> ACTIVATED
  - PERIOD_ONLY：仅依据 Test Period 到期
  - QUOTA_ONLY：仅依据 Test Quota 耗尽
  - PERIOD_OR_QUOTA：Test Period 到期或 Test Quota 耗尽任一满足即到期（默认）
- Commitment Period（承诺期）：订阅该产品包后必须使用的商用时长；拆机门槛按该 SIM 全部订阅中最大承诺期门槛计算

#### 3.6.5 控制策略（Control Policy）

- 开关：on/off
- Throttling Policy ID：关联一个限速策略对象

- 达量策略（可选，结论）：支持配置“达量断网（Cutoff）”类规则
  - 触发条件：SIM 月累计使用量达到阈值
  - 动作：将 SIM 状态由 ACTIVATED 转为 DEACTIVATED

- Throttling Policy（限速策略对象）最小字段（结论）：
  - `throttlingPolicyId`
  - `name`
  - `downlinkKbps` / `uplinkKbps`
  - `effectiveFrom`（可选，用于版本/生效窗口）
  - `enabled`

- 优先级与生效规则（结论）：
  - 状态优先级：当 SIM 状态为 DEACTIVATED/RETIRED 时，不再下发或维持限速配置
  - Cutoff 优先级：Cutoff 触发后以状态迁移为准（ACTIVATED -> DEACTIVATED），限速不再作为替代动作
  - 策略变更：次月生效（通过产品包版本发布），并对订阅该产品包的 SIM 执行配置对齐

- 最小验收标准（结论）：
  - Given：产品包开启限速策略 P（1Mbps/1Mbps），SIM 状态为 ACTIVATED
  - When：策略发布生效
  - Then：上游 CMP 接收到限速下发并回执对齐；当 Cutoff 触发后 SIM 变为 DEACTIVATED 且限速配置不再生效

#### 3.6.6 产品包订阅（Subscription）语义（结论）

产品包订阅是企业侧对产品包的实例化与计费对象（可绑定到一个或多个 SIM）。以下语义会影响“订阅 SIM 数”“当月费用”“对账差异”。

- 生效时间（结论）：订阅生效时间精确到秒（TIMESTAMPTZ），按 Reseller System 时区解释与展示
- 订阅状态（结论）：PENDING / ACTIVE / CANCELLED / EXPIRED
  - PENDING：创建后尚未到达生效时间（典型场景：月内变更次月生效）
  - ACTIVE：当前账期内生效
  - CANCELLED：撤销订阅（撤销后当月计数与配额不回收，口径见已确定项）
  - EXPIRED：自然到期或被替换后归档
- 首次订阅时间（结论）：记录 SIM 首次订阅某产品包的时间，用于承诺期 Commitment Period 校验（拆机/退网限制）
  - 拆机门槛：对该 SIM 的全部产品包订阅计算 max(首次订阅时间_i + 承诺期_i)
- 计数口径（订阅 SIM 数）（结论）：
  - 月初取数时统计范围：以订阅生效时间为准
  - 月内新增订阅计数生效点：以订阅生效时间为准

- 计费窗口与用量归集口径（结论）：
  - 计费窗口：以产品包定义的计费周期为准（`CALENDAR_MONTH` 或 `CUSTOM_RANGE`），按 Reseller System 所在时区计算边界
  - 用量归集窗口：与计费窗口一致（同一账期内的用量用于该账期计费与配额判断）
  - 变更口径：月内产品包变更次月生效；当月用量与订阅计数不受影响

- 最小验收标准（结论）：
  - Given：某产品包账期类型为 `CALENDAR_MONTH`，订阅生效时间为 2026-02-10 10:00（系统时区）
  - When：计算 2026-02 账期订阅数与费用
  - Then：订阅计数以生效时间计入 2026-02；用量仅统计 2026-02 账期窗口
  - Given：产品包变更在 2026-02-15 提交，设置次月生效
  - Then：2026-02 的订阅计数与用量归集不受影响，2026-03 起生效新版本

- **订阅约束与变更策略（新增）**：
  - **互斥规则**：单张 SIM 仅允许存在一个生效的“主数据产品包”；叠加包（Add-on）可共存。
  - **变更（Switch）**：
    - 默认策略：**次月生效**（Next Billing Cycle）。即本月维持旧套餐，下月1号0点启用新套餐。
    - 计费影响：本月收旧套餐全额月租，下月收新套餐月租；不进行跨套餐的“补差价”或“按天折算”。
  - **退订（Cancel）**：
    - 模式 A（默认）：**到期退订**（Expire at End）。服务持续至月底，次月不再续费。
    - 模式 B（可选）：**立即退订**（Terminate Now）。服务立即停止，状态变更为 `CANCELLED`。
    - 费用：无论何种模式，当月已产生的月租费**不退还**（No Refund）。

#### 3.6.7 上游对账与产品映射（Provisioning & Mapping）

Reseller System 作为中间层，必须维护其“内部产品包”与“上游供应商产品包”的严格映射关系，并负责将用户的业务操作（订阅/变更/退订）翻译并调度到上游系统。

- **产品映射模型（Product Mapping）**：
  - **一一对应原则**：系统内定义的每一个基础产品包（Base Plan），必须显式绑定一个上游供应商的 `externalProductId`（或 Service Code）。
  - **字段定义**：
    - `supplierId`：供应商标识。
    - `externalProductId`：上游产品 ID（用于调用上游 API）。
    - `provisioningParameters`：开通参数模板（如：部分上游需要指定 `APN` 或 `QoS` 参数）。

- **开通同步机制（Provisioning Synchronization）**：
  - **同步策略**：采用 **“本地调度 + 上游执行”** 的混合模式。
  - **场景 A：立即生效操作（如：新购卡激活、立即叠加包）**：
    1.  系统记录请求为 `PROVISIONING_IN_PROGRESS`。
    2.  立即调用上游 API（`Activate` / `AddService`）。
    3.  若上游成功，更新本地状态为 `ACTIVE`；若失败，回滚或标记为 `PROVISIONING_FAILED` 并告警。
  - **场景 B：预约生效操作（如：套餐次月变更、次月退订）**：
    1.  系统创建一个 **“待办变更单（Pending Order）”**，记录期望生效时间（如 `2026-03-01 00:00:00`）。
    2.  **调度逻辑**：
        - 若上游支持“预约参数”（Future Dated Change）：立即调用上游接口并带上生效时间，本地标记为 `SCHEDULED_ON_SUPPLIER`。
        - 若上游仅支持“立即执行”：变更单保留在本地调度器中，状态为 `SCHEDULED_LOCALLY`。系统在生效时间窗口（如次月 1 号凌晨）触发执行上游调用。
  - **状态一致性**：
    - 必须通过每日的“全量/增量同步（Reconciliation）”任务，比对 Reseller System 与上游 CMP 的订阅状态。
    - 若发现不一致（如：本地显示次月生效，但上游已被意外修改），以**最新同步结果**为准并触发差异告警。

### 3.7 账单与出账管理（结论）

#### 3.7.1 出账流程与周期
- **出账触发**：
  - 自动出账：账期结束后的 T+N 日自动触发（N 默认为 3，可配置）。
  - 触发条件：上游话单/用量已归集完成（或达到截止时间强制截断）。
- **流程步骤**：
  1. **数据归集（Aggregation）**：锁定账期内的所有用量记录与 SIM 状态快照。
  2. **批价与计费（Rating & Billing）**：应用 3.6.2 定义的资费计划规则，计算每张 SIM、每个产品包的费用。
  3. **账单生成（Generation）**：按企业/部门维度汇总费用，生成账单对象（Bill）与详情文件。
  4. **发布与通知（Notification）**：账单状态转为 `PUBLISHED`，并发送邮件/站内信通知企业管理员。

#### 3.7.2 账单结构与展示
- **账单层级**：
  - **L1 汇总账单（Account Summary）**：企业维度总览。包含：上期余额、本期新增费用、本期已付、本期应付总额、缴费截止日期（Due Date）。
  - **L2 分组汇总（Group Summary）**：
    - 按部门（Department）汇总。
    - 按产品包（Price Plan）汇总。
  - **L3 费用明细（Line Items）**：
    - 按 SIM 维度展示：SIM ID (ICCID)、MSISDN、所属部门、订阅产品包、月租费、用量（Data/Voice/SMS）、套外费用、小计。
- **导出格式**：
  - 汇总页：PDF（盖章/品牌化）。
  - 明细单：CSV/Excel（支持百万级行数据下载）。

#### 3.7.3 调账与差异处理
- **差异来源**：上游迟到话单、计费规则追溯修正、商务纠纷调整。
- **处理机制**：
  - **不修改历史账单**：已发布的账单（PUBLISHED）不可篡改。
  - **调账单（Adjustment Note）**：
    - **Credit Note（红字/贷项通知单）**：用于退款/抵扣/调减费用。
    - **Debit Note（蓝字/借项通知单）**：用于补收/调增费用。
  - **下期结算**：调账金额计入当前账期的“期初调整”或独立行项，并在下期账单中体现结算结果。

- **迟到话单处理（结论）**：
  - **判定**：当话单/用量落在“已出账且已发布（PUBLISHED）”的账期窗口内，即视为迟到话单。
  - **动作**：系统自动生成对应企业的 Adjustment Note 草稿（Debit/Credit），并标注 `inputRef`（fileId/lineNo）与 `calculationId`，进入待审核状态；审核通过后在下期账单出账时一并结算。
  - **审计**：草稿生成、审核、发布均记录审计日志（含操作人/时间/原因）。

#### 3.7.4 欠费管控与信用流程（Credit Control & Dunning Process）（结论）

针对后付费（Post-paid）模式，系统需实现自动化的催收与管控状态流转。

- **关键时间轴（Timeline）**：
  - **账单日（Bill Date, T）**：账单生成并发布（状态 `PUBLISHED`）。
  - **到期日（Due Date, T+N）**：合同约定的最晚付款日（例如账单日后 30 天，可按企业配置）。
  - **宽限期（Grace Period, M天）**：逾期后允许缓冲的天数（默认 3 天，可配置）。
  - **管控触发点**：当前时间 > (到期日 + 宽限期)。

- **状态流转规则**：
  1.  **逾期提醒（Overdue Warning）**：
      - 触发：当前时间 > 到期日 且 账单状态仍为 `PUBLISHED`。
      - 动作：每日发送催收邮件/短信给企业财务/管理员；企业状态仍保持 `ACTIVE`。
  2.  **触发管控（Suspend）**：
      - 触发：超过宽限期仍未结清 且 欠费总额 > 豁免阈值（Min Threshold，如 10 元）。
      - **前置检查**：检查企业属性 `autoSuspendEnabled`。
        - 若为 `false`（豁免）：仅记录逾期日志，继续发送高频催收提醒，**跳过**后续 SUSPENDED 转换动作。
        - 若为 `true`（默认）：执行以下动作。
      - 动作：
        - 系统自动将企业状态流转为 **`SUSPENDED`**。
        - 触发 `ENTERPRISE_STATUS_CHANGED` 事件（通知下游网关/销售系统）。
        - 强制执行 1.5.1 定义的限制（禁止新开卡、禁止变更套餐）。
  3.  **服务阻断（Service Interruption - 强控模式）**：
      - 触发：进入 `SUSPENDED` 状态超过 X 天（如 15 天）仍未回款。
      - 动作（需系统开关控制）：系统自动创建异步批量任务，对该企业下所有 `ACTIVATED` 的 SIM 卡下发 **停机（Deactivate）** 指令，防止损失扩大。

- **复机/恢复流程（Restoration）**：
  - 触发：企业线下转账或线上支付，财务核销使账单变为 `PAID` 或账户余额充足。
  - 动作：
    - 系统自动将企业状态恢复为 **`ACTIVE`**。
    - 解除新购与变更限制。
    - **注意**：若之前已触发“服务阻断（批量停机）”，系统**不自动**触发批量复机（防止瞬间产生大额流量或企业仍需人工确认），需由管理员或企业用户在 Portal 上手动发起“批量复机”。

#### 3.7.5 信控期间的计费与补缴原则（结论）

- **计费持续性**：
  - 企业进入 `SUSPENDED` 状态不代表计费停止。
  - 计费引擎继续依据 **3.0.2（月租费）** 与 **3.0.1.4（用量）** 规则对 SIM 进行计费。
  - 若系统已成功对 SIM 执行批量停机（`DEACTIVATED`）：按停机保号费收取（或全额，视当月轨迹）。
  - 若 SIM 未能成功停机（仍 `ACTIVATED`）：继续按全额月租收取。
- **复机补缴（无回溯）**：
  - 当企业结清欠费并复机时，**不需要**对信控期间的费用进行“补差价”（即：不要求补交停机期间的月租费）。
  - 理由：信控期间企业确实无法使用服务，按停机保号费收取是公平的。
  - **例外**：若企业属于“高价值豁免”客户（`autoSuspendEnabled=false`），则信控期间服务未中断，自然按全额月租计费，复机时亦无特殊补缴逻辑。
- **欠费结清顺序**：
  - 支付金额优先抵扣：最早的逾期账单 > 滞纳金（如有） > 当前账单。

## 4. 监控、诊断与可观测性

（架构示意图：见 [Monitoring_and_Diagnostics.svg](Monitoring_and_Diagnostics.svg)）

### 4.1 数据源与能力边界（结论）

由于系统不直接对接运营商核心网元（HLR/HSS/PGW），所有监控与诊断数据均依赖上游供应商提供的 API 与文件接口。

- **数据源分类**：
  1.  **管理面 API（Management API）**：
      - 来源：上游供应商 CMP 接口。
      - 内容：SIM 生命周期状态（Status）、当前产品包订阅（Subscription）、累积用量（To-date Usage）。
      - 时效性：近实时（通常有分钟级延迟）或按需同步。
  2.  **话单文件（CDR Files）**：
      - 来源：上游供应商提供的批量话单文件（SFTP/API）。
      - 内容：每一张 SIM 在特定漫游地（Visited Network）的数据会话详情（Start/End Time, Volume, RAT, APN）。
      - 时效性：准实时（通常 T+15min 到 T+24h 不等，取决于漫游链路）。

- **能力约束**：
  - **无信令级诊断**：无法获取鉴权失败（Auth Failure）、位置更新拒绝（LU Reject）等底层信令错误码。
  - **无实时会话状态**：无法实时查看 PDP Context/Bearer 状态，只能通过 API 查询“当前在线状态”（如上游支持）。

### 4.2 诊断能力范围（基于 API）

诊断能力仅限于对“业务状态”与“历史用量”的分析，而非“网络连接”的实时调试。

- **必需诊断项**：
  1.  **业务状态核对**：对比 Reseller System 状态与上游 CMP 实际状态是否一致（如：我方显示 ACTIVATED，上游是否也为 ACTIVATED）。
  2.  **订阅一致性**：检查上游是否正确配置了对应的资费计划与 APN。
  3.  **用量分析**：查询最近一次 CDR 记录，判断 SIM 是否有近期流量产生（以此推断设备是否在线）。
  4.  **网络覆盖检查**：基于历史 CDR 中的 `visitedMccMnc`，确认设备所在区域是否在当前产品包的覆盖范围内。

### 4.3 告警与监控（结论）

- **监控指标**：
  - 业务侧：流量池使用率、套外用量激增、沉默卡（长期无用量）占比。
  - 系统侧：上游 API 连通性、CDR 文件迟到/缺失。

- **告警触发**：
  - 基于 API 同步的状态变更（如：上游通知 SIM 状态变为 RETIRED）。
  - 基于 CDR 计算的异常漫游（Unexpected Roaming）。

- **告警处理与投递可靠性**：
  - **去重键（Dedup Key）**：`tenantId + simId + alertType + windowStart`（避免同一原因反复刷屏）。
  - **抑制（Suppression）**：同一 SIM/同一告警类型在 N 分钟内只通知一次；窗口内新增用量仅更新告警详情。
  - **投递通道**：Email / Webhook（可配置）。
  - **投递安全**：Webhook 必须携带签名（HMAC）与时间戳，支持重放保护。
  - **投递重试**：指数退避重试（至少 3 次），最终失败入“投递失败队列”并可人工补投。

### 4.4 报表

- 必需报表：用量趋势、Top SIM、异常 SIM、停机原因分布
- 指标口径（默认建议）：先按 企业 / 产品包 / SIM 维度统计；暂不按 APN / 资费计划 / 地域 分组（后续可扩展）

### 4.5 可观测性实现要点（结论）

为支撑“可追踪、可定位、可审计”，系统需将北向请求、异步任务与南向调用在同一条链路上关联起来。

- **链路关联（Correlation）**：
  - **requestId**：API Gateway 为每个请求生成/透传 `requestId`，贯穿所有下游服务。
  - **jobId**：所有长耗时/批量操作必须返回 `jobId`，并在日志/事件中携带。
  - **eventId**：事件总线消息必须携带 `eventId` + `occurredAt`，支持幂等消费与重放排查。
  - **idempotencyKey**：南向指令必须携带（避免重复下发导致多次变更）。

- **日志（Logs）**：
  - 结构化日志（JSON）：最小字段包含 `tenantId, requestId, jobId(可选), simId(可选), supplierId(可选), level, code, message`。
  - 关键操作（Provisioning/Billing/权限变更）必须落审计日志，并可按 `tenantId + timeRange` 检索。

- **指标（Metrics）**：
  - 北向：P95/P99 延迟、429/5xx 比例、鉴权失败率。
  - 南向：上游 API 成功率/超时率、重试次数、限速命中次数。
  - 数据侧：CDR 文件迟到/缺失、解析失败率、幂等去重命中率。

- **追踪（Traces）**：
  - 最小要求：北向请求可追踪到核心服务与适配器调用；异步任务可追踪到 MQ 消费与执行结果。

- **能力边界说明（保持一致）**：
  - 系统不依赖 HLR/HSS/PGW 等信令错误码；诊断以“业务状态 + 历史用量 + 覆盖范围”推断为主。

## 5. 集成与接口

### 5.1 南向集成：多供应商虚拟化层（Multi-Vendor Virtualization Layer）

为彻底屏蔽上游供应商（Supplier/Operator）的能力与接口差异，系统构建统一的**虚拟化适配层（Virtualization Layer）**，确保核心业务逻辑的纯净性与稳定性。

- **架构设计（Adapter Pattern + Facade）**：
  - **核心层（Core Domain）**：仅定义与使用标准化的 SPI（Service Provider Interface），完全不感知具体供应商。
  - **虚拟化层（Virtualization Layer）**：
    - **SPI 定义（标准接口）**：
      - `ProvisioningSPI`：标准化指令（如 `activateSim`, `suspendSim`, `changePlan`）。
      - `UsageSPI`：标准化用量获取（如 `getDailyUsage`, `fetchCdrFiles`）。
      - `CatalogSPI`：标准化产品目录映射（如 `mapVendorProduct`）。
    - **适配器（Vendor Adapters）**：针对不同厂商（如 Jasper, Ericsson, 自研 CMP）的独立实现插件。
      - **协议转换**：负责将 REST/SOAP/XML/CMPPv2 等异构协议转换为内部标准对象。
      - **状态映射**：负责将上游五花八门的生命周期状态（如 `Test Ready`, `Inventory`, `Active`）统一映射为系统标准的 5 种状态（INVENTORY/TEST_READY/ACTIVATED/DEACTIVATED/RETIRED）。


- **差异化能力管理（Capability Negotiation）**：
  - **背景**：不同上游的能力参差不齐（例如：有的支持“预约变更”，有的仅支持“立即变更”）。
  - **机制**：每个适配器必须通过元数据声明其**能力集（Capabilities）**。
    - 示例配置：`supportsFutureDatedChange = false`, `supportsRealTimeUsage = true`。
  - **策略路由**：核心业务层根据适配器的能力声明，动态决定执行策略。
    - *案例*：若上游不支持“预约变更”，核心层会自动切换为 **“虚拟预约模式”**（即：系统本地暂存变更请求，由内部调度器在生效日凌晨自动触发立即变更指令）。

- **上游集成技术标准（Technical Standards）**：
  - **指令交互（Provisioning）**：
    - 优先采用 RESTful API（JSON）。
    - 必须支持“异步指令+回调”或“同步指令+状态查询”模式，确保长耗时操作不阻塞。
    - 必须支持幂等性（Idempotency Key）。
  - **数据交付（CDR/Usage）**：
    - **批量文件（推荐）**：通过 SFTP/S3 交付 CSV/JSON 格式的话单/用量文件；文件需包含校验和（Checksum）与行数统计。
    - **API 拉取（可选）**：仅用于近实时用量查询或小规模补数；不作为大规模计费数据主来源。
  
- **网元直连（非 MVP 重点，视供应商能力而定）**：
  - HLR/HSS/PGW：原则上通过供应商 CMP 代理，不直连核心网元。
  - SMSC：通过供应商 CMP API 收发短信；若需直连 SMPP 协议，需在适配层封装为 HTTP 接口。

### 5.2 北向（客户系统）集成（结论）

- **接口规范**：
  - **协议**：RESTful API over HTTPS (JSON)。
  - **文档标准**：必须提供 OpenAPI 3.0 (Swagger) 规范文档。
  - **版本控制**：URI 版本化（如 `/v1/...`）；大版本不兼容变更需提前通知并保留旧版本过渡期（至少 6 个月）。

- **认证与鉴权（Authentication & Authorization）**：
  - **API Key**：适用于 M2M / 后端服务集成（长效密钥，支持轮换）。
  - **OAuth2 / OIDC**：适用于 Web Portal / 第三方应用集成（User Context）。
  - **RBAC**：基于 1.3 定义的权限模型进行细粒度鉴权（Resource-Level）。

- **安全与流控（Security & Throttling）**：
  - **传输安全**：强制 TLS 1.2+。
  - **速率限制（Rate Limiting）**：
    - 按租户（Tenant）+ 接口维度设置配额（Token Bucket 算法）。
    - 超限返回 `429 Too Many Requests`。

- **Webhook 推送**：
  - **机制**：支持企业配置接收地址，订阅特定事件（如 SIM 状态变更、阈值告警）。
  - **安全**：必须包含 HMAC-SHA256 签名（`X-Signature`）供接收方验签。
  - **可靠性**：支持指数退避重试（至少 3 次）；超时/失败计入投递失败日志。

### 5.3 数据同步与权威源（必须明确）

- SIM 状态权威源：上游 CMP（供应商侧）（Reseller System 做镜像+审计）
- 用量/话单权威源：上游 CMP（供应商侧）（默认建议：SFTP 批量为主，API 按需查询为辅）
  - SFTP：按日或按小时投递（以供应商能力为准），支持补传与重放；Reseller 侧按文件幂等入库
  - API：用于近实时查询/兜底核对；需限流、鉴权与幂等
- 指令闭环：下发操作 -> 上游受理回执 -> 最终结果确认（需要 jobId/对账/重试策略）

#### 5.3.1 话单时区与用量归集窗口（结论）

- 上游话单来源时区：可配置（按供应商维度）
- 时间换算：按上游话单来源时区将话单时间换算为 Reseller System 所在时区时间
- 用量归集：按 Reseller System 所在时区的自然月执行

#### 5.3.2 话单/用量数据最小字段（建议）

- 供应商标识：supplierId（对接对象）
- 归属运营商标识（Home，可选）：homeMccMnc（通常可由 SIM 主数据推导；用于对账维度补充）
- 拜访地运营商标识（Visited）：visitedMccMnc（MCC+MNC；用于漫游用量分析与企业计费规则扩展）
- SIM 标识：ICCID（必填）、IMSI（可选）、MSISDN（可选）
- 事件时间：eventTime（上游侧时间戳）+ eventTimeZone（来源时区标识）
- 用量：uplinkBytes、downlinkBytes、totalBytes（至少提供 totalBytes）
- 业务维度：apn（可选）、rat（可选）
- 幂等键：recordId（推荐）或 fileId + lineNo（兜底）

#### 5.3.3 SFTP 交付的幂等、补传与重放（建议）

- 幂等入库：同一份文件/同一条记录可重复投递，Reseller System 需可重复消费且不重复计费
- 补传机制：支持按时间范围或按 fileId 触发补传；支持对“迟到话单”重新归集与重算（保留重算痕迹）
- 重放机制：支持在故障恢复后对历史文件重放（以幂等键去重）

### 5.4 事件目录（Event Catalog）（结论）

为保证异步任务、可观测性与对外通知的一致性，系统需定义统一的事件目录。

- **事件通用字段（必须）**：`eventId`, `eventType`, `occurredAt`, `tenantScope`, `actor`, `payload`, `requestId`（可选）, `jobId`（可选）
- **幂等与去重**：消费者侧必须按 `eventId` 幂等；对外推送（Webhook/Email）按业务去重键抑制重复通知

| eventType | 触发条件 | payload 最小字段 | 去重键（建议） |
|---|---|---|---|
| `SIM_STATUS_CHANGED` | SIM 状态发生变更（上游通知/本地操作/规则触发） | `simId`, `iccid`, `beforeStatus`, `afterStatus`, `supplierId` | `tenantId + simId + afterStatus + occurredAt(1min)` |
| `SUBSCRIPTION_CHANGED` | 订阅创建/变更/退订生效 | `subscriptionId`, `simId`, `packageId`, `beforeState`, `afterState`, `effectiveAt` | `tenantId + subscriptionId + afterState + effectiveAt` |
| `BILL_PUBLISHED` | 账单从生成转为已发布 | `billId`, `enterpriseId`, `period`, `totalAmount`, `dueDate` | `enterpriseId + billId` |
| `PAYMENT_CONFIRMED` | 人工核销或支付回调确认 | `billId`, `enterpriseId`, `paidAmount`, `paidAt`, `paymentRef` | `enterpriseId + billId + paymentRef` |
| `ALERT_TRIGGERED` | 告警触发（异常漫游/池枯竭/沉默卡等） | `alertType`, `enterpriseId`, `simId`（可选）, `threshold`, `currentValue`, `windowStart` | `enterpriseId + simId + alertType + windowStart` |
| `ENTERPRISE_STATUS_CHANGED` | 企业状态变更（ACTIVE/SUSPENDED/INACTIVE） | `enterpriseId`, `beforeStatus`, `afterStatus`, `reason` | `enterpriseId + afterStatus + occurredAt(1min)` |

## 6. 非功能需求（NFR）与技术架构（结论）

### 6.1 可扩展性与性能（Scalability & Performance）
- **微服务架构**：采用领域驱动设计（DDD），核心域包括：资源域（Inventory）、计费域（Billing）、客户域（Customer）、集成域（Integration）。
- **数据模型（Billing Domain）**：
  - **SIM 状态轨迹表**（`sim_state_history`）：记录 SIM 全生命周期状态变更（Type 2 SCD），用于高水位计费。
  - **用量明细表**（`usage_daily_summary`）：按 `SIM + Day + Zone` 预聚合，加速月度账单计算。
- **数据分片（Sharding）**：
  - 话单/用量数据（海量）：按 `SupplierID + 账期` 或 `ICCID` 进行数据库分表/分库。
  - 归档策略：在线库保留 N 个月（如 6 个月），历史数据归档至冷存储（S3/Glacier）。
- **缓存策略**：
  - 使用 Redis 缓存高频读数据（如 SIM 状态、产品包配置、Auth Token）。
  - 计费引擎：本地缓存资费规则，减少对 DB 的 IO 压力。
- **消息队列**：
  - 使用 Kafka/Pulsar 处理高吞吐量数据流（话单接入、状态变更事件）。
  - 削峰填谷：确保下游计费与通知服务不被突发流量压垮。

### 6.2 高并发与 I/O 模型（Concurrency & I/O Model）

针对 CMP 业务特征（上游接口慢且不稳定、下游查询快且高并发、话单数据量大且持续），采用 **“微服务 + 消息队列（MQ）”** 的组合架构，**不引入**传统的重型企业服务总线（ESB）。

- **架构选型：事件驱动微服务（Event-Driven Microservices）**：
  - **核心组件**：
    - **API Gateway**：统一入口，负责鉴权、限流与路由。
    - **Event Bus (RabbitMQ/Kafka)**：内部服务间的通信骨干，替代 ESB。
    - **Microservices**：独立部署的业务单元（Provisioning, Billing, Inventory）。

- **I/O 交互模式与组件选择**：
  1.  **指令通道（Command Channel） - 削峰填谷**：
      - **场景**：企业批量开卡、停机、变更套餐（Provisioning）。
      - **挑战**：上游供应商 API 吞吐量低（如 5 TPS）且易超时，而企业可能瞬间提交 1 万个请求。
      - **方案**：
        - 引入 **RabbitMQ**（或类似 MQ）作为缓冲。
        - 采用 **“生产者-消费者”** 模式：API Gateway 快速接收请求并入队（Ack），后台适配器（Adapter）按上游限制的速率（Throttling）平滑消费并执行。
  2.  **数据通道（Data Channel） - 高吞吐流式处理**：
      - **场景**：每日数百万/千万级话单（CDR）入库、实时累积用量、阈值告警。
      - **挑战**：写入量极大，传统 DB 无法承载实时高频写入。
      - **方案**：
        - 引入 **Kafka** 作为高吞吐数据管道。
        - 采用 **“流式计算（Stream Processing）”**：CDR 文件解析后直接推入 Kafka，计费引擎（Billing Engine）消费流数据进行内存计算（Redis 辅助），仅将聚合结果写入数据库。

- **为什么不选 ESB？**：
  - 传统 ESB 过于厚重，存在单点瓶颈，且难以适应云原生环境。
  - 现代架构倾向于“智能端点，哑管道（Smart Endpoints and Dumb Pipes）”，即逻辑在微服务中，MQ 仅负责高效传输。

### 6.3 高可用与容灾（Availability & DR）
- **部署架构**：
  - **多可用区（Multi-AZ）**：应用服务与数据库主备跨 AZ 部署。
  - **RPO/RTO 目标**：核心业务 RPO < 5分钟，RTO < 30分钟。
- **熔断与限流**：
  - 针对上游 CMP 接口调用设置熔断器（Circuit Breaker），防止级联故障。
  - 关键路径（如鉴权、计费）降级策略：优先保证连接可用，计费可延迟处理。

### 6.4 安全与合规（Security & Compliance）
- **数据安全**：
  - 传输加密：全链路 TLS 1.2+。
  - 存储加密：敏感字段（密钥、PII）AES-256 加密存储。
- **合规性**：
  - **GDPR**：支持“被遗忘权”（销户后按合规要求清除 PII，但保留审计/计费存根）。
  - **审计**：所有关键操作（Provisioning/Billing）保留不可篡改的审计日志（WORM 存储或归档）。
  - **PCI-DSS**：若涉及直接信用卡处理，需满足 PCI 标准（建议通过支付网关 Tokenization 规避）。

### 6.5 数据保留策略（Data Retention）
- **话单/用量明细**：在线查询 6 个月；归档保留 5 年（合规要求）。
- **审计日志**：在线查询 12 个月；归档保留 5 年。
- **账单数据**：永久保留（或至少 10 年）。

## 7. MVP 范围（建议先定一个闭环）

MVP 目标（默认建议，可调整）：在 8 周内交付“可演示、可试用”的最小闭环。

#### 7.1 默认建议（可调整）

- MVP 周期：8 周

- 租户与用户：企业创建、RBAC、审计
- SIM：入库导入、激活/停机、查询详情
- 用量：查询当月汇总
- 账务：余额/套餐余量展示
- 诊断：连接状态查询、重置连接

## 8. 问题清单（Open Questions）

（暂无未决问题）

（已确定项已移入“决策记录”）

## 9. 决策记录（Decision Log）

- [x] 租户层级：供应商 -> 代理商 -> 企业；企业支持部门/项目
- [x] 白标能力：代理商自定义品牌/域名/Logo
- [x] 计费主体最小粒度：企业/部门（两级）
- [x] 计费模式：支持 one-time, SIM Dependent Bundle, Fixed Bundle, Tiered Volume Pricing
- [x] 资费分层：取消两层资费；本期仅实现资费_企业，不实现资费_运营商（批发资费不入库、不计算）
- [x] 阶梯计费口径：Tiered Volume Pricing 采用分段累进（Progressive），不采用全量按档（All-in）
- [x] 共享池口径：按产品包计费规则定义（如 SIM Dependent 动态累加、Fixed 固定总池）
- [x] 异步任务：支持异步任务（jobId + 查询进度/结果）；企业侧 webhook 回调非 MVP 必需（可选）
- [x] SIM 资产标识：ICCID 作为唯一索引；IMEI Lock 默认关闭
- [x] SIM 状态机：INVENTORY/TEST_READY/ACTIVATED/DEACTIVATED/RETIRED
- [x] SIM 状态同步：上游 Notification 驱动对齐 + 下发 CMP API 指令
- [x] 测试期到期判定：Test Expiry Condition 支持 PERIOD_ONLY / QUOTA_ONLY / PERIOD_OR_QUOTA（默认）
- [x] 订阅计数口径：订阅生效时间决定月初取数与月内新增计数；月内变更次月生效
- [x] 用量归集与时区：配置供应商话单来源时区并换算为系统时区；按系统时区自然月归集
- [x] 话单交付方式：SFTP 批量交付为主（推荐 CSV/JSON），API 为辅（近实时查询）
- [x] 数据保留：话单归档 5 年；在线查询 6 个月
- [x] 北向集成：REST API + Webhook（HMAC 签名）；认证支持 API Key / OAuth2
- [x] 南向集成：适配层模式；异步指令 + 幂等设计
- [x] **容量规划**：日均 500 万用量事件，支持峰值 1000 TPS（基于 MQ 削峰填谷）
- [x] **SLA 目标**：可用性 99.9%，核心接口 P95 < 300ms
- [x] **批量处理能力**：单次支持 10 万级批量操作（异步处理）
- [x] **MVP 交付周期**：8 周（最小闭环）

## 10. 计费黄金用例集（Golden Test Cases）

本章节用于将第 3 章“资费、计费与出账口径”的关键规则固化为可执行验收用例（输入 -> 期望输出），作为实现与回归测试的统一标准。

**统一约定**：
- 计费周期：自然月（CALENDAR_MONTH）。
- 流量单位：计费引擎内部按 KB，向上取整（见 3.2）。
- 用量数据维度：`iccid + visitedMccMnc + eventTime`。
- 用量命中规则：叠加包优先；范围最小优先；主套餐兜底；无覆盖则 Out-of-Profile（见 3.0.1.4）。
- Out-of-Profile：不扣减任何现有套餐配额；按主资费计划 `paygRates` 计费并触发“异常漫游”告警。
- 月租费：高水位口径（账期内出现过 ACTIVATED 则收全额月租；否则如出现过 DEACTIVATED 收停机保号费）（见 3.0.2）。
- 迟到话单：落入已发布账期则生成调账单草稿并下期结算（见 3.7.3）。

### 10.1 基础用例（用量匹配与扣减）

| Case | 前置订阅（同一 SIM） | visitedMccMnc | 用量 | 期望命中 | 期望扣减/计费 | 期望告警 |
|---|---|---|---:|---|---|---|
| U-01 | 主：Global 1GB（覆盖全球） | 234-15 | 100MB | 主套餐 | 扣减主套餐配额 100MB | 无 |
| U-02 | 主：Europe 1GB（覆盖欧盟）；叠加：France 500MB（仅法国） | 208-01 | 100MB | 叠加（France） | 扣减 France 配额 100MB | 无 |
| U-03 | 主：Europe 1GB；叠加：France 500MB | 262-02 | 100MB | 主套餐（Europe） | France 不覆盖，扣减 Europe 配额 100MB | 无 |
| U-04 | 主：Europe 1GB；叠加：France 500MB；叠加：EU+UK 800MB | 208-01 | 100MB | 叠加（France） | 多叠加同时覆盖时，范围更小优先（France） | 无 |
| U-05 | 主：Europe 1GB（不含阿联酋）；主资费计划存在 PAYG：Zone4(阿联酋)=0.02 USD/KB | 424-02 | 10MB | Out-of-Profile | 不扣减任何套餐；按 PAYG 计费（10MB -> KB 向上取整） | 异常漫游 |
| U-06 | 主：Europe 1GB；主资费计划 PAYG 未覆盖 999-99 | 999-99 | 10MB | Out-of-Profile | 不扣减；默认阻断或高价告警（按 3.6.2.1 缺省行为） | 异常漫游 + 规则缺失 |
| U-07 | 主：Global 1GB；主套餐配额已耗尽；overageRate=0.01 USD/KB | 234-15 | 10MB | 主套餐 | 配额不足部分按套外单价计费（套外） | 可选（按 Control Policy） |

### 10.2 非活跃状态用量（异常/漏控）

| Case | SIM 状态（话单发生时） | 用量来源 | 期望处理 | 期望告警 |
|---|---|---|---|---|
| U-08 | DEACTIVATED | CDR | 默认按 Out-of-Profile（独立计费 + 告警），不扣减正常套餐 | 异常用量（停机仍有流量） |
| U-09 | RETIRED | CDR | 记录并进入异常队列；不生成对企业可见的“正常扣费”行项（需人工稽核） | 高优先级异常 |

### 10.3 月租费黄金用例（高水位）

| Case | 账期内状态轨迹（示例） | 期望月租项 |
|---|---|---|
| M-01 | 02-10 ACTIVATED → 02-20 DEACTIVATED | 全额月租（出现过 ACTIVATED） |
| M-02 | 全月 DEACTIVATED | 停机保号费 |
| M-03 | 全月 INVENTORY 或 TEST_READY | 无月租项 |
| M-04 | 02-01 00:00:01 ACTIVATED → 02-01 00:00:02 DEACTIVATED | 全额月租（出现过 ACTIVATED，哪怕 1 秒） |

### 10.4 信控联动用例（企业状态 vs SIM 状态）

| Case | 企业状态 | SIM 状态轨迹 | 期望计费 |
|---|---|---|---|
| C-01 | SUSPENDED | 当月曾 ACTIVATED，后被批量停机为 DEACTIVATED | 全额月租（计费只认 SIM 状态） |
| C-02 | SUSPENDED | 全月 DEACTIVATED（停机保号） | 停机保号费 |
| C-03 | SUSPENDED | 漏停机，SIM 持续 ACTIVATED | 全额月租 + 用量计费照常 |

### 10.5 迟到话单与调账用例

| Case | 话单落账期 | 账单状态 | 期望动作 |
|---|---|---|---|
| A-01 | 2026-02（已出账） | PUBLISHED | 生成 Adjustment Note 草稿（Debit/Credit），下期结算；记录 inputRef/calculationId |
| A-02 | 2026-02（未出账/生成中） | GENERATED | 允许进入当期归集与计费；不生成调账单 |

### 10.6 Job/审计/可追溯用例（最小要求）

| Case | 操作 | 期望产物 |
|---|---|---|
| O-01 | `PATCH /sims/{iccid}` 触发停机 | 返回 jobId；审计日志包含 requestId、before/after；事件 `SIM_STATUS_CHANGED` 可查询 |
| O-02 | 计费重算（补数/重放） | 产物可关联到 inputRef（fileId/lineNo 或 recordId）与 ruleVersion（package/price plan version），保留 calculationId |

