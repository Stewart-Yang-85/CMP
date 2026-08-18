import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('Alert Configurations OpenAPI module', () => {
  it('defines the new Alert Configurations tag and core ABC paths', async () => {
    const yaml = await readFile('iot-cmp-api.yaml', 'utf8')

    expect(yaml).toContain('- name: Alert Configurations')
    expect(yaml).toContain('/alert-types:')
    expect(yaml).toContain('/alert-config-profiles:')
    expect(yaml).toContain('/alert-config-profiles/{profileId}:')
    expect(yaml).toContain('operationId: replaceAlertConfigProfile')
    expect(yaml).toContain('operationId: getEffectiveAlertConfigProfile')
  })

  it('omits legacy single-table alert-configs paths from Swagger', async () => {
    const yaml = await readFile('iot-cmp-api.yaml', 'utf8')

    expect(yaml).not.toContain('/alert-configs:')
    expect(yaml).not.toContain('/alert-configs/{configId}:')
    expect(yaml).not.toContain('/alert-configs/effective:')
  })

  it('omits item-level alert config profile paths from Swagger', async () => {
    const yaml = await readFile('iot-cmp-api.yaml', 'utf8')

    expect(yaml).not.toContain('/alert-config-profiles/{profileId}/items:')
    expect(yaml).not.toContain('/alert-config-profiles/{profileId}/items/{alertType}:')
    expect(yaml).not.toContain('operationId: listAlertConfigItems')
    expect(yaml).not.toContain('operationId: putAlertConfigItem')
    expect(yaml).not.toContain('operationId: patchAlertConfigItem')
  })

  it('uses query scope parameters for full-profile writes', async () => {
    const yaml = await readFile('iot-cmp-api.yaml', 'utf8')
    const requestStart = yaml.indexOf('    AlertConfigProfileRequest:')
    const requestEnd = yaml.indexOf('    EventListItem:', requestStart)
    const requestSchema = requestStart >= 0 && requestEnd > requestStart ? yaml.slice(requestStart, requestEnd) : ''
    const postStart = yaml.indexOf('      operationId: createAlertConfigProfile')
    const postEnd = yaml.indexOf('      requestBody:', postStart)
    const postBlock = postStart >= 0 && postEnd > postStart ? yaml.slice(postStart, postEnd) : ''
    const putStart = yaml.indexOf('      operationId: replaceAlertConfigProfile')
    const putEnd = yaml.indexOf('      requestBody:', putStart)
    const putBlock = putStart >= 0 && putEnd > putStart ? yaml.slice(putStart, putEnd) : ''

    expect(requestSchema).toContain('required: [items]')
    expect(requestSchema).not.toContain('scopeType:')
    expect(requestSchema).not.toContain('resellerId:')
    expect(requestSchema).not.toContain('enterpriseId:')
    expect(postBlock).toContain('name: scopeType')
    expect(postBlock).toContain('enum: [PLATFORM, RESELLER, ENTERPRISE]')
    expect(postBlock).toContain('name: resellerId')
    expect(postBlock).toContain('name: enterpriseId')
    expect(putBlock).toContain('name: scopeType')
    expect(putBlock).toContain('name: resellerId')
    expect(putBlock).toContain('name: enterpriseId')
  })
})
