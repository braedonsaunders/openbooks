import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

const stateKey = Symbol.for('openbooks.form-template-route-test')
interface Call { kind: 'tx'; text: string }
interface AuditCall {
  orgId: string
  table: string
  rowId: string
  action: string
  changes: Record<string, unknown>
  actorId: string
}
interface RouteState {
  calls: Call[]
  audits: AuditCall[]
  transactionStarts: number
  committedMetadataUpdates: number
  latest: { id: string; version: number; schema: unknown; published_at: string | null } | undefined
  failSchemaWrite: boolean
  templateLocked: boolean
  versionUpdateKept: boolean
}
const DRAFT_SCHEMA = { schemaVersion: 1, title: 'Intake', sections: [] }
const routeState: RouteState = {
  calls: [],
  audits: [],
  transactionStarts: 0,
  committedMetadataUpdates: 0,
  latest: { id: 'version-1', version: 1, schema: DRAFT_SCHEMA, published_at: null },
  failSchemaWrite: false,
  templateLocked: true,
  versionUpdateKept: true,
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
    'mock:audit',
    `
      const state = globalThis[Symbol.for('openbooks.form-template-route-test')]
      export async function auditSetupChange(args, runner) {
        state.audits.push(args)
        // The audit must share the mutation's transaction: run the insert
        // through the passed runner so a rollback takes the event with it.
        await runner.execute({ queryChunks: ['insert into audit_log (mocked)'] })
      }
    `,
  ],
  [
    'mock:db',
    `
      const state = globalThis[Symbol.for('openbooks.form-template-route-test')]
      const sqlText = globalThis.openbooksSqlText
      const templateRow = () => ({
        id: 'template-1', key: 'intake', name: 'Intake', category: null,
        description: null, status: 'draft', kind: 'form', allowed_roles: null,
      })
      export const db = {
        execute() { throw new Error('unexpected direct database write') },
        async transaction(work) {
          state.transactionStarts += 1
          const staged = { metadata: false }
          const tx = {
            async execute(query) {
              const text = sqlText(query)
              state.calls.push({ kind: 'tx', text })
              if (text.includes('update form_templates')) {
                staged.metadata = true
                return { rows: [{ id: 'template-1' }] }
              }
              if (state.failSchemaWrite && text.includes('update form_template_versions')) {
                throw new Error('schema write failed')
              }
              if (text.includes('from form_templates') && text.includes('for update')) {
                return { rows: state.templateLocked ? [templateRow()] : [] }
              }
              if (text.includes('update form_template_versions')) {
                return { rows: state.versionUpdateKept && state.latest ? [{ version: state.latest.version }] : [] }
              }
              if (text.includes('insert into form_template_versions')) {
                return { rows: [{ id: 'version-2' }] }
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
  ['@openbooks/engine/src/platform/db.ts', 'mock:db'],
  ['../../../../../lib/authz', 'mock:authz'],
  ['../../../../../lib/setup/audit', 'mock:audit'],
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
const { PUT, DELETE } = (await import(routeUrl)) as typeof import('./route.ts')
hooks.deregister()

function reset(): void {
  routeState.calls.length = 0
  routeState.audits.length = 0
  routeState.transactionStarts = 0
  routeState.committedMetadataUpdates = 0
  routeState.latest = { id: 'version-1', version: 1, schema: DRAFT_SCHEMA, published_at: null }
  routeState.failSchemaWrite = false
  routeState.templateLocked = true
  routeState.versionUpdateKept = true
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
  assert.equal(routeState.calls.length, 6)
  assert.match(routeState.calls[0]!.text, /from form_templates[\s\S]*for update/)
  assert.match(routeState.calls[1]!.text, /update form_templates/)
  assert.match(routeState.calls[2]!.text, /insert into audit_log/)
  assert.match(routeState.calls[3]!.text, /select id, version, schema, published_at/)
  assert.match(routeState.calls[3]!.text, /for update/)
  assert.match(routeState.calls[4]!.text, /update form_template_versions/)
  assert.match(routeState.calls[4]!.text, /published_at is null/)
  assert.match(routeState.calls[5]!.text, /insert into audit_log/)

  const metaAudit = routeState.audits.find((a) => a.table === 'form_templates')
  assert.equal(metaAudit?.action, 'update')
  assert.equal(metaAudit?.actorId, 'user-1')
  assert.equal((metaAudit?.changes.before as { name: string }).name, 'Intake')
  assert.equal((metaAudit?.changes.after as { name: string }).name, 'Renamed intake')
  const versionAudit = routeState.audits.find((a) => a.table === 'form_template_versions')
  assert.equal(versionAudit?.action, 'update')
  assert.ok((versionAudit?.changes.before as { schemaHash: string }).schemaHash)
  assert.ok((versionAudit?.changes.after as { schemaHash: string }).schemaHash)
  assert.notEqual(
    (versionAudit?.changes.before as { schemaHash: string }).schemaHash,
    (versionAudit?.changes.after as { schemaHash: string }).schemaHash,
  )
})

test('a schema write failure does not commit the transaction metadata update', async () => {
  reset()
  routeState.failSchemaWrite = true

  await assert.rejects(() => put({ name: 'Renamed intake', schema: validSchema }), /schema write failed/)

  assert.equal(routeState.transactionStarts, 1)
  assert.equal(routeState.committedMetadataUpdates, 0)
  assert.ok(routeState.calls.some(({ text }) => text.includes('update form_templates')))
})

test('a publish that wins the race turns the edit into a new draft version', async () => {
  reset()
  // The locked latest read still saw a draft, but the guarded in-place
  // update matched zero rows: publish committed first. The edit must land
  // as version 2, never overwrite the published snapshot.
  routeState.versionUpdateKept = false

  const response = await put({ schema: validSchema })

  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { ok: true, savedVersion: 2 })
  assert.ok(
    routeState.calls.some(({ text }) =>
      text.includes('insert into form_template_versions'),
    ),
  )
})

test('a template deleted mid-request is a 404, not a silent success', async () => {
  reset()
  routeState.templateLocked = false

  const response = await put({ name: 'Renamed intake', schema: validSchema })

  assert.equal(response.status, 404)
})

test('archive writes a before/after audit event in the same transaction', async () => {
  reset()

  const response = await DELETE(
    new Request('http://openbooks.test/api/forms/templates/intake', { method: 'DELETE' }),
    { params: Promise.resolve({ key: 'intake' }) },
  )

  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { ok: true })
  assert.equal(routeState.calls.length, 3)
  assert.match(routeState.calls[0]!.text, /from form_templates[\s\S]*for update/)
  assert.match(routeState.calls[1]!.text, /update form_templates/)
  assert.match(routeState.calls[2]!.text, /insert into audit_log/)
  assert.equal(routeState.audits.length, 1)
  const audit = routeState.audits[0]!
  assert.equal(audit.table, 'form_templates')
  assert.equal(audit.actorId, 'user-1')
  assert.equal((audit.changes.before as { status: string }).status, 'draft')
  assert.equal((audit.changes.after as { status: string }).status, 'archived')
})

test('archiving a vanished template is a 404, not success', async () => {
  reset()
  routeState.templateLocked = false

  const response = await DELETE(
    new Request('http://openbooks.test/api/forms/templates/intake', { method: 'DELETE' }),
    { params: Promise.resolve({ key: 'intake' }) },
  )

  assert.equal(response.status, 404)
  assert.equal(routeState.audits.length, 0)
})
