function toError(status, code, message) {
  return { ok: false, status, code, message }
}

function isValidUuid(value) {
  const s = String(value || '').trim().toLowerCase()
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(s)
}

function isValidMcc(value) {
  return /^\d{3}$/.test(String(value || ''))
}

function isValidMnc(value) {
  return /^\d{2,3}$/.test(String(value || ''))
}

function normalizeMnc(value) {
  const s = String(value || '').trim()
  return s.length === 2 ? `0${s}` : s.length === 3 ? s : null
}

export async function listPublicInfos({ supabase, name, mcc, mnc, page, pageSize }) {
  const p = Math.max(1, Number(page) || 1)
  const ps = Math.min(200, Math.max(1, Number(pageSize) || 20))
  const offset = (p - 1) * ps

  const hasMcc = mcc !== null && mcc !== undefined && String(mcc).trim() !== ''
  const hasMnc = mnc !== null && mnc !== undefined && String(mnc).trim() !== ''
  if ((hasMcc && !hasMnc) || (!hasMcc && hasMnc)) {
    return toError(400, 'BAD_REQUEST', 'Both mcc and mnc must be provided together.')
  }

  const filters = []
  if (name) {
    filters.push(`name=ilike.${encodeURIComponent(`%${String(name).trim()}%`)}`)
  }
  if (hasMcc && hasMnc) {
    filters.push(`mcc=eq.${encodeURIComponent(String(mcc).trim())}`)
    filters.push(`mnc=eq.${encodeURIComponent(String(mnc).trim())}`)
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
  const country = payload.country ? String(payload.country).trim() : null
  const mcc = payload.mcc ? String(payload.mcc).trim() : null
  const mnc = payload.mnc ? String(payload.mnc).trim() : null
  const lteBands = payload.lteBands ? String(payload.lteBands).trim() : null

  if (!name) return toError(400, 'BAD_REQUEST', 'name is required.')
  if (!mcc || !isValidMcc(mcc)) return toError(400, 'BAD_REQUEST', 'mcc must be a 3-digit string.')
  if (!mnc || !isValidMnc(mnc)) return toError(400, 'BAD_REQUEST', 'mnc must be a 2 or 3 digit string.')

  const normalizedMnc = normalizeMnc(mnc) ?? mnc

  // Check for duplicate PLMN
  const existing = await supabase.select(
    'public_infos',
    `select=public_info_id&mcc=eq.${encodeURIComponent(mcc)}&mnc=eq.${encodeURIComponent(normalizedMnc)}&limit=1`
  )
  if (Array.isArray(existing) && existing.length > 0) {
    return toError(409, 'DUPLICATE_PLMN', `A PLMN entry with mcc=${mcc} mnc=${normalizedMnc} already exists.`)
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

  const patch = {}
  if (payload.name !== undefined) patch.name = String(payload.name).trim()
  if (payload.country !== undefined) patch.country = payload.country === null ? null : String(payload.country).trim()
  if (payload.lteBands !== undefined) patch.lte_bands = payload.lteBands === null ? null : String(payload.lteBands).trim()

  if (payload.mcc !== undefined || payload.mnc !== undefined) {
    const newMcc = payload.mcc !== undefined ? String(payload.mcc).trim() : current.mcc
    const newMnc = payload.mnc !== undefined ? String(payload.mnc).trim() : current.mnc
    if (!isValidMcc(newMcc)) return toError(400, 'BAD_REQUEST', 'mcc must be a 3-digit string.')
    if (!isValidMnc(newMnc)) return toError(400, 'BAD_REQUEST', 'mnc must be a 2 or 3 digit string.')
    const normalizedMnc = normalizeMnc(newMnc) ?? newMnc

    // Check duplicate if PLMN changed
    if (newMcc !== current.mcc || normalizedMnc !== current.mnc) {
      const dup = await supabase.select(
        'public_infos',
        `select=public_info_id&mcc=eq.${encodeURIComponent(newMcc)}&mnc=eq.${encodeURIComponent(normalizedMnc)}&public_info_id=neq.${encodeURIComponent(publicInfoId)}&limit=1`
      )
      if (Array.isArray(dup) && dup.length > 0) {
        return toError(409, 'DUPLICATE_PLMN', `A PLMN entry with mcc=${newMcc} mnc=${normalizedMnc} already exists.`)
      }
    }
    patch.mcc = newMcc
    patch.mnc = normalizedMnc
  }

  if (Object.keys(patch).length === 0) {
    return toError(400, 'BAD_REQUEST', 'At least one field must be provided for update.')
  }

  patch.updated_at = new Date().toISOString()

  const rows = await supabase.update(
    'public_infos',
    `public_info_id=eq.${encodeURIComponent(publicInfoId)}`,
    patch,
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
