import { randomUUID } from 'node:crypto'

export type DbSnapshot = {
  id: string
}

export async function createSnapshot(): Promise<DbSnapshot> {
  return { id: randomUUID() }
}

export async function restoreSnapshot(snapshot: DbSnapshot): Promise<void> {
  void snapshot
}
