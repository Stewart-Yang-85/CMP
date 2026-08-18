import { describe, expect, it, vi, beforeEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { WXZHONGGENG_DIAGNOSTICS_CAPABILITIES } from '../src/vendors/diagnosticsCapabilities.js'

vi.mock('../src/services/upstreamIntegration.js', () => ({
  loadUpstreamIntegrationRuntime: vi.fn(),
}))

import { loadUpstreamIntegrationRuntime } from '../src/services/upstreamIntegration.js'
import { resolveDiagnosticsIntegration } from '../src/services/simDiagnosticsIntegration.js'

const mockLoadRuntime = vi.mocked(loadUpstreamIntegrationRuntime)

describe('resolveDiagnosticsIntegration', () => {
  const supabase = { select: async () => [] }

  beforeEach(() => {
    mockLoadRuntime.mockReset()
  })

  it('returns 503 when sim has no supplier or operator', async () => {
    const result = await resolveDiagnosticsIntegration(supabase, { iccid: '893107032536638540' })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.status).toBe(503)
    expect(result.code).toBe('UPSTREAM_NOT_CONFIGURED')
  })

  it('returns 503 when no active integration exists', async () => {
    mockLoadRuntime.mockResolvedValue(null)
    const result = await resolveDiagnosticsIntegration(supabase, {
      supplier_id: randomUUID(),
      operator_id: randomUUID(),
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('UPSTREAM_NOT_CONFIGURED')
  })

  it('returns adapter and WXZG diagnostics capabilities from integration runtime', async () => {
    const integrationId = randomUUID()
    mockLoadRuntime.mockResolvedValue({
      integrationId,
      supplierId: randomUUID(),
      operatorId: randomUUID(),
      adapterType: 'wxzhonggeng',
      apiEndpoint: 'https://upstream.example.com',
      apiKey: 'key',
      apiSecret: 'secret',
      username: null,
      password: null,
      webhookKey: 'wh',
      authType: 'api_key',
      tokenUrl: null,
      enabled: true,
      config: {},
    })
    const result = await resolveDiagnosticsIntegration(supabase, {
      supplier_id: randomUUID(),
      operator_id: randomUUID(),
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.context.integrationId).toBe(integrationId)
    expect(result.context.adapter.supplierKey).toBe('wxzhonggeng')
    expect(result.context.capabilities).toEqual(WXZHONGGENG_DIAGNOSTICS_CAPABILITIES)
  })
})
