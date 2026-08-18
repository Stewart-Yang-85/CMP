# Runbook：Package 单实体迁移（Phase 28）

**迁移文件**：`supabase/migrations/20260422100001_packages_single_entity.sql`  
**关联**：[plan.md — T184 门禁](./plan.md#t184-gate)、[tasks.md — Phase 28](./tasks.md#phase-28)

## 1. 前置

- 全库 **`pg_dump`**（或托管平台等价快照），并记录当前应用与 Supabase 版本。
- **迁移链验证（T188）**：
  - **仅云上、无本地 Docker**：在 **空白云测试 Project**（或专用验证项目）执行 `supabase link --project-ref <REF>` 后 `supabase db push`，或按文件名顺序在 SQL Editor 执行 `supabase/migrations/*.sql`；确认无 **约束名 / IF EXISTS** 环境差异。
  - **本地 Docker**：可选用 `supabase start` 后 `supabase db reset`（仅本地容器库，会清空数据）。
  - **勿**对承载唯一业务数据的云库误用「整库重置」类操作。
- 通知 API 消费方：**`packageId` 现为可售行主键**（原「容器 + 多版本」语义废弃）；兼容别名仍见 [pricing-api.md](./contracts/pricing-api.md)。

## 2. 执行窗口

- 与 Phase 28 耦合的停机/限流策略由发布节奏决定；本迁移在事务内 `BEGIN/COMMIT`，失败则整批回滚。
- 建议设置会话 `statement_timeout`（例如 10–30 分钟，视数据量调整），避免长锁无界占用。

## 3. 步骤（生产）

1. 进入只读或维护模式（负载均衡摘流 / 拒绝写流量）。
2. 再次确认备份可恢复。
3. 应用迁移 SQL（Supabase CLI / CI 或受控 SQL 会话）。
4. 校验：
   - `public.packages` 仅保留单实体语义；**无**独立 `package_versions` 对外契约。
   - `subscriptions.package_id`、`vendor_product_mappings.package_id`、`rating_results.matched_package_id`、`bill_line_items.package_id` 外键指向 `packages.package_id`。
   - `share_links.kind` 仅 `packages` / `bills`（旧 `packageVersions` 已改写）。
   - 权限表无 `catalog.package_versions.list`。
5. 部署已对齐单表模型的 **应用** 版本（见 Phase 28 代码任务）。
6. 恢复流量；抽样：订阅创建/切换、按包查 SIM、计费 Golden、烟测脚本。

## 4. 回滚

- 本迁移 **非** 单语句可逆；回滚依赖 **还原 `pg_dump`** 与回退应用版本。
- 若仅部分语句失败且事务已回滚，数据库应保持迁移前状态；勿在失败中途手工 `COMMIT` 半成品。

## 5. 消费方公告要点

- 请求体优先使用 **`packageId`** / **`newPackageId`** / **`toPackageId`**；`**packageVersionId**` 等为兼容别名（与 UUID 值相同）。
- OpenAPI / 生成客户端以 `packageId` 为准；废弃字段见 `iot-cmp-api.yaml` 中 `deprecated`。
