import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

// Route-boundary regression coverage for the certificate action repair at
// b2d36ef3. The fake database deliberately separates committed state from
// transaction-local state, so a route that writes the certificate and audit
// row as independent autocommits cannot satisfy the rollback assertions below.
const stateKey = Symbol.for('openbooks.compliance-record-route-test')

type Action = 'verify' | 'reject' | 'reopen' | 'update'
type Certificate = Record<string, unknown>
type AuditRow = {
  org_id: string
  table_name: string
  row_id: string
  action: string
  changes: { before: Certificate; after: Record<string, unknown> }
  actor_id: string
  at: string
}
type DbCall = { kind: 'execute' | 'tx-execute'; text: string; params: string[] }

interface RouteState {
  calls: DbCall[]
  committedRecord: Certificate
  stagedRecord: Certificate | null
  committedAudits: AuditRow[]
  pendingAudits: AuditRow[]
  nextRecord: Certificate
  failAudit: boolean
  transactions: number
  inTx: boolean
}

const state: RouteState = {
  calls: [],
  committedRecord: {},
  stagedRecord: null,
  committedAudits: [],
  pendingAudits: [],
  nextRecord: {},
  failAudit: false,
  transactions: 0,
  inTx: false,
}
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = state

/** Flatten a drizzle SQL chunk into text for statement routing and assertions. */
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
;(globalThis as typeof globalThis & Record<string, unknown> & { openbooksSqlTextCompliance?: unknown }).openbooksSqlTextCompliance = sqlText

/** Extract drizzle's interpolated values, excluding literal SQL chunks. */
function sqlParams(query: unknown): string[] {
  const chunks = (query as { queryChunks?: unknown[] })?.queryChunks
  if (!Array.isArray(chunks)) return []
  const params: string[] = []
  for (const chunk of chunks) {
    if (typeof chunk === 'string') {
      params.push(chunk)
      continue
    }
    if ((chunk as { queryChunks?: unknown[] })?.queryChunks) {
      params.push(...sqlParams(chunk))
      continue
    }
    const value = (chunk as { value?: unknown })?.value
    if (!Array.isArray(value)) params.push(String(value))
  }
  return params
}
;(globalThis as typeof globalThis & Record<string, unknown> & { openbooksSqlParamsCompliance?: unknown }).openbooksSqlParamsCompliance = sqlParams

const ORG_ID = '00000000-0000-4000-8000-00000000a001'
const ACTOR_ID = '00000000-0000-4000-8000-00000000a002'
const CREATOR_ID = '00000000-0000-4000-8000-00000000a003'
const PARTY_ID = '00000000-0000-4000-8000-00000000a004'
const REQUIREMENT_ID = '00000000-0000-4000-8000-00000000a005'
const RECORD_ID = '00000000-0000-4000-8000-00000000a006'
const AUDIT_AT = '2026-08-28T06:00:00.000Z'

const mockSources = new Map<string, string>([
  [
    'mock:db',
    `
      const state = globalThis[Symbol.for('openbooks.compliance-record-route-test')]
      const sqlText = globalThis.openbooksSqlTextCompliance
      const sqlParams = globalThis.openbooksSqlParamsCompliance

      function respond(kind, query) {
        const text = sqlText(query)
        const params = sqlParams(query)
        state.calls.push({ kind, text, params })
        const transactional = kind === 'tx-execute'

        if (text.includes('from compliance_records')) {
          return { rows: [state.committedRecord] }
        }

        if (text.includes('update compliance_records')) {
          // The next row is the deterministic result for the action under test.
          // Transaction-local writes remain invisible until transaction commit.
          if (transactional) state.stagedRecord = { ...state.nextRecord }
          else state.committedRecord = { ...state.nextRecord }
          return { rows: [] }
        }

        if (text.includes('insert into audit_log')) {
          if (state.failAudit) throw new Error('immutable audit sink unavailable')
          const changes = JSON.parse(params[3])
          const audit = {
            org_id: params[0],
            table_name: 'compliance_records',
            row_id: params[1],
            action: params[2],
            changes,
            actor_id: params[4],
            // PostgreSQL supplies audit_log.at from its DEFAULT now().
            at: '2026-08-28T06:00:00.000Z',
          }
          if (transactional) state.pendingAudits.push(audit)
          else state.committedAudits.push(audit)
          return { rows: [] }
        }

        return { rows: [] }
      }

      export const db = {
        execute: (query) => Promise.resolve(respond('execute', query)),
        transaction: async (work) => {
          state.transactions += 1
          state.inTx = true
          state.stagedRecord = null
          state.pendingAudits = []
          try {
            const result = await work({ execute: (query) => respond('tx-execute', query) })
            if (state.stagedRecord) state.committedRecord = state.stagedRecord
            state.committedAudits.push(...state.pendingAudits)
            return result
          } catch (error) {
            // Rollback: both the staged certificate and pending audit rows vanish.
            throw error
          } finally {
            state.stagedRecord = null
            state.pendingAudits = []
            state.inTx = false
          }
        },
      }
      export const schema = {}
      export const pool = {}
      export const env = {}
      export function withOrgTransaction(_orgId, work) { return work() }
      export async function withOrg(_orgId, work) { return work() }
      export async function withOrgContext(_orgId, work) { return work() }
      export async function withBypass(work) { return work() }
      export async function withBypassContext(_opts, work) { return work() }
      export function registerRequestOrgResolver() {}
    `,
  ],
  [
    'mock:authz',
    `
      export async function getAuthz() {
        return { user: { orgId: '00000000-0000-0000-0000-000000000001', id: '00000000-0000-0000-0000-000000000002' }, allowedSubsidiaryIds: null }
      }
      export function can() { return true }
    `,
  ],
  [
    'mock:compliance',
    `
      export async function guardComplianceFeature() { return null }
    `,
  ],
])

// Patch the authz fixture's IDs after loading its source. Keeping the values in
// this test-local state avoids importing production auth/session machinery.
mockSources.set(
  'mock:authz',
  `
    export async function getAuthz() {
      return { user: { orgId: '${ORG_ID}', id: '${ACTOR_ID}' }, allowedSubsidiaryIds: null }
    }
    export function can() { return true }
  `,
)

const mockUrls = new Map<string, string>([
  ['@openbooks/engine/src/db.ts', 'mock:db'],
  ['@/lib/authz', 'mock:authz'],
  ['@/lib/compliance', 'mock:compliance'],
])

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') {
      return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
    }
    const mocked = mockUrls.get(specifier)
    if (mocked) return { url: mocked, shortCircuit: true }
    // Resolve the web tsconfig's @/ alias for the plain Node test runner.
    if (specifier.startsWith('@/')) {
      return {
        url: new URL(`../../../../../${specifier.slice(2)}.ts`, import.meta.url).href,
        shortCircuit: true,
      }
    }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    const source = mockSources.get(url)
    if (source !== undefined) return { format: 'module', source, shortCircuit: true }
    return nextLoad(url, context)
  },
})

const routeUrl = './route.ts?compliance-record-route-test'
const { PATCH } = (await import(routeUrl)) as typeof import('./route.ts')
hooks.deregister()

function certificate(overrides: Certificate = {}): Certificate {
  return {
    id: RECORD_ID,
    status: 'pending_review',
    party_id: PARTY_ID,
    requirement_id: REQUIREMENT_ID,
    created_by: CREATOR_ID,
    effective_from: '2026-08-01',
    expires_on: '2027-08-01',
    coverage_amount: '100000.0000',
    aggregate_amount: '200000.0000',
    coverage_currency: 'CAD',
    additional_insured: false,
    waiver_of_subrogation: false,
    primary_noncontributory: false,
    issuer_name: 'Original Insurer',
    policy_number: 'POL-ORIGINAL',
    ...overrides,
  }
}

type Scenario = {
  action: Action
  body: Record<string, unknown>
  before: Certificate
  after: Certificate
}

const scenarios: Scenario[] = [
  {
    action: 'verify',
    body: { action: 'verify' },
    before: certificate(),
    after: certificate({ status: 'active' }),
  },
  {
    action: 'reject',
    body: { action: 'reject', reason: 'Policy evidence is incomplete' },
    before: certificate(),
    after: certificate({ status: 'rejected' }),
  },
  {
    action: 'reopen',
    body: { action: 'reopen' },
    before: certificate({ status: 'rejected' }),
    after: certificate({ status: 'pending_review' }),
  },
  {
    action: 'update',
    body: {
      action: 'update',
      issuerName: 'Updated Insurer',
      policyNumber: 'POL-UPDATED',
      coverageAmount: '125000.50',
      notes: 'renewal paperwork received',
    },
    before: certificate({ status: 'active' }),
    after: certificate({ status: 'pending_review', issuer_name: 'Updated Insurer', policy_number: 'POL-UPDATED', coverage_amount: '125000.50' }),
  },
]

function reset(scenario: Scenario): void {
  state.calls = []
  state.committedRecord = { ...scenario.before }
  state.stagedRecord = null
  state.committedAudits = []
  state.pendingAudits = []
  state.nextRecord = { ...scenario.after }
  state.failAudit = false
  state.transactions = 0
  state.inTx = false
}

function patch(body: Record<string, unknown>): Promise<Response> {
  return PATCH(
    new Request(`http://openbooks.test/api/compliance/records/${RECORD_ID}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: RECORD_ID }) },
  )
}

for (const scenario of scenarios) {
  test(`${scenario.action} rolls back the certificate when immutable audit insertion fails`, async () => {
    reset(scenario)
    state.failAudit = true

    const response = await patch(scenario.body)

    assert.equal(response.status, 400)
    assert.deepEqual(state.committedRecord, scenario.before, 'the certificate mutation rolled back')
    assert.equal(state.committedAudits.length, 0, 'the failed audit row did not commit')
    const writes = state.calls.filter((call) =>
      call.text.includes('update compliance_records') || call.text.includes('insert into audit_log'),
    )
    assert.equal(writes.length, 2, 'the mutation and audit insert were both attempted')
    assert.ok(writes.every((call) => call.kind === 'tx-execute'), 'both writes ran inside one transaction')
  })

  test(`${scenario.action} commits one complete immutable audit row`, async () => {
    reset(scenario)

    const response = await patch(scenario.body)

    assert.equal(response.status, 200)
    assert.deepEqual(state.committedRecord, scenario.after, 'the certificate mutation committed')
    assert.equal(state.committedAudits.length, 1, 'exactly one audit row committed')
    const audit = state.committedAudits[0]!
    assert.equal(audit.org_id, ORG_ID)
    assert.equal(audit.table_name, 'compliance_records')
    assert.equal(audit.row_id, RECORD_ID)
    assert.equal(audit.action, scenario.action)
    assert.equal(audit.actor_id, ACTOR_ID)
    assert.equal(new Date(audit.at).toISOString(), AUDIT_AT, 'the database timestamp is present')
    assert.deepEqual(audit.changes.before, scenario.before, 'audit evidence captures the full prior row')
    assert.deepEqual(audit.changes.after, scenario.body, 'audit evidence captures the submitted action')

    const writes = state.calls.filter((call) =>
      call.text.includes('update compliance_records') || call.text.includes('insert into audit_log'),
    )
    assert.equal(state.transactions, 1)
    assert.equal(writes.length, 2)
    assert.ok(writes.every((call) => call.kind === 'tx-execute'), 'the mutation and audit share one transaction')
  })
}
