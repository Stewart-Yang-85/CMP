declare module '../supabaseRest.js' {
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
}

declare module '../password.js' {
  export function hashSecretScrypt(secret: string): string
  export function verifySecretScrypt(secret: string, stored: string): boolean
}

declare module './jwt.js' {
  export function signJwtHs256(payload: Record<string, unknown>, secret: string): string
  export function verifyJwtHs256(token: string, secret: string): { ok: boolean; payload?: Record<string, unknown>; error?: string }
}

declare module '../services/simImport.js' {
  export function runSimImport(input: Record<string, unknown>): Promise<Record<string, unknown>>
}

declare module '../services/simLifecycle.js' {
  export function changeSimStatus(input: Record<string, unknown>): Promise<Record<string, unknown>>
  export function parseSimIdentifier(value: unknown): { ok: boolean; status?: number; code?: string; message?: string; field?: string; value?: string }
}

declare module '../vendors/wxzhonggeng.js' {
  export function createWxzhonggengAdapter(): any
  export function createWxzhonggengClient(): any
}

declare module './wxzhonggeng.js' {
  export function createWxzhonggengAdapter(): any
  export function createWxzhonggengClient(): any
}

declare module './vendors/wxzhonggeng.js' {
  export function createWxzhonggengAdapter(): any
  export function createWxzhonggengClient(): any
}
