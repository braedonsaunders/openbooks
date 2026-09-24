import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { createScratchOrg, dropScratchOrg, seedFlowActors } from '@openbooks/engine/src/testing/fixtures.ts'
import { importStatement, startReconciliation } from '@openbooks/engine/src/banking/banking.ts'
import type { Authz } from '../../../lib/authz'

// Banking subsidiary boundary at the HTTP layer (AUDIT-H): every route that
// resolves a bank account, session, statement line, feed connection, or
// import schedule hides out-of-scope rows (uniform not-found / filtered
// lists), and org-wide configuration (servers, rule definitions) requires
// unrestricted scope. Only the authorization seam is substituted; feature
// checks, routes, domain services, and SQL are native.

const enabled = !!process.env.OPENBOOKS_DB_URL
const state: { gate: Authz | null } = { gate: null }
;(globalThis as typeof globalThis & Record<symbol, unknown>)[Symbol.for('openbooks.banking-scope-routes')] = state
registerHooks({ resolve(specifier, context, next) {
  if (specifier === '@/lib/api/json') return next(new URL('../../../lib/api/json.ts', import.meta.url).href, context)
  if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' }
  if (specifier === './authz' && (context.parentURL ?? '').endsWith('/lib/feature-gates.ts')) {
    return { shortCircuit: true, url: 'data:text/javascript,' + encodeURIComponent(
      `export async function guardPermission(permission) {
        const state = globalThis[Symbol.for('openbooks.banking-scope-routes')]
        if (!state.gate) return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 })
        if (!state.gate.permissions.has('*') && !state.gate.permissions.has(permission)) {
          return new Response(JSON.stringify({ error: 'missing permission: ' + permission }), { status: 403 })
        }
        return state.gate
      }
      export async function getAuthz() { return globalThis[Symbol.for('openbooks.banking-scope-routes')].gate }`,
    ) }
  }
  return next(specifier, context)
} })

const reconList = await import('./reconciliations/route.ts')
const reconSession = await import('./reconciliations/[id]/route.ts')
const reconMatches = await import('./reconciliations/[id]/matches/route.ts')
const reconAutoMatch = await import('./reconciliations/[id]/auto-match/route.ts')
const reconSignOff = await import('./reconciliations/[id]/sign-off/route.ts')
const reconEnsure = await import('./reconciliations/ensure/route.ts')
const rules = await import('./rules/route.ts')
const ruleById = await import('./rules/[id]/route.ts')
const rulesPreview = await import('./rules/preview/route.ts')
const rulesApply = await import('./rules/apply/route.ts')
const rulesApplyLine = await import('./rules/apply-line/route.ts')
const bankImport = await import('./import/route.ts')
const stmtLine = await import('./statement-lines/[id]/route.ts')
const stmtCreateMatch = await import('./statement-lines/[id]/create-match/route.ts')
const stmtBulk = await import('./statement-lines/bulk/route.ts')
const feeds = await import('./bank-feeds/route.ts')
const feedById = await import('./bank-feeds/[id]/route.ts')
const sftpServers = await import('./sftp/route.ts')
const sftpServerById = await import('./sftp/[id]/route.ts')
const sftpSchedules = await import('./sftp/schedules/route.ts')
const sftpScheduleById = await import('./sftp/schedules/[id]/route.ts')

interface Fixture {
  orgId: string
  actor: string
  date: string
  subA: string
  subB: string
  bankA: string
  bankB: string
  bankShared: string
  sessionA: string
  sessionB: string
  sessionShared: string
  lineA: string
  lineB: string
  feedB: string
  server: string
  scheduleA: string
  scheduleB: string
}

async function fixture(): Promise<Fixture> {
  const org = await createScratchOrg()
  const actor = (await seedFlowActors(org.orgId)).adminId
  await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features}',
    coalesce(settings->'features','{}'::jsonb)||'{"bankFeeds":true}'::jsonb) where id=${org.orgId}`)
  const subB = randomUUID()
  await db.execute(sql`insert into subsidiaries (id, org_id, parent_id, name, base_currency, country)
    values (${subB}, ${org.orgId}, ${org.subsidiaryId}, 'Second entity', 'CAD', 'CA')`)
  const bankB = randomUUID()
  const bankShared = randomUUID()
  await db.execute(sql`insert into accounts
    (id, org_id, number, name, type, is_summary, is_active, eliminate,
     reconcilable, required_dimensions, custom, subsidiary_include_children,
     subsidiary_id, currency_restriction)
    values
      (${bankB}, ${org.orgId}, '1011', 'Second entity bank', 'asset_bank',
       false, true, false, true, '[]'::jsonb, '{}'::jsonb, true, ${subB}, 'CAD'),
      (${bankShared}, ${org.orgId}, '1012', 'Shared bank', 'asset_bank',
       false, true, false, true, '[]'::jsonb, '{}'::jsonb, true, null, 'CAD')`)
  await db.execute(sql`update accounts set reconcilable = true, currency_restriction = 'CAD',
    subsidiary_id = ${org.subsidiaryId} where id = ${org.accounts.bank} and org_id = ${org.orgId}`)
  const bankA = org.accounts.bank
  const nonce = randomUUID().slice(0, 8)
  for (const [account, tag] of [[bankA, 'route-a'], [bankB, 'route-b'], [bankShared, 'route-s']] as const) {
    await importStatement(
      {
        accountId: account,
        source: 'ofx',
        statementDate: org.date,
        openingBalance: '0',
        closingBalance: '5',
        currency: 'CAD',
        lines: [{
          postedOn: org.date,
          amount: '5',
          description: `${tag} probe`,
          bankTransactionId: `${tag}-${nonce}`,
        }],
      },
      { orgId: org.orgId, userId: actor, allowedSubsidiaryIds: null },
    )
  }
  const lines = (await db.execute<{ account_id: string; id: string }>(sql`
    select account_id, id from bank_statement_lines where org_id = ${org.orgId}`)).rows
  const lineOf = (account: string) => lines.find((l) => l.account_id === account)!.id
  const ctx = { orgId: org.orgId, userId: actor, allowedSubsidiaryIds: null }
  const sessionA = (await startReconciliation({ accountId: bankA, throughDate: org.date, statementBalance: '5' }, ctx)).id
  const sessionB = (await startReconciliation({ accountId: bankB, throughDate: org.date, statementBalance: '5' }, ctx)).id
  const sessionShared = (await startReconciliation({ accountId: bankShared, throughDate: org.date, statementBalance: '5' }, ctx)).id
  const feedB = randomUUID()
  await db.execute(sql`insert into bank_feed_connections
    (id, org_id, name, provider, account_id, status, sync_cadence, created_by, updated_by)
    values (${feedB}, ${org.orgId}, 'B feed', 'manual', ${bankB}, 'connected', 'manual', ${actor}, ${actor})`)
  const server = randomUUID()
  await db.execute(sql`insert into sftp_servers
    (id, org_id, name, username, backend, root_prefix, created_by, updated_by)
    values (${server}, ${org.orgId}, 'Scope bank host', ${`scope-${nonce}`},
      'local', ${`sftp/${org.orgId}/scope-${nonce}`}, ${actor}, ${actor})`)
  const scheduleA = randomUUID()
  const scheduleB = randomUUID()
  await db.execute(sql`insert into sftp_import_schedules
    (id, org_id, sftp_server_id, account_id, created_by)
    values (${scheduleA}, ${org.orgId}, ${server}, ${bankA}, ${actor}),
           (${scheduleB}, ${org.orgId}, ${server}, ${bankB}, ${actor})`)
  return {
    orgId: org.orgId, actor, date: org.date, subA: org.subsidiaryId, subB,
    bankA, bankB, bankShared, sessionA, sessionB, sessionShared,
    lineA: lineOf(bankA), lineB: lineOf(bankB), feedB, server, scheduleA, scheduleB,
  }
}

function authorize(fx: Fixture, scope: 'all' | 'A'): void {
  state.gate = {
    user: { orgId: fx.orgId, id: fx.actor },
    permissions: new Set(['*']),
    allowedSubsidiaryIds: scope === 'all' ? null : new Set([fx.subA]),
  } as Authz
}

const get = (url: string) => new Request(url, { method: 'GET' })
const postJson = (url: string, body: unknown) => new Request(url, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
})
const patchJson = (url: string, body: unknown) => new Request(url, {
  method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
})
const params = (id: string) => ({ params: Promise.resolve({ id }) })
async function errorOf(res: Response): Promise<{ status: number; body: Record<string, unknown> }> {
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

test('reconciliation list hides out-of-scope sessions; detail is uniform not-found', { skip: !enabled }, async () => {
  const fx = await fixture()
  try {
    authorize(fx, 'A')
    const listed = (await (await reconList.GET(get('https://openbooks.test/api/banking/reconciliations'))).json()) as {
      reconciliations: { id: string }[]
    }
    const ids = listed.reconciliations.map((r) => r.id)
    assert.ok(ids.includes(fx.sessionA), 'own session is listed')
    assert.ok(!ids.includes(fx.sessionB), 'other entity session is hidden')
    assert.ok(!ids.includes(fx.sessionShared), 'shared-account session is hidden from restricted callers')
    authorize(fx, 'all')
    const all = (await (await reconList.GET(get('https://openbooks.test/api/banking/reconciliations'))).json()) as {
      reconciliations: { id: string }[]
    }
    assert.equal(all.reconciliations.length, 3)

    authorize(fx, 'A')
    const hidden = await errorOf(await reconSession.GET(get(`https://openbooks.test/x/${fx.sessionB}`), params(fx.sessionB)))
    assert.equal(hidden.status, 404)
    assert.equal(hidden.body.error, 'not found')
    const sharedHidden = await errorOf(await reconSession.GET(get(`https://openbooks.test/x/${fx.sessionShared}`), params(fx.sessionShared)))
    assert.equal(sharedHidden.status, 404)
    const shown = await reconSession.GET(get(`https://openbooks.test/x/${fx.sessionA}`), params(fx.sessionA))
    assert.equal(shown.status, 200)
    const shownBody = (await shown.json()) as { reconciliation: Record<string, unknown> }
    assert.ok(!('account_subsidiary_id' in shownBody.reconciliation), 'ownership column is not part of the response')
  } finally { state.gate = null; await dropScratchOrg(fx.orgId) }
})

test('session write verbs refuse across the boundary with 404', { skip: !enabled }, async () => {
  const fx = await fixture()
  try {
    authorize(fx, 'A')
    const base = 'https://openbooks.test/api/banking/reconciliations'
    const line = randomUUID()
    const match = await errorOf(await reconMatches.POST(
      postJson(`${base}/${fx.sessionB}/matches`, { statementLineId: line, journalLineIds: [randomUUID()] }),
      params(fx.sessionB),
    ))
    assert.equal(match.status, 404, JSON.stringify(match))
    const unmatch = await errorOf(await reconMatches.DELETE(
      new Request(`${base}/${fx.sessionB}/matches?statementLineId=${line}`, { method: 'DELETE' }),
      params(fx.sessionB),
    ))
    assert.equal(unmatch.status, 404)
    const auto = await errorOf(await reconAutoMatch.POST(
      new Request(`${base}/${fx.sessionB}/auto-match`, { method: 'POST' }), params(fx.sessionB),
    ))
    assert.equal(auto.status, 404)
    const signoff = await errorOf(await reconSignOff.POST(
      new Request(`${base}/${fx.sessionB}/sign-off`, { method: 'POST' }), params(fx.sessionB),
    ))
    // The engine denial (404) flows through bankingErrorResponse untouched.
    assert.equal(signoff.status, 404, JSON.stringify(signoff))
    const adjust = await errorOf(await reconSession.PATCH(
      patchJson(`${base}/${fx.sessionB}`, { statementBalance: '6' }), params(fx.sessionB),
    ))
    assert.equal(adjust.status, 404)
    const discard = await errorOf(await reconSession.DELETE(
      new Request(`${base}/${fx.sessionB}`, { method: 'DELETE' }), params(fx.sessionB),
    ))
    assert.equal(discard.status, 404)
    const ensure = await errorOf(await reconEnsure.POST(
      postJson('https://openbooks.test/api/banking/reconciliations/ensure', { accountId: fx.bankB }),
    ))
    assert.equal(ensure.status, 404)
    const start = await errorOf(await reconList.POST(
      postJson(base, { accountId: fx.bankShared, throughDate: fx.date, statementBalance: '5' }),
    ))
    assert.equal(start.status, 404)
    // The refused session is untouched.
    authorize(fx, 'all')
    const still = await reconSession.GET(get(`https://openbooks.test/x/${fx.sessionB}`), params(fx.sessionB))
    assert.equal(still.status, 200)
  } finally { state.gate = null; await dropScratchOrg(fx.orgId) }
})

test('bank-rule definitions require unrestricted scope', { skip: !enabled }, async () => {
  const fx = await fixture()
  try {
    authorize(fx, 'A')
    const base = 'https://openbooks.test/api/banking/rules'
    const created = await errorOf(await rules.POST(postJson(base, {
      name: 'Scope probe rule',
      criteria: { version: 2, match: { combinator: 'and', rules: [{ field: 'description', op: 'contains', value: 'scope' }] } },
      outcome: { action: 'exclude' },
    })))
    assert.equal(created.status, 403)
    assert.equal(created.body.error, 'requires unrestricted subsidiary access')
    const patched = await errorOf(await rules.PATCH(patchJson(base, {
      id: randomUUID(), name: 'Renamed',
      criteria: { version: 2, match: { combinator: 'and', rules: [{ field: 'description', op: 'contains', value: 'scope' }] } },
      outcome: { action: 'exclude' },
    })))
    assert.equal(patched.status, 403)
    assert.equal(patched.body.error, 'requires unrestricted subsidiary access')
    const removed = await errorOf(await ruleById.DELETE(
      new Request(`${base}/${randomUUID()}`, { method: 'DELETE' }), params(randomUUID()),
    ))
    assert.equal(removed.status, 403)
    assert.equal(removed.body.error, 'requires unrestricted subsidiary access')
    // Unrestricted callers manage rules end to end.
    authorize(fx, 'all')
    const ok = await rules.POST(postJson(base, {
      name: 'Scope probe rule',
      criteria: { version: 2, match: { combinator: 'and', rules: [{ field: 'description', op: 'contains', value: 'scope' }] } },
      outcome: { action: 'exclude' },
    }))
    assert.equal(ok.status, 200, JSON.stringify(await ok.clone().json()))
    const { id } = (await ok.json()) as { id: string }
    const renamed = await rules.PATCH(patchJson(base, {
      id, name: 'Scope probe rule 2',
      criteria: { version: 2, match: { combinator: 'and', rules: [{ field: 'description', op: 'contains', value: 'scope' }] } },
      outcome: { action: 'exclude' },
    }))
    assert.equal(renamed.status, 200)
    const deleted = await ruleById.DELETE(new Request(`${base}/${id}`, { method: 'DELETE' }), params(id))
    assert.equal(deleted.status, 200)
  } finally { state.gate = null; await dropScratchOrg(fx.orgId) }
})

test('rule data verbs refuse out-of-scope accounts', { skip: !enabled }, async () => {
  const fx = await fixture()
  try {
    const ruleId = randomUUID()
    await db.execute(sql`insert into bank_match_rules (id, org_id, name, criteria, outcome, priority, is_active, created_by)
      values (${ruleId}, ${fx.orgId}, 'Scope excluder',
        '{"version":2,"match":{"combinator":"and","rules":[{"field":"description","op":"contains","value":"probe"}]}}'::jsonb,
        '{"action":"exclude"}'::jsonb, 100, true, ${fx.actor})`)
    authorize(fx, 'A')
    const preview = await errorOf(await rulesPreview.POST(postJson(
      'https://openbooks.test/api/banking/rules/preview', { accountId: fx.bankB },
    )))
    assert.equal(preview.status, 404)
    const apply = await errorOf(await rulesApply.POST(postJson(
      'https://openbooks.test/api/banking/rules/apply', { accountId: fx.bankB },
    )))
    assert.equal(apply.status, 404)
    const applyLine = await errorOf(await rulesApplyLine.POST(postJson(
      'https://openbooks.test/api/banking/rules/apply-line', { statementLineId: fx.lineB, ruleId },
    )))
    assert.equal(applyLine.status, 404)
    // The refused line is still unmatched.
    const status = (await db.execute<{ s: string }>(sql`
      select match_status as s from bank_statement_lines where id = ${fx.lineB}`)).rows[0]!.s
    assert.equal(status, 'unmatched')
    // In-scope application still works.
    const applied = await rulesApply.POST(postJson(
      'https://openbooks.test/api/banking/rules/apply', { accountId: fx.bankA },
    ))
    assert.equal(applied.status, 200, JSON.stringify(await applied.clone().json()))
  } finally { state.gate = null; await dropScratchOrg(fx.orgId) }
})

test('import and statement-line verbs refuse out-of-scope accounts', { skip: !enabled }, async () => {
  const fx = await fixture()
  try {
    authorize(fx, 'A')
    const csv = 'date,amount,description\n2026-01-02,7,Scope probe import'
    const mapping = { date: 0, amount: 1, description: 2 }
    const refused = await errorOf(await bankImport.POST(postJson(
      'https://openbooks.test/api/banking/import',
      { accountId: fx.bankB, source: 'csv', text: csv, mapping, mode: 'preview' },
    )))
    assert.equal(refused.status, 404, JSON.stringify(refused))
    const previewed = await bankImport.POST(postJson(
      'https://openbooks.test/api/banking/import',
      { accountId: fx.bankA, source: 'csv', text: csv, mapping, mode: 'preview' },
    ))
    assert.equal(previewed.status, 200, JSON.stringify(await previewed.clone().json()))

    const excluded = await errorOf(await stmtLine.PATCH(
      patchJson(`https://openbooks.test/api/banking/statement-lines/${fx.lineB}`,
        { action: 'exclude', reason: 'a sufficient reason' }),
      params(fx.lineB),
    ))
    assert.equal(excluded.status, 404)
    const createMatch = await errorOf(await stmtCreateMatch.POST(
      postJson(`https://openbooks.test/api/banking/statement-lines/${fx.lineB}/create-match`,
        { reconciliationId: fx.sessionB, offsetAccountId: fx.bankA }),
      params(fx.lineB),
    ))
    assert.equal(createMatch.status, 404)
    // The duplicate-flag verbs gate the same way: the clear refuses before
    // reading any flag, and the bulk refuse precedes every line it would
    // touch.
    const clearDupe = await errorOf(await stmtLine.PATCH(
      patchJson(`https://openbooks.test/api/banking/statement-lines/${fx.lineB}`,
        { action: 'clear-duplicate' }),
      params(fx.lineB),
    ))
    assert.equal(clearDupe.status, 404)
    const bulk = await errorOf(await stmtBulk.POST(postJson(
      'https://openbooks.test/api/banking/statement-lines/bulk',
      { action: 'exclude-duplicates', accountId: fx.bankB, reason: 'a sufficient reason' },
    )))
    assert.equal(bulk.status, 404)
    const bulkStatus = (await db.execute<{ s: string }>(sql`
      select match_status as s from bank_statement_lines where id = ${fx.lineB}`)).rows[0]!.s
    assert.equal(bulkStatus, 'unmatched')
  } finally { state.gate = null; await dropScratchOrg(fx.orgId) }
})

test('bank feeds hide and refuse out-of-scope connections', { skip: !enabled }, async () => {
  const fx = await fixture()
  try {
    authorize(fx, 'A')
    const base = 'https://openbooks.test/api/banking/bank-feeds'
    const listed = (await (await feeds.GET()).json()) as { connections: { id: string }[] }
    assert.ok(!listed.connections.some((c) => c.id === fx.feedB), 'other entity connection is hidden')
    const created = await errorOf(await feeds.POST(postJson(base, {
      name: 'Cross feed', provider: 'manual', accountId: fx.bankB,
    })))
    assert.equal(created.status, 404)
    const patched = await errorOf(await feedById.PATCH(
      patchJson(`${base}/${fx.feedB}`, { name: 'Renamed' }), params(fx.feedB),
    ))
    assert.equal(patched.status, 404)
    const synced = await errorOf(await feedById.POST(
      postJson(`${base}/${fx.feedB}`, { action: 'sync' }), params(fx.feedB),
    ))
    assert.equal(synced.status, 404)
    const removed = await errorOf(await feedById.DELETE(
      new Request(`${base}/${fx.feedB}`, { method: 'DELETE' }), params(fx.feedB),
    ))
    assert.equal(removed.status, 404)
    // The refused connection is untouched.
    const row = (await db.execute<{ n: string }>(sql`
      select name as n from bank_feed_connections where id = ${fx.feedB}`)).rows[0]!.n
    assert.equal(row, 'B feed')
    // In-scope connections still manage end to end.
    authorize(fx, 'all')
    const listedAll = (await (await feeds.GET()).json()) as { connections: { id: string }[] }
    assert.ok(listedAll.connections.some((c) => c.id === fx.feedB))
  } finally { state.gate = null; await dropScratchOrg(fx.orgId) }
})

test('sftp servers require unrestricted scope', { skip: !enabled }, async () => {
  const fx = await fixture()
  try {
    authorize(fx, 'A')
    const base = 'https://openbooks.test/api/banking/sftp'
    const listed = (await (await sftpServers.GET()).json()) as { servers: unknown[] }
    assert.deepEqual(listed.servers, [])
    const created = await errorOf(await sftpServers.POST(postJson(base, { name: 'Scope host' })))
    assert.equal(created.status, 403)
    assert.equal(created.body.error, 'requires unrestricted subsidiary access')
    const toggled = await errorOf(await sftpServerById.PATCH(
      patchJson(`${base}/${fx.server}`, { action: 'toggle', isActive: false }), params(fx.server),
    ))
    assert.equal(toggled.status, 403)
    assert.equal(toggled.body.error, 'requires unrestricted subsidiary access')
    const removed = await errorOf(await sftpServerById.DELETE(
      new Request(`${base}/${fx.server}`, { method: 'DELETE' }), params(fx.server),
    ))
    assert.equal(removed.status, 403)
    assert.equal(removed.body.error, 'requires unrestricted subsidiary access')
  } finally { state.gate = null; await dropScratchOrg(fx.orgId) }
})

test('sftp schedules hide and refuse out-of-scope bindings', { skip: !enabled }, async () => {
  const fx = await fixture()
  try {
    authorize(fx, 'A')
    const base = 'https://openbooks.test/api/banking/sftp/schedules'
    const listed = (await (await sftpSchedules.GET()).json()) as { schedules: { id: string }[] }
    const ids = listed.schedules.map((s) => s.id)
    assert.ok(ids.includes(fx.scheduleA), 'own schedule is listed')
    assert.ok(!ids.includes(fx.scheduleB), 'other entity schedule is hidden')
    const created = await errorOf(await sftpSchedules.POST(postJson(base, {
      sftpServerId: fx.server, accountId: fx.bankB,
    })))
    assert.equal(created.status, 404)
    const ran = await errorOf(await sftpScheduleById.PATCH(
      patchJson(`${base}/${fx.scheduleB}`, { action: 'run' }), params(fx.scheduleB),
    ))
    // The run refuses as not-found before the engine scan ever starts.
    assert.equal(ran.status, 404, JSON.stringify(ran))
    const toggled = await errorOf(await sftpScheduleById.PATCH(
      patchJson(`${base}/${fx.scheduleB}`, { isActive: false }), params(fx.scheduleB),
    ))
    assert.equal(toggled.status, 404)
    const removed = await errorOf(await sftpScheduleById.DELETE(
      new Request(`${base}/${fx.scheduleB}`, { method: 'DELETE' }), params(fx.scheduleB),
    ))
    assert.equal(removed.status, 404)
    // In-scope schedules still manage.
    const own = await sftpSchedules.POST(postJson(base, { sftpServerId: fx.server, accountId: fx.bankA }))
    assert.equal(own.status, 200, JSON.stringify(await own.clone().json()))
  } finally { state.gate = null; await dropScratchOrg(fx.orgId) }
})
