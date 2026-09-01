import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

const stateKey = Symbol.for('openbooks.folder-download-zip-route-test')
const state = {
  mode: 'ok' as 'ok' | 'limit',
  entries: [{ id: 'file-1', path: 'Folder/file-1.bin' }],
  manifestCalls: 0,
  buildCalls: 0,
}
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = state

const mockSources = new Map<string, string>([
  [
    'mock:auth-lib',
    `
      export async function requireSession() {
        return { user: { orgId: 'org-1', id: 'user-1' } }
      }
      export async function requireFolderAccess() { return null }
      export function fileViewer() { return { userId: 'user-1', isAdmin: false, baseline: 'viewer' } }
    `,
  ],
  [
    'mock:cabinet',
    `export async function getFolder() { return { name: 'Folder' } }`,
  ],
  [
    'mock:list-params',
    `export function isUuid() { return true }`,
  ],
  [
    'mock:business-date',
    `export async function businessToday() { return '2026-08-31' }`,
  ],
  [
    'mock:file-zip',
    `
      const state = globalThis[Symbol.for('openbooks.folder-download-zip-route-test')]
      export const MAX_ZIP_FILES = 300
      export class ZipSizeLimitError extends Error {
        constructor() {
          super('zip source exceeds 250 MB limit')
          this.name = 'ZipSizeLimitError'
        }
      }
      export async function folderZipManifest() {
        state.manifestCalls += 1
        return state.entries
      }
      export async function buildZip(_orgId, _viewer, entries) {
        state.buildCalls += 1
        if (state.mode === 'limit') throw new ZipSizeLimitError()
        return { bytes: Buffer.from('zip'), included: entries.length }
      }
    `,
  ],
])

const hooks = registerHooks({
  resolve(specifier, _context, nextResolve) {
    if (specifier === 'server-only') {
      return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
    }
    const mocked = new Map<string, string>([
      ['../../../lib', 'mock:auth-lib'],
      ['../../../../../../lib/file-cabinet', 'mock:cabinet'],
      ['../../../../../../lib/file-zip', 'mock:file-zip'],
      ['../../../../../../lib/list-params', 'mock:list-params'],
      ['@openbooks/engine/src/business-date.ts', 'mock:business-date'],
    ]).get(specifier)
    if (mocked) return { shortCircuit: true, format: 'module', url: mocked }
    return nextResolve(specifier, _context)
  },
  load(url, _context, nextLoad) {
    const source = mockSources.get(url)
    if (source !== undefined) return { format: 'module', source, shortCircuit: true }
    return nextLoad(url, _context)
  },
})

const routeUrl = './route.ts?folder-download-zip-route-test'
const { GET } = (await import(routeUrl)) as typeof import('./route.ts')
hooks.deregister()

function reset(): void {
  state.mode = 'ok'
  state.entries = [{ id: 'file-1', path: 'Folder/file-1.bin' }]
  state.manifestCalls = 0
  state.buildCalls = 0
}

function get(): Promise<Response> {
  return GET(new Request('http://openbooks.test/api/file-cabinet/folders/folder-1/download-zip'), {
    params: Promise.resolve({ id: 'folder-1' }),
  })
}

test('folder ZIP maps the ZIP source limit to HTTP 413', async () => {
  reset()
  state.mode = 'limit'

  const response = await get()

  assert.equal(response.status, 413)
  assert.deepEqual(await response.json(), { error: 'zip source exceeds 250 MB limit' })
  assert.equal(state.manifestCalls, 1)
  assert.equal(state.buildCalls, 1)
})

test('folder ZIP permits a boundary-sized archive returned by buildZip', async () => {
  reset()

  const response = await get()

  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'application/zip')
  assert.equal(response.headers.get('content-disposition'), 'attachment; filename="Folder-2026-08-31.zip"')
})

test('folder ZIP keeps the MAX_ZIP_FILES guard before blob work', async () => {
  reset()
  state.entries = Array.from({ length: 301 }, (_, index) => ({ id: `file-${index}`, path: `Folder/file-${index}.bin` }))

  const response = await get()

  assert.equal(response.status, 413)
  assert.match((await response.json()).error, /too many files/)
  assert.equal(state.buildCalls, 0)
})

test('folder ZIP retains its empty-folder 404 response', async () => {
  reset()
  state.entries = []

  const response = await get()

  assert.equal(response.status, 404)
  assert.deepEqual(await response.json(), { error: 'folder is empty' })
  assert.equal(state.buildCalls, 0)
})
