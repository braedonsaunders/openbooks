import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

// H-STATEMENT: GET /api/parties/[id]/statement/send disclosed an
// out-of-scope party's name and email, POST would send it a statement, and
// POST gated only ar.create/ap.create while rendering requires reports.read
// (a create-only sender got a generic 422 'Report access denied'). The party
// is now the record boundary (uniform 'record not found'), and POST requires
// the full permission set at the boundary, by name.
interface StatementState {
  permissions: string[]
  allowedSubsidiaryIds: Set<string> | null
  party: { id: string; display_name: string | null; email: string | null; subsidiary_id: string | null } | null
  executed: string[]
  renderCalls: number
  sendCalls: number
}

const stateKey = Symbol.for('openbooks.statement-send-test')
const statementState: StatementState = {
  permissions: [],
  allowedSubsidiaryIds: null,
  party: null,
  executed: [],
  renderCalls: 0,
  sendCalls: 0,
}
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = statementState

const PARTY_ID = '00000000-0000-4000-8000-00000000e001'
const SUB_A = '00000000-0000-4000-8000-00000000e00a'
const SUB_B = '00000000-0000-4000-8000-00000000e00b'

const mockSources = new Map<string, string>([
  [
    'mock:authz',
    `
      const state = globalThis[Symbol.for('openbooks.statement-send-test')]
      export async function guardPermission(perm) {
        if (!state.permissions.includes(perm)) {
          return Response.json({ error: 'missing permission: ' + perm }, { status: 403 })
        }
        return {
          user: { orgId: 'org-1', id: 'user-1' },
          permissions: new Set(state.permissions),
          allowedSubsidiaryIds: state.allowedSubsidiaryIds,
        }
      }
      export function can(authz, perm) {
        return authz.permissions.has(perm)
      }
      // The canonical party rule: null scope passes; a null subsidiary is
      // org-wide only with orgWideNull.
      export function subsidiaryScopeAllows(scope, subsidiaryId, opts) {
        if (scope === null || scope === undefined) return true
        if (subsidiaryId === null || subsidiaryId === undefined || subsidiaryId === '') {
          return (opts && opts.orgWideNull) === true
        }
        return scope.has(subsidiaryId)
      }
    `,
  ],
  [
    'mock:db',
    `
      const state = globalThis[Symbol.for('openbooks.statement-send-test')]
      // Render static SQL text the way drizzle nests it: raw strings, static
      // text inside { value: [...] } chunks, nested fragments, and scalar
      // bound params. A strings-only join sees none of the static text, so
      // the party lookup would never match and every scope denial would pass
      // trivially against a missing row.
      const sqlText = (query) => {
        const chunks = query?.queryChunks
        if (!Array.isArray(chunks)) return ''
        return chunks
          .map((chunk) => {
            if (typeof chunk === 'string') return chunk
            const value = chunk?.value
            if (Array.isArray(value)) return value.map(String).join('')
            if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
              return String(value)
            }
            if (chunk?.queryChunks) return sqlText(chunk)
            if (chunk === null) return 'null'
            return ''
          })
          .join('')
      }
      export const db = {
        async execute(query) {
          const text = sqlText(query)
          state.executed.push(text)
          if (text.includes('from parties')) {
            return { rows: state.party ? [state.party] : [] }
          }
          return { rows: [] }
        },
      }
    `,
  ],
  [
    'mock:json',
    `
      export const jsonObject = {}
      export async function parseJsonBody(request) {
        return { ok: true, data: await request.json() }
      }
    `,
  ],
  ['mock:intl', `export async function getTranslations() { return (key) => key }`],
  ['mock:bizdate', `export async function businessToday() { return '2026-07-15' }`],
  [
    'mock:email-config',
    `
      export async function insertEmailLog() { return 'log-1' }
      export async function markEmailFailed() {}
      export async function markEmailSent() {}
      export async function markEmailUncertain() {}
      export async function resolveOrgEmailTransport() { return { kind: 'test' } }
    `,
  ],
  [
    'mock:emails',
    `
      const state = globalThis[Symbol.for('openbooks.statement-send-test')]
      export function deriveEmailDeliveryKey() { return 'key-1' }
      export function isValidEmailAddress() { return true }
      export function documentEmail() { return { subject: 'Statement', html: '<p>x</p>', text: 'x' } }
      export async function sendVia() {
        state.sendCalls += 1
        return { kind: 'sent', providerMessageId: 'm-1' }
      }
    `,
  ],
  ['mock:report-filters', `export function parseReportQuery() { return { period: 'custom' } }`],
  ['mock:periods', `export async function resolvePeriod() { return { from: '2026-07-01', to: '2026-07-31' } }`],
  [
    'mock:report-run',
    `
      const state = globalThis[Symbol.for('openbooks.statement-send-test')]
      export async function resolveReport() {
        state.renderCalls += 1
        return { render: 'data', data: {} }
      }
    `,
  ],
  [
    'mock:report-pdf',
    `
      export async function exportDataToPdf() { return new Uint8Array([1, 2, 3]) }
      export async function orgBranding() { return { orgName: 'Test Org' } }
      export function resolveLayout() { return { page: {}, showSummary: false } }
    `,
  ],
  ['mock:export', `export function safeName(name) { return name }`],
])

const mockUrls = new Map<string, string>([
  ['@/lib/api/json', 'mock:json'],
  ['@openbooks/engine/src/platform/db.ts', 'mock:db'],
  ['@openbooks/engine/src/platform/business-date.ts', 'mock:bizdate'],
  ['@openbooks/engine/src/delivery/email-config.ts', 'mock:email-config'],
  ['@openbooks/emails', 'mock:emails'],
  ['../../../../../../lib/authz', 'mock:authz'],
  ['../../../../../../lib/report-filters', 'mock:report-filters'],
  ['../../../../../../lib/periods', 'mock:periods'],
  ['../../../../../../lib/report-run', 'mock:report-run'],
  ['../../../../../../lib/report-pdf', 'mock:report-pdf'],
  ['../../../../../../lib/export', 'mock:export'],
  ['next-intl/server', 'mock:intl'],
])

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') return { format: 'module', source: '', shortCircuit: true, url: 'mock:server-only' }
    const mocked = mockUrls.get(specifier)
    if (mocked) return { url: mocked, shortCircuit: true }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    const source = mockSources.get(url)
    if (source !== undefined) return { format: 'module', source, shortCircuit: true }
    if (url === 'mock:server-only') return { format: 'module', source: '', shortCircuit: true }
    return nextLoad(url, context)
  },
})

const routeUrl = './route.ts?statement-send-test'
const { GET, POST } = (await import(routeUrl)) as typeof import('./route.ts')
hooks.deregister()

function reset(overrides: Partial<StatementState>): void {
  statementState.permissions = overrides.permissions ?? []
  statementState.allowedSubsidiaryIds = overrides.allowedSubsidiaryIds ?? null
  statementState.party = overrides.party ?? null
  statementState.executed = []
  statementState.renderCalls = 0
  statementState.sendCalls = 0
}

const bParty = {
  id: PARTY_ID,
  display_name: 'Beta Corp',
  email: 'billing@beta.test',
  subsidiary_id: SUB_B,
}

function get(): Promise<Response> {
  return GET(
    new Request(`http://openbooks.test/api/parties/${PARTY_ID}/statement/send?side=ar`),
    { params: Promise.resolve({ id: PARTY_ID }) },
  )
}

function send(): Promise<Response> {
  return POST(
    new Request(`http://openbooks.test/api/parties/${PARTY_ID}/statement/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ side: 'ar', toDate: '2026-07-31' }),
    }),
    { params: Promise.resolve({ id: PARTY_ID }) },
  )
}

test('GET hides an out-of-scope party exactly like a missing one', async () => {
  reset({ permissions: ['ar.read'], allowedSubsidiaryIds: new Set([SUB_A]), party: bParty })
  const denied = await get()
  assert.equal(denied.status, 404)
  assert.deepEqual(await denied.json(), { error: 'record not found' })

  reset({ permissions: ['ar.read'], allowedSubsidiaryIds: new Set([SUB_A]), party: null })
  const missing = await get()
  assert.equal(missing.status, 404)
  assert.deepEqual(await missing.json(), { error: 'record not found' })
})

test('GET still prefills an in-scope party', async () => {
  reset({ permissions: ['ar.read'], allowedSubsidiaryIds: new Set([SUB_B]), party: bParty })
  const response = await get()
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { to: 'billing@beta.test', partyName: 'Beta Corp' })
})

test('POST by a create-only sender names reports.read instead of rendering', async () => {
  reset({ permissions: ['ar.create'], allowedSubsidiaryIds: null, party: bParty })
  const response = await send()
  assert.equal(response.status, 403)
  assert.deepEqual(await response.json(), { error: 'missing permission: reports.read' })
  assert.equal(statementState.renderCalls, 0)
  assert.equal(statementState.sendCalls, 0)
})

test('POST never sends an out-of-scope party its statement', async () => {
  reset({ permissions: ['ar.create', 'reports.read'], allowedSubsidiaryIds: new Set([SUB_A]), party: bParty })
  const response = await send()
  assert.equal(response.status, 404)
  assert.deepEqual(await response.json(), { error: 'record not found' })
  assert.equal(statementState.renderCalls, 0)
  assert.equal(statementState.sendCalls, 0)
})
