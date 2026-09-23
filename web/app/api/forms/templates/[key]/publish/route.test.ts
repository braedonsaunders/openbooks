import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

const stateKey = Symbol.for('openbooks.form-template-publish-test')
interface AuditCall {
  orgId: string
  table: string
  rowId: string
  action: string
  changes: Record<string, unknown>
  actorId: string
}
interface RouteState {
  calls: string[]
  audits: AuditCall[]
  latest: { id: string; version: number; schema: unknown; published_at: string | null } | undefined
  stampKept: boolean
}
const PUBLISHABLE_SCHEMA = {
  schemaVersion: 1,
  title: 'Intake',
  sections: [
    {
      id: 'main',
      title: 'Details',
      fields: [{ id: 'name', type: 'text', label: 'Name' }],
    },
  ],
}
const routeState: RouteState = {
  calls: [],
  audits: [],
  latest: { id: 'version-1', version: 1, schema: PUBLISHABLE_SCHEMA, published_at: null },
  stampKept: true,
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
;(globalThis as typeof globalThis & Record<string, unknown>).openbooksPublishSqlText = sqlText

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
    `,
  ],
  [
    'mock:audit',
    `
      const state = globalThis[Symbol.for('openbooks.form-template-publish-test')]
      export async function auditSetupChange(args, runner) {
        state.audits.push(args)
        await runner.execute({ queryChunks: ['insert into audit_log (mocked)'] })
      }
    `,
  ],
  [
    'mock:db',
    `
      const state = globalThis[Symbol.for('openbooks.form-template-publish-test')]
      const sqlText = globalThis.openbooksPublishSqlText
      export const db = {
        execute() { throw new Error('unexpected direct database write') },
        async transaction(work) {
          const tx = {
            async execute(query) {
              const text = sqlText(query)
              state.calls.push(text)
              if (text.includes('from form_templates') && text.includes('for update')) {
                return { rows: [{ id: 'template-1' }] }
              }
              if (text.includes('from form_template_versions')) {
                return { rows: state.latest ? [state.latest] : [] }
              }
              if (text.includes('update form_template_versions')) {
                return { rows: state.stampKept ? [{ id: 'version-1' }] : [] }
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
  ['../../../../../../lib/authz', 'mock:authz'],
  ['../../../../../../lib/setup/audit', 'mock:audit'],
  ['../../../_lib', 'mock:forms-lib'],
])

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') {
      return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
    }
    const mocked = mockUrls.get(specifier)
    if (mocked) return { url: mocked, shortCircuit: true }
    if (specifier.startsWith('@openbooks/forms-core') && context.parentURL) {
      return nextResolve(new URL('../../../../../../../packages/forms-core/src/index.ts', context.parentURL).href, context)
    }
    return nextResolve(specifier)
  },
  load(url, context, nextLoad) {
    const source = mockSources.get(url)
    if (source !== undefined) return { format: 'module', source, shortCircuit: true }
    return nextLoad(url, context)
  },
})

const routeUrl = './route.ts?form-template-publish-test'
const { POST } = (await import(routeUrl)) as typeof import('./route.ts')
hooks.deregister()

function reset(): void {
  routeState.calls.length = 0
  routeState.audits.length = 0
  routeState.latest = { id: 'version-1', version: 1, schema: PUBLISHABLE_SCHEMA, published_at: null }
  routeState.stampKept = true
}

function post(body: Record<string, unknown>): Promise<Response> {
  return POST(
    new Request('http://openbooks.test/api/forms/templates/intake/publish', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ key: 'intake' }) },
  )
}

test('publish stamps the draft and records immutable publication evidence', async () => {
  reset()

  const response = await post({ changelog: 'First release' })

  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { ok: true, version: 1 })
  assert.ok(routeState.calls.some((text) => text.includes('update form_template_versions')))
  assert.ok(routeState.calls.some((text) => text.includes('update form_templates')))
  assert.equal(routeState.audits.length, 2)

  const versionAudit = routeState.audits.find((a) => a.table === 'form_template_versions')!
  assert.equal(versionAudit.action, 'update')
  assert.equal(versionAudit.actorId, 'user-1')
  assert.equal((versionAudit.changes as { event: string }).event, 'publish')
  assert.equal((versionAudit.changes as { version: number }).version, 1)
  assert.deepEqual((versionAudit.changes as { before: unknown }).before, { published_at: null })
  const after = (versionAudit.changes as { after: { changelog: string; schemaHash: string } }).after
  assert.equal(after.changelog, 'First release')
  assert.match(after.schemaHash, /^[0-9a-f]{64}$/)

  const templateAudit = routeState.audits.find((a) => a.table === 'form_templates')!
  assert.deepEqual((templateAudit.changes as { before: unknown }).before, { status: 'draft' })
  assert.deepEqual((templateAudit.changes as { after: unknown }).after, { status: 'published' })
})

test('a lost stamp race is a 409 with no audit, not success', async () => {
  reset()
  routeState.stampKept = false

  const response = await post({})

  assert.equal(response.status, 409)
  assert.equal(routeState.audits.length, 0)
})

test('re-publishing an already-published version is a 409 with no audit', async () => {
  reset()
  routeState.latest = { id: 'version-1', version: 1, schema: PUBLISHABLE_SCHEMA, published_at: '2026-01-01T00:00:00Z' }

  const response = await post({})

  assert.equal(response.status, 409)
  assert.equal(routeState.audits.length, 0)
})
