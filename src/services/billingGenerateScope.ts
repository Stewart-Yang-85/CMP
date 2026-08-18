type SupabaseReader = {
  select: (table: string, queryString: string) => Promise<unknown>
}

export type ScopeError = { ok: false; status: number; code: string; message: string }
export type ScopeOk<T> = { ok: true; value: T }

function readOptionalUuidField(source: Record<string, unknown>, camelKey: string): string | null {
  const snakeKey = camelKey.replace(/([A-Z])/g, '_$1').toLowerCase()
  const raw = source[camelKey] ?? source[snakeKey]
  if (raw == null || String(raw).trim() === '') return null
  return String(raw).trim()
}

export function readOptionalBodyUuid(body: Record<string, unknown>, camelKey: string): string | null {
  return readOptionalUuidField(body, camelKey)
}

export function readOptionalQueryUuid(query: Record<string, unknown>, camelKey: string): string | null {
  return readOptionalUuidField(query, camelKey)
}

export async function validateResellerTenant(
  supabase: SupabaseReader,
  resellerId: string
): Promise<ScopeOk<string> | ScopeError> {
  const rows = await supabase.select(
    'tenants',
    `select=tenant_id&tenant_id=eq.${encodeURIComponent(resellerId)}&tenant_type=eq.RESELLER&limit=1`
  )
  const row = Array.isArray(rows) ? (rows[0] as { tenant_id?: string } | undefined) : undefined
  if (!row?.tenant_id) {
    return { ok: false, status: 404, code: 'RESOURCE_NOT_FOUND', message: `reseller ${resellerId} not found.` }
  }
  return { ok: true, value: String(row.tenant_id) }
}

export async function validateEnterpriseForReseller(
  supabase: SupabaseReader,
  enterpriseId: string,
  resellerTenantId: string
): Promise<ScopeOk<string> | ScopeError> {
  const rows = await supabase.select(
    'tenants',
    `select=tenant_id,parent_id&tenant_id=eq.${encodeURIComponent(enterpriseId)}&tenant_type=eq.ENTERPRISE&limit=1`
  )
  const row = Array.isArray(rows) ? (rows[0] as { tenant_id?: string; parent_id?: string | null } | undefined) : undefined
  if (!row?.tenant_id) {
    return { ok: false, status: 404, code: 'RESOURCE_NOT_FOUND', message: `enterprise ${enterpriseId} not found.` }
  }
  if (String(row.parent_id || '') !== String(resellerTenantId)) {
    return { ok: false, status: 403, code: 'FORBIDDEN', message: 'enterpriseId is out of reseller scope.' }
  }
  return { ok: true, value: String(row.tenant_id) }
}

export function normalizeOptionalScopeId(value: unknown): string | null {
  if (value == null || String(value).trim() === '') return null
  return String(value).trim()
}

export type BillingGenerateScope = {
  period: string
  resellerId: string | null
  enterpriseId: string | null
}

export function parseJobPayload(payload: unknown): Record<string, unknown> {
  if (payload == null) return {}
  if (typeof payload === 'string') {
    try {
      const parsed = JSON.parse(payload) as unknown
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {}
    } catch {
      return {}
    }
  }
  if (typeof payload === 'object' && !Array.isArray(payload)) {
    return payload as Record<string, unknown>
  }
  return {}
}

export function billingGenerateScopeFromPayload(payload: Record<string, unknown>): BillingGenerateScope {
  return {
    period: String(payload.period ?? '').trim(),
    resellerId: normalizeOptionalScopeId(payload.resellerId),
    enterpriseId: normalizeOptionalScopeId(payload.enterpriseId),
  }
}

export function billingGenerateScopesEqual(a: BillingGenerateScope, b: BillingGenerateScope): boolean {
  return (
    a.period === b.period
    && normalizeOptionalScopeId(a.resellerId) === normalizeOptionalScopeId(b.resellerId)
    && normalizeOptionalScopeId(a.enterpriseId) === normalizeOptionalScopeId(b.enterpriseId)
  )
}

export function buildBillingGenerateJobResponse(
  job: Record<string, unknown>,
  scope: BillingGenerateScope,
  idempotencyKey: string | null
) {
  return {
    jobId: job.job_id ? String(job.job_id) : null,
    period: scope.period,
    status: job.status ? String(job.status) : 'QUEUED',
    enterpriseId: scope.enterpriseId,
    resellerId: scope.resellerId,
    idempotencyKey,
  }
}

export function billingGenerateReplayStatusCode(jobStatus: unknown): 200 | 202 {
  return String(jobStatus ?? 'QUEUED').toUpperCase() === 'SUCCEEDED' ? 200 : 202
}
