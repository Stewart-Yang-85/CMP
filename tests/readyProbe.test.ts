import { describe, it, expect } from 'vitest'
import { evaluateReadyOk } from '../src/services/readyProbe.js'

describe('evaluateReadyOk', () => {
  const baseConfig = { supabaseUrl: true, supabaseAnonKey: true, supabaseServiceRoleKey: true }

  it('requires supabase probe when supabase is configured', () => {
    expect(
      evaluateReadyOk({
        config: baseConfig,
        upstream: { supabase: false, integrations: [], integrationsProbeSkipped: null },
      }),
    ).toBe(false)
    expect(
      evaluateReadyOk({
        config: baseConfig,
        upstream: { supabase: true, integrations: [], integrationsProbeSkipped: null },
      }),
    ).toBe(true)
  })

  it('fails when any active integration ping fails', () => {
    expect(
      evaluateReadyOk({
        config: baseConfig,
        upstream: {
          supabase: true,
          integrationsProbeSkipped: null,
          integrations: [
            {
              integrationId: 'a',
              name: 'WXZG Primary',
              supplierId: 'b',
              operatorId: 'c',
              adapterType: 'wxzhonggeng',
              reachable: true,
            },
            {
              integrationId: 'd',
              name: 'WXZG Backup',
              supplierId: 'e',
              operatorId: 'f',
              adapterType: 'wxzhonggeng',
              reachable: false,
              error: 'UPSTREAM_HEALTH_CHECK_FAILED',
            },
          ],
        },
      }),
    ).toBe(false)
  })

  it('passes when supabase is not configured and there are no integration failures', () => {
    expect(
      evaluateReadyOk({
        config: { supabaseUrl: false, supabaseAnonKey: false, supabaseServiceRoleKey: false },
        upstream: { supabase: null, integrations: [], integrationsProbeSkipped: null },
      }),
    ).toBe(true)
  })
})
