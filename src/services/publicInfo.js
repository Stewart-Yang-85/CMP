function toError(status, code, message) {
  return { ok: false, status, code, message }
}

function isValidUuid(value) {
  const s = String(value || '').trim().toLowerCase()
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(s)
}

function isValidMcc(value) {
  return /^\d{3}$/.test(String(value || '').trim())
}

function isValidMncInput(value) {
  // Accept 1–3 digits so JSON numbers like 2 / 02-as-string can be normalized to 3 digits.
  return /^\d{1,3}$/.test(String(value ?? '').trim())
}

/** Pad MNC to 3 digits (e.g. "02" / 2 → "002") for storage and uniqueness checks. */
function normalizeMnc(value) {
  const s = String(value ?? '').trim()
  if (!/^\d{1,3}$/.test(s)) return null
  return s.padStart(3, '0')
}

export async function listPublicInfos({ supabase, name, mcc, mnc, page, pageSize }) {
  // page default 1; pageSize default 50, max 100
  const p = Math.max(1, Number(page) || 1)
  const ps = Math.min(100, Math.max(1, Number(pageSize) || 50))
  const offset = (p - 1) * ps

  const hasMcc = mcc !== null && mcc !== undefined && String(mcc).trim() !== ''
  const hasMnc = mnc !== null && mnc !== undefined && String(mnc).trim() !== ''
  // mnc alone is ambiguous across countries → 400; mcc alone lists that country's carriers
  if (hasMnc && !hasMcc) {
    return toError(400, 'BAD_REQUEST', 'mnc must be provided together with mcc (mnc alone is ambiguous across countries).')
  }

  const filters = []
  // Fuzzy (case-insensitive substring) match: catalog rows may store a specific
  // legal/company name rather than a short brand, so exact equality is too strict.
  if (name) {
    filters.push(`name=ilike.${encodeURIComponent(`%${String(name).trim()}%`)}`)
  }
  if (hasMcc) {
    const mccVal = String(mcc).trim()
    filters.push(`mcc=eq.${encodeURIComponent(mccVal)}`)
    if (hasMnc) {
      const mncRaw = String(mnc).trim()
      const mncVal = normalizeMnc(mncRaw)
      if (!mncVal) {
        return toError(400, 'BAD_REQUEST', 'mnc must be a 1–3 digit string (2-digit values are left-padded to 3).')
      }
      filters.push(`mnc=eq.${encodeURIComponent(mncVal)}`)
    }
  }

  const filterQs = filters.length ? `&${filters.join('&')}` : ''
  const { data, total } = await supabase.selectWithCount(
    'public_infos',
    `select=public_info_id,name,country,mcc,mnc,lte_bands&order=name.asc&limit=${ps}&offset=${offset}${filterQs}`
  )
  const rows = Array.isArray(data) ? data : []
  const items = rows.map((row) => ({
    publicInfoId: row.public_info_id,
    name: row.name,
    country: row.country ?? null,
    mcc: row.mcc,
    mnc: row.mnc,
    lteBands: row.lte_bands ?? null,
  }))
  return { ok: true, value: { items, total: typeof total === 'number' ? total : items.length, page: p, pageSize: ps } }
}

export async function createPublicInfo({ supabase, payload }) {
  const name = payload.name ? String(payload.name).trim() : null
  const country = payload.country !== undefined && payload.country !== null ? String(payload.country).trim() : null
  const mcc = payload.mcc ? String(payload.mcc).trim() : null
  const mnc = payload.mnc ? String(payload.mnc).trim() : null
  const hasLteBands = Object.prototype.hasOwnProperty.call(payload ?? {}, 'lteBands')
  const lteBands = hasLteBands
    ? payload.lteBands === null || payload.lteBands === undefined
      ? null
      : String(payload.lteBands).trim() || null
    : null

  if (!name) return toError(400, 'BAD_REQUEST', 'name is required.')
  if (!country) return toError(400, 'BAD_REQUEST', 'country is required.')
  if (!mcc || !isValidMcc(mcc)) return toError(400, 'BAD_REQUEST', 'mcc must be a 3-digit string.')
  if (!mnc || !isValidMncInput(mnc)) {
    return toError(400, 'BAD_REQUEST', 'mnc must be a 1–3 digit string (2-digit values are left-padded to 3).')
  }

  const normalizedMnc = normalizeMnc(mnc)
  if (!normalizedMnc) {
    return toError(400, 'BAD_REQUEST', 'mnc must be a 1–3 digit string (2-digit values are left-padded to 3).')
  }

  // Reject duplicate PLMN after MNC normalization — do not overwrite (use PATCH by publicInfoId).
  const existing = await supabase.select(
    'public_infos',
    `select=public_info_id&mcc=eq.${encodeURIComponent(mcc)}&mnc=eq.${encodeURIComponent(normalizedMnc)}&limit=1`
  )
  if (Array.isArray(existing) && existing.length > 0) {
    return toError(
      409,
      'DUPLICATE_PLMN',
      `A PLMN entry with mcc=${mcc} mnc=${normalizedMnc} already exists.`
    )
  }

  const rows = await supabase.insert('public_infos', {
    name,
    country,
    mcc,
    mnc: normalizedMnc,
    lte_bands: lteBands,
  }, { returning: 'representation' })

  const row = Array.isArray(rows) ? rows[0] : null
  if (!row) return toError(500, 'INTERNAL_ERROR', 'Failed to create public info entry.')

  return {
    ok: true,
    value: {
      publicInfoId: row.public_info_id,
      name: row.name,
      country: row.country ?? null,
      mcc: row.mcc,
      mnc: row.mnc,
      lteBands: row.lte_bands ?? null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    },
  }
}

export async function updatePublicInfo({ supabase, publicInfoId, payload }) {
  if (!publicInfoId || !isValidUuid(publicInfoId)) {
    return toError(400, 'BAD_REQUEST', 'publicInfoId must be a valid uuid.')
  }

  const existing = await supabase.select(
    'public_infos',
    `select=public_info_id,mcc,mnc&public_info_id=eq.${encodeURIComponent(publicInfoId)}&limit=1`
  )
  const current = Array.isArray(existing) ? existing[0] : null
  if (!current) return toError(404, 'NOT_FOUND', 'Public info entry not found.')

  const name = payload.name ? String(payload.name).trim() : null
  const country =
    payload.country !== undefined && payload.country !== null ? String(payload.country).trim() : null
  const mcc = payload.mcc ? String(payload.mcc).trim() : null
  const mnc = payload.mnc ? String(payload.mnc).trim() : null
  const hasLteBands = Object.prototype.hasOwnProperty.call(payload ?? {}, 'lteBands')
  const lteBands = hasLteBands
    ? payload.lteBands === null || payload.lteBands === undefined
      ? null
      : String(payload.lteBands).trim() || null
    : null

  if (!name) return toError(400, 'BAD_REQUEST', 'name is required.')
  if (!country) return toError(400, 'BAD_REQUEST', 'country is required.')
  if (!mcc || !isValidMcc(mcc)) return toError(400, 'BAD_REQUEST', 'mcc must be a 3-digit string.')
  if (!mnc || !isValidMncInput(mnc)) {
    return toError(400, 'BAD_REQUEST', 'mnc must be a 1–3 digit string (2-digit values are left-padded to 3).')
  }

  const normalizedMnc = normalizeMnc(mnc)
  if (!normalizedMnc) {
    return toError(400, 'BAD_REQUEST', 'mnc must be a 1–3 digit string (2-digit values are left-padded to 3).')
  }

  // Always enforce PLMN uniqueness against *other* rows after MNC normalization.
  const dup = await supabase.select(
    'public_infos',
    `select=public_info_id&mcc=eq.${encodeURIComponent(mcc)}&mnc=eq.${encodeURIComponent(normalizedMnc)}&public_info_id=neq.${encodeURIComponent(publicInfoId)}&limit=1`
  )
  if (Array.isArray(dup) && dup.length > 0) {
    return toError(
      409,
      'DUPLICATE_PLMN',
      `A PLMN entry with mcc=${mcc} mnc=${normalizedMnc} already exists on another publicInfoId.`
    )
  }

  const rows = await supabase.update(
    'public_infos',
    `public_info_id=eq.${encodeURIComponent(publicInfoId)}`,
    {
      name,
      country,
      mcc,
      mnc: normalizedMnc,
      lte_bands: lteBands,
      updated_at: new Date().toISOString(),
    },
    { returning: 'representation' }
  )
  const row = Array.isArray(rows) ? rows[0] : null
  if (!row) return toError(500, 'INTERNAL_ERROR', 'Failed to update public info entry.')

  return {
    ok: true,
    value: {
      publicInfoId: row.public_info_id,
      name: row.name,
      country: row.country ?? null,
      mcc: row.mcc,
      mnc: row.mnc,
      lteBands: row.lte_bands ?? null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    },
  }
}

export async function deletePublicInfo({ supabase, publicInfoId }) {
  if (!publicInfoId || !isValidUuid(publicInfoId)) {
    return toError(400, 'BAD_REQUEST', 'publicInfoId must be a valid uuid.')
  }

  const existing = await supabase.select(
    'public_infos',
    `select=public_info_id&public_info_id=eq.${encodeURIComponent(publicInfoId)}&limit=1`
  )
  if (!Array.isArray(existing) || existing.length === 0) {
    return toError(404, 'NOT_FOUND', 'Public info entry not found.')
  }

  try {
    await supabase.delete('public_infos', `public_info_id=eq.${encodeURIComponent(publicInfoId)}`)
  } catch (err) {
    const body = String(err?.body ?? err?.message ?? '')
    if (body.includes('violates foreign key constraint')) {
      return toError(409, 'FK_CONFLICT', 'Cannot delete: this entry is referenced by other records.')
    }
    throw err
  }

  return { ok: true, value: { deleted: true } }
}
