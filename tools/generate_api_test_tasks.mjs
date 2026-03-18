import fs from 'node:fs'
import path from 'node:path'
import YAML from 'yaml'

const projectRoot = path.resolve(process.cwd())
const openapiPath = path.resolve(projectRoot, 'packages', 'openapi', 'openapi.yaml')
const outDir = path.resolve(projectRoot, 'docs', 'api-system-test')
const outMd = path.resolve(outDir, 'tasks.md')
const outJson = path.resolve(outDir, 'inventory.json')

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true })
}

function readYaml(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8')
  return YAML.parse(raw)
}

function isObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v)
}

function clone(v) {
  return JSON.parse(JSON.stringify(v))
}

function resolveJsonPointer(doc, ref) {
  if (!ref.startsWith('#/')) return null
  const parts = ref.slice(2).split('/').map((p) => p.replaceAll('~1', '/').replaceAll('~0', '~'))
  let cur = doc
  for (const part of parts) {
    if (!isObject(cur) && !Array.isArray(cur)) return null
    cur = cur[part]
    if (cur === undefined) return null
  }
  return cur
}

function deref(doc, node, stack = []) {
  if (!isObject(node)) return node
  if (node.$ref && typeof node.$ref === 'string') {
    const hit = resolveJsonPointer(doc, node.$ref)
    if (!hit) return node
    if (stack.includes(node.$ref)) return hit
    return deref(doc, hit, [...stack, node.$ref])
  }
  if (Array.isArray(node.allOf)) {
    const items = node.allOf.map((s) => deref(doc, s, stack)).filter(Boolean)
    const merged = { ...node }
    delete merged.allOf
    for (const it of items) {
      if (!isObject(it)) continue
      for (const [k, v] of Object.entries(it)) {
        if (k === 'required') {
          const a = Array.isArray(merged.required) ? merged.required : []
          const b = Array.isArray(v) ? v : []
          merged.required = Array.from(new Set([...a, ...b]))
        } else if (k === 'properties') {
          merged.properties = { ...(merged.properties || {}), ...(v || {}) }
        } else if (k === 'description') {
          if (!merged.description) merged.description = v
        } else if (k === 'type') {
          if (!merged.type) merged.type = v
        } else if (merged[k] === undefined) {
          merged[k] = v
        }
      }
    }
    return merged
  }
  return node
}

function schemaSummary(schema) {
  const s = isObject(schema) ? schema : {}
  const type = s.type ? String(s.type) : (s.properties ? 'object' : (s.items ? 'array' : 'unknown'))
  const parts = [type]
  if (s.format) parts.push(`format=${String(s.format)}`)
  if (Array.isArray(s.enum)) parts.push(`enum=${s.enum.map((v) => JSON.stringify(v)).join('|')}`)
  if (typeof s.minLength === 'number') parts.push(`minLength=${s.minLength}`)
  if (typeof s.maxLength === 'number') parts.push(`maxLength=${s.maxLength}`)
  if (typeof s.minimum === 'number') parts.push(`min=${s.minimum}`)
  if (typeof s.maximum === 'number') parts.push(`max=${s.maximum}`)
  if (typeof s.minItems === 'number') parts.push(`minItems=${s.minItems}`)
  if (typeof s.maxItems === 'number') parts.push(`maxItems=${s.maxItems}`)
  if (s.pattern) parts.push(`pattern=${String(s.pattern)}`)
  if (s.nullable === true) parts.push('nullable=true')
  return parts.join(', ')
}

function boundaryList(schema) {
  const s = isObject(schema) ? schema : {}
  const type = s.type ? String(s.type) : (s.properties ? 'object' : (s.items ? 'array' : 'unknown'))
  const out = []
  if (Array.isArray(s.enum) && s.enum.length) {
    out.push(...s.enum.map((v) => ({ kind: '合法枚举', value: v })))
    out.push({ kind: '非法枚举', value: '__INVALID_ENUM__' })
    return out
  }
  if (type === 'string') {
    out.push({ kind: '空字符串', value: '' })
    out.push({ kind: '空白字符串', value: '   ' })
    out.push({ kind: '特殊字符', value: `"'\\\\\\n\\r<>` })
    out.push({ kind: 'Unicode', value: '中文測試Καλημέρα' })
    if (s.format === 'uuid') {
      out.push({ kind: '合法UUID', value: '__UUID__' })
      out.push({ kind: '非法UUID', value: 'not-a-uuid' })
    }
    if (typeof s.minLength === 'number') {
      out.push({ kind: '最小长度', value: `<string length=${s.minLength}>` })
      if (s.minLength > 0) out.push({ kind: '小于最小长度', value: `<string length=${Math.max(0, s.minLength - 1)}>` })
    }
    if (typeof s.maxLength === 'number') {
      out.push({ kind: '最大长度', value: `<string length=${s.maxLength}>` })
      out.push({ kind: '超过最大长度', value: `<string length=${s.maxLength + 1}>` })
    }
    if (s.pattern) {
      out.push({ kind: '满足pattern', value: `<match ${String(s.pattern)}>` })
      out.push({ kind: '不满足pattern', value: `<mismatch ${String(s.pattern)}>` })
    }
    return out
  }
  if (type === 'integer' || type === 'number') {
    out.push({ kind: '零值', value: 0 })
    out.push({ kind: '负数', value: -1 })
    out.push({ kind: '极大值', value: 2147483647 })
    out.push({ kind: '极小值', value: -2147483648 })
    if (typeof s.minimum === 'number') {
      out.push({ kind: '最小值', value: s.minimum })
      out.push({ kind: '小于最小值', value: s.minimum - 1 })
    }
    if (typeof s.maximum === 'number') {
      out.push({ kind: '最大值', value: s.maximum })
      out.push({ kind: '超过最大值', value: s.maximum + 1 })
    }
    if (type === 'number') {
      out.push({ kind: '小数', value: 0.1 })
      out.push({ kind: '极大浮点', value: 1.7976931348623157e308 })
      out.push({ kind: '极小浮点', value: 5e-324 })
    }
    return out
  }
  if (type === 'boolean') {
    out.push({ kind: 'true', value: true })
    out.push({ kind: 'false', value: false })
    return out
  }
  if (type === 'array') {
    out.push({ kind: '空数组', value: [] })
    out.push({ kind: '单元素数组', value: ['__ONE__'] })
    if (typeof s.minItems === 'number') out.push({ kind: '最小元素数', value: `<array size=${s.minItems}>` })
    if (typeof s.maxItems === 'number') {
      out.push({ kind: '最大元素数', value: `<array size=${s.maxItems}>` })
      out.push({ kind: '超过最大元素数', value: `<array size=${s.maxItems + 1}>` })
    }
    return out
  }
  if (type === 'object') {
    out.push({ kind: '空对象', value: {} })
    out.push({ kind: '缺失必填字段', value: '__MISSING_REQUIRED__' })
    out.push({ kind: '多余字段', value: '__EXTRA_FIELDS__' })
    return out
  }
  return out
}

function typeErrorList(schema) {
  const s = isObject(schema) ? schema : {}
  const type = s.type ? String(s.type) : (s.properties ? 'object' : (s.items ? 'array' : 'unknown'))
  const out = []
  const commonNull = s.nullable === true ? [] : [{ kind: 'null', value: null }]
  if (type === 'string') return [{ kind: 'number', value: 123 }, { kind: 'boolean', value: true }, { kind: 'object', value: {} }, { kind: 'array', value: [] }, ...commonNull]
  if (type === 'integer' || type === 'number') return [{ kind: 'string', value: 'abc' }, { kind: 'boolean', value: true }, { kind: 'object', value: {} }, { kind: 'array', value: [] }, ...commonNull]
  if (type === 'boolean') return [{ kind: 'string', value: 'true' }, { kind: 'number', value: 1 }, { kind: 'object', value: {} }, { kind: 'array', value: [] }, ...commonNull]
  if (type === 'array') return [{ kind: 'object', value: {} }, { kind: 'string', value: 'x' }, { kind: 'number', value: 1 }, { kind: 'boolean', value: true }, ...commonNull]
  if (type === 'object') return [{ kind: 'array', value: [] }, { kind: 'string', value: 'x' }, { kind: 'number', value: 1 }, { kind: 'boolean', value: true }, ...commonNull]
  return [{ kind: 'null', value: null }]
}

function normalizeMethod(m) {
  return String(m || '').toUpperCase()
}

function opKey(method, p) {
  return `${normalizeMethod(method)} ${p}`
}

function collectOperationInputs(doc, method, p, op, pathItem) {
  const params = []
  const allParams = []
  if (Array.isArray(pathItem?.parameters)) allParams.push(...pathItem.parameters)
  if (Array.isArray(op?.parameters)) allParams.push(...op.parameters)
  for (const raw of allParams) {
    const param = deref(doc, raw)
    if (!isObject(param)) continue
    const schema = deref(doc, param.schema || {})
    params.push({
      location: param.in || 'unknown',
      name: param.name || 'unknown',
      required: param.required === true,
      schema,
      description: param.description || null,
    })
  }

  const bodies = []
  const rb = deref(doc, op?.requestBody || null)
  if (isObject(rb) && isObject(rb.content)) {
    for (const [ct, content] of Object.entries(rb.content)) {
      const schema = deref(doc, content?.schema || null)
      bodies.push({
        contentType: ct,
        required: rb.required === true,
        schema,
      })
    }
  }

  return { params, bodies }
}

function flattenSchemaFields(doc, schema, prefix, requiredFromParent, depth, out) {
  if (!schema || depth > 5) return
  const s = deref(doc, schema)
  const type = s?.type ? String(s.type) : (s?.properties ? 'object' : (s?.items ? 'array' : 'unknown'))
  const requiredSet = new Set(Array.isArray(s?.required) ? s.required.map(String) : [])

  if (type === 'object' && isObject(s?.properties)) {
    for (const [k, v] of Object.entries(s.properties)) {
      const childPath = prefix ? `${prefix}.${k}` : k
      const required = requiredSet.has(k)
      const childSchema = deref(doc, v)
      const childType = childSchema?.type ? String(childSchema.type) : (childSchema?.properties ? 'object' : (childSchema?.items ? 'array' : 'unknown'))
      out.push({ path: childPath, required, schema: childSchema, type: childType })
      flattenSchemaFields(doc, childSchema, childPath, required, depth + 1, out)
    }
    return
  }

  if (type === 'array' && s?.items) {
    const itemSchema = deref(doc, s.items)
    const itemType = itemSchema?.type ? String(itemSchema.type) : (itemSchema?.properties ? 'object' : (itemSchema?.items ? 'array' : 'unknown'))
    const itemPath = `${prefix}[]`
    out.push({ path: itemPath, required: requiredFromParent, schema: itemSchema, type: itemType })
    flattenSchemaFields(doc, itemSchema, itemPath, requiredFromParent, depth + 1, out)
  }
}

function pickSecurity(doc, op) {
  if (Array.isArray(op?.security)) return op.security
  if (Array.isArray(doc?.security)) return doc.security
  return []
}

function securityLabel(sec) {
  const list = Array.isArray(sec) ? sec : []
  if (!list.length) return 'NONE'
  const keys = []
  for (const item of list) {
    if (!isObject(item)) continue
    keys.push(...Object.keys(item))
  }
  const uniq = Array.from(new Set(keys))
  if (!uniq.length) return 'UNKNOWN'
  return uniq.join(' | ')
}

function extraOperations() {
  const extras = []
  extras.push({
    method: 'POST',
    path: '/sims',
    source: 'code:src/routes/simPhase4.ts',
    summary: 'Create single SIM (reseller_admin)',
    security: [{ BearerAuth: [] }],
    parameters: [],
    requestBody: {
      contentType: 'application/json',
      required: true,
      schema: {
        type: 'object',
        required: ['iccid', 'imsi', 'apn', 'supplierId', 'operatorId'],
        properties: {
          iccid: { type: 'string', description: '18-20 digits', minLength: 18, maxLength: 20, pattern: '^\\d{18,20}$' },
          imsi: { type: 'string', minLength: 1 },
          secondaryImsi1: { type: 'string', nullable: true },
          secondaryImsi2: { type: 'string', nullable: true },
          secondaryImsi3: { type: 'string', nullable: true },
          msisdn: { type: 'string', nullable: true },
          apn: { type: 'string', minLength: 1 },
          supplierId: { type: 'string', format: 'uuid' },
          operatorId: { type: 'string', format: 'uuid' },
          enterpriseId: { type: 'string', format: 'uuid', nullable: true },
          formFactor: { type: 'string', enum: ['consumer_removable', 'industrial_removable', 'consumer_embedded', 'industrial_embedded'], nullable: true },
          activationCode: { type: 'string', nullable: true },
          imei: { type: 'string', pattern: '^\\d{15}$', nullable: true },
          imeiLockEnabled: { type: 'boolean', nullable: true },
        },
      },
    },
    state: [{ kind: 'SIM_STATE', notes: ['写入后状态为 INVENTORY'] }],
    rbac: { roles: ['reseller_admin'], permissions: ['sims.create'] },
  })

  for (const action of [
    { suffix: ':activate', permissions: ['sims.activate'], roles: ['reseller_admin', 'reseller_sales', 'reseller_sales_director'], requireReason: false, requireConfirm: false, allowedFrom: ['INVENTORY', 'TEST_READY', 'DEACTIVATED'] },
    { suffix: ':deactivate', permissions: ['sims.deactivate'], roles: ['reseller_admin', 'reseller_sales', 'reseller_sales_director'], requireReason: true, requireConfirm: false, allowedFrom: ['ACTIVATED', 'TEST_READY'] },
    { suffix: ':reactivate', permissions: ['sims.reactivate'], roles: ['reseller_admin'], requireReason: false, requireConfirm: false, allowedFrom: ['DEACTIVATED'] },
    { suffix: ':retire', permissions: ['sims.retire'], roles: ['reseller_admin'], requireReason: true, requireConfirm: true, allowedFrom: ['DEACTIVATED'] },
  ]) {
    const reqRequired = []
    const props = {
      reason: { type: 'string', nullable: true },
      idempotencyKey: { type: 'string', nullable: true, maxLength: 128 },
      commitmentExempt: { type: 'boolean', nullable: true },
      confirm: { type: 'boolean', nullable: true },
    }
    if (action.requireReason) reqRequired.push('reason')
    if (action.requireConfirm) reqRequired.push('confirm')
    extras.push({
      method: 'POST',
      path: `/sims/{simId}${action.suffix}`,
      source: 'code:src/routes/simPhase4.ts',
      summary: `SIM status change ${action.suffix}`,
      security: [{ BearerAuth: [] }],
      parameters: [{ in: 'path', name: 'simId', required: true, schema: { type: 'string' } }],
      requestBody: {
        contentType: 'application/json',
        required: reqRequired.length > 0,
        schema: {
          type: 'object',
          required: reqRequired,
          properties: props,
        },
      },
      state: [{ kind: 'SIM_STATUS_TRANSITION', allowedFrom: action.allowedFrom, notes: action.suffix === ':retire' ? ['confirm 必须为 true'] : [] }],
      rbac: { roles: action.roles, permissions: action.permissions },
    })
  }

  extras.push({
    method: 'GET',
    path: '/bills/{billId}/reconciliation',
    source: 'code:src/app.ts',
    summary: 'Bill reconciliation summary',
    security: [{ BearerAuth: [] }],
    parameters: [{ in: 'path', name: 'billId', required: true, schema: { type: 'string', format: 'uuid' } }],
    requestBody: null,
    state: [],
    rbac: { roles: [], permissions: [] },
  })

  extras.push({
    method: 'GET',
    path: '/bills/{billId}/reconciliation:csv',
    source: 'code:src/app.ts',
    summary: 'Bill reconciliation CSV export',
    security: [{ BearerAuth: [] }],
    parameters: [{ in: 'path', name: 'billId', required: true, schema: { type: 'string', format: 'uuid' } }],
    requestBody: null,
    state: [],
    rbac: { roles: [], permissions: [] },
  })

  return extras
}

function renderMd(inventory) {
  const now = new Date().toISOString()
  const lines = []
  lines.push(`# API 系统性测试任务清单`)
  lines.push(``)
  lines.push(`- 生成时间: ${now}`)
  lines.push(`- 范围基线: OpenAPI（packages/openapi/openapi.yaml） + 代码额外路由补齐`)
  lines.push(`- 生成方式: 自动解析 schema，按字段推导边界值与类型错误输入集合`)
  lines.push(``)
  lines.push(`## 用例模板（每条用例都按此填写）`)
  lines.push(``)
  lines.push(`- 用例编号:`)
  lines.push(`- 接口:`)
  lines.push(`- 分类: HP | BND | TYPE | AUTH | STATE | CONCURRENCY | PERF | SEC`)
  lines.push(`- 鉴权:`)
  lines.push(`- 前置条件:`)
  lines.push(`- 请求:`)
  lines.push(`- 期望响应:`)
  lines.push(`- 后置断言:`)
  lines.push(`- 清理/回滚:`)
  lines.push(`- 备注:`)
  lines.push(``)
  lines.push(`## Token/身份矩阵（权限类用例统一引用）`)
  lines.push(``)
  lines.push(`| 场景ID | 身份/Token | 期望 | 说明 |`)
  lines.push(`|---|---|---|---|`)
  lines.push(`| AUTH-00 | 无Token | 401/403 | 取决于接口是否公开 |`)
  lines.push(`| AUTH-01 | 缺失Token头 | 401/403 | 验证 header 处理 |`)
  lines.push(`| AUTH-02 | 无效Token | 401 | 签名/格式错误 |`)
  lines.push(`| AUTH-03 | 过期Token | 401 | exp 过期 |`)
  lines.push(`| AUTH-04 | 跨租户Token | 403/404 | A 租户访问 B 资源 |`)
  lines.push(`| AUTH-05 | 低权限角色 | 403 | 角色不满足 RBAC |`)
  lines.push(`| AUTH-06 | 高权限角色 | 2xx | 满足 RBAC 与租户范围 |`)
  lines.push(`| AUTH-07 | Admin API Key | 2xx/403 | 仅 admin 接口允许 |`)
  lines.push(``)
  lines.push(`## 端点清单与用例任务`)
  lines.push(``)

  for (const op of inventory.operations) {
    lines.push(`### ${op.opId} ${op.method} ${op.path}`)
    lines.push(``)
    if (op.summary) lines.push(`- Summary: ${op.summary}`)
    lines.push(`- Security: ${op.securityLabel}`)
    if (op.source) lines.push(`- Source: ${op.source}`)
    if (op.rbac?.roles?.length || op.rbac?.permissions?.length) {
      const roles = op.rbac.roles?.length ? op.rbac.roles.join(', ') : '-'
      const perms = op.rbac.permissions?.length ? op.rbac.permissions.join(', ') : '-'
      lines.push(`- RBAC: roles=[${roles}] permissions=[${perms}]`)
    }
    lines.push(``)
    lines.push(`**用例编号（本端点固定集合）**`)
    lines.push(`- ${op.opId}-HP: 正向测试（标准输入 -> 成功响应）`)
    lines.push(`- ${op.opId}-AUTH: 权限测试（引用 AUTH-00~AUTH-07）`)
    if (op.stateSuites?.length) {
      for (const s of op.stateSuites) {
        lines.push(`- ${op.opId}-STATE-${s.key}: 状态依赖测试（${s.title}）`)
      }
    }
    if (op.concurrencySuggested) {
      lines.push(`- ${op.opId}-CONC: 并发/幂等性测试（同资源并发、重复提交）`)
    }
    lines.push(``)
    lines.push(`**入参字段清单（含边界/类型错误枚举）**`)
    lines.push(``)
    lines.push(`| 位置 | 字段 | 必填 | Schema | 边界值枚举 | 类型错误枚举 |`)
    lines.push(`|---|---|---:|---|---|---|`)
    for (const f of op.fields) {
      const b = f.boundaries.map((x) => `${x.kind}:${formatCell(x.value)}`).join('<br/>')
      const t = f.typeErrors.map((x) => `${x.kind}:${formatCell(x.value)}`).join('<br/>')
      lines.push(`| ${escapePipe(f.location)} | ${escapePipe(f.name)} | ${f.required ? 'Y' : ''} | ${escapePipe(f.schemaSummary)} | ${escapePipe(b)} | ${escapePipe(t)} |`)
    }
    lines.push(``)
    lines.push(`**字段级用例任务（逐字段，不做笛卡尔积）**`)
    lines.push(`- ${op.opId}-BND-*：对上表每个字段依次覆盖“边界值枚举”`)
    lines.push(`- ${op.opId}-TYPE-*：对上表每个字段依次覆盖“类型错误枚举”`)
    lines.push(``)
  }

  return lines.join('\n')
}

function escapePipe(s) {
  return String(s ?? '').replaceAll('|', '\\|')
}

function formatCell(v) {
  if (typeof v === 'string') return v === '' ? '""' : v
  if (v === null) return 'null'
  if (Array.isArray(v)) return v.length ? '[...]' : '[]'
  if (isObject(v)) return '{...}'
  return String(v)
}

function buildInventory(doc) {
  const operations = []
  const paths = isObject(doc?.paths) ? doc.paths : {}
  const methods = ['get', 'post', 'put', 'patch', 'delete', 'options', 'head']
  let idx = 0
  for (const [p, pathItemRaw] of Object.entries(paths)) {
    const pathItem = deref(doc, pathItemRaw)
    if (!isObject(pathItem)) continue
    for (const m of methods) {
      if (!pathItem[m]) continue
      const op = deref(doc, pathItem[m])
      if (!isObject(op)) continue
      idx += 1
      const opId = `OP${String(idx).padStart(3, '0')}`
      const { params, bodies } = collectOperationInputs(doc, m, p, op, pathItem)
      const fields = []
      for (const param of params) {
        fields.push({
          location: param.location,
          name: param.name,
          required: param.required,
          schemaSummary: schemaSummary(param.schema),
          boundaries: boundaryList(param.schema),
          typeErrors: typeErrorList(param.schema),
        })
      }
      for (const body of bodies) {
        if (!body?.schema) continue
        const flat = []
        flattenSchemaFields(doc, body.schema, '', body.required === true, 0, flat)
        if (!flat.length) {
          fields.push({
            location: `body:${body.contentType}`,
            name: '(body)',
            required: body.required === true,
            schemaSummary: schemaSummary(body.schema),
            boundaries: boundaryList(body.schema),
            typeErrors: typeErrorList(body.schema),
          })
        } else {
          for (const f of flat) {
            fields.push({
              location: `body:${body.contentType}`,
              name: f.path,
              required: f.required,
              schemaSummary: schemaSummary(f.schema),
              boundaries: boundaryList(f.schema),
              typeErrors: typeErrorList(f.schema),
            })
          }
        }
      }

      const sec = pickSecurity(doc, op)
      const stateSuites = inferStateSuites(normalizeMethod(m), p, op)
      const concurrencySuggested = inferConcurrency(normalizeMethod(m), p, op)
      operations.push({
        opId,
        method: normalizeMethod(m),
        path: p,
        summary: op.summary || op.description || null,
        security: sec,
        securityLabel: securityLabel(sec),
        source: 'openapi',
        rbac: null,
        fields,
        stateSuites,
        concurrencySuggested,
      })
    }
  }

  const extras = extraOperations()
  for (const e of extras) {
    idx += 1
    const opId = `OP${String(idx).padStart(3, '0')}`
    const fields = []
    for (const param of e.parameters || []) {
      const schema = deref(doc, param.schema || {})
      fields.push({
        location: param.in || 'unknown',
        name: param.name || 'unknown',
        required: param.required === true,
        schemaSummary: schemaSummary(schema),
        boundaries: boundaryList(schema),
        typeErrors: typeErrorList(schema),
      })
    }
    if (e.requestBody?.schema) {
      const flat = []
      flattenSchemaFields(doc, e.requestBody.schema, '', e.requestBody.required === true, 0, flat)
      for (const f of flat) {
        fields.push({
          location: `body:${e.requestBody.contentType || 'application/json'}`,
          name: f.path,
          required: f.required,
          schemaSummary: schemaSummary(f.schema),
          boundaries: boundaryList(f.schema),
          typeErrors: typeErrorList(f.schema),
        })
      }
    }
    const sec = Array.isArray(e.security) ? e.security : []
    const stateSuites = inferStateSuites(e.method, e.path, { summary: e.summary }, e.state || [])
    const concurrencySuggested = inferConcurrency(e.method, e.path, { summary: e.summary })
    operations.push({
      opId,
      method: e.method,
      path: e.path,
      summary: e.summary || null,
      security: sec,
      securityLabel: securityLabel(sec),
      source: e.source || 'code',
      rbac: e.rbac || null,
      fields,
      stateSuites,
      concurrencySuggested,
    })
  }

  operations.sort((a, b) => opKey(a.method, a.path).localeCompare(opKey(b.method, b.path)))
  for (let i = 0; i < operations.length; i += 1) {
    operations[i].opId = `OP${String(i + 1).padStart(3, '0')}`
  }
  return { operations }
}

function inferStateSuites(method, p, op, extraState = []) {
  const out = []
  const mp = `${method} ${p}`
  const pathLower = String(p).toLowerCase()
  const summaryLower = String(op?.summary || op?.description || '').toLowerCase()
  if (pathLower.includes('/jobs/') && pathLower.includes(':cancel')) {
    out.push({ key: 'JOB_CANCEL', title: '仅 QUEUED/RUNNING 可取消，其它返回 409' })
  }
  if (pathLower.includes('/packages/') && pathLower.includes(':publish')) {
    out.push({ key: 'PKG_PUBLISH', title: '仅 DRAFT 可发布；依赖 profile/version 状态' })
  }
  if (pathLower.includes('/apn-profiles/') && pathLower.includes(':publish')) {
    out.push({ key: 'APN_PUBLISH', title: '仅 DRAFT 可发布；版本递增与回滚约束' })
  }
  if (pathLower.includes('/roaming-profiles/') && pathLower.includes(':publish')) {
    out.push({ key: 'ROAMING_PUBLISH', title: '仅 DRAFT 可发布；版本递增与回滚约束' })
  }
  if (pathLower.includes('/subscriptions') && (method === 'POST' || method === 'PUT')) {
    out.push({ key: 'SUBSCRIPTION_DEP', title: '依赖 enterprise ACTIVE、SIM 非 RETIRED、package version 状态' })
  }
  if (pathLower.includes('/sims') && (pathLower.includes(':activate') || pathLower.includes(':deactivate') || pathLower.includes(':reactivate') || pathLower.includes(':retire'))) {
    out.push({ key: 'SIM_STATUS', title: 'allowedFrom 状态机约束 + reason/confirm' })
  } else if (pathLower.includes('/sims:batch-status-change')) {
    out.push({ key: 'SIM_BATCH_STATUS', title: '批量状态机约束 + confirm + 单项结果一致性' })
  } else if (summaryLower.includes('sim') && summaryLower.includes('status')) {
    out.push({ key: 'SIM_STATUS', title: '状态机约束' })
  }
  for (const e of extraState) {
    if (e?.kind === 'SIM_STATUS_TRANSITION') {
      const allowed = Array.isArray(e.allowedFrom) ? e.allowedFrom.join('|') : ''
      out.push({ key: `SIM_${allowed || 'TRANSITION'}`, title: `allowedFrom=${allowed || '-'} ${Array.isArray(e.notes) ? e.notes.join('; ') : ''}`.trim() })
    }
  }
  return out
}

function inferConcurrency(method, p, op) {
  const pathLower = String(p).toLowerCase()
  if (method === 'POST' && (pathLower.includes('import') || pathLower.includes(':batch') || pathLower.includes(':retry'))) return true
  if (pathLower.includes(':cancel') || pathLower.includes(':publish') || pathLower.includes(':rotate') || pathLower.includes(':adjust')) return true
  if (pathLower.includes(':activate') || pathLower.includes(':deactivate') || pathLower.includes(':reactivate') || pathLower.includes(':retire')) return true
  if (pathLower.includes('/subscriptions') && method === 'POST') return true
  return false
}

function main() {
  if (!fs.existsSync(openapiPath)) {
    throw new Error(`openapi.yaml not found: ${openapiPath}`)
  }
  const doc = readYaml(openapiPath)
  ensureDir(outDir)
  const inventory = buildInventory(doc)
  fs.writeFileSync(outJson, JSON.stringify(inventory, null, 2))
  fs.writeFileSync(outMd, renderMd(inventory))
  process.stdout.write(`OK\n- inventory: ${path.relative(projectRoot, outJson)}\n- tasks: ${path.relative(projectRoot, outMd)}\n`)
}

main()
