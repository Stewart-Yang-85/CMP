/**
 * jobs / audit_logs.actor_user_id is uuid. Platform M2M JWTs may use non-uuid sub (e.g. cmp-admin).
 */

export function isActorUserUuid(value: unknown): boolean {
  const s = String(value ?? '').trim().toLowerCase()
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(s)
}

export function actorUserIdForDb(userId: string | null | undefined): string | null {
  if (userId == null || String(userId).trim() === '') return null
  return isActorUserUuid(userId) ? String(userId).trim().toLowerCase() : null
}
