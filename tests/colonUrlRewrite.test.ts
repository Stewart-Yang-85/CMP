import { describe, it, expect } from 'vitest'
import { rewriteColonCatalogUrl } from '../src/colonUrlRewrite.js'

describe('rewriteColonCatalogUrl', () => {
  it('rewrites roaming-profiles:import-csv to /import-csv (not /rollback)', () => {
    expect(rewriteColonCatalogUrl('/v1/roaming-profiles:import-csv')).toBe(
      '/v1/roaming-profiles/import-csv'
    )
    expect(rewriteColonCatalogUrl('/v1/roaming-profiles:import-csv?foo=1')).toBe(
      '/v1/roaming-profiles/import-csv?foo=1'
    )
  })

  it('rewrites roaming-profiles export-csv colon action', () => {
    const id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
    expect(rewriteColonCatalogUrl(`/v1/roaming-profiles/${id}:export-csv`)).toBe(
      `/v1/roaming-profiles/${id}/export-csv`
    )
  })

  it('rewrites profile-versions rollback colon action', () => {
    const id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
    expect(rewriteColonCatalogUrl(`/v1/profile-versions/${id}:rollback`)).toBe(
      `/v1/profile-versions/${id}/rollback`
    )
  })

  it('rewrites subscriptions cancel colon action (not /rollback)', () => {
    const id = 'db04df47-9756-46e1-901d-bc883c65994d'
    expect(rewriteColonCatalogUrl(`/v1/subscriptions/${id}:cancel`)).toBe(
      `/v1/subscriptions/${id}/cancel`
    )
    expect(rewriteColonCatalogUrl(`/v1/subscriptions/${id}:cancel?immediate=true`)).toBe(
      `/v1/subscriptions/${id}/cancel?immediate=true`
    )
  })

  it('rewrites sims cancel-location colon action', () => {
    const iccid = '89860012345678901234'
    expect(rewriteColonCatalogUrl(`/v1/sims/${iccid}:cancel-location`)).toBe(
      `/v1/sims/${iccid}/cancel-location`
    )
    expect(rewriteColonCatalogUrl(`/v1/sims/${iccid}:cancel-location?reason=test`)).toBe(
      `/v1/sims/${iccid}/cancel-location?reason=test`
    )
  })

  it('rewrites admin sims backdate-test-start colon action', () => {
    const iccid = '89860099000000100001'
    expect(rewriteColonCatalogUrl(`/v1/admin/sims/${iccid}:backdate-test-start`)).toBe(
      `/v1/admin/sims/${iccid}/backdate-test-start`
    )
    expect(rewriteColonCatalogUrl(`/admin/sims/${iccid}:backdate-test-start`)).toBe(
      `/admin/sims/${iccid}/backdate-test-start`
    )
  })

  it('rewrites alerts acknowledge colon action', () => {
    const id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
    expect(rewriteColonCatalogUrl(`/v1/alerts/${id}:acknowledge`)).toBe(
      `/v1/alerts/${id}/acknowledge`
    )
  })

  it('rewrites covered profile colon publish even when id is malformed', () => {
    const malformedId = 'f625d1f1-ea0f-431b-9d0d-11230be9c7f'
    expect(rewriteColonCatalogUrl(`/v1/covered-network-profiles/${malformedId}:publish`)).toBe(
      `/v1/covered-network-profiles/${malformedId}/publish`
    )
  })
})
