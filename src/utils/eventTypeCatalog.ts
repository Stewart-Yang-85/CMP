/** Query-layer grouping for GET /v1/events; maps to existing events.event_type values (no DB column). */

export const EVENT_CATEGORY_IDS = ['webhook', 'billing', 'sim', 'inbound', 'subscription'] as const

export type EventCategoryId = (typeof EVENT_CATEGORY_IDS)[number]

export type EventCategoryDefinition = {
  id: EventCategoryId
  label: string
  description: string
  eventTypes: readonly string[]
}

export const EVENT_TYPE_CATALOG: readonly EventCategoryDefinition[] = [
  {
    id: 'webhook',
    label: 'Outbound Webhook',
    description: 'FR-039 integration events deliverable via webhook_subscriptions.',
    eventTypes: [
      'SIM_STATUS_CHANGED',
      'JOB_FINISHED',
      'SUBSCRIPTION_CHANGED',
      'BILL_PUBLISHED',
      'PAYMENT_CONFIRMED',
      'ALERT_TRIGGERED',
      'ENTERPRISE_STATUS_CHANGED',
    ],
  },
  {
    id: 'billing',
    label: 'Billing & adjustments',
    description: 'Bill lifecycle and adjustment-note events (not all webhook-deliverable).',
    eventTypes: [
      'BILL_PUBLISHED',
      'PAYMENT_CONFIRMED',
      'BILL_WRITTEN_OFF',
      'BILL_VOIDED',
      'BILL_ADJUSTMENT_NOTE_CREATED',
      'BILL_ADJUSTMENT_NOTE_APPROVED',
      'BILL_ADJUSTMENT_NOTE_APPLIED',
      'BILL_ADJUSTMENT_ICCID_WARNING',
    ],
  },
  {
    id: 'sim',
    label: 'SIM batch & assignment',
    description: 'Bulk SIM status change and inventory/department assignment jobs.',
    eventTypes: [
      'SIM_BATCH_STATUS_CHANGE',
      'SIM_BATCH_STATUS_CHANGE_RESULT',
      'SIM_ASSIGN_INVENTORY',
      'SIM_ASSIGN_INVENTORY_RESULT',
      'SIM_ASSIGN_DEPARTMENT',
      'SIM_ASSIGN_DEPARTMENT_RESULT',
    ],
  },
  {
    id: 'inbound',
    label: 'Inbound webhooks',
    description: 'Platform-level events from any upstream adapter inbound webhook (vendor messageType stays in payload).',
    eventTypes: [
      'UPDATE_LOCATION',
      'INBOUND_SIM_STATUS_CHANGED',
      'TRAFFIC_ALERT',
      'SUBSCRIPTION',
    ],
  },
  {
    id: 'subscription',
    label: 'Subscription provisioning',
    description: 'Upstream provision failure paths (distinct from SUBSCRIPTION_CHANGED).',
    eventTypes: ['SUBSCRIPTION_PROVISION_FAILED'],
  },
] as const

const categoryById = new Map<EventCategoryId, EventCategoryDefinition>(
  EVENT_TYPE_CATALOG.map((entry) => [entry.id, entry]),
)

export function listAllEventTypes(): string[] {
  const set = new Set<string>()
  for (const entry of EVENT_TYPE_CATALOG) {
    for (const eventType of entry.eventTypes) set.add(eventType)
  }
  return [...set].sort()
}

export function buildEventTypeCatalogMap(): Record<EventCategoryId, string[]> {
  return Object.fromEntries(
    EVENT_TYPE_CATALOG.map((entry) => [entry.id, [...entry.eventTypes]]),
  ) as Record<EventCategoryId, string[]>
}

export function listEventCategoryCatalog() {
  return EVENT_TYPE_CATALOG.map((entry) => ({
    id: entry.id,
    label: entry.label,
    description: entry.description,
    eventTypes: [...entry.eventTypes],
  }))
}

export function normalizeEventCategoryId(value: unknown): EventCategoryId | null {
  const raw = String(value ?? '').trim().toLowerCase()
  if (!raw) return null
  const normalized = raw === 'upstream' ? 'inbound' : raw
  return categoryById.has(normalized as EventCategoryId) ? (normalized as EventCategoryId) : null
}

export function normalizeEventTypeValue(value: unknown): string | null {
  const raw = String(value ?? '').trim().toUpperCase()
  return raw || null
}

export function getEventTypesForCategory(categoryId: EventCategoryId): readonly string[] {
  return categoryById.get(categoryId)?.eventTypes ?? []
}

export function buildEventTypeFilterClause(eventTypes: readonly string[]): string | null {
  if (!eventTypes.length) return null
  if (eventTypes.length === 1) {
    return `event_type=eq.${encodeURIComponent(eventTypes[0])}`
  }
  return `event_type=in.(${eventTypes.map((t) => encodeURIComponent(t)).join(',')})`
}

export type ResolveEventTypeFilterResult =
  | { ok: true; filter: string | null }
  | { ok: false; message: string }

export function resolveEventTypeFilter(input: {
  eventCategory?: unknown
  eventType?: unknown
}): ResolveEventTypeFilterResult {
  const categoryRaw = input.eventCategory != null ? String(input.eventCategory).trim() : ''
  const eventType = normalizeEventTypeValue(input.eventType)

  if (categoryRaw) {
    const categoryId = normalizeEventCategoryId(categoryRaw)
    if (!categoryId) {
      return {
        ok: false,
        message: `eventCategory must be one of: ${EVENT_CATEGORY_IDS.join(', ')}.`,
      }
    }
    const categoryTypes = getEventTypesForCategory(categoryId)
    if (eventType) {
      if (!categoryTypes.includes(eventType)) {
        return {
          ok: false,
          message: `eventType ${eventType} is not in eventCategory ${categoryId}.`,
        }
      }
      return { ok: true, filter: buildEventTypeFilterClause([eventType]) }
    }
    return { ok: true, filter: buildEventTypeFilterClause(categoryTypes) }
  }

  if (eventType) {
    return { ok: true, filter: buildEventTypeFilterClause([eventType]) }
  }

  return { ok: true, filter: null }
}
