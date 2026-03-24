import { describe, expect, it } from 'vitest'

// Phase 22: Bill Write-Off Tests (T121)
// Structural tests verifying write-off route, permission, and status machine support

describe('Phase 22: Bill Write-Off', () => {
  it('T118: POST /bills/:billId:write-off route exists in app.js', async () => {
    const fs = await import('node:fs/promises')
    const content = await fs.readFile('src/app.js', 'utf-8')
    expect(content).toContain("app.post(`${prefix}/bills/:billId\\\\:write-off`")
    expect(content).toContain("action: 'write_off'")
    expect(content).toContain('reason is required for write-off')
  })

  it('T118: billStatusMachine supports OVERDUE -> write_off -> WRITTEN_OFF transition', async () => {
    const fs = await import('node:fs/promises')
    const content = await fs.readFile('src/services/billStatusMachine.js', 'utf-8')
    expect(content).toContain("write_off: 'WRITTEN_OFF'")
  })

  it('T118: billStatusMachine emits BILL_WRITTEN_OFF event', async () => {
    const fs = await import('node:fs/promises')
    const content = await fs.readFile('src/services/billStatusMachine.js', 'utf-8')
    expect(content).toContain("eventType: 'BILL_WRITTEN_OFF'")
    expect(content).toContain("nextStatus === 'WRITTEN_OFF'")
  })

  it('T119: bills.write_off permission is in reseller default permissions', async () => {
    const fs = await import('node:fs/promises')
    const content = await fs.readFile('src/app.js', 'utf-8')
    expect(content).toContain("'bills.write_off'")
    // Check it appears in the reseller section of defaultPermissionsByRoleScope
    const resellerSection = content.slice(
      content.indexOf('reseller: ['),
      content.indexOf('],', content.indexOf('reseller: [')) + 2
    )
    expect(resellerSection).toContain('bills.write_off')
  })

  it('T119: permission resolver maps write-off route to bills.write_off', async () => {
    const fs = await import('node:fs/promises')
    const content = await fs.readFile('src/app.js', 'utf-8')
    expect(content).toContain("if (/\\/bills\\/[^/]+:write-off$/.test(path)) return 'bills.write_off'")
  })

  it('T118: write-off route has rate limiter', async () => {
    const fs = await import('node:fs/promises')
    const content = await fs.readFile('src/app.js', 'utf-8')
    expect(content).toContain("app.use('/v1/bills/:billId\\\\:write-off', writeLimiter)")
    expect(content).toContain("app.use('/bills/:billId\\\\:write-off', writeLimiter)")
  })

  it('T120: route file contains OpenAPI update note', async () => {
    const fs = await import('node:fs/promises')
    const content = await fs.readFile('src/app.js', 'utf-8')
    // Check for the OpenAPI TODO comment near the write-off route
    expect(content).toContain('T120')
  })
})
