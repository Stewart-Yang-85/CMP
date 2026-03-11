# 安全债务登记簿 (T-NEW-6)

> **状态**: MVP 阶段已知并接受的安全债务，V1.1 前必须全部解决。
> **最后更新**: 2026-03-11

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

## 审计清单

| ID | 描述 | 严重级 | MVP 状态 | V1.1 计划 |
|----|------|--------|----------|-----------|
| SD-01 | RLS 未隔离租户 | HIGH | 应用层缓解 | DB 级策略 |
| SD-02 | 无 API 限流 | MEDIUM | 平台级 DDoS + 业务上限 | Token Bucket |
| SD-03 | Scrypt 参数未文档化 | LOW | API Key 未启用 | 文档化 |
| SD-04 | eSIM 未实现 | LOW | 501 guard | 独立 spec + 实现 |
| SD-05 | 租户双层断裂 | HIGH | **已修复** | N/A |
