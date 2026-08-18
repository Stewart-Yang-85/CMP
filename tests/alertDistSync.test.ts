import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import * as alerting from '../src/services/alerting.js'

describe('alerting worker dist sync', () => {
  it('exports runAlertEvaluation from the worker alerting module', () => {
    expect(typeof alerting.runAlertEvaluation).toBe('function')
  })

  it('sync_dist_assets copies hand-written alerting.js into dist', async () => {
    const script = await readFile('tools/sync_dist_assets.mjs', 'utf8')
    expect(script).toContain("'services/alerting.js'")
    expect(script).toContain("'services/alertDelivery.js'")
  })
})
