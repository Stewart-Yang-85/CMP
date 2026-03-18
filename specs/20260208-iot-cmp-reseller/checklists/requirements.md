# Quality Checklist: iot-cmp-reseller

**Feature**: `iot-cmp-reseller`
**Generated**: 2026-02-08
**Source**: `CMP_Requirements_Workshop.md` (1523 lines)
**Target**: `spec.md` (914 lines)

## Completeness Verification (spec.md >= source)

### 1. Background & Goals (§0)
- [x] 平台定位：Reseller System（面向代理商运营与企业自助）
- [x] 上游集成：对接上游供应商 CMP
- [x] 统一模式架构图（模式 a / 模式 b / 统一模式）
- [x] 名词约定（供应商/运营商/代理商/企业）
- [x] 关系模型（供应商-SIM-产品包-运营商-代理商-企业关联关系）
- [x] 量化目标（10万SIM / 500万条/日 / 1000 TPS / 99.9% / P95 300ms）
- [x] 非目标（物理卡片物流/核心网元/实时流控/C端计费）
- [x] 上线里程碑（PoC T+1月 / 内测 T+3月 / 商用 T+5月）

### 2. Roles & Tenant Model (§1)
- [x] 三级租户层级：供应商 -> 代理商 -> 企业 -> 部门/项目
- [x] 白标能力（代理商自定义品牌/域名/Logo）
- [x] RBAC 角色定义（系统管理员 / 代理商角色 / 企业角色）
- [x] 系统管理员权限范围与操作
- [x] 代理商管理员权限范围与操作
- [x] 销售总监权限（仅限被分配企业集合）
- [x] 销售权限（仅限被分配企业）
- [x] 财务权限（只读）
- [x] 企业管理员权限
- [x] 企业运维权限（仅所属部门 SIM）
- [x] 权限边界（最小可见、最小可操作）
- [x] 企业对象属性（ID/名称/状态/autoSuspendEnabled/归属代理商）
- [x] 企业三态（ACTIVE/INACTIVE/SUSPENDED）业务规则
- [x] 企业状态变更实时生效 + ENTERPRISE_STATUS_CHANGED 事件
- [x] 上游主数据（供应商 UUID / 运营商 E.212 MCC+MNC）
- [x] 供应商-运营商多对多关联 + 禁止创建未关联运营商的供应商
- [x] GSMA 分配表校验（允许管理员紧急覆写+审计）
- [x] 操作审计（审计日志最小字段）
- [x] API 接口（POST /v1/resellers, enterprises, departments, users）

### 3. SIM Lifecycle (§2)
- [x] SIM 卡清单字段（ICCID/IMSI/MSISDN/SIM形态/Activation Code/供应商/运营商/状态/企业归属/产品包/用量/IMEI）
- [x] 5 状态生命周期（INVENTORY/TEST_READY/ACTIVATED/DEACTIVATED/RETIRED）
- [x] INVENTORY 初始状态与允许操作
- [x] TEST_READY 测试期规则（Test Period / Test Quota / Test Expiry Condition）
- [x] ACTIVATED 规则（Control Policy / 禁止直接 RETIRED）
- [x] DEACTIVATED 规则（拆机限制 / 承诺期门槛 max(首次订阅时间_i + 承诺期_i)）
- [x] RETIRED 终态（永久退出 / 禁止回退 / 保留审计）
- [x] 状态对齐（上游 CMP 为权威源 / 上下游同步机制）
- [x] 企业状态 vs SIM 状态独立性
- [x] 单向驱动（企业 SUSPENDED 可手工触发批量停机）
- [x] 计费只认 SIM 状态
- [x] 批量与异步任务（10万条上限 / Job 状态 QUEUED-CANCELLED）
- [x] 幂等（batchId/fileHash / idempotencyKey）
- [x] 重试（指数退避 + 最大 3 次）
- [x] SIM 入库仅代理商 Portal（不对企业开放）
- [x] 必填字段（供应商ID/运营商ID/ICCID/Primary IMSI/APN）
- [x] API 接口（import-jobs / jobs / sims / activate / deactivate / reactivate / retire）

### 4. Pricing & Billing (§3)
- [x] 权威源（SIM 状态/用量/话单以上游 CMP 为准）
- [x] 仅实现资费_企业，不实现资费_运营商
- [x] 4 种资费计划类型（One-time / SIM Dependent Bundle / Fixed Bundle / Tiered Pricing）
- [x] 通用规则（金额精度/流量单位KB/生效时间/业务类型/计费周期）
- [x] 通用字段（serviceType/currency/billingCycleType/firstCycleProration/prorationRounding）
- [x] 分摊算法（DAILY_PRORATION: perDayFee/activeDays/chargedMonthlyFee）
- [x] One-time 规则（oneTimeFee/quotaKb/validityDays/expiryBoundary）
- [x] SIM Dependent Bundle 规则（monthlyFee/deactivatedMonthlyFee/perSimQuotaKb/overageRatePerKb）
- [x] Fixed Bundle 规则（monthlyFee/deactivatedMonthlyFee/totalQuotaKb/overageRatePerKb）
- [x] Tiered Pricing 规则（monthlyFee/deactivatedMonthlyFee/tiers[]）
- [x] 分段累进（Progressive）计费公式
- [x] Zone-based PAYG Rates（paygRates[]/zoneCode/countries/ratePerKb）
- [x] PAYG 匹配优先级（MCC+MNC > MCC 通配）
- [x] PAYG 冲突处理（同级冲突配置错误阻断）
- [x] 运营商业务（RAT/业务类型/Roaming Profile/APN）
- [x] 商业条款（Test Period/Test Quota/Test Expiry Condition/Commitment Period）
- [x] 控制策略（on/off/Throttling Policy/达量断网 Cutoff）
- [x] 月租费高水位计费（High-Water Mark）
- [x] 月租费判定（全额月租/停机保号费/无月租）
- [x] 月租费与停机保号费绝对互斥
- [x] Waterfall Logic 用量匹配（叠加包优先 -> 范围最小 -> 主套餐 -> Out-of-Profile）
- [x] Out-of-Profile 不扣减套餐配额 + PAYG 独立计费
- [x] SIM Dependent Bundle 总配额 = activatedSimCount(高水位) × perSimQuotaKb
- [x] 多包场景示例（Global + France + 古巴）
- [x] 用量数据采集（API 拉取 + CDR 解析）
- [x] 漫游用量报表最小字段
- [x] 一致性与审计（幂等/迟到话单/inputRef/ruleVersion/calculationId）

### 5. Billing & Invoicing (§3.7)
- [x] 出账流程（数据归集 -> 批价计费 -> 账单生成 -> 发布通知）
- [x] 出账触发（T+N 日自动，N 默认 3）
- [x] 账单结构（L1 汇总 / L2 分组 / L3 SIM 明细）
- [x] 账单状态（GENERATED -> PUBLISHED -> PAID / OVERDUE / WRITTEN_OFF）
- [x] 导出格式（PDF / CSV/Excel 百万级行）
- [x] 调账（Credit Note / Debit Note）
- [x] 已发布账单不可篡改
- [x] 迟到话单处理（自动生成 Adjustment Note 草稿）
- [x] API 接口（GET /v1/bills / bills/{id} / bills/{id}/files / mark-paid / adjust）

### 6. Dunning Process (§3.7.4-3.7.5)
- [x] 时间轴（账单日 -> 到期日 -> 宽限期 -> 管控触发点）
- [x] 逾期提醒（Overdue Warning）
- [x] 管控等级（Suspend）记录与建议，不自动变更企业状态
- [x] 服务阻断（Service Interruption）建议（批量停机需人工触发）
- [x] 复机/恢复（企业状态手工恢复，不自动批量复机）
- [x] 信控期间计费持续
- [x] 复机无回溯补缴
- [x] 欠费结清顺序（最早逾期 > 滞纳金 > 当前账单）

### 7. Monitoring & Diagnostics (§4)
- [x] 数据源（管理面 API / CDR 文件）
- [x] 能力约束（无信令级诊断/无实时会话状态）
- [x] 诊断能力（业务状态核对/订阅一致性/用量分析/网络覆盖检查）
- [x] 告警（流量池使用率/套外激增/沉默卡/异常漫游）
- [x] 告警去重（resellerId + simId + alertType + windowStart）
- [x] 告警抑制（N 分钟内仅通知一次）
- [x] 投递（Email/Webhook + HMAC 签名 + 时间戳 + 重放保护）
- [x] 投递重试（指数退避至少 3 次）
- [x] 报表（用量趋势/Top SIM/异常 SIM/停机原因分布）
- [x] 连接状态 API（connectivity-status / reset-connection / location / location-history）
- [x] 架构示意图引用（Monitoring_and_Diagnostics.svg）

### 8. Integration (§5)
- [x] 南向虚拟化层（Adapter Pattern + Facade）
- [x] SPI 定义（ProvisioningSPI / UsageSPI / CatalogSPI）
- [x] 差异化能力管理（Capability Negotiation / supportsFutureDatedChange）
- [x] 上游技术标准（RESTful API / 幂等 / SFTP 批量文件）
- [x] 北向接口（RESTful HTTPS JSON / OpenAPI 3.0 / URI 版本化）
- [x] 认证（API Key + OAuth2/OIDC）
- [x] Rate Limiting（Token Bucket / 429）
- [x] Webhook（HMAC-SHA256 / 指数退避重试）
- [x] 数据同步（SIM 状态/用量权威源 = 上游 CMP）
- [x] 话单/用量数据最小字段
- [x] SFTP 交付（幂等入库/补传/重放）
- [x] 话单时区处理

### 9. Events & Observability (§4.5 / §5.4)
- [x] 事件目录（6 种事件类型 + payload + 去重键）
- [x] 链路关联（requestId / jobId / eventId / idempotencyKey）
- [x] 结构化日志（JSON / resellerId / customerId / requestId）
- [x] 指标（北向 P95/P99 / 南向成功率 / CDR 迟到）
- [x] 追踪（北向到核心服务+适配器 / 异步任务到 MQ）

### 10. NFR & Architecture (§6)
- [x] 微服务架构（DDD：资源域/计费域/客户域/集成域）
- [x] 数据模型（sim_state_history Type 2 SCD / usage_daily_summary）
- [x] 数据分片（SupplierID+账期 / ICCID）
- [x] 归档（在线 6 个月 / 冷存储）
- [x] 缓存（Redis）
- [x] 消息队列（Kafka/Pulsar）
- [x] 事件驱动微服务（API Gateway + Event Bus + Microservices）
- [x] 指令通道（RabbitMQ 缓冲）
- [x] 数据通道（Kafka 高吞吐）
- [x] 高可用（Multi-AZ / RPO<5min / RTO<30min / Circuit Breaker）
- [x] 安全（TLS 1.2+ / AES-256 / GDPR / WORM / PCI-DSS）
- [x] 数据保留（话单 6月+5年 / 审计 12月+5年 / 账单永久）

### 11. MVP Scope (§7)
- [x] MVP 目标 8 周
- [x] MVP 范围（租户/SIM/用量/账务/诊断）

### 12. Golden Test Cases (§10)
- [x] 基础用例 U-01 ~ U-07（用量匹配与扣减）
- [x] 非活跃状态 U-08 ~ U-09
- [x] 月租费 M-01 ~ M-04（高水位）
- [x] 信控联动 C-01 ~ C-03
- [x] 迟到话单 A-01 ~ A-02
- [x] Job/审计 O-01 ~ O-02

### 13. Decision Log (§9)
- [x] 全部 22 项决策已记录

### 14. Edge Cases
- [x] 12 个边界场景全部覆盖

## Structural Quality

- [x] 11 个 User Stories 均含完整结构（描述/优先级/技术实现/独立测试/验收场景）
- [x] 39 条功能需求（FR-001 ~ FR-039）按模块分组
- [x] 13 个关键实体定义完整
- [x] 14 条成功标准（SC-001 ~ SC-014）可量化
- [x] 优先级分配合理（P1: 核心交易流程 / P2: 运营保障）
- [x] 无 [NEEDS CLARIFICATION] 项（源文档所有决策已确定）

## Traceability Matrix

| Source Section | Spec Coverage | Status |
|---|---|---|
| §0 背景与目标 | User Story 1 + NFR + MVP | ✅ Complete |
| §1 角色与租户 | User Story 1 + FR-001~007 | ✅ Complete |
| §2 SIM 生命周期 | User Story 2 + FR-008~014 | ✅ Complete |
| §3 资费/计费/出账 | User Stories 3-6 + FR-015~032 | ✅ Complete |
| §3.7.4 信控 | User Story 7 + FR-033~034 | ✅ Complete |
| §4 监控诊断 | User Story 9 | ✅ Complete |
| §5 集成接口 | User Stories 8,10 + FR-035~038 | ✅ Complete |
| §5.4 事件目录 | User Story 11 + FR-039 | ✅ Complete |
| §6 NFR | NFR Section | ✅ Complete |
| §7 MVP | MVP Section | ✅ Complete |
| §10 Golden Cases | Golden Test Cases Section | ✅ Complete |
| §9 Decision Log | Decision Log Section | ✅ Complete |

## Summary

- **Total source sections checked**: 14
- **Fully covered**: 14 / 14 (100%)
- **Missing items**: 0
- **Needs clarification**: 0
- **Overall status**: ✅ PASS
