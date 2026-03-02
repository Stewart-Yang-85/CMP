import crypto from 'node:crypto'

type SupabaseClient = {
  select: (table: string, queryString: string) => Promise<unknown>
  insert: (table: string, rows: unknown, options?: { returning?: 'minimal' | 'representation' }) => Promise<unknown>
  update: (table: string, matchQueryString: string, patch: unknown, options?: { returning?: 'minimal' | 'representation' }) => Promise<unknown>
}

type ImportInput = {
  supabase: SupabaseClient
  csvText: string
  supplierId: string
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

function normalizeIccid(value: unknown) {
  if (value === undefined || value === null) return ''
  return String(value).trim()
}

function isValidIccid(value: unknown) {
  const s = normalizeIccid(value)
  return /^\d{18,20}$/.test(s)
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
  const { supabase, csvText, supplierId, enterpriseId, batchId, traceId, actorUserId, actorRole, resellerId, sourceIp } = input
  if (!supplierId) return toError(400, 'BAD_REQUEST', 'supplierId is required.')
  const rows = parseCsvText(csvText)
  if (!rows.length) {
    return toError(400, 'INVALID_FORMAT', 'CSV file is empty.')
  }
  const header = rows[0].map((h) => h.toLowerCase())
  const required = ['iccid']
  for (const field of required) {
    if (!header.includes(field)) {
      return toError(400, 'INVALID_FORMAT', `CSV missing required field: ${field}.`)
    }
  }
  const iccidIndex = header.indexOf('iccid')
  const msisdnIndex = header.indexOf('msisdn')
  const imsiIndex = header.indexOf('imsi')
  const apnIndex = header.indexOf('apn')
  const activationCodeIndex = header.indexOf('activation_code')
  const formFactorIndex = header.indexOf('form_factor')
  const rowsData = rows.slice(1)
  const prepared: Array<Record<string, any>> = []
  for (const row of rowsData) {
    const iccid = normalizeIccid(row[iccidIndex])
    if (!iccid || !isValidIccid(iccid)) {
      return toError(400, 'INVALID_FORMAT', `Invalid iccid: ${row[iccidIndex]}`)
    }
    prepared.push({
      iccid,
      msisdn: msisdnIndex >= 0 && row[msisdnIndex] ? String(row[msisdnIndex]).trim() : null,
      primary_imsi: imsiIndex >= 0 && row[imsiIndex] ? String(row[imsiIndex]).trim() : null,
      apn: apnIndex >= 0 && row[apnIndex] ? String(row[apnIndex]).trim() : null,
      activation_code: activationCodeIndex >= 0 && row[activationCodeIndex] ? String(row[activationCodeIndex]).trim() : null,
      form_factor: formFactorIndex >= 0 && row[formFactorIndex] ? String(row[formFactorIndex]).trim() : null,
    })
  }
  const iccids = prepared.map((row) => row.iccid)
  const existing = await findExistingIccids(supabase, iccids)
  const nowIso = new Date().toISOString()
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
      enterprise_id: enterpriseId ?? null,
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
    } catch {
      ok = false
      failed += 1
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
        error_summary: failed ? `${failed} sims failed to import.` : null,
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
