import { describe, expect, it } from 'vitest'

// Phase 21: SIM/eSIM Remark Field Tests (T117)
// Structural tests verifying migration and route support for remark field

describe('Phase 21: SIM Remark Field', () => {
  it('T111: migration file exists and adds remark column to sims table', async () => {
    const fs = await import('node:fs/promises')
    const content = await fs.readFile(
      'supabase/migrations/20260324100006_sim_remark.sql',
      'utf-8'
    )
    expect(content).toContain('ALTER TABLE sims ADD COLUMN IF NOT EXISTS remark TEXT')
    expect(content).toContain('BEGIN')
    expect(content).toContain('COMMIT')
  })

  it('T113: simPhase4 routes contain PATCH handler supporting remark updates', async () => {
    const fs = await import('node:fs/promises')
    const content = await fs.readFile('src/routes/simPhase4.js', 'utf-8')
    expect(content).toContain("app.patch(`${prefix}/sims/:simId`")
    expect(content).toContain("'remark'")
    expect(content).toContain('patch.remark')
  })

  it('T115: GET /sims and GET /sims/:simId include remark in response', async () => {
    const fs = await import('node:fs/promises')
    const content = await fs.readFile('src/routes/simPhase4.ts', 'utf-8')
    expect(content).toContain("'remark'")
    expect(content).toMatch(/remark:\s*r\.remark\s*\?\?\s*null/)
    expect(content).toMatch(/remark:\s*sim\.remark\s*\?\?\s*null/)
    expect(content).toMatch(/remark:\s*\(r\.remark as string \| null \| undefined\)\s*\?\?\s*null/)
  })

  it('T115: CSV export includes remark header', async () => {
    const fs = await import('node:fs/promises')
    const content = await fs.readFile('src/routes/simPhase4.ts', 'utf-8')
    expect(content).toContain("'remark'")
    expect(content).toContain("escapeCsv(r.remark ?? '')")
    expect(content).toContain("escapeCsv((r.remark as string | null | undefined) ?? '')")
  })

  it('T116: route file contains OpenAPI update note', async () => {
    const fs = await import('node:fs/promises')
    const content = await fs.readFile('src/routes/simPhase4.js', 'utf-8')
    expect(content).toContain('OpenAPI')
  })
})

describe('Phase 21b: eSIM Profile & SM-DP+ System routes', () => {
  it('T170: eSIM Profile CRUD routes exist', async () => {
    const fs = await import('node:fs/promises')
    const content = await fs.readFile('src/routes/esimProfiles.js', 'utf-8')
    expect(content).toContain("app.post(`${prefix}/esim-profiles`")
    expect(content).toContain("app.get(`${prefix}/esim-profiles`")
  })

  it('T171: eSIM status change routes exist (activate/deactivate/retire)', async () => {
    const fs = await import('node:fs/promises')
    const content = await fs.readFile('src/routes/esimProfiles.js', 'utf-8')
    expect(content).toContain("'activate'")
    expect(content).toContain("'deactivate'")
    expect(content).toContain("'retire'")
    expect(content).toContain('esim-profiles/:profileId')
  })

  it('T172: SM-DP+ system CRUD routes exist', async () => {
    const fs = await import('node:fs/promises')
    const content = await fs.readFile('src/routes/esimProfiles.js', 'utf-8')
    expect(content).toContain("app.post(`${prefix}/smdp-systems`")
    expect(content).toContain("app.get(`${prefix}/smdp-systems`")
    expect(content).toContain("app.patch(`${prefix}/smdp-systems/:smdpSystemId`")
  })

  it('T173: eSIM state history migration exists', async () => {
    const fs = await import('node:fs/promises')
    const content = await fs.readFile(
      'supabase/migrations/20260324100007_esim_profiles_smdp.sql',
      'utf-8'
    )
    expect(content).toContain('esim_state_history')
    expect(content).toContain('esim_profiles')
    expect(content).toContain('smdp_systems')
    expect(content).toContain('esim_profile_status')
    expect(content).toContain('BEGIN')
    expect(content).toContain('COMMIT')
  })

  it('T173: eSIM state history records before/after status', async () => {
    const fs = await import('node:fs/promises')
    const content = await fs.readFile(
      'supabase/migrations/20260324100007_esim_profiles_smdp.sql',
      'utf-8'
    )
    expect(content).toContain('before_status')
    expect(content).toContain('after_status')
    expect(content).toContain('profile_id')
  })
})
