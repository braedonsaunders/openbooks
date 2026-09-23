import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

const stateKey = Symbol.for('openbooks.form-template-post-test')
interface RouteState {
  calls: string[]
  audits: Array<{ table: string; action: string }>
  transactionStarts: number
  dupe: boolean
  failVersionWrite: boolean
  raceInsert: boolean
}
const routeState: RouteState = {
  calls: [],
  audits: [],
  transactionStarts: 0,
  dupe: false,
  failVersionWrite: false,
  raceInsert: false,
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
;(globalThis as typeof globalThis & Record<string, unknown>).openbooksPostSqlText = sqlText

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
    'mock:audit',
    `
      const state = globalThis[Symbol.for('openbooks.form-template-post-test')]
      export async function auditSetupChange(args, runner) {
        state.audits.push({ table: args.table, action: args.action })
        await runner.execute({ queryChunks: ['insert into audit_log (mocked)'] })
      }
    `,
  ],
  [
    'mock:db',
    `
      const state = globalThis[Symbol.for('openbooks.form-template-post-test')]
      const sqlText = globalThis.openbooksPostSqlText
      export const db = {
        execute() { throw new Error('unexpected direct database write') },
        async transaction(work) {
          state.transactionStarts += 1
          const tx = {
            async execute(query) {
              const text = sqlText(query)
              state.calls.push(text)
              if (text.includes('select 1 from form_templates')) {
                return { rows: state.dupe ? [{ '?column?': 1 }] : [] }
              }
              if (text.includes('insert into form_templates')) {
                if (state.raceInsert) {
                  const wrapped = new Error('Failed query: insert')
                  wrapped.cause = { code: '23505' }
                  throw wrapped
                }
                return { rows: [{ id: 'template-1' }] }
              }
              if (text.includes('insert into form_template_versions')) {
                if (state.failVersionWrite) throw new Error('version write failed')
                return { rows: [] }
              }
              return { rows: [] }
            },
          }
          return work(tx)
        },
      }
    `,
  ],
])

const mockUrls = new Map<string, string>([
  ['@/lib/api/json', 'mock:json'],
  ['@openbooks/engine/src/platform/db.ts', 'mock:db'],
  ['../../../../lib/authz', 'mock:authz'],
  ['../../../../lib/setup/audit', 'mock:audit'],
])

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') {
      return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
    }
    const mocked = mockUrls.get(specifier)
    if (mocked) return { url: mocked, shortCircuit: true }
    if (specifier.startsWith('@openbooks/forms-core') && context.parentURL) {
      return nextResolve(new URL('../../../../../packages/forms-core/src/index.ts', context.parentURL).href, context)
    }
    return nextResolve(specifier)
  },
  load(url, context, nextLoad) {
    const source = mockSources.get(url)
    if (source !== undefined) return { format: 'module', source, shortCircuit: true }
    return nextLoad(url, context)
  },
})

const routeUrl = './route.ts?form-template-post-test'
const { POST } = (await import(routeUrl)) as typeof import('./route.ts')
hooks.deregister()

function reset(): void {
  routeState.calls.length = 0
  routeState.audits.length = 0
  routeState.transactionStarts = 0
  routeState.dupe = false
  routeState.failVersionWrite = false
  routeState.raceInsert = false
}

function post(body: Record<string, unknown>): Promise<Response> {
  return POST(
    new Request('http://openbooks.test/api/forms/templates', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )
}

test('create commits parent, version 1, and audit in one transaction', async () => {
  reset()

  const response = await post({ key: 'intake', name: 'Intake' })

  assert.equal(response.status, 201)
  assert.deepEqual(await response.json(), { id: 'template-1', key: 'intake' })
  assert.equal(routeState.transactionStarts, 1)
  assert.ok(routeState.calls.some((text) => text.includes('select 1 from form_templates')))
  assert.ok(routeState.calls.some((text) => text.includes('insert into form_templates')))
  assert.ok(routeState.calls.some((text) => text.includes('insert into form_template_versions')))
  assert.ok(routeState.calls.some((text) => text.includes('insert into audit_log')))
  assert.deepEqual(routeState.audits, [{ table: 'form_templates', action: 'insert' }])
})

test('a taken key is a 409 with no writes', async () => {
  reset()
  routeState.dupe = true

  const response = await post({ key: 'intake', name: 'Intake' })

  assert.equal(response.status, 409)
  assert.ok(!routeState.calls.some((text) => text.includes('insert into')))
})

test('a version-write failure rolls the template insert back with it', async () => {
  reset()
  routeState.failVersionWrite = true

  await assert.rejects(() => post({ key: 'intake', name: 'Intake' }), /version write failed/)
  assert.equal(routeState.transactionStarts, 1)
})

test('a concurrent creator racing the dupe check is a 409, not a 500', async () => {
  reset()
  routeState.raceInsert = true

  const response = await post({ key: 'intake', name: 'Intake' })

  assert.equal(response.status, 409)
  assert.match(((await response.json()) as { error: string }).error, /already exists/)
})
