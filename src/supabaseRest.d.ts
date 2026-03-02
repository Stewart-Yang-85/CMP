export function createSupabaseRestClient(options?: {
  useServiceRole?: boolean
  traceId?: string | null
}): {
  select: (table: string, queryString: string, options?: { headers?: Record<string, string>; suppressMissingColumns?: boolean }) => Promise<unknown>
  selectWithCount: (table: string, queryString: string) => Promise<{ data: unknown; total: number | null }>
  insert: (table: string, rows: unknown, options?: { returning?: 'minimal' | 'representation'; suppressMissingColumns?: boolean }) => Promise<unknown>
  update: (table: string, matchQueryString: string, patch: unknown, options?: { returning?: 'minimal' | 'representation'; suppressMissingColumns?: boolean }) => Promise<unknown>
  delete: (table: string, matchQueryString: string) => Promise<unknown>
  rpc: (functionName: string, args?: unknown) => Promise<unknown>
}
