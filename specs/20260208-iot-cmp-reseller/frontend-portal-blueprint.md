# 前端 WEB Portal 开发蓝图

> **V1.1 范围** — 本文档定义的 Web Portal 不纳入 MVP 交付范围。MVP 阶段使用 Swagger UI + Postman 验证 API 正确性。如需临时操作界面，使用 Retool/Appsmith 低代码平台搭建。

## 目标与范围

- 面向代理商与企业运维的统一门户
- 聚焦 SIM 生命周期、订阅与计费对账、连接诊断与运营交付
- 兼容多环境（测试/预生产/生产）与多租户

## 信息架构与页面清单

### 0. 登录与权限
- 登录页
- 令牌刷新与权限降级提示

### 1. 总览仪表盘
- 关键指标概览（激活数、在线率、异常量、账单差异）
- 今日/近 7 天异常与告警摘要
- 任务执行概况（RUNNING/SUCCEEDED/FAILED）

### 2. SIM 与连接管理
- SIM 列表与筛选（状态/供应商/企业/地域）
- SIM 详情（基础信息/状态历史/套餐与订阅）
- SIM 操作（激活/停机/复机/销号）
- 连接诊断（状态查询、重置连接）

### 3. 订阅与套餐
- 套餐列表与详情
- 订阅列表（按企业/套餐/SIM）
- 订阅详情（计费周期、有效期、变更记录）

### 4. 计费与对账
- 账单列表与详情
- 对账摘要与差异明细
- 异常 SOP 入口与演练记录

### 5. 任务与异步作业
- 任务列表与详情
- 任务状态追踪与错误回放

### 6. 审计与导出中心
- 审计日志查询与导出
- 事件流查询与导出

### 7. 运营交付与证据
- 验收包与交付材料索引
- 证据链接与模板下载

### 8. 管理与设置
- 代理商/企业/部门与用户管理
- 角色与权限配置
- Webhook 与密钥管理
- 环境切换

## 关键接口映射

### 认证与会话
- POST /v1/auth/login
- POST /v1/auth/refresh

### SIM 与连接
- GET /v1/sims
- POST /v1/sims
- GET /v1/sims/{simId}
- PATCH /v1/sims/{simId}
- GET /v1/sims/{simId}/subscriptions
- GET /v1/sims/{simId}/connectivity-status
- POST /v1/sims/{simId}:reset-connection
- POST /v1/sims/{id}:activate
- POST /v1/sims/{id}:deactivate
- POST /v1/sims/{id}:reactivate
- POST /v1/sims/{id}:retire
- POST /v1/sims/import-jobs

### 订阅与套餐
- GET /v1/subscriptions
- POST /v1/subscriptions
- GET /v1/packages
- GET /v1/packages/{packageId}

### 计费与对账
- GET /v1/bills
- GET /v1/bills/{billId}
- GET /v1/bills/{billId}/files

### 任务与作业
- GET /v1/jobs/{jobId}

### 管理端与导出
- /admin/*（审计、事件、任务导出与触发）

### 代理商与企业管理
- POST/GET /v1/resellers
- POST /v1/resellers/{id}/users
- POST /v1/enterprises/{id}:change-status
- POST/GET /v1/enterprises/{id}/departments

## 组件结构（可执行拆分）

### 1. 应用骨架
- AppShell（侧边栏、顶部栏、环境切换、账户菜单）
- RouteGuard（鉴权与权限拦截）

### 2. 数据与状态
- ApiClient（基于 OpenAPI 生成）
- QueryCache（列表分页、筛选与刷新策略）
- SessionStore（令牌、租户与角色）

### 3. 通用业务组件
- DataTable（列配置、筛选、分页、导出）
- FilterBar（条件组合、保存视图）
- KeyMetrics（指标卡）
- StatusBadge（SIM/任务/账单状态）
- EvidenceLink（证据链接预览与复制）

### 4. 关键页面组件
- SimListPage / SimDetailPage
- SubscriptionListPage / SubscriptionDetailPage
- BillingListPage / BillingDetailPage / ReconciliationPage
- JobListPage / JobDetailPage
- AuditLogPage / EventsPage / ExportCenterPage
- AdminResellerPage / EnterprisePage / DepartmentPage / UserPage

### 5. 表单与交互
- SimActionDialog（激活/停机/复机/销号）
- ReconcileRunDialog（对账摘要与差异核验）
- WebhookConfigForm（密钥与回调地址）

## 数据与交互规范

- 列表统一支持：分页、筛选、排序、导出
- 关键操作必须二次确认并写入审计
- 异步作业统一入口：创建任务 + 轮询状态

## 页面 → 接口 → 组件字段对齐

### 登录与权限

| 区域/组件 | 接口 | 字段 |
| --- | --- | --- |
| 登录表单 | POST /v1/auth/login | clientId、clientSecret |
| 会话管理 | POST /v1/auth/refresh | refreshToken、expiresAt |
| 顶部账户菜单 | 本地会话 | userName、role、tenantName |

### 总览仪表盘

| 区域/组件 | 接口 | 字段 |
| --- | --- | --- |
| KeyMetrics | GET /v1/sims | totalCount、activeCount、inactiveCount |
| 告警摘要 | GET /v1/sims | status、lastSeenAt、alertCount |
| 任务概况 | GET /v1/jobs/{jobId} | status、createdAt、finishedAt、error |

### SIM 列表

| 区域/组件 | 接口 | 字段 |
| --- | --- | --- |
| FilterBar | GET /v1/sims | status、supplierId、enterpriseId、region |
| DataTable 列 | GET /v1/sims | simId、iccid、msisdn、status、supplierName、enterpriseName、packageName、lastSeenAt |
| 批量导入 | POST /v1/sims/import-jobs | fileId、jobId |

### SIM 详情

| 区域/组件 | 接口 | 字段 |
| --- | --- | --- |
| 基础信息卡 | GET /v1/sims/{simId} | simId、iccid、msisdn、imsi、status、supplierId、enterpriseId、activatedAt |
| 订阅列表 | GET /v1/sims/{simId}/subscriptions | subscriptionId、packageId、status、startAt、endAt |
| 状态历史 | GET /v1/sims/{simId} | statusHistory、changedAt、changedBy |

### SIM 操作与连接诊断

| 区域/组件 | 接口 | 字段 |
| --- | --- | --- |
| 激活/停机/复机/销号 | POST /v1/sims/{id}:activate<br>POST /v1/sims/{id}:deactivate<br>POST /v1/sims/{id}:reactivate<br>POST /v1/sims/{id}:retire | reason、operator、jobId |
| 连接状态 | GET /v1/sims/{simId}/connectivity-status | radioTech、signalStrength、ipAddress、lastOnlineAt |
| 重置连接 | POST /v1/sims/{simId}:reset-connection | requestId、result、jobId |

### 套餐与订阅

| 区域/组件 | 接口 | 字段 |
| --- | --- | --- |
| 套餐列表 | GET /v1/packages | packageId、packageName、quota、cycle、price |
| 套餐详情 | GET /v1/packages/{packageId} | packageId、versions、terms、limits |
| 订阅列表 | GET /v1/subscriptions | subscriptionId、enterpriseId、packageId、status、startAt、endAt |
| 订阅详情 | GET /v1/subscriptions | billingCycle、autoRenew、changeHistory |

### 计费与对账

| 区域/组件 | 接口 | 字段 |
| --- | --- | --- |
| 账单列表 | GET /v1/bills | billId、period、enterpriseId、amount、status |
| 账单详情 | GET /v1/bills/{billId} | billId、period、items、totalAmount、generatedAt |
| 对账文件 | GET /v1/bills/{billId}/files | fileId、fileType、downloadUrl |
| 对账摘要 | GET /v1/bills | deltaAmount、deltaCount、reconciledAt |

### 任务中心

| 区域/组件 | 接口 | 字段 |
| --- | --- | --- |
| 任务详情 | GET /v1/jobs/{jobId} | jobId、jobType、status、progress、startedAt、finishedAt、error |
| 错误回放 | GET /v1/jobs/{jobId} | error、failedItems |

### 审计与导出中心

| 区域/组件 | 接口 | 字段 |
| --- | --- | --- |
| 审计日志 | /admin/* | action、actor、targetId、createdAt |
| 事件流 | /admin/* | eventType、payload、createdAt |
| 导出中心 | /admin/* | csvType、downloadUrl、createdAt |

### 管理与设置

| 区域/组件 | 接口 | 字段 |
| --- | --- | --- |
| 代理商管理 | POST/GET /v1/resellers | resellerId、name、status、owner |
| 企业管理 | POST /v1/enterprises/{id}:change-status | enterpriseId、status、changedAt |
| 部门管理 | POST/GET /v1/enterprises/{id}/departments | departmentId、name、parentId |
| 代理商用户 | POST /v1/resellers/{id}/users | userId、email、role |
| Webhook 配置 | /admin/* | callbackUrl、secret、status |
| 环境切换 | 本地配置 | envName、baseUrl |

## 交付节奏建议

1. 登录与会话框架
2. SIM 列表与详情 + 连接诊断
3. 订阅与套餐
4. 计费与对账
5. 任务中心 + 审计/导出
6. 管理与设置

## 前端工程化与运行要求

### 运行方式与目录结构
- 推荐独立前端项目，或在当前仓库新增 frontend 目录单独构建
- 基础目录建议：src/pages、src/components、src/services、src/store、src/routes、src/assets

### 环境配置
- BASE_URL：后端 API 基地址
- AUTH_CLIENT_ID / AUTH_CLIENT_SECRET：登录凭证
- ADMIN_API_KEY：管理端能力（仅管理员可用）
- CMP_WEBHOOK_KEY：Webhook 配置与演示

### 路由与导航
- 统一入口：/login、/dashboard、/sims、/subscriptions、/billing、/jobs、/audits、/exports、/admin
- 顶部环境切换影响 BASE_URL 与权限上下文

## 权限与多租户规则

- 代理商仅可访问自身下属企业与 SIM
- 企业管理员可管理部门与用户
- 审计与导出为管理员可见模块

## 数据模型速览

| 模型 | 关键字段 |
| --- | --- |
| SIM | simId、iccid、msisdn、imsi、status、supplierId、enterpriseId |
| Subscription | subscriptionId、packageId、status、startAt、endAt |
| Package | packageId、packageName、quota、cycle、price |
| Bill | billId、period、amount、status |
| Job | jobId、jobType、status、progress、error |

## 交互与状态策略

- 列表分页：page、pageSize、sort
- 详情页缓存：基于 simId、billId、jobId 的缓存键
- 异步任务：创建后轮询 status，失败态展示 error
- 批量操作：逐条展示结果与错误码，汇总展示成功/失败/幂等计数

### 批量错误码展示规则

| 错误码 | 展示文案 | 处理建议 |
| --- | --- | --- |
| INVALID_SIM_ID | SIM 标识无效 | 检查 simId/ICCID 格式 |
| RESOURCE_NOT_FOUND | SIM 不存在或无权限 | 检查所属企业或输入清单 |
| INVALID_STATE | 当前状态不允许变更 | 先完成必要的前置状态 |
| ENTERPRISE_INACTIVE | 企业未激活 | 启用企业后再操作 |
| COMMITMENT_NOT_MET | 承诺期未满足 | 等待承诺期结束或走豁免流程 |
| INTERNAL_ERROR | 系统处理失败 | 稍后重试或联系管理员 |

### i18n 文案配置建议

```json
{
  "errors": {
    "batch": {
      "INVALID_SIM_ID": "SIM 标识无效",
      "RESOURCE_NOT_FOUND": "SIM 不存在或无权限",
      "INVALID_STATE": "当前状态不允许变更",
      "ENTERPRISE_INACTIVE": "企业未激活",
      "COMMITMENT_NOT_MET": "承诺期未满足",
      "INTERNAL_ERROR": "系统处理失败"
    }
  }
}
```

## 安全与合规要求

- 不在前端存储任何服务端密钥
- 重要操作前确认并记录审计
- 导出链接需签名或短期有效

## 观测与质量

- 关键路径埋点：登录、SIM 操作、对账、导出
- 错误捕获：接口异常与前端异常统一上报
- 前端性能目标：核心列表首屏 < 2s
