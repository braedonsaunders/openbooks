import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

const stateKey = Symbol.for('openbooks.bulk-download-route-test')
const state = {
  mode: 'ok' as 'ok' | 'limit',
  entries: [{ id: 'file-1', path: 'file-1.bin' }],
  manifestCalls: 0,
  buildCalls: 0,
}
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = state

const mockSources = new Map<string, string>([
  [
    'mock:json',
    `
      export const jsonObject = {}
      export async function parseJsonBody(request) {
        const body = await request.json().catch(() => null)
        return { ok: true, data: body }
      }
    `,
  ],
  [
    'mock:authz',
    `
      export async function guardPermission() {
        return { user: { orgId: 'org-1', id: 'user-1' } }
      }
    `,
  ],
  [
    'mock:business-date',
    `export async function businessToday() { return '2026-08-31' }`,
  ],
  [
    'mock:file-zip',
    `
      const state = globalThis[Symbol.for('openbooks.bulk-download-route-test')]
      export const MAX_ZIP_FILES = 300
      export class ZipSizeLimitError extends Error {
        constructor() {
          super('zip source exceeds 250 MB limit')
          this.name = 'ZipSizeLimitError'
        }
      }
      export async function filesZipManifest() {
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
  [
    'mock:cabinet-lib',
    `export function fileViewer() { return { userId: 'user-1', isAdmin: false, baseline: 'viewer' } }`,
  ],
])

const hooks = registerHooks({
  resolve(specifier, _context, nextResolve) {
    if (specifier === 'server-only') {
      return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
    }
    const mocked = new Map<string, string>([
      ['@/lib/api/json', 'mock:json'],
      ['../../../../lib/authz', 'mock:authz'],
      ['@openbooks/engine/src/business-date.ts', 'mock:business-date'],
      ['../../../../lib/file-zip', 'mock:file-zip'],
      ['../lib', 'mock:cabinet-lib'],
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

const routeUrl = './route.ts?bulk-download-route-test'
const { POST } = (await import(routeUrl)) as typeof import('./route.ts')
hooks.deregister()

function reset(): void {
  state.mode = 'ok'
  state.entries = [{ id: 'file-1', path: 'file-1.bin' }]
  state.manifestCalls = 0
  state.buildCalls = 0
}

function post(fileIds: unknown): Promise<Response> {
  return POST(
    new Request('http://openbooks.test/api/file-cabinet/bulk-download', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fileIds }),
    }),
  )
}

test('bulk download maps the ZIP source limit to HTTP 413', async () => {
  reset()
  state.mode = 'limit'

  const response = await post(['file-1'])

  assert.equal(response.status, 413)
  assert.deepEqual(await response.json(), { error: 'zip source exceeds 250 MB limit' })
  assert.equal(state.manifestCalls, 1)
  assert.equal(state.buildCalls, 1)
})

test('bulk download permits a boundary-sized archive returned by buildZip', async () => {
  reset()

  const response = await post(['file-1'])

  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'application/zip')
  assert.equal(await response.arrayBuffer().then((bytes) => Buffer.from(bytes).toString()), 'zip')
})

test('bulk download keeps the MAX_ZIP_FILES guard before manifest and blob work', async () => {
  reset()
  const ids = Array.from({ length: 301 }, (_, index) => `file-${index}`)

  const response = await post(ids)

  assert.equal(response.status, 413)
  assert.match((await response.json()).error, /too many files/)
  assert.equal(state.manifestCalls, 0)
  assert.equal(state.buildCalls, 0)
})
