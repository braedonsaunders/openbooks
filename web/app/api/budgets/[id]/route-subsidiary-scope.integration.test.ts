import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import type { SessionUser } from '../../../../lib/auth'

/**
 * Scenario-level subsidiary authority for budget scenarios.
 *
 * A scenario's lines can span subsidiaries while its status, name and
 * revision govern the whole scenario. Reads (GET, export) reveal only
 * scenarios wholly within scope — anything else answers as missing.
 * Scenario-level writes (PATCH, DELETE, lines, import, submit/approve/
 * reject/archive) require authority over every subsidiary the lines touch
 * and refuse by name otherwise. Regression: an A-scoped approver on an
 * A+B scenario is refused naming B; on an A-only scenario, approved.
 * Only the session is stubbed; gates, permission resolution and storage
 * are real.
 */
const root = pathToFileURL(process.cwd() + '/').href
const state: { user: SessionUser | null } = { user: null }
Object.assign(globalThis, { __budgetScopeUser: state })
const virtual = (source: string) => ({ shortCircuit: true as const, url: 'data:text/javascript,' + encodeURIComponent(source) })
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'server-only') return virtual('export {}')
    if ((specifier === './auth' || specifier.endsWith('/lib/auth')) && context.parentURL?.endsWith('/web/lib/authz.ts')) {
      return virtual('export async function currentUser(){return globalThis.__budgetScopeUser.user}')
    }
    if (specifier.startsWith('@/')) return next(root + 'web/' + specifier.slice(2) + '.ts', context)
    return next(specifier, context)
  },
})
const { db, withBypassContext, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { sql } = await import('drizzle-orm')
const { createScratchOrg, createScratchUser, dropScratchOrg } =
  await import('@openbooks/engine/src/testing/fixtures.ts')
const { GET, PATCH, DELETE } = await import('./route')
const { POST: act } = await import('./actions/route')
const { GET: exportScenario } = await import('./export/route')
const { PATCH: saveLines } = await import('./lines/route')
const { POST: importScenario } = await import('./import/route')
const DB = !!process.env.OPENBOOKS_DB_URL

function sessionUser(id: string, orgId: string): SessionUser {
  return {
    id, orgId, name: 'tester', email: `tester-${id.slice(0, 8)}@scratch.test`, roles: [],
    isSuperAdmin: false, envKind: 'production', productionOrgId: orgId,
    homeOrgId: orgId, homeUserId: id,
  }
}

async function enableBudgets(orgId: string): Promise<void> {
  await withBypassContext(() =>
    db.execute(sql`
      update orgs set settings = jsonb_set(
        settings, '{features}',
        coalesce(settings->'features', '{}'::jsonb) || '{"budgets":true}'::jsonb, true)
      where id = ${orgId}`),
  )
}

async function makeBranch(orgId: string, rootId: string): Promise<string> {
  const branch = randomUUID()
  await withBypassContext(() => db.execute(sql`
    insert into subsidiaries
      (id, org_id, parent_id, name, base_currency, country, tax_ids, is_elimination, is_active, custom)
    values (${branch}, ${orgId}, ${rootId}, 'Scope Branch', 'CAD', 'CA', '{}'::jsonb, false, true, '{}'::jsonb)`))
  return branch
}

async function makeScenario(
  orgId: string, bookId: string, name: string, status: string, submittedBy: string | null,
): Promise<string> {
  const id = randomUUID()
  // Insert as a draft first: the ledger refuses a submitted/approved
  // scenario with no non-zero lines. Callers add lines, then submitScenario.
  await withBypassContext(() => db.execute(sql`
    insert into budget_scenarios (id, org_id, book_id, fiscal_year, name, kind, status)
    values (${id}, ${orgId}, ${bookId}, 2026, ${name}, 'budget', 'draft')`))
  if (status !== 'draft') await submitScenario(orgId, id, status, submittedBy)
  return id
}

async function submitScenario(
  orgId: string, id: string, status: string, submittedBy: string | null,
): Promise<void> {
  await withBypassContext(() => db.execute(sql`
    update budget_scenarios set status = ${status}, submitted_by = ${submittedBy}, revision = revision + 1
     where id = ${id} and org_id = ${orgId}`))
}

async function addLine(
  orgId: string, scenarioId: string, accountId: string, periodId: string,
  subsidiaryId: string, actorId: string,
): Promise<void> {
  await withBypassContext(() => db.execute(sql`
    insert into budget_lines
      (org_id, scenario_id, account_id, period_id, subsidiary_id, amount, created_by, updated_by)
    values (${orgId}, ${scenarioId}, ${accountId}, ${periodId}, ${subsidiaryId}, '100.0000', ${actorId}, ${actorId})`))
}

async function revisionOf(orgId: string, scenarioId: string): Promise<number> {
  const rows = (await withBypassContext(() => db.execute<{ revision: number }>(sql`
    select revision from budget_scenarios where id = ${scenarioId} and org_id = ${orgId}`)))
  return Number(rows.rows[0]?.revision ?? 1)
}

async function jsonResponse(response: Response) {
  return { status: response.status, json: await response.json() as Record<string, unknown> }
}

test('reads reveal only scenarios wholly within scope', { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg())
  try {
    await enableBudgets(org.orgId)
    const branch = await makeBranch(org.orgId, org.subsidiaryId)
    const actor = await withBypassContext(() => createScratchUser(org.orgId, 'maker', 'maker'))
    const cross = await makeScenario(org.orgId, org.bookId, 'Cross Scope', 'draft', null)
    await addLine(org.orgId, cross, org.accounts.cogs, org.periodId, org.subsidiaryId, actor)
    await addLine(org.orgId, cross, org.accounts.cogs, org.periodId, branch, actor)
    const home = await makeScenario(org.orgId, org.bookId, 'Home Only', 'draft', null)
    await addLine(org.orgId, home, org.accounts.cogs, org.periodId, org.subsidiaryId, actor)
    // A scenario with no lines in scope at all: its rows would filter to
    // nothing, so even the exported title must not disclose it.
    const hidden = await makeScenario(org.orgId, org.bookId, 'Hidden Only', 'draft', null)
    await addLine(org.orgId, hidden, org.accounts.cogs, org.periodId, branch, actor)

    const userId = await withBypassContext(() => createScratchUser(org.orgId, 'scope checker', 'scope_checker'))
    await withBypassContext(() => db.execute(sql`
      update app_roles
         set permissions = '["budgets.read", "budgets.manage", "budgets.approve", "data.export"]'::jsonb,
             subsidiary_restriction = ${JSON.stringify({ mode: 'list', subsidiaryIds: [org.subsidiaryId] })}::jsonb
       where org_id = ${org.orgId} and key = 'scope_checker'`))
    state.user = sessionUser(userId, org.orgId)
    const params = (id: string) => ({ params: Promise.resolve({ id }) })

    const crossGet = await withOrgContext(org.orgId, () =>
      GET(new Request(`http://budgets.test/api/budgets/${cross}`), params(cross)).then(jsonResponse))
    assert.equal(crossGet.status, 404, 'a cross-scope scenario reads as missing')
    assert.deepEqual(crossGet.json, { error: 'not_found' })
    const missingGet = await withOrgContext(org.orgId, () =>
      GET(new Request(`http://budgets.test/api/budgets/${randomUUID()}`), params(randomUUID())).then(jsonResponse))
    assert.deepEqual(crossGet.json, missingGet.json, 'cross-scope and missing read identically')

    const homeGet = await withOrgContext(org.orgId, () =>
      GET(new Request(`http://budgets.test/api/budgets/${home}`), params(home)).then(jsonResponse))
    assert.equal(homeGet.status, 200, 'an in-scope scenario still reads')

    // A partially-visible scenario keeps the house redacted view: 200
    // with only the caller's rows (locked in by the export visibility
    // test next door — asserted here only for status, not content).
    const crossExported = await withOrgContext(org.orgId, () =>
      exportScenario(
        new Request(`http://budgets.test/api/budgets/${cross}/export?format=csv`),
        params(cross),
      ))
    assert.equal(crossExported.status, 200, 'a partially-visible scenario exports its visible rows')
    await crossExported.text()
    // A scenario with nothing in scope answers as missing — the exported
    // title and filename must not disclose it.
    const hiddenExport = await withOrgContext(org.orgId, () =>
      exportScenario(
        new Request(`http://budgets.test/api/budgets/${hidden}/export?format=csv`),
        params(hidden),
      ).then(jsonResponse))
    assert.equal(hiddenExport.status, 404, 'export must not disclose an out-of-scope name')
    assert.deepEqual(hiddenExport.json, { error: 'not_found' })

    const crossRev = await revisionOf(org.orgId, cross)
    const crossPatch = await withOrgContext(org.orgId, () =>
      PATCH(new Request(`http://budgets.test/api/budgets/${cross}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Renamed', expectedRevision: crossRev }),
      }), params(cross)).then(jsonResponse))
    assert.equal(crossPatch.status, 404, 'rename of a cross-scope scenario reads as missing')

    const crossDelete = await withOrgContext(org.orgId, () =>
      DELETE(new Request(`http://budgets.test/api/budgets/${cross}`, { method: 'DELETE' }), params(cross))
        .then(jsonResponse))
    assert.equal(crossDelete.status, 404, 'delete of a cross-scope scenario reads as missing')
  } finally {
    state.user = null
    await withBypassContext(() => dropScratchOrg(org.orgId))
  }
})

test('writes refuse a cross-scope scenario by name', { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg())
  try {
    await enableBudgets(org.orgId)
    const branch = await makeBranch(org.orgId, org.subsidiaryId)
    const actor = await withBypassContext(() => createScratchUser(org.orgId, 'maker', 'maker'))
    const cross = await makeScenario(org.orgId, org.bookId, 'Cross Scope', 'draft', null)
    await addLine(org.orgId, cross, org.accounts.cogs, org.periodId, org.subsidiaryId, actor)
    await addLine(org.orgId, cross, org.accounts.cogs, org.periodId, branch, actor)

    const userId = await withBypassContext(() => createScratchUser(org.orgId, 'scope writer', 'scope_writer'))
    await withBypassContext(() => db.execute(sql`
      update app_roles
         set permissions = '["budgets.read", "budgets.manage", "budgets.approve", "data.export"]'::jsonb,
             subsidiary_restriction = ${JSON.stringify({ mode: 'list', subsidiaryIds: [org.subsidiaryId] })}::jsonb
       where org_id = ${org.orgId} and key = 'scope_writer'`))
    state.user = sessionUser(userId, org.orgId)
    const params = { params: Promise.resolve({ id: cross }) }
    const rev = await revisionOf(org.orgId, cross)

    const lines = await withOrgContext(org.orgId, () =>
      saveLines(new Request(`http://budgets.test/api/budgets/${cross}/lines`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedRevision: rev, cells: [] }),
      }), params).then(jsonResponse))
    assert.equal(lines.status, 403, 'cell save on a cross-scope scenario is refused')
    assert.match(String(lines.json.error ?? ''), /out_of_scope_subsidiaries/)
    assert.match(String(lines.json.error ?? ''), /Scope Branch/, 'the refusal names the out-of-scope subsidiary')

    const imported = await withOrgContext(org.orgId, () =>
      importScenario(new Request(`http://budgets.test/api/budgets/${cross}/import`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ format: 'csv', expectedRevision: rev, text: 'Account Number\n12345', commit: false }),
      }), params).then(jsonResponse))
    assert.equal(imported.status, 403, 'import into a cross-scope scenario is refused')
    assert.match(String(imported.json.error ?? ''), /Scope Branch/)
  } finally {
    state.user = null
    await withBypassContext(() => dropScratchOrg(org.orgId))
  }
})

test('an A-scoped approver is refused on A+B but approves A-only', { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg())
  try {
    await enableBudgets(org.orgId)
    const branch = await makeBranch(org.orgId, org.subsidiaryId)
    const maker = await withBypassContext(() => createScratchUser(org.orgId, 'maker', 'maker'))
    const cross = await makeScenario(org.orgId, org.bookId, 'Cross Pending', 'draft', null)
    await addLine(org.orgId, cross, org.accounts.cogs, org.periodId, org.subsidiaryId, maker)
    await addLine(org.orgId, cross, org.accounts.cogs, org.periodId, branch, maker)
    await submitScenario(org.orgId, cross, 'pending_approval', maker)
    const home = await makeScenario(org.orgId, org.bookId, 'Home Pending', 'draft', null)
    await addLine(org.orgId, home, org.accounts.cogs, org.periodId, org.subsidiaryId, maker)
    await submitScenario(org.orgId, home, 'pending_approval', maker)

    const approver = await withBypassContext(() => createScratchUser(org.orgId, 'approver', 'checker'))
    await withBypassContext(() => db.execute(sql`
      update app_roles
         set permissions = '["budgets.read", "budgets.manage", "budgets.approve"]'::jsonb,
             subsidiary_restriction = ${JSON.stringify({ mode: 'list', subsidiaryIds: [org.subsidiaryId] })}::jsonb
       where org_id = ${org.orgId} and key = 'checker'`))
    state.user = sessionUser(approver, org.orgId)
    const approve = (id: string, rev: number) =>
      withOrgContext(org.orgId, () =>
        act(new Request(`http://budgets.test/api/budgets/${id}/actions`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'approve', expectedRevision: rev }),
        }), { params: Promise.resolve({ id }) }).then(jsonResponse))

    const refused = await approve(cross, await revisionOf(org.orgId, cross))
    assert.equal(refused.status, 403, 'approving a cross-scope scenario is refused')
    assert.match(String(refused.json.error ?? ''), /out_of_scope_subsidiaries/)
    assert.match(String(refused.json.error ?? ''), /Scope Branch/)

    const approved = await approve(home, await revisionOf(org.orgId, home))
    assert.equal(approved.status, 200, `an in-scope scenario approves: ${JSON.stringify(approved.json)}`)
    assert.equal(approved.json.status, 'approved')
  } finally {
    state.user = null
    await withBypassContext(() => dropScratchOrg(org.orgId))
  }
})
