# API 系统性测试

该目录内容由脚本自动生成，用于输出“按每个 endpoint 逐字段覆盖”的系统性测试任务清单。

## 生成

```bash
node tools/generate_api_test_tasks.mjs
```

输出：

- `docs/api-system-test/inventory.json`：接口台账（machine-readable）
- `docs/api-system-test/tasks.md`：按 endpoint 汇总的测试任务清单（human-readable）

## 范围基线

- OpenAPI：`packages/openapi/openapi.yaml`
- 额外路由补齐：当前脚本内置了一小部分 OpenAPI 未覆盖的端点（以代码为准，后续可扩充）。

