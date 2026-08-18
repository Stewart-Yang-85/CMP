import { describe, expect, it } from 'vitest'
import { actorUserIdForDb, isActorUserUuid } from '../src/utils/actorUserId.ts'

describe('actorUserIdForDb', () => {
  it('accepts lowercase uuid', () => {
    const id = '0925eb82-53ef-4522-8d81-07ebaa17d819'
    expect(actorUserIdForDb(id)).toBe(id)
    expect(isActorUserUuid(id)).toBe(true)
  })

  it('returns null for platform M2M sub', () => {
    expect(actorUserIdForDb('cmp-admin')).toBeNull()
    expect(actorUserIdForDb('user-1')).toBeNull()
  })

  it('returns null for empty', () => {
    expect(actorUserIdForDb(null)).toBeNull()
    expect(actorUserIdForDb('')).toBeNull()
  })
})
