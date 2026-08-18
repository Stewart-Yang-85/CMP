/**
 * Normalize OpenAPI-style paths like `/v1/apn-profiles/{uuid}:publish` to `/v1/apn-profiles/{uuid}/publish`
 * so Express/Fastify routers can match a single `/:id/publish` registration.
 * @param {string} raw `req.url` (path + optional `?query`)
 */
export function rewriteColonCatalogUrl(raw) {
  const url = typeof raw === 'string' ? raw : '/'
  const qIdx = url.indexOf('?')
  const pathOnly = qIdx === -1 ? url : url.slice(0, qIdx)
  const query = qIdx === -1 ? '' : url.slice(qIdx)

  const U = '[^/:?]+'
  const ICCID = '[0-9]{18,20}'
  const patterns = [
    new RegExp(`^(/v1/bills/${U}):(publish|mark-paid|write-off|adjust|void)$`, 'i'),
    new RegExp(`^(/bills/${U}):(publish|mark-paid|write-off|adjust|void)$`, 'i'),
    new RegExp(`^(/v1/adjustment-notes/${U}):(approve)$`, 'i'),
    new RegExp(`^(/adjustment-notes/${U}):(approve)$`, 'i'),
    new RegExp(`^(/v1/alerts/${U}):(acknowledge)$`, 'i'),
    new RegExp('^(/v1/bills):(csv)$', 'i'),
    new RegExp('^(/bills):(csv)$', 'i'),
    new RegExp(`^(/v1/bills/${U}):(csv)$`, 'i'),
    new RegExp(`^(/bills/${U}):(csv)$`, 'i'),
    new RegExp(`^(/v1/bills/${U}/line-items):(csv)$`, 'i'),
    new RegExp(`^(/bills/${U}/line-items):(csv)$`, 'i'),
    new RegExp('^(/v1/roaming-profiles):(import-csv)$', 'i'),
    new RegExp(`^(/v1/sims/${ICCID}):(activate|deactivate|reactivate|retire|mark-test-ready)$`, 'i'),
    new RegExp(`^(/v1/sims/${U}):(activate|deactivate|reactivate|retire|mark-test-ready)$`, 'i'),
    new RegExp(`^(/v1/apn-profiles/${U}):(publish|clone|deprecate)$`, 'i'),
    new RegExp(`^(/v1/roaming-profiles/${U}):(publish|clone|deprecate|export-csv)$`, 'i'),
    new RegExp(`^(/v1/covered-network-profiles/${U}):(publish|deprecate)$`, 'i'),
    new RegExp(`^(/v1/commercial-terms/${U}):(publish|clone|deprecate)$`, 'i'),
    new RegExp(`^(/v1/control-policies/${U}):(publish|clone|deprecate)$`, 'i'),
    new RegExp(`^(/v1/carrier-services/${U}):(publish|deprecate)$`, 'i'),
    new RegExp(`^(/v1/price-plans/${U}):(publish|deprecate)$`, 'i'),
    new RegExp(`^(/v1/packages/${U}):(publish|deprecate)$`, 'i'),
    new RegExp(`^(/v1/webhook-subscriptions/${U}):(deprecate)$`, 'i'),
    new RegExp(`^(/webhook-subscriptions/${U}):(deprecate)$`, 'i'),
    new RegExp('^(/v1/rating-fallback-packages):(set-default|unset-default)$', 'i'),
    new RegExp(`^(/v1/profile-versions/${U}):(rollback)$`, 'i'),
    new RegExp(`^(/v1/subscriptions/${U}):(cancel)$`, 'i'),
    new RegExp(`^(/v1/sims/${ICCID}):(cancel-location)$`, 'i'),
    new RegExp(`^(/sims/${ICCID}):(cancel-location)$`, 'i'),
    // Admin helper: OpenAPI colon action → slash segment (find-my-way cannot safely parse :iccid::action).
    new RegExp(`^(/v1/admin/sims/${ICCID}):(backdate-test-start)$`, 'i'),
    new RegExp(`^(/admin/sims/${ICCID}):(backdate-test-start)$`, 'i'),
    new RegExp(`^(/v1/admin/sims/${U}):(backdate-test-start)$`, 'i'),
    new RegExp(`^(/admin/sims/${U}):(backdate-test-start)$`, 'i'),
  ]
  for (const re of patterns) {
    const m = re.exec(pathOnly)
    if (m) {
      if (m[2]) {
        const action = m[2].toLowerCase()
        if (action === 'import-csv') return `${m[1]}/import-csv${query}`
        if (action === 'csv') return `${m[1]}/csv${query}`
        return `${m[1]}/${action}${query}`
      }
    }
  }
  return url
}
