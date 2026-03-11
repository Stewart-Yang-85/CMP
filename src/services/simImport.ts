import crypto from 'node:crypto'

type SupabaseClient = {
  select: (table: string, queryString: string, options?: { headers?: Record<string, string>; suppressMissingColumns?: boolean }) => Promise<unknown>
  insert: (table: string, rows: unknown, options?: { returning?: 'minimal' | 'representation' }) => Promise<unknown>
  update: (table: string, matchQueryString: string, patch: unknown, options?: { returning?: 'minimal' | 'representation' }) => Promise<unknown>
}

type ImportInput = {
  supabase: SupabaseClient
  csvText: string
  supplierId: string
  apn: string
  operatorId: string
  enterpriseId?: string | null
  batchId?: string | null
  traceId?: string | null
  actorUserId?: string | null
  actorRole?: string | null
  resellerId?: string | null
  sourceIp?: string | null
}

type ImportResult =
  | {
      ok: true
      jobId: string | null
      status: string
      totalRows: number
      createdAt: string | null
    }
  | {
      ok: false
      status: number
      code: string
      message: string
    }

function toError(status: number, code: string, message: string) {
  return { ok: false as const, status, code, message }
}

function classifySimInsertError(err: any) {
  const text = String(err?.body ?? err?.message ?? '').toLowerCase()
  if (text.includes('null value in column') && text.includes('carrier_id')) return 'legacy_carrier_required'
  if (text.includes('violates foreign key constraint')) return 'foreign_key_violation'
  return 'insert_failed'
}

function isMissingSimResellerColumnError(err: any) {
  const text = String(err?.body ?? err?.message ?? '').toLowerCase()
  return text.includes('column sims.reseller_id does not exist')
}

async function detectSimResellerColumn(supabase: SupabaseClient) {
  try {
    await supabase.select('sims', 'select=reseller_id&limit=1', { suppressMissingColumns: true })
    return true
  } catch (err) {
    if (isMissingSimResellerColumnError(err)) return false
    throw err
  }
}

function normalizeIccid(value: unknown) {
  if (value === undefined || value === null) return ''
  return String(value).trim()
}

function isValidIccid(value: unknown) {
  const s = normalizeIccid(value)
  return /^\d{18,20}$/.test(s)
}

function isValidUuid(value: unknown) {
  const s = String(value ?? '').trim().toLowerCase()
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(s)
}

function parseCsvText(csvText: string) {
  const lines = csvText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  if (!lines.length) return []
  return lines
    .map((line) => line.split(',').map((cell) => cell.trim()))
    .filter((cells) => cells.length > 0)
}

async function findExistingIccids(supabase: SupabaseClient, iccids: string[]) {
  if (!iccids.length) return new Set<string>()
  const values = iccids.map((iccid) => `"${iccid}"`).join(',')
  const rows = await supabase.select('sims', `select=iccid&iccid=in.(${values})`)
  const existing = new Set<string>()
  if (Array.isArray(rows)) {
    for (const row of rows as Array<Record<string, any>>) {
      if (row.iccid) existing.add(String(row.iccid))
    }
  }
  return existing
}

export async function runSimImport(input: ImportInput): Promise<ImportResult> {
  const {
    supabase,
    csvText,
    supplierId,
    apn,
    operatorId,
    enterpriseId,
    batchId,
    traceId,
    actorUserId,
    actorRole,
    resellerId,
    sourceIp,
  } = input
  if (!supplierId || !isValidUuid(supplierId)) return toError(400, 'BAD_REQUEST', 'supplierId is required and must be a valid uuid.')
  const apnValue = String(apn ?? '').trim()
  if (!apnValue) return toError(400, 'BAD_REQUEST', 'apn is required.')
  const operatorIdValue = String(operatorId ?? '').trim()
  if (!operatorIdValue || !isValidUuid(operatorIdValue)) {
    return toError(400, 'BAD_REQUEST', 'operatorId is required and must be a valid uuid.')
  }
  const rows = parseCsvText(csvText)
  if (!rows.length) {
    return toError(400, 'INVALID_FORMAT', 'CSV file is empty.')
  }
  const header = rows[0].map((h) => h.toLowerCase())
  const required = ['iccid', 'imsi']
  for (const field of required) {
    if (!header.includes(field)) {
      return toError(400, 'INVALID_FORMAT', `CSV missing required field: ${field}.`)
    }
  }
  const iccidIndex = header.indexOf('iccid')
  const msisdnIndex = header.indexOf('msisdn')
  const imsiIndex = header.indexOf('imsi')
  const activationCodeIndex = header.indexOf('activation_code')
  const formFactorIndex = header.indexOf('form_factor')
  const rowsData = rows.slice(1)
  const supplierRows = await supabase.select(
    'suppliers',
    `select=supplier_id&supplier_id=eq.${encodeURIComponent(supplierId)}&limit=1`
  )
  const supplier = Array.isArray(supplierRows) ? supplierRows[0] : null
  if (!supplier) {
    return toError(404, 'SUPPLIER_NOT_FOUND', 'Supplier not found.')
  }
  if (resellerId) {
    const resellerSupplierRows = await supabase.select(
      'reseller_suppliers',
      `select=reseller_id,supplier_id&reseller_id=eq.${encodeURIComponent(String(resellerId))}&supplier_id=eq.${encodeURIComponent(supplierId)}&limit=1`
    )
    const resellerSupplier = Array.isArray(resellerSupplierRows) ? resellerSupplierRows[0] : null
    if (!resellerSupplier?.reseller_id) {
      return toError(400, 'INVALID_SUPPLIER', 'Supplier is not linked to reseller.')
    }
  }
  const operatorRows = await supabase.select(
    'operators',
    `select=operator_id,business_operator_id&operator_id=eq.${encodeURIComponent(operatorIdValue)}&supplier_id=eq.${encodeURIComponent(supplierId)}&limit=1`
  )
  let operator = Array.isArray(operatorRows) ? operatorRows[0] : null
  if (!operator?.operator_id) {
    const linkRows = await supabase.select(
      'operators',
      `select=operator_id,business_operator_id&business_operator_id=eq.${encodeURIComponent(operatorIdValue)}&supplier_id=eq.${encodeURIComponent(supplierId)}&limit=1`
    )
    operator = Array.isArray(linkRows) ? linkRows[0] : null
  }
  let resolvedBusinessOperatorId = operator?.business_operator_id ? String(operator.business_operator_id) : null
  if (!operator?.operator_id) {
    const supplierOperatorRows = await supabase.select(
      'operators',
      `select=operator_id,business_operator_id&supplier_id=eq.${encodeURIComponent(supplierId)}`
    )
    const supplierOperators = Array.isArray(supplierOperatorRows) ? supplierOperatorRows : []
    operator = supplierOperators.find((row: any) => {
      const rowOperatorId = row?.operator_id ? String(row.operator_id) : ''
      const rowBusinessOperatorId = row?.business_operator_id ? String(row.business_operator_id) : ''
      return rowOperatorId === operatorIdValue || rowBusinessOperatorId === operatorIdValue
    }) ?? null
    if (operator?.business_operator_id) {
      resolvedBusinessOperatorId = String(operator.business_operator_id)
    }
    if (!operator?.operator_id) {
      const businessRowsById = await supabase.select(
        'business_operators',
        `select=operator_id,mcc,mnc&operator_id=eq.${encodeURIComponent(operatorIdValue)}&limit=1`
      )
      const businessById = Array.isArray(businessRowsById) ? businessRowsById[0] : null
      if (businessById?.operator_id) {
        resolvedBusinessOperatorId = String(businessById.operator_id)
      }
    }
  }
  if (!operator?.operator_id) {
    return toError(400, 'INVALID_OPERATOR', 'Operator is not linked to supplier.')
  }
  const businessOperatorId = resolvedBusinessOperatorId || operatorIdValue
  const businessRows = await supabase.select(
    'business_operators',
    `select=operator_id&operator_id=eq.${encodeURIComponent(businessOperatorId)}&limit=1`
  )
  const business = Array.isArray(businessRows) ? businessRows[0] : null
  if (!business?.operator_id) {
    return toError(400, 'INVALID_OPERATOR', 'Operator is not found in business operators.')
  }
  const prepared: Array<Record<string, any>> = []
  for (const row of rowsData) {
    const iccid = normalizeIccid(row[iccidIndex])
    const imsiValue = imsiIndex >= 0 && row[imsiIndex] ? String(row[imsiIndex]).trim() : ''
    if (!iccid || !isValidIccid(iccid)) {
      return toError(400, 'INVALID_FORMAT', `Invalid iccid: ${row[iccidIndex]}`)
    }
    if (!imsiValue) {
      return toError(400, 'INVALID_FORMAT', `Invalid imsi: ${row[imsiIndex]}`)
    }
    prepared.push({
      iccid,
      msisdn: msisdnIndex >= 0 && row[msisdnIndex] ? String(row[msisdnIndex]).trim() : null,
      primary_imsi: imsiValue,
      apn: apnValue,
      activation_code: activationCodeIndex >= 0 && row[activationCodeIndex] ? String(row[activationCodeIndex]).trim() : null,
      form_factor: formFactorIndex >= 0 && row[formFactorIndex] ? String(row[formFactorIndex]).trim() : null,
    })
  }
  const iccids = prepared.map((row) => row.iccid)
  const existing = await findExistingIccids(supabase, iccids)
  const nowIso = new Date().toISOString()
  const hasSimResellerColumn = await detectSimResellerColumn(supabase)
  const simRows = prepared
    .filter((row) => !existing.has(row.iccid))
    .map((row) => ({
      sim_id: crypto.randomUUID(),
      iccid: row.iccid,
      msisdn: row.msisdn,
      primary_imsi: row.primary_imsi,
      apn: row.apn,
      activation_code: row.activation_code,
      form_factor: row.form_factor,
      supplier_id: supplierId,
      operator_id: (operator as any).operator_id,
      enterprise_id: enterpriseId ?? null,
      ...(hasSimResellerColumn ? { reseller_id: resellerId ?? null } : {}),
      status: 'INVENTORY',
      created_at: nowIso,
    }))
  const jobRows = await supabase.insert(
    'jobs',
    {
      job_type: 'SIM_IMPORT',
      status: 'QUEUED',
      progress_processed: 0,
      progress_total: simRows.length,
      request_id: traceId ?? null,
      actor_user_id: actorUserId ?? null,
      actor_role: actorRole ?? null,
      reseller_id: resellerId ?? null,
      customer_id: enterpriseId ?? null,
      payload: {
        supplierId,
        enterpriseId: enterpriseId ?? null,
        batchId: batchId ?? null,
        totalRows: simRows.length,
        existingRows: existing.size,
      },
    },
    { returning: 'representation' }
  )
  const job = Array.isArray(jobRows) ? (jobRows[0] as Record<string, any>) : null
  const jobId = job?.job_id ?? null
  if (!simRows.length) {
    if (jobId) {
      await supabase.update(
        'jobs',
        `job_id=eq.${encodeURIComponent(String(jobId))}`,
        {
          status: 'SUCCEEDED',
          progress_processed: 0,
          progress_total: 0,
          started_at: nowIso,
          finished_at: nowIso,
        },
        { returning: 'minimal' }
      )
    }
    return {
      ok: true,
      jobId,
      status: 'SUCCEEDED',
      totalRows: 0,
      createdAt: job?.created_at ? String(job.created_at) : null,
    }
  }
  if (jobId) {
    await supabase.update(
      'jobs',
      `job_id=eq.${encodeURIComponent(String(jobId))}`,
      { status: 'RUNNING', started_at: nowIso },
      { returning: 'minimal' }
    )
  }
  let processed = 0
  let failed = 0
  let legacyCarrierRequiredHit = false
  for (const sim of simRows) {
    processed += 1
    let ok = true
    try {
      await supabase.insert('sims', sim, { returning: 'minimal' })
      await supabase.insert(
        'audit_logs',
        {
          actor_user_id: actorUserId ?? null,
          actor_role: actorRole ?? null,
          tenant_id: enterpriseId ?? null,
          action: 'SIM_IMPORTED',
          target_type: 'SIM',
          target_id: sim.iccid,
          request_id: traceId ?? null,
          source_ip: sourceIp ?? null,
          after_data: { iccid: sim.iccid, supplierId, enterpriseId: enterpriseId ?? null, batchId: batchId ?? null },
        },
        { returning: 'minimal' }
      )
    } catch (err) {
      ok = false
      failed += 1
      const classified = classifySimInsertError(err)
      if (classified === 'legacy_carrier_required') legacyCarrierRequiredHit = true
    }
    if (jobId && processed % 100 === 0) {
      await supabase.update(
        'jobs',
        `job_id=eq.${encodeURIComponent(String(jobId))}`,
        { progress_processed: processed, progress_total: simRows.length },
        { returning: 'minimal' }
      )
    }
  }
  if (jobId) {
    await supabase.update(
      'jobs',
      `job_id=eq.${encodeURIComponent(String(jobId))}`,
      {
        status: failed ? 'FAILED' : 'SUCCEEDED',
        progress_processed: processed,
        progress_total: simRows.length,
        error_summary: failed
          ? legacyCarrierRequiredHit
            ? `${failed} sims failed to import: legacy carrier_id constraint still required.`
            : `${failed} sims failed to import.`
          : null,
        finished_at: new Date().toISOString(),
      },
      { returning: 'minimal' }
    )
  }
  return {
    ok: true,
    jobId,
    status: failed ? 'FAILED' : 'SUCCEEDED',
    totalRows: simRows.length,
    createdAt: job?.created_at ? String(job.created_at) : null,
  }
}
