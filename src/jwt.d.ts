export function signJwtHs256(payload: Record<string, unknown>, secret: string): string
export function verifyJwtHs256(token: string, secret: string): { ok: boolean; payload?: Record<string, unknown>; error?: string }
