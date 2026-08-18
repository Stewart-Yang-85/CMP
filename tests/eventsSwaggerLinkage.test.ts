import { describe, expect, it } from 'vitest'
import { buildEventsSwaggerLinkageScript } from '../src/swagger/buildEventsSwaggerLinkageScript.ts'

describe('buildEventsSwaggerLinkageScript', () => {
  it('embeds catalog map and refresh hook for Swagger UI', () => {
    const script = buildEventsSwaggerLinkageScript()
    expect(script).toContain('typesByCategory')
    expect(script).toContain('data-param-name')
    expect(script).toContain('data-cmp-event-type')
    expect(script).toContain('__cmpRefreshEventsSwaggerParams')
    expect(script).toContain("path === '/events'")
  })
})
