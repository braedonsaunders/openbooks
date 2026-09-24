import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveImportCommitIdentity, type ImportCommitInput } from './commit-identity'

class MemoryStorage {
  private readonly values = new Map<string, string>()

  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value)
  }

  removeItem(key: string): void {
    this.values.delete(key)
  }
}

const input: ImportCommitInput = {
  resource: 'customers',
  format: 'csv',
  rows: [{ name: 'Acme', externalId: 'A-1' }],
  mapping: { Customer: 'name', 'External ID': 'externalId' },
  importMode: 'upsert',
  fileName: 'customers.csv',
  post: false,
}

test('an unchanged commit payload keeps its idempotency key across retries and reloads', async () => {
  const storage = new MemoryStorage()
  const makeKey = (() => {
    let next = 0
    return () => `stable-import-key-${++next}`
  })()

  const first = await resolveImportCommitIdentity(input, null, storage, makeKey)
  const retry = await resolveImportCommitIdentity(input, first, storage, makeKey)
  const afterReload = await resolveImportCommitIdentity(input, null, storage, makeKey)

  assert.equal(retry.key, first.key)
  assert.equal(afterReload.key, first.key)
})

test('changing a commit input gets a new key while preserving the old payload identity', async () => {
  const storage = new MemoryStorage()
  const makeKey = (() => {
    let next = 0
    return () => `stable-import-key-${++next}`
  })()

  const first = await resolveImportCommitIdentity(input, null, storage, makeKey)
  const changed = await resolveImportCommitIdentity(
    { ...input, mapping: { Customer: 'displayName', 'External ID': 'externalId' } },
    first,
    storage,
    makeKey,
  )
  const oldPayloadRetry = await resolveImportCommitIdentity(input, null, storage, makeKey)

  assert.notEqual(changed.key, first.key)
  assert.equal(oldPayloadRetry.key, first.key)
})
