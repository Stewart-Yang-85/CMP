# 安全债务登记簿 (T-NEW-6)

> **状态**: MVP 阶段已知并接受的安全债务，V1.1 前必须全部解决。
> **最后更新**: 2026-04-21

---

## SD-01: RLS 策略未实现租户级隔离

**严重级**: HIGH | **目标修复版本**: V1.1

**现状**: V007_rls_policies.sql 中所有策略仅区分 `authenticated` vs `anon` 角色。任何已认证用户可查询任何 reseller 的 SIM 卡、账单、订阅等数据。

**MVP 缓解措施**:
- 应用层通过 `tenantScope.ts` 中间件强制注入 `enterprise_id` / `reseller_id` 过滤
- 所有 Supabase 查询使用 `service_role` key，绕过 RLS（信任应用层过滤）
- 限制 MVP 部署范围：仅内部团队 + 1-2 个可信客户

**V1.1 修复方案**:
```sql
-- 示例：SIM 表租户隔离
CREATE POLICY sims_tenant_isolation ON sims
  FOR ALL TO authenticated
  USING (enterprise_id IN (
    SELECT tenant_id FROM users
    WHERE user_id = auth.uid()
    UNION
    SELECT enterprise_id FROM enterprise_user_departments
    WHERE user_id = auth.uid()
  ));
```
需要为所有包含 `enterprise_id` / `reseller_id` 的表创建类似策略。

---

## SD-02: 无 API 速率限制

**严重级**: MEDIUM | **目标修复版本**: V1.1

**现状**: T100 (rateLimit.ts) 已标记为 V1.1。MVP 阶段无任何 API 请求速率限制。

**MVP 缓解措施**:
- Vercel 平台级提供基础的 DDoS 防护
- SIM 批量导入已有 10 万行上限校验
- 批量状态变更已有 100 条上限
- 仅向可信客户开放 API

**V1.1 修复方案**:
- 实现 Token Bucket 算法，按 `tenant_id` + 接口路径限流
- 超限返回 429 + `Retry-After` 头
- 默认: 100 req/min (普通接口), 10 req/min (写入接口), 2 req/min (批量操作)

---

## SD-03: API Secret Hash 加密参数未文档化

**严重级**: LOW | **目标修复版本**: V1.1

**现状**: `customers.api_secret_hash` 使用 scrypt 算法加密（实现在 `src/middleware/apiKeyAuth.ts`），但以下参数未文档化:
- scrypt 参数 (N, r, p, keyLen)
- salt 生成策略
- 密钥轮换流程

**MVP 缓解措施**: API Key 认证 (T098) 本身已推迟到 V1.1，当前不存在运行时风险。

**V1.1 修复方案**: 在 `docs/security.md` 中文档化 scrypt 参数 + salt 策略 + 轮换 SOP。

---

## SD-04: eSIM 生命周期未实现

**严重级**: LOW (MVP) | **目标修复版本**: V1.1

**现状**: `esim_profiles` 表已在 data-model.md 中定义，但:
- SM-DP+ profile state → 本地 SIM state 的映射规则未定义
- eSIM 激活需要设备端确认的异步流程未设计
- eSIM 退役时是否需要通知 SM-DP+ 删除 profile 未明确

**MVP 缓解措施**: `simLifecycle.ts` 中增加 guard：eSIM 类型操作返回 `501 NOT_IMPLEMENTED`。

**V1.1 修复方案**:
1. 产出 eSIM 状态机独立 spec
2. 定义 SM-DP+ callback webhook 接口
3. 实现 `esimLifecycle.ts` 服务

---

## SD-05: 租户模型双层架构

**严重级**: HIGH (已修复) | **修复状态**: MVP 已修复

**修复内容**: V003_tenant_reseller.sql 中 `resellers` 和 `customers` 表增加了 `tenant_id UUID NOT NULL REFERENCES tenants(tenant_id) UNIQUE` 列，建立了 Layer 1 (tenants) ↔ Layer 2 (resellers/customers) 的一对一映射。

**注意**: Service 层创建 reseller/customer 时，必须先创建 tenants 记录，再用返回的 tenant_id 创建 reseller/customer 记录。

---

## SD-06: Reseller 身份标识已统一为 tenants.tenant_id

**严重级**: HIGH (已修复) | **修复状态**: V1.1 Phase 24 已修复

**问题**: `auth.resellerId` 可能来自 `resellers.id`（如 `customers.reseller_id`）或 `tenants.tenant_id`，导致：
- `tenants.parent_id` 层级查询用 `resellers.id` 查不到子企业（静默返回空）
- `reseller_suppliers` 等用 `tenant_id` 查关联数据失败
- `buildTenantFilterAsync` 等租户隔离函数行为不一致

**修复内容** (V1.1 Phase 24):
1. **DB 迁移**: `customers` 新增 `reseller_tenant_id` FK→tenants(tenant_id)，弃用 `reseller_id`
2. **DB 迁移**: `reseller_suppliers.reseller_id` FK 改为指向 tenants(tenant_id)
3. **API Key 认证**: 从 `customers.reseller_tenant_id` 直接获取 tenant_id
4. **JWT 签发**: login 路径通过 `customers.reseller_tenant_id` 解析 reseller tenant_id 写入 JWT
5. **OIDC**: 文档化 OIDC claims 必须使用 tenant_id 语义
6. **代码清理**: 移除 `resolveResellerIdentity` workaround 函数（`src/app.js`、`src/routes/simPhase4.js`）

**设计决策**: 所有身份标识统一使用 `tenants.tenant_id`。对外契约与鉴权语义以 **`tenant_id`** 为准；**`resellers.id` 仅在有限 HTTP 兼容期**内仍可作为路径/Body 输入，见 **SD-07**。

---

## SD-07: `resellers.id` 路径与 Body 兼容日落（T183）

**严重级**: LOW（过渡期） | **公告日**: 2026-03-30 | **目标移除日**: **2027-03-31**（此后次要版本发布中落实）

**背景（FR-058）**: 路径参数、查询、Body 与 JWT 中的 **`resellerId`** 语义应为 RESELLER **`tenants.tenant_id`**。为降低既有集成破损，实现上仍允许将 **`resellers.id`** 传入部分路由，经 `resolveResellerForEnterpriseScope`（或等价逻辑）解析为同一代理商主体。

**对外公告**（集成方须知）:

1. **应立即采用** `create_reseller`（或 `GET /v1/resellers` 等）返回的 **`tenant_id` / JSON `resellerId`**（与 **`tenants.tenant_id`** 一致），勿依赖 `resellerRecordId`（`resellers.id`）拼 URL。
2. **自 2027-03-31 起**：在计划内的版本中，**不再保证**在路径或请求体中使用裸 **`resellers.id`** 作为代理商标识；此类请求将按未识别资源处理（如 **404**），请在此之前完成切换。
3. **例外**：数据库 RPC（如 `create_customer(p_reseller_id)`）若仍定义为 `resellers.id`，以数据库函数签名为准；与 HTTP API 的「代理商公网 id」分离。

**到期后工程动作**（维护者清单）:

- 收窄或删除对路径/Body **`resellers.id`** 的 `or=(id.eq...,tenant_id.eq...)` 式解析；仅接受 **UUID = `tenants.tenant_id`**。
- 更新 OpenAPI / 契约文案，移除「误传 `resellers.id` 仍可解析」的兼容说明。
- 回归：`tests/resellerIdentity.test.ts` 等中「path 使用 `resellers.id` 仍可 200」用例改为仅限过渡期或删除。

**参考**: [tenant-api.md §0](contracts/tenant-api.md)、[tasks.md T183](tasks.md)。

---

<a id="sd-08-control-policy-breaking"></a>

## SD-08: Control Policy 请求体破坏性变更（Phase 29）

**严重级**: MEDIUM（集成兼容性） | **公告日**: 2026-04-21 | **生效**: 部署含 **T210** 的应用版本起（写路径立即拒绝旧键）

**背景**: 产品包域 `controlPolicy`（`control_policy_modules.control_policy`、`packages.control_policy`、资费 `payg_rates.meta.controlPolicy`）已统一为 [clarifications/control-policy-module.md](clarifications/control-policy-module.md)（T205）嵌套结构，**不再**使用扁平废弃键。

**对外公告**（集成方迁移清单）:

1. **禁止** 在请求 JSON 根级再发送 **`cutoffPolicyId`**、**`throttlingPolicyId`**、**`cutoffThresholdMb`**；此类请求返回 **400**。
2. **应改用**：**`enabled`**（boolean，必填）；可选 **`cutoff`**（`timeWindow`: `DAILY` \| `MONTHLY`，`thresholdMb`，`action`）；可选 **`throttling`**（`timeWindow`，非空 **`tiers[]`**：`thresholdMb`，`downlinkKbps`，`uplinkKbps`）。
3. **存量行**（库内仍为旧 JSON）：读响应可能仍含旧键直至迁移或重保存；**发布**前须符合 T205（见 [runbook-phase29-control-policy-legacy.md](runbook-phase29-control-policy-legacy.md)、[T209](tasks.md#phase-29-control-policy)）。
4. **OpenAPI / 生成客户端**：以 `iot-cmp-api.yaml` / `packages/openapi/*` 中 **`ControlPolicy`** schema 为准；若使用旧生成物，请 **T199** 再生。

**参考**: [tasks.md — Phase 29](tasks.md#phase-29-control-policy)、[plan.md — 变更交付顺序 / 路线图](plan.md#t184-gate)、[pricing-api.md §5](contracts/pricing-api.md)。

---

## 审计清单

| ID | 描述 | 严重级 | MVP 状态 | V1.1 计划 |
|----|------|--------|----------|-----------|
| SD-01 | RLS 未隔离租户 | HIGH | 应用层缓解 | DB 级策略 |
| SD-02 | 无 API 限流 | MEDIUM | 平台级 DDoS + 业务上限 | Token Bucket |
| SD-03 | Scrypt 参数未文档化 | LOW | API Key 未启用 | 文档化 |
| SD-04 | eSIM 未实现 | LOW | 501 guard | 独立 spec + 实现 |
| SD-05 | 租户双层断裂 | HIGH | **已修复** | N/A |
| SD-06 | Reseller 身份双标识 | HIGH | **V1.1 已修复** | N/A |
| SD-07 | `resellers.id` HTTP 输入兼容 | LOW | 过渡期接受 | **2027-03-31** 起仅 `tenant_id` |
| SD-08 | Control Policy JSON 请求体换型 | MEDIUM | N/A | T205 + T210；见公告与 runbook |
