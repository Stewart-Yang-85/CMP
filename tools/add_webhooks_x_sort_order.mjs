import fs from 'fs'

const OUTBOUND_PATHS = [
  '/outbound-webhook-events:',
  '/webhook-subscriptions:',
  '/webhook-subscriptions/{webhookId}:',
  '/webhook-subscriptions/{webhookId}:deprecate:',
  '/webhook-subscriptions/{webhookId}/deliveries:',
  '/webhook-deliveries/{deliveryId}/retry:',
]

const INBOUND_PATHS = [
  '/upstream-webhook-events:',
  '/suppliers/{supplierId}/operators/{operatorId}/webhooks/wxzhonggeng/subscription:',
  '/suppliers/{supplierId}/operators/{operatorId}/webhooks/wxzhonggeng/update-location:',
  '/suppliers/{supplierId}/operators/{operatorId}/webhooks/wxzhonggeng/sim-status-changed:',
  '/suppliers/{supplierId}/operators/{operatorId}/webhooks/wxzhonggeng/traffic-alert:',
]

/** Keep in sync with OUTBOUND/INBOUND_SWAGGER_OPERATIONS_ORDER in src/app.ts */
const outboundAssignments = [
  { path: '/outbound-webhook-events:', method: 'get', order: 1 },
  { path: '/webhook-subscriptions:', method: 'post', order: 2 },
  { path: '/webhook-subscriptions:', method: 'get', order: 3 },
  { path: '/webhook-subscriptions/{webhookId}:', method: 'get', order: 4 },
  { path: '/webhook-subscriptions/{webhookId}:', method: 'patch', order: 5 },
  { path: '/webhook-subscriptions/{webhookId}:deprecate:', method: 'post', order: 6 },
  { path: '/webhook-subscriptions/{webhookId}/deliveries:', method: 'get', order: 7 },
  { path: '/webhook-deliveries/{deliveryId}/retry:', method: 'post', order: 8 },
]

const inboundAssignments = [
  { path: '/upstream-webhook-events:', method: 'get', order: 1 },
  {
    path: '/suppliers/{supplierId}/operators/{operatorId}/webhooks/wxzhonggeng/subscription:',
    method: 'post',
    order: 2,
  },
  {
    path: '/suppliers/{supplierId}/operators/{operatorId}/webhooks/wxzhonggeng/update-location:',
    method: 'post',
    order: 3,
  },
  {
    path: '/suppliers/{supplierId}/operators/{operatorId}/webhooks/wxzhonggeng/sim-status-changed:',
    method: 'post',
    order: 4,
  },
  {
    path: '/suppliers/{supplierId}/operators/{operatorId}/webhooks/wxzhonggeng/traffic-alert:',
    method: 'post',
    order: 5,
  },
]

const OUTBOUND_PATH_BLOCK = `  /outbound-webhook-events:
    get:
      x-sort-order: 1
      tags: [Outbound Webhooks]
      operationId: listOutboundWebhookEvents
      summary: List outbound webhook event types
      description: |
        Platform catalog of event types that may be used in \`webhook-subscriptions.eventTypes\`
        for CMP → customer outbound delivery (**FR-039**). Distinct from inbound supplier callbacks
        (\`GET /upstream-webhook-events\`).
      security:
        - BearerAuth: []
        - ApiKeyAuth: []
      responses:
        '200':
          description: Outbound webhook event catalog
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/OutboundWebhookEventsResponse'
        '401':
          $ref: '#/components/responses/Unauthorized'
        '403':
          $ref: '#/components/responses/Forbidden'
`

function retagPathBlock(text, pathKey, tagName) {
  const needle = `  ${pathKey}\n`
  const pathIdx = text.indexOf(needle)
  if (pathIdx < 0) throw new Error(`path not found: ${pathKey}`)
  const nextPath = text.indexOf('\n  /', pathIdx + needle.length)
  const end = nextPath < 0 ? text.length : nextPath + 1
  const before = text.slice(0, pathIdx)
  let block = text.slice(pathIdx, end)
  block = block
    .replace(/tags: \[Webhooks\]/g, `tags: [${tagName}]`)
    .replace(/tags: \[Integration\]/g, `tags: [${tagName}]`)
    .replace(/tags: \[Outbound Webhooks\]/g, `tags: [${tagName}]`)
    .replace(/tags: \[Inbound Webhooks\]/g, `tags: [${tagName}]`)
  return before + block + text.slice(end)
}

function setSortOrders(text, assignments) {
  for (const { path: pathKey, method, order } of assignments) {
    const pathIdx = text.indexOf(`  ${pathKey}\n`)
    if (pathIdx < 0) throw new Error(`path not found for sort: ${pathKey}`)
    const nextPath = text.indexOf('\n  /', pathIdx + 1)
    const pathEnd = nextPath < 0 ? text.length : nextPath
    const methodNeedle = `\n    ${method}:\n`
    const methodIdx = text.indexOf(methodNeedle, pathIdx)
    if (methodIdx < 0 || methodIdx > pathEnd) {
      throw new Error(`${method} not found under ${pathKey}`)
    }
    const insertAt = methodIdx + methodNeedle.length
    const sortLine = `      x-sort-order: ${order}\n`
    if (text.slice(insertAt, insertAt + 20).startsWith('      x-sort-order:')) {
      text = text.slice(0, insertAt) + sortLine + text.slice(insertAt).replace(/^      x-sort-order: [\d.]+\n/, '')
    } else {
      text = text.slice(0, insertAt) + sortLine + text.slice(insertAt)
    }
    // Drop leftover x-sort-order deeper in the operation
    const rest = text.slice(insertAt + sortLine.length)
    const nextBoundary = rest.search(/\n    [a-z]+:\n|\n  \//)
    if (nextBoundary > 0) {
      const cleaned = rest.slice(0, nextBoundary).replace(/\n      x-sort-order: [\d.]+\n/g, '\n')
      text = text.slice(0, insertAt + sortLine.length) + cleaned + rest.slice(nextBoundary)
    }
  }
  return text
}

function patchFile(file) {
  let text = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n')

  // Ensure split tags exist (idempotent-ish)
  if (!text.includes('  - name: Outbound Webhooks\n')) {
    text = text.replace(
      /  - name: Webhooks\n    description: [^\n]+\n/,
      '  - name: Outbound Webhooks\n    description: CMP → customer outbound webhook event catalog, subscriptions, and deliveries (FR-039)\n  - name: Inbound Webhooks\n    description: Supplier → CMP inbound webhook event catalog and WXZHONGGENG callback endpoints (FR-067+)\n'
    )
  }

  if (!text.includes('  /outbound-webhook-events:\n')) {
    const anchor = '  /webhook-subscriptions:\n'
    const idx = text.indexOf(anchor)
    if (idx < 0) throw new Error(`${file}: /webhook-subscriptions not found`)
    text = text.slice(0, idx) + OUTBOUND_PATH_BLOCK + text.slice(idx)
  }

  if (!text.includes('OutboundWebhookEventsResponse:')) {
    throw new Error(`${file}: OutboundWebhookEventsResponse schema missing — add it first`)
  }

  for (const p of OUTBOUND_PATHS) text = retagPathBlock(text, p, 'Outbound Webhooks')
  for (const p of INBOUND_PATHS) text = retagPathBlock(text, p, 'Inbound Webhooks')

  text = setSortOrders(text, outboundAssignments)
  text = setSortOrders(text, inboundAssignments)

  fs.writeFileSync(file, text)
  console.log(`Patched webhook tags/order in ${file}`)
}

for (const file of ['iot-cmp-api.yaml', 'packages/openapi/openapi.yaml']) {
  patchFile(file)
}
