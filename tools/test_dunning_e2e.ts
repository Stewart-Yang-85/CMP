import 'dotenv/config'
import { randomUUID } from 'node:crypto'
import { getEnterpriseDunningSummary, resolveDunningForEnterprise, runDunningCheck } from '../src/services/dunning.ts'

function toDateOnly(date: Date) {
  return date.toISOString().slice(0, 10)
}

function firstDayOfMonthUtc(date: Date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1))
}

function firstDayNextMonthUtc(date: Date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1))
}

async function main() {
  const supabase = createMockSupabase()
  const runId = Date.now().toString().slice(-6)

  try {
    const today = new Date()
    const dueDate = new Date(today)
    dueDate.setUTCDate(dueDate.getUTCDate() - 5)
    const dueDateStr = toDateOnly(dueDate)
    const periodStart = firstDayOfMonthUtc(today)
    const periodEnd = firstDayNextMonthUtc(today)

    const tenants = await supabase.insert('tenants', {
      name: `E2E_Dunning_${runId}`,
      tenant_type: 'ENTERPRISE',
      code: `E2E_DUN_${runId}`,
      auto_suspend_enabled: true,
    })
    const enterpriseId = tenants[0].tenant_id

    await supabase.insert('dunning_policies', {
      enterprise_id: enterpriseId,
      grace_period_days: 3,
      suspend_after_days: 3,
      interruption_after_days: 7,
      enabled: true,
    })

    await supabase.insert('late_fee_rules', {
      enterprise_id: enterpriseId,
      fee_type: 'PERCENTAGE',
      fee_value: 2,
      grace_period_days: 0,
      enabled: true,
    })

    const bills = await supabase.insert('bills', {
      enterprise_id: enterpriseId,
      period_start: toDateOnly(periodStart),
      period_end: toDateOnly(periodEnd),
      status: 'PUBLISHED',
      currency: 'USD',
      total_amount: 100,
      due_date: dueDateStr,
      generated_at: new Date().toISOString(),
      published_at: new Date().toISOString(),
    })
    const billId = bills[0].bill_id

    const runResult = await runDunningCheck({ supabase, enterpriseId, asOfDate: toDateOnly(today) })
    if (!runResult.ok) {
      throw new Error(`runDunningCheck failed: ${runResult.code} ${runResult.message}`)
    }

    const records = await supabase.select(
      'dunning_records',
      `select=dunning_id,bill_id,dunning_status,overdue_since,grace_period_days,suspend_triggered_at&customer_id=eq.${enterpriseId}`
    )
    const record = Array.isArray(records) ? records.find((row) => row.bill_id === billId) : null
    if (!record) {
      throw new Error('Dunning record not created.')
    }
    if (record.dunning_status !== 'SUSPENDED') {
      throw new Error(`Unexpected dunning status: ${record.dunning_status}`)
    }

    const summary = await getEnterpriseDunningSummary({ supabase, enterpriseId, asOfDate: toDateOnly(today) })
    if (!summary.ok) {
      throw new Error(`getEnterpriseDunningSummary failed: ${summary.code} ${summary.message}`)
    }
    if (summary.value.dunningStatus !== 'SUSPENDED') {
      throw new Error(`Summary status mismatch: ${summary.value.dunningStatus}`)
    }
    if (Number(summary.value.overdueAmount) !== 100) {
      throw new Error(`Summary overdue amount mismatch: ${summary.value.overdueAmount}`)
    }
    if (Number(summary.value.lateFeeAmount) !== 10) {
      throw new Error(`Summary late fee mismatch: ${summary.value.lateFeeAmount}`)
    }

    await supabase.update('bills', `bill_id=eq.${billId}`, { status: 'PAID', paid_at: new Date().toISOString() })

    const resolveResult = await resolveDunningForEnterprise({ supabase, enterpriseId, asOfDate: toDateOnly(today) })
    if (!resolveResult.ok) {
      throw new Error(`resolveDunningForEnterprise failed: ${resolveResult.code} ${resolveResult.message}`)
    }

    const resolved = await supabase.select(
      'dunning_records',
      `select=dunning_status,resolved_at&dunning_id=eq.${record.dunning_id}`
    )
    const resolvedRow = Array.isArray(resolved) ? resolved[0] : null
    if (!resolvedRow || resolvedRow.dunning_status !== 'NORMAL' || !resolvedRow.resolved_at) {
      throw new Error('Dunning record not resolved as expected.')
    }

    const actions = await supabase.select(
      'dunning_actions',
      `select=action_type,metadata&dunning_id=eq.${record.dunning_id}`
    )
    const actionTypes = Array.isArray(actions) ? actions.map((row) => row.action_type) : []
    if (!actionTypes.includes('SUSPENDED')) {
      throw new Error(`Expected SUSPENDED action missing: ${JSON.stringify(actionTypes)}`)
    }
    if (!actionTypes.includes('RESOLVED')) {
      throw new Error(`Expected RESOLVED action missing: ${JSON.stringify(actionTypes)}`)
    }

    console.log('SUCCESS: Dunning business logic test passed.')
  } catch (err) {
    console.error('Test failed:', err)
    process.exit(1)
  }
}

main()

type Row = Record<string, any>

function createMockSupabase() {
  const tables = new Map<string, Row[]>([
    ['tenants', []],
    ['bills', []],
    ['dunning_policies', []],
    ['late_fee_rules', []],
    ['dunning_records', []],
    ['dunning_actions', []],
    ['events', []],
  ])
  let actionId = 1
  const idDefaults: Record<string, string> = {
    tenants: 'tenant_id',
    bills: 'bill_id',
    dunning_policies: 'policy_id',
    late_fee_rules: 'rule_id',
    dunning_records: 'dunning_id',
  }

  return {
    async select(table: string, queryString: string) {
      const rows = tables.get(table) ?? []
      const { filters, limit } = parseQuery(queryString)
      const result = rows.filter((row) => filters.every((filter) => matchFilter(row, filter)))
      return typeof limit === 'number' ? result.slice(0, limit) : result
    },
    async insert(table: string, rows: Row | Row[]) {
      const list = Array.isArray(rows) ? rows : [rows]
      const target = tables.get(table)
      if (!target) throw new Error(`Unknown table ${table}`)
      const inserted = list.map((row) => {
        const next = { ...row }
        const idField = idDefaults[table]
        if (idField && !next[idField]) next[idField] = randomUUID()
        if (table === 'dunning_actions' && !next.action_id) {
          next.action_id = actionId++
        }
        target.push(next)
        return next
      })
      return inserted
    },
    async update(table: string, matchQueryString: string, patch: Row) {
      const rows = tables.get(table) ?? []
      const { filters } = parseQuery(matchQueryString)
      const updated: Row[] = []
      for (const row of rows) {
        if (!filters.every((filter) => matchFilter(row, filter))) continue
        Object.assign(row, patch)
        updated.push({ ...row })
      }
      return updated
    },
  }
}

type Filter = { key: string; op: string; value?: string | string[] }

function parseQuery(queryString: string) {
  const params = new URLSearchParams(queryString)
  const filters: Filter[] = []
  let limit: number | undefined
  for (const [key, rawValue] of params.entries()) {
    if (key === 'select') continue
    if (key === 'limit') {
      const n = Number(rawValue)
      if (Number.isFinite(n)) limit = n
      continue
    }
    const value = decodeURIComponent(rawValue)
    if (value === 'not.is.null') {
      filters.push({ key, op: 'not_null' })
      continue
    }
    if (value.startsWith('eq.')) {
      filters.push({ key, op: 'eq', value: value.slice(3) })
      continue
    }
    if (value.startsWith('neq.')) {
      filters.push({ key, op: 'neq', value: value.slice(4) })
      continue
    }
    if (value.startsWith('lte.')) {
      filters.push({ key, op: 'lte', value: value.slice(4) })
      continue
    }
    if (value.startsWith('in.(') && value.endsWith(')')) {
      const list = value.slice(4, -1).split(',').map((item) => item.trim())
      filters.push({ key, op: 'in', value: list })
      continue
    }
  }
  return { filters, limit }
}

function matchFilter(row: Row, filter: Filter) {
  const value = row[filter.key]
  if (filter.op === 'not_null') return value !== null && value !== undefined
  if (filter.op === 'eq') return String(value) === String(filter.value ?? '')
  if (filter.op === 'neq') return String(value) !== String(filter.value ?? '')
  if (filter.op === 'lte') return String(value ?? '') <= String(filter.value ?? '')
  if (filter.op === 'in') {
    const list = Array.isArray(filter.value) ? filter.value : []
    return list.map(String).includes(String(value))
  }
  return false
}
