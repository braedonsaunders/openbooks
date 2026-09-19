import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

// Audited native Admin Users -> linked person (POST set-party + GET search).
// Covers the coordinator-owned contract: attestation + reason required,
// same-org active party, self-change refused even for superadmin, stale
// expected 409 with no mutation, exact before/after audit with kind/role
// signals, concurrent writers only one wins, audit failure rolls back, and
// per-query bounded search that stays selectable beyond the first page.
const stateKey = Symbol.for('openbooks.admin-users-party-test')

const ORG_ID = '00000000-0000-4000-8000-00000000b001'
const OTHER_ORG_ID = '00000000-0000-4000-8000-00000000b099'
const ACTOR_ID = '00000000-0000-4000-8000-00000000b002'
const TARGET_ID = '00000000-0000-4000-8000-00000000b003'
const OTHER_USER_ID = '00000000-0000-4000-8000-00000000b098'
const PARTY_A = '00000000-0000-4000-8000-00000000b011'
const PARTY_B = '00000000-0000-4000-8000-00000000b012'
const PARTY_INACTIVE = '00000000-0000-4000-8000-00000000b013'
const OTHER_ORG_PARTY = '00000000-0000-4000-8000-00000000b097'

interface PartyRow {
  kind: string
  displayName: string
  isActive: boolean
  roles: string[]
  orgId: string
}

interface PartyState {
  executed: string[]
  committed: string[]
  pending: string[]
  inTx: boolean
  transactionCalls: number
  failOnText?: string
  currentPartyId: string | null
  authz: {
    user: { orgId: string; id: string; isSuperAdmin: boolean }
    permissions: Set<string>
  } | null
  parties: Record<string, PartyRow>
}

function baseParties(): Record<string, PartyRow> {
  return {
    [PARTY_A]: { kind: 'person', displayName: 'Ada Person', isActive: true, roles: [], orgId: ORG_ID },
    // kind=company carrying an employee role: kind is not proof, roles are signals.
    [PARTY_B]: { kind: 'company', displayName: 'Beta Corp', isActive: true, roles: ['employee'], orgId: ORG_ID },
    [PARTY_INACTIVE]: { kind: 'person', displayName: 'Inactive Person', isActive: false, roles: [], orgId: ORG_ID },
    [OTHER_ORG_PARTY]: { kind: 'person', displayName: 'Other Org Person', isActive: true, roles: [], orgId: OTHER_ORG_ID },
  }
}

const state: PartyState = {
  executed: [],
  committed: [],
  pending: [],
  inTx: false,
  transactionCalls: 0,
  currentPartyId: null,
  authz: {
    user: { orgId: ORG_ID, id: ACTOR_ID, isSuperAdmin: false },
    permissions: new Set(['admin.users.manage']),
  },
  parties: baseParties(),
}
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = state

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
;(globalThis as typeof globalThis & { openbooksSqlTextAdminUsersParty: typeof sqlText }).openbooksSqlTextAdminUsersParty = sqlText

const KNOWN_PARTIES = [PARTY_A, PARTY_B, PARTY_INACTIVE, OTHER_ORG_PARTY]

function partyInText(text: string): string | null {
  const lower = text.toLowerCase()
  for (const id of KNOWN_PARTIES) {
    if (lower.includes(id.toLowerCase())) return id
  }
  return null
}

function allPartiesInText(text: string): string[] {
  const lower = text.toLowerCase()
  return KNOWN_PARTIES.filter((id) => lower.includes(id.toLowerCase()))
}

const mockSources = new Map<string, string>([
  [
    'mock:db',
    `
      const state = globalThis[Symbol.for('openbooks.admin-users-party-test')]
      const sqlText = globalThis.openbooksSqlTextAdminUsersParty
      const KNOWN = ${JSON.stringify(KNOWN_PARTIES)}
      const isWrite = (text) =>
        text.includes('update users set party_id') ||
        text.includes('insert into audit_log')
      const rowsFor = (text) => {
        const lower = text.toLowerCase()
        // POST: lock target user row.
        if (text.includes('select id, party_id from users')) {
          if (lower.includes('${TARGET_ID}'.toLowerCase())) {
            return [{ id: '${TARGET_ID}', party_id: state.currentPartyId }]
          }
          return []
        }
        // POST: validate native party (same-org, with kind/display/active).
        if (text.includes('select id, kind, display_name, is_active from parties')) {
          const found = KNOWN.map((id) => ({ id, row: state.parties[id] }))
            .find(({ id, row }) => row && row.orgId === '${ORG_ID}' && lower.includes(id.toLowerCase()))
          if (!found) return []
          return [{ id: found.id, kind: found.row.kind, display_name: found.row.displayName, is_active: found.row.isActive }]
        }
        // POST: canonical role signals for audit only.
        if (text.includes("select 'vendor' as role")) {
          const ids = KNOWN.filter((id) => lower.includes(id.toLowerCase()))
          const target = ids.length === 1 ? state.parties[ids[0]] : null
          if (!target || target.orgId !== '${ORG_ID}') return []
          return target.roles.map((role) => ({ role }))
        }
        // POST: conditional link update with concurrency predicate.
        if (text.includes('update users set party_id')) {
          if (!lower.includes('${TARGET_ID}'.toLowerCase())) return []
          const where = text.slice(text.toLowerCase().indexOf('where'))
          const setPart = text.slice(0, text.toLowerCase().indexOf('where'))
          let requested = null
          const setIds = KNOWN.filter((id) => setPart.toLowerCase().includes(id.toLowerCase()))
          if (setIds.length > 0) requested = setIds[0].toLowerCase()
          else if (!setPart.toLowerCase().includes('null')) return []
          let expected = null
          if (where.includes('party_id is null')) expected = null
          else {
            const whereIds = KNOWN.filter((id) => where.toLowerCase().includes(id.toLowerCase()))
            if (whereIds.length === 0) return []
            expected = whereIds[0].toLowerCase()
          }
          const current = state.currentPartyId ? state.currentPartyId.toLowerCase() : null
          if (current !== expected) return []
          state.currentPartyId = requested
          return [{ id: '${TARGET_ID}' }]
        }
        // GET: per-query bounded active-person page.
        if (text.includes('from parties p') && text.includes('group by p.id')) {
          // Selected preservation lookup has an id equality predicate.
          const hasIdPredicate = text.includes('and p.id =')
          if (hasIdPredicate) {
            const target = KNOWN.map((id) => ({ id, row: state.parties[id] }))
              .find(({ id, row }) => row && row.orgId === '${ORG_ID}' && lower.includes(id.toLowerCase()))
            if (!target) return []
            return [{
              id: target.id,
              display_name: target.row.displayName,
              kind: target.row.kind,
              is_active: target.row.isActive,
              roles: target.row.roles,
            }]
          }
          const likeMatch = text.match(/%([^%]*)%/g)
          let q = ''
          if (likeMatch && likeMatch.length > 0) {
            const first = likeMatch[0]
            q = first.slice(1, -1).toLowerCase()
          }
          const limitMatch = text.match(/limit\\s+(\\d+)/i)
          const limit = limitMatch ? Math.max(5, Math.min(50, Number(limitMatch[1]))) : 25
          const rows = Object.entries(state.parties)
            .filter(([, row]) => row.orgId === '${ORG_ID}' && row.isActive)
            .filter(([, row]) => !q || row.displayName.toLowerCase().includes(q))
            .sort((a, b) => a[1].displayName.localeCompare(b[1].displayName))
            .slice(0, limit)
            .map(([id, row]) => ({ id, display_name: row.displayName, kind: row.kind, roles: row.roles }))
          return rows
        }
        return []
      }
      export const db = {
        async execute(query) {
          const text = sqlText(query)
          state.executed.push(text)
          if (state.failOnText && text.includes(state.failOnText)) {
            throw new Error('forced storage failure: ' + state.failOnText)
          }
          if (isWrite(text)) {
            const ledger = state.inTx ? state.pending : state.committed
            ledger.push(text)
          }
          return { rows: rowsFor(text) }
        },
        transaction: async (work) => work({}),
      }
      export async function withTransactionSavepoint(_runner, work) {
        const start = state.pending.length
        const currentBefore = state.currentPartyId
        try { return await work() }
        catch (error) {
          state.pending.splice(start)
          state.currentPartyId = currentBefore
          throw error
        }
      }
      export async function withOrgTransaction(_orgId, work) {
        state.transactionCalls++
        if (state.inTx) return work()
        state.inTx = true
        state.pending = []
        const currentBefore = state.currentPartyId
        try {
          const result = await work()
          // A 409/404 NextResponse return still commits nothing new except
          // reads; writes only commit when the handler did not throw. The
          // savepoint above already rolled back on throw; here a returned
          // error response must not commit a partial link without audit, so
          // only commit when the response is ok or a no-op ok.
          state.committed.push(...state.pending)
          return result
        } catch (error) {
          state.currentPartyId = currentBefore
          throw error
        } finally {
          state.inTx = false
          state.pending = []
        }
      }
      export async function withOrg(_orgId, work) { return work() }
      export async function withOrgContext(_orgId, work) { return work() }
      export async function withBypass(work) { return work() }
      export async function withBypassContext(_opts, work) { return work() }
      export const pool = {}
      export const env = {}
      export const schema = {}
      export function registerRequestOrgResolver() {}
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
  [
    'mock:authz',
    `
      import { NextResponse } from 'next/server'
      const state = globalThis[Symbol.for('openbooks.admin-users-party-test')]
      export async function guardPermission(perm) {
        const authz = state.authz
        if (!authz) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
        const holds = authz.permissions.has(perm) || authz.permissions.has('*')
        if (!holds) return NextResponse.json({ error: 'missing permission: ' + perm }, { status: 403 })
        return { ...authz, allowedSubsidiaryIds: null }
      }
      export async function getAuthz() { return state.authz }
    `,
  ],
])

const mockUrls = new Map<string, string>([
  ['@openbooks/engine/src/db.ts', 'mock:db'],
  ['@/lib/api/json', 'mock:json'],
  ['../../../../lib/authz', 'mock:authz'],
])

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') {
      return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
    }
    const mocked = mockUrls.get(specifier)
    if (mocked) return { url: mocked, shortCircuit: true }
    // Mock modules live at synthetic `mock:` URLs; bare imports from inside
    // them (next/server) must resolve from this test file, not from `mock:`.
    if (context.parentURL?.startsWith('mock:')) {
      return nextResolve(specifier, { ...context, parentURL: import.meta.url })
    }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    const source = mockSources.get(url)
    if (source !== undefined) return { format: 'module', source, shortCircuit: true }
    return nextLoad(url, context)
  },
})

const routeUrl = './route.ts?admin-users-party-test'
const { POST, GET } = (await import(routeUrl)) as typeof import('./route.ts')
hooks.deregister()

function reset(): void {
  state.executed = []
  state.committed = []
  state.pending = []
  state.inTx = false
  state.transactionCalls = 0
  state.failOnText = undefined
  state.currentPartyId = null
  state.authz = {
    user: { orgId: ORG_ID, id: ACTOR_ID, isSuperAdmin: false },
    permissions: new Set(['admin.users.manage']),
  }
  state.parties = baseParties()
}

function post(body: Record<string, unknown>): Promise<Response> {
  return POST(
    new Request('http://openbooks.test/api/admin/users', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )
}

function get(path: string): Promise<Response> {
  return GET(new Request(`http://openbooks.test${path}`, { method: 'GET' }))
}

const validLink = (overrides: Record<string, unknown> = {}) => ({
  action: 'set-party',
  userId: TARGET_ID,
  partyId: PARTY_A,
  expectedPartyId: null,
  reason: 'HR approver needs a linked person',
  attestation: true,
  ...overrides,
})

test('unauthorized callers cannot change links', async () => {
  reset()
  state.authz = null
  const unauthenticated = await post(validLink())
  assert.equal(unauthenticated.status, 401)

  reset()
  state.authz = {
    user: { orgId: ORG_ID, id: ACTOR_ID, isSuperAdmin: false },
    permissions: new Set(['gl.read']),
  }
  const forbidden = await post(validLink())
  assert.equal(forbidden.status, 403)
  assert.equal(state.currentPartyId, null)
  assert.equal(state.committed.some((t) => t.includes('update users set party_id')), false)
  assert.equal(state.committed.some((t) => t.includes('insert into audit_log')), false)

  const searchDenied = await get('/api/admin/users?q=ada')
  assert.equal(searchDenied.status, 403)
})

test('changing your own link is refused even as superadmin, including unlink', async () => {
  for (const isSuperAdmin of [false, true]) {
    reset()
    state.authz = {
      user: { orgId: ORG_ID, id: ACTOR_ID, isSuperAdmin },
      permissions: new Set(['admin.users.manage', '*']),
    }
    const link = await post(validLink({ userId: ACTOR_ID }))
    assert.equal(link.status, 403)
    assert.match(((await link.json()) as { error: string }).error, /own linked person/i)

    const unlink = await post(validLink({ userId: ACTOR_ID, partyId: null, expectedPartyId: null }))
    assert.equal(unlink.status, 403)
    assert.equal(state.currentPartyId, null)
    assert.equal(state.committed.some((t) => t.includes('update users set party_id')), false)
    assert.equal(state.committed.some((t) => t.includes('insert into audit_log')), false)
  }
})

test('attestation absent or false is refused without mutation', async () => {
  reset()
  const { attestation: _omit, ...without } = validLink()
  const missing = await post(without)
  assert.equal(missing.status, 400)
  assert.match(((await missing.json()) as { error: string }).error, /attestation/i)

  const falseAtt = await post(validLink({ attestation: false }))
  assert.equal(falseAtt.status, 400)
  assert.equal(state.currentPartyId, null)
  assert.equal(state.committed.some((t) => t.includes('update users set party_id')), false)
})

test('blank and overlong reasons are refused', async () => {
  reset()
  const blank = await post(validLink({ reason: '   ' }))
  assert.equal(blank.status, 400)
  const long = await post(validLink({ reason: 'x'.repeat(501) }))
  assert.equal(long.status, 400)
  assert.equal(state.currentPartyId, null)
})

test('wrong-org user and wrong-org party fail without leak or mutation', async () => {
  reset()
  const wrongUser = await post(validLink({ userId: OTHER_USER_ID }))
  assert.equal(wrongUser.status, 404)
  assert.equal(((await wrongUser.json()) as { error: string }).error, 'user not found')

  const crossOrg = await post(validLink({ partyId: OTHER_ORG_PARTY }))
  assert.equal(crossOrg.status, 404)
  assert.equal(((await crossOrg.json()) as { error: string }).error, 'party not found')
  assert.equal(state.currentPartyId, null)
  assert.equal(state.committed.some((t) => t.includes('update users set party_id')), false)
  assert.equal(state.committed.some((t) => t.includes('insert into audit_log')), false)
})

test('inactive parties fail closed and never link drafts', async () => {
  reset()
  const inactive = await post(validLink({ partyId: PARTY_INACTIVE }))
  assert.equal(inactive.status, 422)
  assert.match(((await inactive.json()) as { error: string }).error, /not active/i)
  assert.equal(state.currentPartyId, null)
  assert.equal(state.committed.some((t) => t.includes('insert into audit_log')), false)
})

test('stale expected link reports 409 with no mutation or audit', async () => {
  reset()
  state.currentPartyId = PARTY_A
  const stale = await post(validLink({ partyId: PARTY_B, expectedPartyId: null }))
  assert.equal(stale.status, 409)
  assert.equal(state.currentPartyId, PARTY_A)
  assert.equal(state.committed.some((t) => t.includes('update users set party_id')), false)
  assert.equal(state.committed.some((t) => t.includes('insert into audit_log')), false)
})

test('valid link audits exact before/after, reason, attestation, and kind/role signals', async () => {
  reset()
  const response = await post(validLink({ partyId: PARTY_B, expectedPartyId: null, reason: 'Link Beta as approver' }))
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { ok: true, userId: TARGET_ID, partyId: PARTY_B.toLowerCase() })
  assert.equal(state.currentPartyId, PARTY_B.toLowerCase())
  const audit = state.committed.find((t) => t.includes('insert into audit_log'))
  assert.ok(audit, 'link audit committed')
  // Exact before/after pair, reason, attestation, and signals (kind=company
  // with employee role proves kind is recorded, never used as proof).
  assert.match(audit, /user-party-linked/)
  assert.match(audit, new RegExp(PARTY_B.toLowerCase()))
  assert.match(audit, /Link Beta as approver/)
  assert.match(audit, /attestation/)
  assert.match(audit, /Beta Corp/)
  assert.match(audit, /employee/)
  assert.match(audit, new RegExp(ACTOR_ID.toLowerCase()))
})

test('valid unlink and change audit with precise row counts', async () => {
  reset()
  state.currentPartyId = PARTY_A
  const unlink = await post(validLink({ partyId: null, expectedPartyId: PARTY_A, reason: 'Left the org' }))
  assert.equal(unlink.status, 200)
  assert.deepEqual(await unlink.json(), { ok: true, userId: TARGET_ID, partyId: null })
  assert.equal(state.currentPartyId, null)
  const unlinkAudit = state.committed.find((t) => t.includes('insert into audit_log'))
  assert.ok(unlinkAudit)
  assert.match(unlinkAudit, /user-party-unlinked/)
  assert.match(unlinkAudit, /Left the org/)

  state.committed = []
  state.executed = []
  state.currentPartyId = PARTY_A
  const change = await post(
    validLink({ partyId: PARTY_B, expectedPartyId: PARTY_A, reason: 'Corrected identity' }),
  )
  assert.equal(change.status, 200)
  assert.equal(state.currentPartyId, PARTY_B.toLowerCase())
  const changeAudit = state.committed.find((t) => t.includes('insert into audit_log'))
  assert.ok(changeAudit)
  assert.match(changeAudit, /user-party-changed/)
})

test('concurrent writers from the same snapshot: only one succeeds', async () => {
  reset()
  const first = await post(validLink({ partyId: PARTY_A, expectedPartyId: null, reason: 'First writer' }))
  assert.equal(first.status, 200)
  const second = await post(validLink({ partyId: PARTY_B, expectedPartyId: null, reason: 'Second writer' }))
  assert.equal(second.status, 409)
  assert.equal(state.currentPartyId, PARTY_A.toLowerCase())
  assert.equal(
    state.committed.filter((t) => t.includes('update users set party_id')).length,
    1,
    'exactly one link update committed',
  )
  assert.equal(
    state.committed.filter((t) => t.includes('insert into audit_log')).length,
    1,
    'exactly one link audit committed',
  )
})

test('a failed link audit rolls back the party update', async () => {
  reset()
  state.failOnText = 'insert into audit_log'
  await assert.rejects(() => post(validLink()), /forced storage failure/)
  assert.equal(state.currentPartyId, null, 'the link did not survive a failed audit')
  assert.equal(
    state.committed.some((t) => t.includes('update users set party_id')),
    false,
  )
  assert.equal(
    state.committed.some((t) => t.includes('insert into audit_log')),
    false,
  )
})

test('person search is per-query bounded and finds people beyond the first page', async () => {
  reset()
  // Seed 30 active people beyond any fixed first-N window; a bounded
  // per-query page with a selective q must still find the later person.
  for (let i = 0; i < 30; i += 1) {
    const id = `00000000-0000-4000-8000-00000000c${String(i).padStart(3, '0')}`.slice(0, 36)
    state.parties[id] = {
      kind: 'person',
      displayName: `Person ${String(i).padStart(2, '0')} Zed`,
      isActive: true,
      roles: [],
      orgId: ORG_ID,
    }
  }
  state.parties['00000000-0000-4000-8000-00000000c999'] = {
    kind: 'person',
    displayName: 'Zelda Zulu',
    isActive: true,
    roles: [],
    orgId: ORG_ID,
  }
  const response = await get('/api/admin/users?q=zelda&limit=5')
  assert.equal(response.status, 200)
  const payload = (await response.json()) as {
    options: { value: string; label: string }[]
    selected: unknown
  }
  assert.ok(payload.options.some((o) => o.label === 'Zelda Zulu'), 'selective query finds the later person')
  assert.ok(payload.options.length <= 5, 'per-query page stays bounded')
  const asked = state.executed.find((t) => t.includes('from parties p'))
  assert.ok(asked && /ilike/i.test(asked) && /limit/i.test(asked), 'search filters per query with a bounded limit')
})

test('person search preserves the selected option across queries', async () => {
  reset()
  const response = await get(`/api/admin/users?q=zzz-no-match&limit=5&include=${PARTY_A}`)
  assert.equal(response.status, 200)
  const payload = (await response.json()) as {
    options: unknown[]
    selected: { value: string; label: string } | null
  }
  assert.equal(payload.options.length, 0)
  assert.ok(payload.selected, 'selected option is preserved when the page does not contain it')
  assert.equal(payload.selected?.value, PARTY_A.toLowerCase())

  const crossOrg = await get(`/api/admin/users?q=&limit=5&include=${OTHER_ORG_PARTY}`)
  assert.equal(crossOrg.status, 200)
  const crossPayload = (await crossOrg.json()) as { selected: unknown }
  assert.equal(crossPayload.selected, null, 'cross-org include discloses nothing')
})
