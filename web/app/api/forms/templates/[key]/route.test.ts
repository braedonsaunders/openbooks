import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

const stateKey = Symbol.for('openbooks.form-template-route-test')
interface Call { kind: 'tx'; text: string }
interface RouteState {
  calls: Call[]
  transactionStarts: number
  committedMetadataUpdates: number
  latest: { id: string; version: number; published_at: string | null } | undefined
  failSchemaWrite: boolean
}
const routeState: RouteState = {
  calls: [],
  transactionStarts: 0,
  committedMetadataUpdates: 0,
  latest: { id: 'version-1', version: 1, published_at: null },
  failSchemaWrite: false,
}
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState

function sqlText(query: unknown): string {
  const chunks = (query as { queryChunks?: unknown[] })?.queryChunks
  if (!Array.isArray(chunks)) return ''
  return chunks
    .map((chunk) => {
      if (typeof chunk === 'string') return chunk
      const value = (chunk as { value?: unknown[] })?.value
      if (Array.isArray(value)) return value.map(String).join('')
      if ((chunk as { queryChunks?: unknown[] })?.queryChunks) return sqlText(chunk)
      return ''
    })
    .join('')
}
;(globalThis as typeof globalThis & Record<string, unknown>).openbooksSqlText = sqlText

const mockSources = new Map<string, string>([
  [
    'mock:json',
    `
      export const jsonObject = {}
      export async function parseJsonBody(request) {
        return { ok: true, data: await request.json() }
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
    'mock:forms-lib',
    `
      export async function getTemplateByKey() {
        return {
          id: 'template-1', key: 'intake', name: 'Intake', category: null,
          description: null, status: 'draft', kind: 'form', allowed_roles: null,
        }
      }
      export async function getLatestVersion() {
        return globalThis[Symbol.for('openbooks.form-template-route-test')].latest
      }
    `,
  ],
  [
    'mock:db',
    `
      const state = globalThis[Symbol.for('openbooks.form-template-route-test')]
      const sqlText = globalThis.openbooksSqlText
      export const db = {
        execute() { throw new Error('unexpected direct database write') },
        async transaction(work) {
          state.transactionStarts += 1
          const staged = { metadata: false }
          const tx = {
            async execute(query) {
              const text = sqlText(query)
              state.calls.push({ kind: 'tx', text })
              if (text.includes('update form_templates')) staged.metadata = true
              if (state.failSchemaWrite && text.includes('update form_template_versions')) {
                throw new Error('schema write failed')
              }
              if (text.includes('form_template_versions') && text.includes('select id')) {
                return { rows: state.latest ? [state.latest] : [] }
              }
              return { rows: [] }
            },
          }
          const result = await work(tx)
          if (staged.metadata) state.committedMetadataUpdates += 1
          return result
        },
      }
    `,
  ],
])

const mockUrls = new Map<string, string>([
  ['@/lib/api/json', 'mock:json'],
  ['@openbooks/engine/src/db.ts', 'mock:db'],
  ['../../../../../lib/authz', 'mock:authz'],
  ['../../_lib', 'mock:forms-lib'],
])

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') {
      return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
    }
    const mocked = mockUrls.get(specifier)
    if (mocked) return { url: mocked, shortCircuit: true }
    if (specifier.startsWith('@openbooks/forms-core') && context.parentURL) {
      return nextResolve(new URL('../../../../../../packages/forms-core/src/index.ts', context.parentURL).href, context)
    }
    return nextResolve(specifier)
  },
  load(url, context, nextLoad) {
    const source = mockSources.get(url)
    if (source !== undefined) return { format: 'module', source, shortCircuit: true }
    return nextLoad(url, context)
  },
})

const routeUrl = './route.ts?form-template-atomic-test'
const { PUT } = (await import(routeUrl)) as typeof import('./route.ts')
hooks.deregister()

function reset(): void {
  routeState.calls.length = 0
  routeState.transactionStarts = 0
  routeState.committedMetadataUpdates = 0
  routeState.latest = { id: 'version-1', version: 1, published_at: null }
  routeState.failSchemaWrite = false
}

function put(body: Record<string, unknown>): Promise<Response> {
  return PUT(
    new Request('http://openbooks.test/api/forms/templates/intake', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ key: 'intake' }) },
  )
}

const validSchema = {
  schemaVersion: 1,
  title: 'Intake',
  sections: [{ id: 'main', title: 'Details', fields: [] }],
}

test('invalid schema rejects before metadata can enter a write transaction', async () => {
  reset()

  const response = await put({ name: 'Renamed intake', schema: {} })

  assert.equal(response.status, 422)
  const payload = (await response.json()) as { error: string; issues: Array<{ path: string[]; message: string }> }
  assert.equal(payload.error, 'invalid schema')
  assert.equal(payload.issues[0]?.path[0], 'schemaVersion')
  assert.match(payload.issues[0]?.message ?? '', /expected 1/)
  assert.equal(routeState.transactionStarts, 0)
  assert.equal(routeState.calls.length, 0)
})

test('metadata and a valid draft schema commit together in one transaction', async () => {
  reset()

  const response = await put({ name: 'Renamed intake', schema: validSchema })

  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { ok: true, savedVersion: 1 })
  assert.equal(routeState.transactionStarts, 1)
  assert.equal(routeState.committedMetadataUpdates, 1)
  assert.equal(routeState.calls.length, 3)
  assert.match(routeState.calls[0]!.text, /update form_templates/)
  assert.match(routeState.calls[1]!.text, /select id, version, published_at/)
  assert.match(routeState.calls[2]!.text, /update form_template_versions/)
})

test('a schema write failure does not commit the transaction metadata update', async () => {
  reset()
  routeState.failSchemaWrite = true

  await assert.rejects(() => put({ name: 'Renamed intake', schema: validSchema }), /schema write failed/)

  assert.equal(routeState.transactionStarts, 1)
  assert.equal(routeState.committedMetadataUpdates, 0)
  assert.ok(routeState.calls.some(({ text }) => text.includes('update form_templates')))
})
