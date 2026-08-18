// Phase 21b: eSIM Profile CRUD + Lifecycle + SM-DP+ System routes (T170-T173)

export function registerEsimRoutes({ app, prefix, deps }) {
  const {
    createSupabaseRestClient,
    getTraceId,
    sendError,
    getRoleScope,
    ensureResellerAdmin,
    isValidUuid,
  } = deps

  // ── T170: eSIM Profile CRUD ──────────────────────────────────

  app.post(`${prefix}/esim-profiles`, async (req, res) => {
    const auth = ensureResellerAdmin(req, res)
    if (!auth) return
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const {
      iccid,
      eid,
      smdpSystemId,
      activationCode,
      status,
      remark,
    } = req.body ?? {}
    if (!iccid || typeof iccid !== 'string') {
      return sendError(res, 400, 'BAD_REQUEST', 'iccid is required.')
    }
    if (!eid || typeof eid !== 'string') {
      return sendError(res, 400, 'BAD_REQUEST', 'eid is required.')
    }
    if (smdpSystemId && !isValidUuid(smdpSystemId)) {
      return sendError(res, 400, 'BAD_REQUEST', 'smdpSystemId must be a valid uuid.')
    }
    const row = {
      iccid: String(iccid).trim(),
      eid: String(eid).trim(),
      smdp_system_id: smdpSystemId ?? null,
      activation_code: activationCode ?? null,
      status: status ?? 'INVENTORY',
      remark: remark ? String(remark).slice(0, 1000) : null,
    }
    const created = await supabase.insert('esim_profiles', row, { returning: 'representation' })
    const profile = Array.isArray(created) ? created[0] : created
    if (!profile) {
      return sendError(res, 500, 'INTERNAL_ERROR', 'Failed to create eSIM profile.')
    }
    res.code().send({
      profileId: profile.profile_id ?? profile.id,
      iccid: profile.iccid,
      eid: profile.eid,
      smdpSystemId: profile.smdp_system_id ?? null,
      activationCode: profile.activation_code ?? null,
      status: profile.status,
      remark: profile.remark ?? null,
      createdAt: profile.created_at ?? null,
    })
  })

  app.get(`${prefix}/esim-profiles`, async (req, res) => {
    const roleScope = getRoleScope(req)
    if (!roleScope) {
      return sendError(res, 401, 'UNAUTHORIZED', 'Authentication required.')
    }
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const pageSize = req.query.pageSize ? Math.min(100, Math.max(1, Number(req.query.pageSize))) : 20
    const page = req.query.page ? Math.max(1, Number(req.query.page)) : 1
    const offset = (page - 1) * pageSize
    const filters = []
    if (req.query.iccid) filters.push(`iccid=eq.${encodeURIComponent(req.query.iccid)}`)
    if (req.query.eid) filters.push(`eid=eq.${encodeURIComponent(req.query.eid)}`)
    if (req.query.status) filters.push(`status=eq.${encodeURIComponent(req.query.status)}`)
    const filterQs = filters.length ? `&${filters.join('&')}` : ''
    const { data, total } = await supabase.selectWithCount(
      'esim_profiles',
      `select=profile_id,iccid,eid,smdp_system_id,activation_code,status,remark,created_at&order=created_at.desc&limit=${pageSize}&offset=${offset}${filterQs}`
    )
    const rows = Array.isArray(data) ? data : []
    res.send({
      items: rows.map((r) => ({
        profileId: r.profile_id,
        iccid: r.iccid,
        eid: r.eid,
        smdpSystemId: r.smdp_system_id ?? null,
        activationCode: r.activation_code ?? null,
        status: r.status,
        remark: r.remark ?? null,
        createdAt: r.created_at ?? null,
      })),
      total: typeof total === 'number' ? total : rows.length,
      page,
      pageSize,
    })
  })

  // ── PATCH /v1/esim-profiles/:profileId — update remark ─────
  app.patch(`${prefix}/esim-profiles/:profileId`, async (req, res) => {
    const auth = ensureResellerAdmin(req, res)
    if (!auth) return
    const profileId = String(req.params.profileId)
    if (!isValidUuid(profileId)) {
      return sendError(res, 400, 'BAD_REQUEST', 'profileId must be a valid uuid.')
    }
    const body = req.body ?? {}
    const allowedFields = new Set(['remark'])
    const patchKeys = Object.keys(body).filter((k) => allowedFields.has(k))
    if (patchKeys.length === 0) {
      return sendError(res, 400, 'BAD_REQUEST', 'No updatable fields provided. Supported: remark.')
    }
    const patch = {}
    if ('remark' in body) {
      const remarkValue = body.remark === null ? null : String(body.remark).slice(0, 1000)
      patch.remark = remarkValue
    }
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const rows = await supabase.select(
      'esim_profiles',
      `select=profile_id,iccid,eid,status&profile_id=eq.${encodeURIComponent(profileId)}&limit=1`
    )
    const profile = Array.isArray(rows) ? rows[0] : null
    if (!profile) {
      return sendError(res, 404, 'NOT_FOUND', 'eSIM profile not found.')
    }
    const updatedRows = await supabase.update(
      'esim_profiles',
      `profile_id=eq.${encodeURIComponent(profileId)}`,
      patch,
      { returning: 'representation' }
    )
    const updated = Array.isArray(updatedRows) ? updatedRows[0] : null
    if (!updated) {
      return sendError(res, 500, 'INTERNAL_ERROR', 'Failed to update eSIM profile.')
    }
    res.send({
      profileId: updated.profile_id,
      iccid: updated.iccid,
      eid: updated.eid,
      remark: updated.remark ?? null,
    })
  })

  // ── T171: eSIM status change routes ──────────────────────────

  const esimStatusActions = [
    { action: 'activate', from: ['INVENTORY', 'TEST_READY', 'DEACTIVATED'], to: 'ACTIVATED' },
    { action: 'deactivate', from: ['ACTIVATED', 'TEST_READY'], to: 'DEACTIVATED' },
    { action: 'retire', from: ['DEACTIVATED'], to: 'RETIRED' },
    { action: 'test-ready', from: ['INVENTORY'], to: 'TEST_READY' },
  ]

  for (const { action, from, to } of esimStatusActions) {
    app.post(`${prefix}/esim-profiles/:profileId\\:${action}`, async (req, res) => {
      const auth = ensureResellerAdmin(req, res)
      if (!auth) return
      const profileId = String(req.params.profileId)
      if (!isValidUuid(profileId)) {
        return sendError(res, 400, 'BAD_REQUEST', 'profileId must be a valid uuid.')
      }
      const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
      const rows = await supabase.select(
        'esim_profiles',
        `select=profile_id,iccid,eid,status&profile_id=eq.${encodeURIComponent(profileId)}&limit=1`
      )
      const profile = Array.isArray(rows) ? rows[0] : null
      if (!profile) {
        return sendError(res, 404, 'NOT_FOUND', 'eSIM profile not found.')
      }
      if (!from.includes(profile.status)) {
        return sendError(res, 409, 'INVALID_STATUS', `Cannot ${action} eSIM profile in status ${profile.status}.`)
      }
      const nowIso = new Date().toISOString()
      const updated = await supabase.update(
        'esim_profiles',
        `profile_id=eq.${encodeURIComponent(profileId)}`,
        { status: to },
        { returning: 'representation' }
      )
      const result = Array.isArray(updated) ? updated[0] : null
      if (!result) {
        return sendError(res, 500, 'INTERNAL_ERROR', `Failed to ${action} eSIM profile.`)
      }
      // Record state history
      try {
        await supabase.insert('esim_state_history', {
          profile_id: profileId,
          before_status: profile.status,
          after_status: to,
          source: `api:${action}`,
          request_id: getTraceId(res),
          occurred_at: nowIso,
        })
      } catch {
        // non-fatal: history table may not exist yet
      }
      res.send({
        profileId: result.profile_id,
        iccid: result.iccid,
        eid: result.eid,
        status: result.status,
        previousStatus: profile.status,
      })
    })
  }

  // ── T172: SM-DP+ System CRUD ─────────────────────────────────

  app.post(`${prefix}/smdp-systems`, async (req, res) => {
    const auth = ensureResellerAdmin(req, res)
    if (!auth) return
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const { name, baseUrl, authType, credentials } = req.body ?? {}
    if (!name || typeof name !== 'string') {
      return sendError(res, 400, 'BAD_REQUEST', 'name is required.')
    }
    if (!baseUrl || typeof baseUrl !== 'string') {
      return sendError(res, 400, 'BAD_REQUEST', 'baseUrl is required.')
    }
    const row = {
      name: String(name).trim(),
      base_url: String(baseUrl).trim(),
      auth_type: authType ? String(authType).trim() : 'NONE',
      credentials: credentials ?? null,
    }
    const created = await supabase.insert('smdp_systems', row, { returning: 'representation' })
    const system = Array.isArray(created) ? created[0] : created
    if (!system) {
      return sendError(res, 500, 'INTERNAL_ERROR', 'Failed to create SM-DP+ system.')
    }
    res.code().send({
      smdpSystemId: system.smdp_system_id ?? system.id,
      name: system.name,
      baseUrl: system.base_url,
      authType: system.auth_type,
      createdAt: system.created_at ?? null,
    })
  })

  app.get(`${prefix}/smdp-systems`, async (req, res) => {
    const roleScope = getRoleScope(req)
    if (!roleScope) {
      return sendError(res, 401, 'UNAUTHORIZED', 'Authentication required.')
    }
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const pageSize = req.query.pageSize ? Math.min(100, Math.max(1, Number(req.query.pageSize))) : 20
    const page = req.query.page ? Math.max(1, Number(req.query.page)) : 1
    const offset = (page - 1) * pageSize
    const { data, total } = await supabase.selectWithCount(
      'smdp_systems',
      `select=smdp_system_id,name,base_url,auth_type,created_at&order=created_at.desc&limit=${pageSize}&offset=${offset}`
    )
    const rows = Array.isArray(data) ? data : []
    res.send({
      items: rows.map((r) => ({
        smdpSystemId: r.smdp_system_id,
        name: r.name,
        baseUrl: r.base_url,
        authType: r.auth_type,
        createdAt: r.created_at ?? null,
      })),
      total: typeof total === 'number' ? total : rows.length,
      page,
      pageSize,
    })
  })

  app.patch(`${prefix}/smdp-systems/:smdpSystemId`, async (req, res) => {
    const auth = ensureResellerAdmin(req, res)
    if (!auth) return
    const smdpSystemId = String(req.params.smdpSystemId)
    if (!isValidUuid(smdpSystemId)) {
      return sendError(res, 400, 'BAD_REQUEST', 'smdpSystemId must be a valid uuid.')
    }
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const body = req.body ?? {}
    const patch = {}
    if ('name' in body) patch.name = String(body.name).trim()
    if ('baseUrl' in body) patch.base_url = String(body.baseUrl).trim()
    if ('authType' in body) patch.auth_type = String(body.authType).trim()
    if ('credentials' in body) patch.credentials = body.credentials
    if (Object.keys(patch).length === 0) {
      return sendError(res, 400, 'BAD_REQUEST', 'No updatable fields provided.')
    }
    const updated = await supabase.update(
      'smdp_systems',
      `smdp_system_id=eq.${encodeURIComponent(smdpSystemId)}`,
      patch,
      { returning: 'representation' }
    )
    const system = Array.isArray(updated) ? updated[0] : null
    if (!system) {
      return sendError(res, 404, 'NOT_FOUND', 'SM-DP+ system not found.')
    }
    res.send({
      smdpSystemId: system.smdp_system_id,
      name: system.name,
      baseUrl: system.base_url,
      authType: system.auth_type,
      createdAt: system.created_at ?? null,
    })
  })
}
