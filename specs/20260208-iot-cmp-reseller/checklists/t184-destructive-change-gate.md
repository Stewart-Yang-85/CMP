# T184 — 破坏性 Schema / 契约变更门禁（自检清单）

在动数据库或对外 API 之前，按顺序核对。权威说明与上下文见 [plan.md — 变更交付顺序（门禁 T184）](../plan.md#t184-gate) 与 [tasks.md — §28.0 / T184](../tasks.md#t184-task)。

| 顺序 | 产出 | 说明 |
|------|------|------|
| 1 | [tasks.md](../tasks.md) | 新建/更新 Phase、任务 ID、依赖与验收标准 |
| 2 | [data-model.md](../data-model.md) | ER / 表定义与迁移草案一致 |
| 3 | `supabase/migrations/` | 可回放 SQL、回滚与 Breaking 说明 |
| 4 | [contracts/](../contracts/) | Markdown 契约与示例 |
| 5 | `src/` | 应用实现与 DB 一致 |
| 6 | `iot-cmp-api.yaml`、`packages/openapi/*` | OpenAPI 与契约一致；**Schema 组件须符合 OAS 3.0**（例如组件 schema 上勿用非法字段，以免 `openapi-generator` 校验失败） |
| 7 | `tests/`、`fixtures/` | 自动化与 Golden 夹具 |

**登记完成**：本清单与 [plan.md](../plan.md) 表格同步落库后，对应 Phase 的 **T184** 可在 [tasks.md](../tasks.md) 勾选为流程门禁已文档化（不表示未来每次变更已预批准，而是表示团队有可重复执行的顺序）。
