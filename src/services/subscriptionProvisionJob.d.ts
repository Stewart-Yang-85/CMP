export const SUBSCRIPTION_PROVISION_JOB_TYPE: 'SUBSCRIPTION_PROVISION'

export function enqueueSubscriptionProvisionJob(args: {
  supabase: {
    insert: (
      table: string,
      rows: unknown,
      options?: { returning?: 'minimal' | 'representation'; suppressMissingColumns?: boolean }
    ) => Promise<unknown>
  }
  subscriptionId: string
  enterpriseId: string
  iccid: string
  packageId: string
  externalProductId: string
  effectiveAt: string
  beforeState: string
  audit?: {
    actorUserId?: string | null
    requestId?: string | null
  }
  idempotencyKey?: string | null
}): Promise<string | null>

export function processSubscriptionProvisionJob(args: {
  supabase: {
    select: (table: string, queryString: string) => Promise<unknown>
    update: (
      table: string,
      matchQueryString: string,
      patch: unknown,
      options?: { returning?: 'minimal' | 'representation' }
    ) => Promise<unknown>
    delete: (table: string, matchQueryString: string) => Promise<unknown>
    insert: (
      table: string,
      rows: unknown,
      options?: { returning?: 'minimal' | 'representation' }
    ) => Promise<unknown>
  }
  job: Record<string, unknown>
  emitEvent?: (input: Record<string, unknown>) => Promise<unknown>
}): Promise<{ pending?: boolean; failed?: boolean; ok?: boolean; errorSummary?: string; errorCode?: string }>
