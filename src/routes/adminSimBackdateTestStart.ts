type Deps = {
  createSupabaseRestClient: (options?: { useServiceRole?: boolean; traceId?: string | null }) => any
  getTraceId: (res: any) => string | null
  sendError: (res: any, status: number, code: string, message: string) => void
  requireAdminAccess: (req: any, res: any) => boolean
  requireIccid: (res: any, value: unknown, label?: string) => string | null
}

/**
 * Admin helper: backdate TEST_READY start so PERIOD_* expiry can be exercised without waiting.
 * OpenAPI path `/admin/sims/{iccid}:backdate-test-start` is rewritten to
 * `/admin/sims/:iccid/backdate-test-start` via `rewriteColonCatalogUrl`
 * (find-my-way does not correctly parse `:iccid::action` path params).
 */
export function registerAdminSimBackdateTestStartRoutes({
  app,
  prefix,
  deps,
}: {
  app: any
  prefix: string
  deps: Deps
}) {
  const { createSupabaseRestClient, getTraceId, sendError, requireAdminAccess, requireIccid } = deps

  app.post(`${prefix}/admin/sims/:iccid/backdate-test-start`, async (req: any, res: any) => {
    if (!requireAdminAccess(req, res)) return

    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const iccid = requireIccid(res, req.params?.iccid)
    if (!iccid) return

    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>
    const daysBackRaw = body.daysBack != null ? Number(body.daysBack) : 1
    const daysBack = Number.isFinite(daysBackRaw) && daysBackRaw > 0 ? Math.floor(daysBackRaw) : 1
    const backIso = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000).toISOString()

    const rows = await supabase.select(
      'sims',
      `select=sim_id,iccid,status,enterprise_id,last_status_change_at&iccid=eq.${encodeURIComponent(iccid)}&limit=1`
    )
    const sim = Array.isArray(rows) ? rows[0] : null
    if (!sim) {
      return sendError(res, 404, 'RESOURCE_NOT_FOUND', `sim ${iccid} not found.`)
    }

    await supabase.update(
      'sims',
      `sim_id=eq.${encodeURIComponent(sim.sim_id)}`,
      {
        status: 'TEST_READY',
        last_status_change_at: backIso,
      },
      { returning: 'minimal' }
    )

    const histRows = await supabase.select(
      'sim_state_history',
      `select=history_id,start_time&sim_id=eq.${encodeURIComponent(sim.sim_id)}&after_status=eq.TEST_READY&order=start_time.desc&limit=1`
    )
    const hist = Array.isArray(histRows) ? histRows[0] : null
    if (hist?.history_id) {
      await supabase.update(
        'sim_state_history',
        `history_id=eq.${encodeURIComponent(hist.history_id)}`,
        { start_time: backIso },
        { returning: 'minimal' }
      )
    } else {
      await supabase.insert(
        'sim_state_history',
        {
          sim_id: sim.sim_id,
          after_status: 'TEST_READY',
          start_time: backIso,
          source: 'ADMIN_BACKDATE',
          request_id: getTraceId(res),
        },
        { returning: 'minimal' }
      )
    }

    await supabase.insert(
      'audit_logs',
      {
        actor_role: 'ADMIN',
        tenant_id: sim.enterprise_id ?? null,
        action: 'ADMIN_BACKDATE_TEST_START',
        target_type: 'SIM',
        target_id: iccid,
        request_id: getTraceId(res),
        source_ip: req.ip ?? null,
        after_data: { daysBack, newStart: backIso },
      },
      { returning: 'minimal' }
    )

    res.send({ success: true, newStart: backIso })
  })
}
