export interface ImportCommitInput {
  resource: string
  format: 'csv' | 'xlsx' | 'json'
  rows: Record<string, unknown>[]
  mapping: Record<string, string>
  importMode: 'insert' | 'upsert'
  fileName: string
  post: boolean
}

export interface ImportCommitIdentity {
  fingerprint: string
  key: string
}

type ImportIdentityStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

export class ImportIdentityPersistenceError extends Error {
  constructor() {
    super('Import retry information could not be saved; no import request was sent')
    this.name = 'ImportIdentityPersistenceError'
  }
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(
        ([key, nested]) => [key, canonicalize(nested)],
      ),
    )
  }
  return value
}

async function fingerprint(input: ImportCommitInput): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(canonicalize(input)))
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

function storageKey(value: string): string {
  return `openbooks:data-import:idempotency:${value}`
}

export async function resolveImportCommitIdentity(
  input: ImportCommitInput,
  previous: ImportCommitIdentity | null,
  storage: ImportIdentityStorage | null,
  createKey: () => string,
): Promise<ImportCommitIdentity> {
  const digest = await fingerprint(input)
  if (!storage) throw new ImportIdentityPersistenceError()
  let stored: string | null
  try {
    stored = storage.getItem(storageKey(digest))
  } catch {
    throw new ImportIdentityPersistenceError()
  }
  const key = previous?.fingerprint === digest ? previous.key : stored ?? createKey()
  try {
    storage.setItem(storageKey(digest), key)
    if (storage.getItem(storageKey(digest)) !== key) throw new Error('session storage did not retain the import key')
  } catch {
    throw new ImportIdentityPersistenceError()
  }
  return { fingerprint: digest, key }
}

export function forgetImportCommitIdentity(
  identity: ImportCommitIdentity,
  storage: ImportIdentityStorage | null,
): void {
  try {
    storage?.removeItem(storageKey(identity.fingerprint))
  } catch {
    // A later import with these exact inputs will replay the safe saved result.
  }
}
