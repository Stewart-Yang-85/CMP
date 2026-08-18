import crypto from 'node:crypto'

function isValidUuid(value) {
  const s = String(value || '').trim().toLowerCase()
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(s)
}

function normalizeIccid(value) {
  if (value === undefined || value === null) return ''
  return String(value).trim()
}

function isValidIccid(value) {
  const s = normalizeIccid(value)
  return /^\d{18,20}$/.test(s)
}

function parseCsvText(text) {
  const rows = []
  let row = []
  let value = ''
  let inQuotes = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          value += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        value += ch
      }
      continue
    }
    if (ch === '"') {
      inQuotes = true
      continue
    }
    if (ch === ',') {
      row.push(value)
      value = ''
      continue
    }
    if (ch === '\n') {
      row.push(value)
      value = ''
      rows.push(row)
      row = []
      continue
    }
    if (ch === '\r') {
      if (text[i + 1] === '\n') continue
      row.push(value)
      value = ''
      rows.push(row)
      row = []
      continue
    }
    value += ch
  }
  if (value.length || row.length) {
    row.push(value)
    rows.push(row)
  }
  return rows
}

function parseCsvHeaders(row) {
  if (!Array.isArray(row)) return []
  return row.map((v, idx) => {
    const s = String(v ?? '').trim()
    return idx === 0 ? s.replace(/^\uFEFF/, '') : s
  })
}

function buildHeaderIndex(headers) {
  const map = new Map()
  headers.forEach((h, i) => {
    const key = String(h || '').trim()
    if (!key) return
    map.set(key.toLowerCase(), i)
  })
  return map
}

function getCsvValue(row, headerMap, key) {
  const idx = headerMap.get(String(key).toLowerCase())
  if (idx === undefined) return ''
  return row[idx] ?? ''
}

function toError(status, code, message) {
  return { ok: false, status, code, message }
}

function classifySimInsertError(err) {
  const text = String(err?.body ?? err?.message ?? '').toLowerCase()
  if (text.includes('violates foreign key constraint')) return 'foreign_key_violation'
  return 'insert_failed'
}

function isMissingSimResellerColumnError(err) {
  const text = String(err?.body ?? err?.message ?? '').toLowerCase()
  return text.includes('column sims.reseller_id does not exist')
}

async function detectSimResellerColumn(supabase) {
  try {
    await supabase.select('sims', 'select=reseller_id&limit=1', { suppressMissingColumns: true })
    return true
  } catch (err) {
    if (isMissingSimResellerColumnError(err)) return false
    throw err
  }
}

async function resolveOperatorLinkedToSupplier(supabase, operatorIdValue, supplierId) {
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
  return operator
}

/**
 * Parse assign-inventory CSV: required column **iccid** only; optional **imsi** (not validated for assignment).
 * At most 100 non-empty data rows; duplicate ICCIDs in file are de-duplicated.
 * @returns {{ ok: true, iccids: string[] } | { ok: false, status: number, code: string, message: string }}
 */
export function parseIccidsFromAssignInventoryCsv(csvText) {
  const rows = parseCsvText(String(csvText ?? ''))
  if (!rows.length) {
    return toError(400, 'INVALID_FORMAT', 'CSV format is invalid.')
  }
  const headers = parseCsvHeaders(rows[0])
  const headerMap = buildHeaderIndex(headers)
  if (!headerMap.has('iccid')) {
    return toError(400, 'INVALID_FORMAT', 'CSV missing required column: iccid.')
  }
  const dataRows = rows.slice(1).filter((r) => Array.isArray(r) && r.some((v) => String(v ?? '').trim().length > 0))
  if (dataRows.length === 0) {
    return toError(400, 'INVALID_FORMAT', 'CSV has no data rows.')
  }
  if (dataRows.length > 100) {
    return toError(400, 'BAD_REQUEST', 'CSV must not exceed 100 data rows.')
  }
  const iccids = []
  const seen = new Set()
  for (let i = 0; i < dataRows.length; i++) {
    const row = dataRows[i]
    const lineNo = i + 2
    const rawIccid = getCsvValue(row, headerMap, 'iccid')
    const iccid = normalizeIccid(rawIccid)
    if (!iccid) continue
    if (!isValidIccid(iccid)) {
      return toError(400, 'INVALID_FORMAT', `Row ${lineNo}: invalid iccid: ${rawIccid}`)
    }
    if (!seen.has(iccid)) {
      seen.add(iccid)
      iccids.push(iccid)
    }
  }
  if (iccids.length === 0) {
    return toError(400, 'INVALID_FORMAT', 'CSV has no valid ICCIDs.')
  }
  return { ok: true, iccids }
}

export async function runSimImport(input) {
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
  if (!supplierId || !isValidUuid(supplierId)) {
    return toError(400, 'BAD_REQUEST', 'supplierId is required and must be a valid uuid.')
  }
  const apnValue = apn != null && String(apn).trim() !== '' ? String(apn).trim() : null
  const operatorIdValue = String(operatorId ?? '').trim()
  if (!operatorIdValue || !isValidUuid(operatorIdValue)) {
    return toError(400, 'BAD_REQUEST', 'operatorId is required and must be a valid uuid.')
  }
  if (enterpriseId && !isValidUuid(enterpriseId)) {
    return toError(400, 'BAD_REQUEST', 'enterpriseId must be a valid uuid.')
  }
  const supplierRows = await supabase.select('suppliers', `select=supplier_id&supplier_id=eq.${encodeURIComponent(supplierId)}&limit=1`)
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
  const rows = parseCsvText(String(csvText ?? ''))
  if (!rows.length) {
    return toError(400, 'INVALID_FORMAT', 'CSV format is invalid.')
  }
  const headers = parseCsvHeaders(rows[0])
  const headerMap = buildHeaderIndex(headers)
  const requiredHeaders = ['iccid', 'imsi']
  if (!requiredHeaders.every((h) => headerMap.has(h))) {
    return toError(400, 'INVALID_FORMAT', 'CSV headers are invalid.')
  }
  const dataRows = rows.slice(1).filter((r) => Array.isArray(r) && r.some((v) => String(v ?? '').trim().length > 0))
  if (dataRows.length > 100000) {
    return toError(400, 'FILE_TOO_LARGE', 'CSV row limit exceeded.')
  }
  const operator = await resolveOperatorLinkedToSupplier(supabase, operatorIdValue, supplierId)
  if (!operator?.operator_id) {
    return toError(400, 'INVALID_OPERATOR', 'Operator is not linked to supplier.')
  }
  const businessOperatorId = operator.business_operator_id
    ? String(operator.business_operator_id)
    : String(operator.operator_id)
  const businessRowsPre = await supabase.select(
    'business_operators',
    `select=operator_id&operator_id=eq.${encodeURIComponent(businessOperatorId)}&limit=1`
  )
  const businessPre = Array.isArray(businessRowsPre) ? businessRowsPre[0] : null
  if (!businessPre?.operator_id) {
    return toError(400, 'INVALID_OPERATOR', 'Operator is not found in business operators.')
  }
  const fileHash = crypto.createHash('sha256').update(Buffer.from(String(csvText ?? ''), 'utf8')).digest('hex')
  const idempotencyKey = batchId || fileHash
  if (idempotencyKey) {
    const existing = await supabase.select('jobs', `select=job_id,created_at,status&job_type=eq.SIM_IMPORT&idempotency_key=eq.${encodeURIComponent(idempotencyKey)}&limit=1`)
    const hit = Array.isArray(existing) ? existing[0] : null
    if (hit) {
      return toError(409, 'DUPLICATE_BATCH', 'Duplicate batch import.')
    }
  }
  const jobRows = await supabase.insert('jobs', {
    job_type: 'SIM_IMPORT',
    status: 'QUEUED',
    progress_processed: 0,
    progress_total: dataRows.length,
    request_id: traceId ?? null,
    actor_user_id: actorUserId ?? null,
    reseller_id: resellerId ?? null,
      enterprise_id: enterpriseId ?? null,
    idempotency_key: idempotencyKey ?? null,
    file_hash: fileHash,
    payload: { supplierId, enterpriseId, batchId, fileHash },
  })
  const job = Array.isArray(jobRows) ? jobRows[0] : null
  const jobId = job?.job_id ?? null
  const createdAt = job?.created_at ?? new Date().toISOString()
  if (jobId) {
    await supabase.update('jobs', `job_id=eq.${encodeURIComponent(jobId)}`, {
      status: 'RUNNING',
      started_at: new Date().toISOString(),
    }, { returning: 'minimal' })
  }
  const allowedFormFactors = new Set(['consumer_removable', 'industrial_removable', 'consumer_embedded', 'industrial_embedded'])
  const hasSimResellerColumn = await detectSimResellerColumn(supabase)
  const seenIccids = new Set()
  const errorCounts = new Map()
  let processed = 0
  let succeeded = 0
  let failed = 0
  const bumpError = (code) => {
    errorCounts.set(code, (errorCounts.get(code) ?? 0) + 1)
  }
  for (const row of dataRows) {
    processed += 1
    const iccid = normalizeIccid(getCsvValue(row, headerMap, 'iccid'))
    const imsi = String(getCsvValue(row, headerMap, 'imsi') ?? '').trim()
    const msisdn = String(getCsvValue(row, headerMap, 'msisdn') ?? '').trim() || null
    const secondaryImsi1 = String(getCsvValue(row, headerMap, 'secondaryImsi1') ?? '').trim() || null
    const secondaryImsi2 = String(getCsvValue(row, headerMap, 'secondaryImsi2') ?? '').trim() || null
    const secondaryImsi3 = String(getCsvValue(row, headerMap, 'secondaryImsi3') ?? '').trim() || null
    const formFactorRaw = String(getCsvValue(row, headerMap, 'formFactor') ?? '').trim()
    const activationCode = String(getCsvValue(row, headerMap, 'activationCode') ?? '').trim() || null
    const imei = String(getCsvValue(row, headerMap, 'imei') ?? '').trim() || null
    if (!iccid || !isValidIccid(iccid)) {
      failed += 1
      bumpError('invalid_iccid')
    } else if (!imsi) {
      failed += 1
      bumpError('missing_required')
    } else if (formFactorRaw && !allowedFormFactors.has(formFactorRaw)) {
      failed += 1
      bumpError('invalid_form_factor')
    } else if (imei && !/^\d{15}$/.test(imei)) {
      failed += 1
      bumpError('invalid_imei')
    } else if (seenIccids.has(iccid)) {
      failed += 1
      bumpError('duplicate_iccid')
    } else {
      const existing = await supabase.select('sims', `select=sim_id&iccid=eq.${encodeURIComponent(iccid)}&limit=1`)
      const hit = Array.isArray(existing) ? existing[0] : null
      if (hit) {
        failed += 1
        bumpError('duplicate_iccid')
      } else {
        seenIccids.add(iccid)
        try {
          await supabase.insert('sims', {
            iccid,
            primary_imsi: imsi,
            imsi_secondary_1: secondaryImsi1,
            imsi_secondary_2: secondaryImsi2,
            imsi_secondary_3: secondaryImsi3,
            msisdn,
            supplier_id: supplierId,
            operator_id: operator.operator_id,
            enterprise_id: enterpriseId ?? null,
            ...(hasSimResellerColumn ? { reseller_id: resellerId ?? null } : {}),
            status: 'INVENTORY',
            apn: apnValue,
            bound_imei: imei,
            form_factor: formFactorRaw || null,
            activation_code: activationCode,
            last_status_change_at: new Date().toISOString(),
          }, { returning: 'minimal' })
          succeeded += 1
        } catch (err) {
          failed += 1
          bumpError(classifySimInsertError(err))
        }
      }
    }
    if (jobId && processed % 200 === 0) {
      await supabase.update('jobs', `job_id=eq.${encodeURIComponent(jobId)}`, {
        progress_processed: processed,
        progress_total: dataRows.length,
      }, { returning: 'minimal' })
    }
  }
  let errorSummary = null
  if (failed > 0) {
    const parts = Array.from(errorCounts.entries()).map(([k, v]) => `${v} ${k}`)
    errorSummary = `${failed} rows failed: ${parts.join(', ')}`
  }
  if (jobId) {
    await supabase.update('jobs', `job_id=eq.${encodeURIComponent(jobId)}`, {
      status: succeeded === 0 && failed > 0 ? 'FAILED' : 'SUCCEEDED',
      progress_processed: processed,
      progress_total: dataRows.length,
      error_summary: errorSummary,
      finished_at: new Date().toISOString(),
    }, { returning: 'minimal' })
    await supabase.insert('audit_logs', {
      actor_user_id: actorUserId ?? null,
      actor_role: actorRole ?? null,
      tenant_id: enterpriseId ?? null,
      action: 'SIM_IMPORT',
      target_type: 'SIM_BATCH',
      target_id: batchId || fileHash,
      request_id: traceId ?? null,
      source_ip: sourceIp ?? null,
      after_data: { supplierId, enterpriseId, total: dataRows.length, succeeded, failed },
    }, { returning: 'minimal' })
  }
  return {
    ok: true,
    jobId,
    status: 'QUEUED',
    totalRows: dataRows.length,
    createdAt,
  }
}
