import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

// Route-boundary tests use a small transactional database double. It models
// the commit/rollback boundary and serializes transactions like PostgreSQL's
// row lock, which lets both failure atomicity and concurrent publication run
// without a live database.
const stateKey = Symbol.for('openbooks.forms-publish-route-test')
type FormState = {
  template: { id: string; key: string; name: string; status: string } | null
  version: {
    id: string
    version: number
    schema: unknown
    published_at: string | null
    changelog: string | null
  } | null
  txCalls: { kind: 'tx'; text: string }[]
  directCalls: { kind: 'direct'; text: string }[]
  transactionCount: number
  failTemplateUpdate: boolean
  transactionTail: Promise<void>
}

const routeState: FormState = {
  template: {
    id: 'template-1',
    key: 'intake',
    name: 'Intake',
    status: 'draft',
  },
  version: {
    id: 'version-1',
    version: 1,
    schema: { schemaVersion: 1 },
    published_at: null,
    changelog: null,
  },
  txCalls: [],
  directCalls: [],
  transactionCount: 0,
  failTemplateUpdate: false,
  transactionTail: Promise.resolve(),
}
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] =
  routeState

const mockSources = new Map<string, string>([
  [
    'mock:sql',
    `
      export function sql(strings, ...values) {
        return { strings: Array.from(strings), values }
      }
    `,
  ],
  [
    'mock:json',
    `
      export const jsonObject = {}
      export async function parseJsonBody(req) {
        return { ok: true, data: await req.json() }
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
    'mock:forms-core',
    `
      export function parseFormSchema() {
        return { success: true, data: { sections: [{ fields: [{ id: 'field-1' }] }] } }
      }
    `,
  ],
  [
    'mock:forms-lib',
    `
      const state = globalThis[Symbol.for('openbooks.forms-publish-route-test')]
      export async function getTemplateByKey() {
        return state.template && {
          ...state.template,
          category: null,
          description: null,
          kind: 'form',
          allowed_roles: null,
        }
      }
      export async function getLatestVersion() {
        return state.version && { ...state.version }
      }
    `,
  ],
  [
    'mock:db',
    `
      const state = globalThis[Symbol.for('openbooks.forms-publish-route-test')]

      const textOf = (query) => Array.isArray(query?.strings) ? query.strings.join('') : String(query)
      const clone = (value) => value && { ...value }

      // Direct execution is retained to prove the regression: the old route
      // committed each UPDATE independently, so the first write survives a
      // failure in the second one.
      export const db = {
        async execute(query) {
          const text = textOf(query)
          state.directCalls.push({ kind: 'direct', text })
          if (/update form_template_versions/i.test(text) && state.version) {
            state.version.published_at = 'direct-published'
          }
          if (/update form_templates/i.test(text)) {
            if (state.failTemplateUpdate) throw new Error('forced template update failure')
            if (state.template) state.template.status = 'published'
          }
          return { rows: [], rowCount: 1 }
        },

        async transaction(work) {
          const previous = state.transactionTail
          let release
          state.transactionTail = new Promise((resolve) => { release = resolve })
          await previous
          state.transactionCount++

          const local = {
            template: clone(state.template),
            version: clone(state.version),
          }
          const tx = {
            async execute(query) {
              const text = textOf(query)
              state.txCalls.push({ kind: 'tx', text })
              if (/select id\\s+from form_templates/i.test(text)) {
                return { rows: local.template ? [clone(local.template)] : [] }
              }
              if (/select id, version, schema, published_at/i.test(text)) {
                return { rows: local.version ? [clone(local.version)] : [] }
              }
              if (/update form_template_versions/i.test(text) && local.version) {
                local.version.published_at = 'transaction-published'
                return { rows: [], rowCount: 1 }
              }
              if (/update form_templates/i.test(text)) {
                if (state.failTemplateUpdate) throw new Error('forced template update failure')
                if (local.template) local.template.status = 'published'
                return { rows: [], rowCount: 1 }
              }
              return { rows: [] }
            },
          }

          try {
            const result = await work(tx)
            state.template = local.template
            state.version = local.version
            return result
          } finally {
            release()
          }
        },
      }
      export const schema = {}
    `,
  ],
])

const mockUrls = new Map<string, string>([
  ['drizzle-orm', 'mock:sql'],
  ['@/lib/api/json', 'mock:json'],
  ['@openbooks/engine/src/db.ts', 'mock:db'],
  ['@openbooks/forms-core', 'mock:forms-core'],
  ['../../../../../../lib/authz', 'mock:authz'],
  ['../../../_lib', 'mock:forms-lib'],
])

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') {
      return {
        shortCircuit: true,
        format: 'module',
        url: 'data:text/javascript,export {}',
      }
    }
    const mocked = mockUrls.get(specifier)
    if (mocked) return { url: mocked, shortCircuit: true }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    const source = mockSources.get(url)
    if (source !== undefined)
      return { format: 'module', source, shortCircuit: true }
    return nextLoad(url, context)
  },
})

const routeUrl = './route.ts?forms-publish-route-test'
const { POST } = (await import(routeUrl)) as typeof import('./route.ts')
hooks.deregister()

function reset(): void {
  routeState.template = {
    id: 'template-1',
    key: 'intake',
    name: 'Intake',
    status: 'draft',
  }
  routeState.version = {
    id: 'version-1',
    version: 1,
    schema: { schemaVersion: 1 },
    published_at: null,
    changelog: null,
  }
  routeState.txCalls = []
  routeState.directCalls = []
  routeState.transactionCount = 0
  routeState.failTemplateUpdate = false
  routeState.transactionTail = Promise.resolve()
}

function post(body: Record<string, unknown> = {}): Promise<Response> {
  return POST(
    new Request('http://openbooks.test/api/forms/templates/intake/publish', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ key: 'intake' }) },
  )
}

test('publishes the draft and template atomically under parent and version locks', async () => {
  reset()

  const response = await post({ changelog: '  initial release  ' })

  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { ok: true, version: 1 })
  assert.equal(routeState.version?.published_at, 'transaction-published')
  assert.equal(routeState.template?.status, 'published')
  assert.equal(
    routeState.directCalls.length,
    0,
    'writes stay on the transaction connection',
  )
  assert.equal(routeState.transactionCount, 1)
  assert.equal(
    routeState.txCalls.filter((call) => /for update/i.test(call.text)).length,
    2,
  )
  assert.ok(
    routeState.txCalls.findIndex((call) =>
      /from form_templates/i.test(call.text),
    ) <
      routeState.txCalls.findIndex((call) =>
        /from form_template_versions/i.test(call.text),
      ),
    'the parent row is locked before the draft version',
  )
})

test('rolls back the immutable version when the template update fails', async () => {
  reset()
  routeState.failTemplateUpdate = true

  await assert.rejects(
    post({ changelog: 'release' }),
    /forced template update failure/,
  )

  assert.equal(
    routeState.version?.published_at,
    null,
    'the failed transaction did not strand a published version',
  )
  assert.equal(
    routeState.template?.status,
    'draft',
    'the template remains a draft after rollback',
  )
  assert.equal(routeState.directCalls.length, 0)
})

test('serializes concurrent publishers and rechecks the latest version after locking', async () => {
  reset()

  const responses = await Promise.all([
    post({ changelog: 'first' }),
    post({ changelog: 'second' }),
  ])
  const statuses = responses
    .map((response) => response.status)
    .sort((a, b) => a - b)
  assert.deepEqual(statuses, [200, 409])
  const conflict = responses.find((response) => response.status === 409)
  assert.ok(conflict)
  assert.match((await conflict.json()).error, /already published/)
  assert.equal(routeState.version?.published_at, 'transaction-published')
  assert.equal(routeState.template?.status, 'published')
  assert.equal(routeState.transactionCount, 2)
  assert.equal(routeState.directCalls.length, 0)
})
