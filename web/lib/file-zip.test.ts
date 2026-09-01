import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

const stateKey = Symbol.for('openbooks.file-zip-test')
type BlobRecord = { filename: string; contentType: string; bytes: Buffer; versionId: string }
const state = {
  blobs: new Map<string, BlobRecord | null>(),
  added: [] as { path: string; length: number }[],
}
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = state

const mockSources = new Map<string, string>([
  [
    'mock:db',
    `export const db = { execute: async () => ({ rows: [] }) }`,
  ],
  [
    'mock:file-cabinet',
    `
      const state = globalThis[Symbol.for('openbooks.file-zip-test')]
      export async function getFileBlob(_orgId, id, _viewer) {
        return state.blobs.get(id) ?? null
      }
    `,
  ],
  [
    'mock:jszip',
    `
      const state = globalThis[Symbol.for('openbooks.file-zip-test')]
      class JSZip {
        file(path, bytes) {
          state.added.push({ path, length: bytes.length })
        }
        async generateAsync() { return Buffer.from('zip') }
      }
      export default JSZip
    `,
  ],
])

const hooks = registerHooks({
  resolve(specifier, _context, nextResolve) {
    if (specifier === 'server-only') {
      return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
    }
    if (specifier === '@openbooks/engine/src/db.ts') {
      return { shortCircuit: true, format: 'module', url: 'mock:db' }
    }
    if (specifier === './file-cabinet') {
      return { shortCircuit: true, format: 'module', url: 'mock:file-cabinet' }
    }
    if (specifier === 'jszip') {
      return { shortCircuit: true, format: 'module', url: 'mock:jszip' }
    }
    return nextResolve(specifier, _context)
  },
  load(url, _context, nextLoad) {
    const source = mockSources.get(url)
    if (source !== undefined) return { format: 'module', source, shortCircuit: true }
    return nextLoad(url, _context)
  },
})

const fileZipUrl = './file-zip.ts?file-zip-test'
const { MAX_ZIP_BYTES, ZipSizeLimitError, buildZip } =
  (await import(fileZipUrl)) as typeof import('./file-zip.ts')
hooks.deregister()

const viewer = { userId: 'user-1', isAdmin: false, baseline: 'viewer' as const }

function sizedBytes(length: number): Buffer {
  return { length } as unknown as Buffer
}

function reset(): void {
  state.blobs.clear()
  state.added.length = 0
}

test('buildZip accepts the exact uncompressed source boundary', async () => {
  reset()
  state.blobs.set('at-limit', {
    filename: 'at-limit.bin',
    contentType: 'application/octet-stream',
    bytes: sizedBytes(MAX_ZIP_BYTES),
    versionId: 'v1',
  })

  const result = await buildZip('org-1', viewer, [{ id: 'at-limit', path: 'at-limit.bin' }])

  assert.equal(result.included, 1)
  assert.deepEqual(state.added, [{ path: 'at-limit.bin', length: MAX_ZIP_BYTES }])
})

test('buildZip rejects source bytes above the limit before adding the over-limit entry', async () => {
  reset()
  state.blobs.set('first', {
    filename: 'first.bin',
    contentType: 'application/octet-stream',
    bytes: sizedBytes(MAX_ZIP_BYTES),
    versionId: 'v1',
  })
  state.blobs.set('second', {
    filename: 'second.bin',
    contentType: 'application/octet-stream',
    bytes: sizedBytes(1),
    versionId: 'v2',
  })

  await assert.rejects(
    buildZip('org-1', viewer, [
      { id: 'first', path: 'first.bin' },
      { id: 'second', path: 'second.bin' },
    ]),
    (error: unknown) => error instanceof ZipSizeLimitError && /250 MB/.test(error.message),
  )
  assert.deepEqual(state.added, [{ path: 'first.bin', length: MAX_ZIP_BYTES }])
})

test('buildZip skips unreadable files without charging them to the source limit', async () => {
  reset()
  state.blobs.set('unreadable', null)
  state.blobs.set('readable', {
    filename: 'readable.bin',
    contentType: 'application/octet-stream',
    bytes: sizedBytes(MAX_ZIP_BYTES),
    versionId: 'v1',
  })

  const result = await buildZip('org-1', viewer, [
    { id: 'unreadable', path: 'unreadable.bin' },
    { id: 'readable', path: 'readable.bin' },
  ])

  assert.equal(result.included, 1)
  assert.deepEqual(state.added, [{ path: 'readable.bin', length: MAX_ZIP_BYTES }])
})
