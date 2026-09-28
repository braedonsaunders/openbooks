import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { registerHooks } from 'node:module'
import test from 'node:test'

// Exercise the action endpoint through real journal creation and posting. The
// session is the only boundary stubbed; journal lifecycle, posting, and the
// warning query all use the real local test database.
const stateKey = Symbol.for('openbooks.journal-actions-warning-test')
interface RouteState {
  authz: { user: { orgId: string; id: string }; permissions: Set<string>; allowedSubsidiaryIds: string[] | null } | null
}
const routeState: RouteState = { authz: null }
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState

const mockAuthz = `
  const state = globalThis[Symbol.for('openbooks.journal-actions-warning-test')]
  export async function guardPermission(perm) {
    if (!state.authz) return new Response(JSON.stringify({ error: 'authentication required' }), { status: 401 })
    if (!state.authz.permissions.has('*') && !state.authz.permissions.has(perm)) {
      return new Response(JSON.stringify({ error: 'missing permission: ' + perm }), { status: 403 })
    }
    return state.authz
  }
  export function guardSubsidiaryScope(authz, subsidiaryId) {
    if (!authz) return new Response(JSON.stringify({ error: 'not found', code: 'not_found' }), { status: 404 })
    if (authz.allowedSubsidiaryIds && subsidiaryId && !authz.allowedSubsidiaryIds.includes(subsidiaryId)) {
      return new Response(JSON.stringify({ error: 'not found', code: 'not_found' }), { status: 404 })
    }
    return null
  }
  export function subsidiariesInScope(authz, ids) {
    if (!authz || authz.allowedSubsidiaryIds === undefined) return false
    if (authz.allowedSubsidiaryIds === null) return true
    return ids.every((id) => id && authz.allowedSubsidiaryIds.includes(id))
  }
`

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '../../../../lib/authz' || specifier === '../../../lib/authz') {
      return { url: 'mock:journal-actions-authz', shortCircuit: true }
    }
    if (specifier === './auth' && context.parentURL?.endsWith('/web/lib/authz.ts')) return { shortCircuit: true, url: 'data:text/javascript,export async function currentUser(){return globalThis.__journalActionsSession ?? null}' }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    if (url === 'mock:journal-actions-authz') return { format: 'module', source: mockAuthz, shortCircuit: true }
    return nextLoad(url, context)
  },
})

const { POST: createJournal } = await import('../route.ts')
const { POST: postJournal } = await import('./route.ts')
const { POST: postGrantCommands } = await import('../../grants/commands/route.ts')
const { POST: postGrantPostings } = await import('../../grants/postings/route.ts')
const { POST: postEncumbranceCommands } = await import('../../encumbrances/commands/route.ts')
const { POST: postLiquidations } = await import('../../encumbrances/liquidations/route.ts')
const { createEncumbrance, listEncumbrances, getEncumbranceDetail } = await import('@openbooks/engine/src/nonprofit/encumbrances.ts')
const { createGrant, listGrants, getGrantTerms } = await import('@openbooks/engine/src/nonprofit/grants.ts')
const { NonprofitError } = await import('@openbooks/engine/src/nonprofit/errors.ts')
const { provisionFundAccounting } = await import('@openbooks/engine/src/nonprofit/provision.ts')
const { db, withBypassContext, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { sql } = await import('drizzle-orm')
const { createScratchOrg, dropScratchOrg, seedFlowActors, createScratchUser } = await import('@openbooks/engine/src/testing/fixtures.ts')
const DB = Boolean(process.env.OPENBOOKS_DB_URL)

test('posting a partyless control leg returns its typed warning with the entry id', { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg())
  try {
    const { adminId } = await withBypassContext(() => seedFlowActors(org.orgId))
    // Factory session runs the real chain; keep the same administrator both doubles see.
    ;(globalThis as Record<string, unknown>).__journalActionsSession = { id: adminId, orgId: org.orgId, isSuperAdmin: true }
    routeState.authz = {
      user: { orgId: org.orgId, id: adminId },
      permissions: new Set(['gl.post']),
      allowedSubsidiaryIds: null,
    }

    const documentId = randomUUID()
    const createResponse = await withOrgContext(org.orgId, () => createJournal(new Request('http://localhost/api/journals', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'Idempotency-Key': documentId },
      body: JSON.stringify({
        documentDate: '2026-07-14',
        lines: [
          { accountId: org.accounts.ar, amount: '100', description: 'partyless receivable control' },
          { accountId: org.accounts.revenue, amount: '-100', description: 'revenue offset' },
        ],
      }),
    })))
    assert.equal(createResponse.status, 201, await createResponse.text())

    const response = await withOrgContext(org.orgId, () => postJournal(new Request('http://localhost/api/journals/actions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'post', documentId }),
    })))
    assert.equal(response.status, 200, await response.clone().text())
    const body = await response.json() as {
      ok?: boolean
      entryId?: string
      warnings?: Array<{ code?: string; accounts?: Array<{ accountName?: string; accountNumber?: string; amount?: string }> }>
    }
    assert.equal(body.ok, true)
    assert.ok(body.entryId)
    assert.equal(body.warnings?.length, 1)
    assert.equal(body.warnings?.[0]?.code, 'partyless_control_lines')
    assert.deepEqual(body.warnings?.[0]?.accounts?.map(({ accountNumber, accountName, amount }) => ({ accountNumber, accountName, amount })), [
      { accountNumber: '1100', accountName: 'Accounts Receivable', amount: '100.0000' },
    ])

    const posted = await withOrgContext(org.orgId, () => db.execute<{ status: string }>(sql`
      select status from documents where id = ${documentId} and org_id = ${org.orgId}
    `))
    assert.equal(posted.rows[0]?.status, 'posted', 'warning communicates the exposure without refusing legitimate GL posting')
  } finally {
    routeState.authz = null
    ;(globalThis as Record<string, unknown>).__journalActionsSession = null
    await withBypassContext(() => dropScratchOrg(org.orgId))
  }
})

const ledgerRequest = (body: unknown) => new Request('http://localhost/api/ledger-actions', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})
const grantRole = (orgId: string, key: string, permissions: unknown, restriction: unknown = { mode: 'all' }) =>
  withBypassContext(() => db.execute(sql`update app_roles set permissions = ${JSON.stringify(permissions)}::jsonb,
    subsidiary_restriction = ${JSON.stringify(restriction)}::jsonb where org_id = ${orgId} and key = ${key}`))
const enableNpFeatures = (orgId: string, extraId?: string) =>
  withOrgContext(orgId, () => db.execute(sql`update orgs set settings = jsonb_set(
    coalesce(settings, '{}'::jsonb), '{features}',
    coalesce(settings->'features', '{}'::jsonb) || '{"nonprofit":true,"fundAccounting":true,"grantManagement":true,"budgets":true,"encumbrances":true}'::jsonb, true)
    where id = ${orgId} or id = ${extraId ?? null}`))

test('posting routes require both manage and posting rights before parsing the body', { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg())
  try {
    const userId = await withBypassContext(() => createScratchUser(org.orgId, 'Grants Manager', 'grants-manager'))
    await grantRole(org.orgId, 'grants-manager', ['grants.manage', 'encumbrances.manage'])
    await enableNpFeatures(org.orgId)
    routeState.authz = { user: { orgId: org.orgId, id: userId }, permissions: new Set(['grants.manage', 'encumbrances.manage']), allowedSubsidiaryIds: null }
    ;(globalThis as Record<string, unknown>).__journalActionsSession = { id: userId, orgId: org.orgId, isSuperAdmin: false }
    assert.equal((await postGrantPostings(ledgerRequest({}))).status, 403)
    assert.equal((await postLiquidations(ledgerRequest({}))).status, 403)
    assert.equal((await postGrantCommands(ledgerRequest({}))).status, 400)
    assert.equal((await postEncumbranceCommands(ledgerRequest({}))).status, 400)
    const posterId = await withBypassContext(() => createScratchUser(org.orgId, 'Posting User', 'posting-user'))
    await grantRole(org.orgId, 'posting-user', ['gl.post'])
    routeState.authz = { user: { orgId: org.orgId, id: posterId }, permissions: new Set(['gl.post']), allowedSubsidiaryIds: null }
    ;(globalThis as Record<string, unknown>).__journalActionsSession = { id: posterId, orgId: org.orgId, isSuperAdmin: false }
    assert.equal((await postGrantPostings(ledgerRequest({}))).status, 403)
    assert.equal((await postLiquidations(ledgerRequest({}))).status, 403)
  } finally {
    routeState.authz = null
    ;(globalThis as Record<string, unknown>).__journalActionsSession = null
    await withBypassContext(() => dropScratchOrg(org.orgId))
  }
})

test('grant and encumbrance boundaries share one provisioned org', { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg())
  const orgB = await withBypassContext(() => createScratchOrg())
  try {
    const userId = await withBypassContext(() => createScratchUser(org.orgId, 'Scope Restricted', 'scope-restricted'))
    const outside = randomUUID()
    await grantRole(org.orgId, 'scope-restricted', ['encumbrances.manage', 'gl.post', 'grants.manage'], { mode: 'list', subsidiaryIds: [outside] })
    const { adminId } = await withBypassContext(() => seedFlowActors(org.orgId))
    await enableNpFeatures(org.orgId, orgB.orgId)
    const { defaultFundId: fundId } = await provisionFundAccounting({ orgId: org.orgId, actorId: adminId,
      defaultFund: { code: '25NP', name: '-' }, classifications: { '25NP': { kind: 'operating', restrictionClass: 'unrestricted' } } })
    const seeded = await withOrgContext(org.orgId, async () => {
      await db.execute(sql`update funds set budgetary_control = 'advisory' where org_id = ${org.orgId} and id = ${fundId}`)
      const scenario = (await db.execute<{ id: string }>(sql`
        insert into budget_scenarios (org_id, book_id, name, period_from, period_to, status, submitted_by, submitted_at, approved_by, approved_at, created_by, updated_by)
        values (${org.orgId}, ${org.bookId}, 'Primary 2026', '2026-01-01', '2026-12-31', 'approved', ${adminId}, now(), ${adminId}, now(), ${adminId}, ${adminId})
        returning id`)).rows[0]!.id
      const dept = (await db.execute<{ id: string }>(sql`
        insert into departments (id, org_id, name, is_active, custom) values (${randomUUID()}, ${org.orgId}, 'Programs', true, '{}'::jsonb) returning id`)).rows[0]!.id
      const proj = (await db.execute<{ id: string }>(sql`
        insert into projects (id, org_id, name) values (${randomUUID()}, ${org.orgId}, 'Harbor Outreach') returning id`)).rows[0]!.id
      const classId = (await db.execute<{ id: string }>(sql`
        insert into classes (id, org_id, name) values (${randomUUID()}, ${org.orgId}, 'Weekend Kitchen') returning id`)).rows[0]!.id
      await db.execute(sql`
        insert into budget_lines (org_id, scenario_id, period_id, account_id, subsidiary_id, department_id, project_id, location_id, class_id, extra_dims, amount, created_by, updated_by)
        values (${org.orgId}, ${scenario}, ${org.periodId}, ${org.accounts.cogs}, ${org.subsidiaryId}, null, null, null, null, ${JSON.stringify({ fund: fundId })}::jsonb, '100.00', ${adminId}, ${adminId}),
          (${org.orgId}, ${scenario}, ${org.periodId}, ${org.accounts.cogs}, ${org.subsidiaryId}, ${dept}, ${proj}, null, null, ${JSON.stringify({ fund: fundId })}::jsonb, '100.00', ${adminId}, ${adminId}),
          (${org.orgId}, ${scenario}, ${org.periodId}, ${org.accounts.cogs}, ${org.subsidiaryId}, null, null, ${org.locationId}, ${classId}, ${JSON.stringify({ fund: fundId })}::jsonb, '100.00', ${adminId}, ${adminId})`)
      const group = (await db.execute<{ id: string }>(sql`
        insert into account_groups (org_id, dimension, key, name, match, is_catch_all, is_active, created_by, updated_by)
        values (${org.orgId}, 'grant_allowable_costs', 'allowable', 'Allowable Costs', '{}'::jsonb, false, true, ${adminId}, ${adminId})
        returning id`)).rows[0]!.id
      return { scenario, group, dept, proj, classId }
    })
    const grant = await createGrant({ orgId: org.orgId, code: 'GRANT-2026-1', name: 'Boundary probe',
      sponsorPartyId: org.customerId, sponsorKind: 'foundation', determination: 'contribution_unconditional',
      awardAmount: '1000.00', periodFrom: '2026-01-01', periodTo: '2026-12-31',
      fundId, allowableAccountGroupId: seeded.group, actorId: adminId })
    const enc = await createEncumbrance({ orgId: org.orgId, sourceKind: 'manual', amount: '75.00',
      accountId: org.accounts.cogs, subsidiaryId: org.subsidiaryId, extraDims: { fund: fundId } })
    const encDP = await createEncumbrance({ orgId: org.orgId, sourceKind: 'manual', amount: '25.00',
      accountId: org.accounts.cogs, subsidiaryId: org.subsidiaryId, departmentId: seeded.dept, projectId: seeded.proj, extraDims: { fund: fundId } })
    const encLC = await createEncumbrance({ orgId: org.orgId, sourceKind: 'manual', amount: '10.00',
      accountId: org.accounts.cogs, subsidiaryId: org.subsidiaryId, locationId: org.locationId, classId: seeded.classId, extraDims: { fund: fundId } })
    routeState.authz = { user: { orgId: org.orgId, id: userId }, permissions: new Set(['encumbrances.manage', 'gl.post', 'grants.manage']), allowedSubsidiaryIds: [outside] }
    ;(globalThis as Record<string, unknown>).__journalActionsSession = { id: userId, orgId: org.orgId, isSuperAdmin: false }
    assert.equal((await postEncumbranceCommands(ledgerRequest({ action: 'close', encumbranceId: enc.id, reason: 'scope probe' }))).status, 404)
    assert.equal((await postLiquidations(ledgerRequest({ action: 'link', encumbranceId: enc.id, documentLineId: randomUUID() }))).status, 404)
    assert.equal((await postEncumbranceCommands(ledgerRequest({ action: 'close', encumbranceId: randomUUID(), reason: 'scope probe' }))).status, 404)
    assert.equal((await postGrantPostings(ledgerRequest({}))).status, 403)
    routeState.authz = { user: { orgId: org.orgId, id: adminId }, permissions: new Set(['*']), allowedSubsidiaryIds: null }
    ;(globalThis as Record<string, unknown>).__journalActionsSession = { id: adminId, orgId: org.orgId, isSuperAdmin: true }
    const documentId = randomUUID()
    await withOrgContext(org.orgId, () => createJournal(new Request('http://localhost/api/journals', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'Idempotency-Key': documentId },
      body: JSON.stringify({ documentDate: '2026-07-14', subsidiaryId: org.subsidiaryId, lines: [
        { accountId: org.accounts.cogs, amount: '150.0000', subsidiaryId: org.subsidiaryId, extraDims: { fund: fundId } },
        { accountId: org.accounts.ar, amount: '-150.0000', subsidiaryId: org.subsidiaryId, extraDims: { fund: fundId } },
        { accountId: org.accounts.cogs, amount: '120.00', subsidiaryId: org.subsidiaryId, departmentId: seeded.dept, projectId: seeded.proj, extraDims: { fund: fundId } },
        { accountId: org.accounts.ar, amount: '-120.00', subsidiaryId: org.subsidiaryId, departmentId: seeded.dept, projectId: seeded.proj, extraDims: { fund: fundId } },
      ] }),
    })))
    const res = await withOrgContext(org.orgId, () => postJournal(new Request('http://localhost/api/journals/actions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'post', documentId }),
    })))
    assert.equal(res.status, 200)
    const posted = await res.json()
    assert.equal(posted.ok, true)
    assert.equal(posted.warnings.length, 2, 'both collectors report through one posting')
    assert.equal(posted.warnings[0].code, 'partyless_control_lines')
    assert.equal(posted.warnings[1].code, 'budgetary_control_advisory')
    const seam = await readFile(new URL('./route.ts', import.meta.url), 'utf8')
    assert.ok(seam.indexOf('await partylessControlLines(') !== -1 && seam.indexOf('await partylessControlLines(') < seam.indexOf('await budgetaryControlAdvisories(') && !seam.includes('Promise.all'), 'warning collectors run sequentially on the pinned handle with no concurrent tuple')
    const overage = posted.warnings[1].overages[0]
    assert.equal(overage.scenarioId, seeded.scenario)
    assert.equal(overage.accountId, org.accounts.cogs)
    assert.equal(overage.fundCode, '25NP')
    assert.equal(overage.subsidiaryId, org.subsidiaryId)
    assert.equal(overage.available, '-125.0000')
    assert.equal(overage.amountOver, '125.0000')
    assert.equal(overage.departmentId, null)
    assert.equal(overage.projectId, null)
    assert.equal(overage.locationId, null)
    assert.equal(overage.classId, null)
    const full = posted.warnings[1].overages.find((o: { departmentId: string | null }) => o.departmentId === seeded.dept)
    assert.ok(full, 'the department/project cell posts its own overage')
    assert.equal(posted.warnings[1].overages.length, 2, 'two distinct cells stay distinguishable')
    assert.equal(full.scenarioId, seeded.scenario)
    assert.equal(full.accountId, org.accounts.cogs)
    assert.equal(full.fundCode, '25NP')
    assert.equal(full.subsidiaryId, org.subsidiaryId)
    assert.equal(full.projectId, seeded.proj)
    assert.equal(full.locationId, null)
    assert.equal(full.classId, null)
    assert.deepEqual(full.extraDims, { fund: fundId })
    assert.equal(full.available, '-45.0000')
    assert.equal(full.amountOver, '45.0000')
    const listed = await listGrants({ orgId: org.orgId })
    assert.equal(listed.items[0]?.code, 'GRANT-2026-1')
    assert.equal(listed.items[0]?.fundCode, '25NP')
    assert.equal((await listGrants({ orgId: orgB.orgId })).total, 0)
    await assert.rejects(listGrants({ orgId: org.orgId, status: 'bogus' as never }),
      (error: unknown) => error instanceof NonprofitError && error.code === 'grant_status_invalid')
    assert.equal((await listGrants({ orgId: org.orgId, status: 'draft' })).total, 1)
    await assert.rejects(getGrantTerms(orgB.orgId, grant.id),
      (error: unknown) => error instanceof NonprofitError && error.code === 'grant_not_found')
    const encListed = await listEncumbrances({ orgId: org.orgId, allowedSubsidiaryIds: null })
    assert.equal(encListed.items[0]?.subsidiaryId, org.subsidiaryId)
    assert.equal((await listEncumbrances({ orgId: org.orgId, allowedSubsidiaryIds: null })).total, 3, 'unrestricted allowlist sees every stored row')
    assert.deepEqual((await listEncumbrances({ orgId: org.orgId, allowedSubsidiaryIds: [] })).items, [], 'empty allowlist returns no rows')
    assert.deepEqual(new Set((await listEncumbrances({ orgId: org.orgId, allowedSubsidiaryIds: [outside, org.subsidiaryId] })).items.map((item) => item.id)), new Set([enc.id, encDP.id, encLC.id]), 'multiple allowed subsidiaries return the stored rows')
    assert.equal((await listEncumbrances({ orgId: org.orgId, allowedSubsidiaryIds: [outside] })).total, 0, 'the stored subsidiary governs, not the caller')
    await assert.rejects(listEncumbrances({ orgId: org.orgId } as never),
      (error: unknown) => error instanceof NonprofitError && error.code === 'encumbrance_scope_required', 'allowlist omitted property refuses before any query')
    await assert.rejects(listEncumbrances({ orgId: org.orgId, allowedSubsidiaryIds: undefined } as never),
      (error: unknown) => error instanceof NonprofitError && error.code === 'encumbrance_scope_required', 'allowlist own undefined refuses before any query')
    await assert.rejects(listEncumbrances({ orgId: org.orgId, allowedSubsidiaryIds: 'sub-1' } as never),
      (error: unknown) => error instanceof NonprofitError && error.code === 'encumbrance_scope_required', 'allowlist non-array scope refuses before any query')
    await assert.rejects(listEncumbrances({ orgId: org.orgId, allowedSubsidiaryIds: ['not-a-uuid'] }),
      (error: unknown) => error instanceof NonprofitError && error.code === 'encumbrance_scope_invalid', 'allowlist invalid member refuses before any query')
    await assert.rejects(listEncumbrances(Object.assign(Object.create({ allowedSubsidiaryIds: null }), { orgId: org.orgId }) as never),
      (error: unknown) => error instanceof NonprofitError && error.code === 'encumbrance_scope_required', 'allowlist inherited null refuses before any query')
    await assert.rejects(listEncumbrances({ orgId: org.orgId, allowedSubsidiaryIds: null, status: 'bogus' as never }),
      (error: unknown) => error instanceof NonprofitError && error.code === 'encumbrance_status_invalid')
    assert.equal((await listEncumbrances({ orgId: org.orgId, allowedSubsidiaryIds: null, status: 'open' })).total, 3)
    const beyondGrants = await listGrants({ orgId: org.orgId, offset: 99 })
    assert.deepEqual([beyondGrants.items, beyondGrants.total], [[], 1])
    const beyondEnc = await listEncumbrances({ orgId: org.orgId, offset: 99, allowedSubsidiaryIds: null })
    assert.deepEqual([beyondEnc.items, beyondEnc.total], [[], 3])
    const detail = await getEncumbranceDetail(org.orgId, enc.id, '2026-07-14')
    assert.equal(detail?.openBalance, '75.0000')
    assert.equal(detail?.links.length, 0)
    assert.ok(detail?.figures)
    const detailDP = await getEncumbranceDetail(org.orgId, encDP.id, '2026-07-14')
    assert.equal(detailDP?.figures?.departmentId, seeded.dept)
    assert.equal(detailDP?.figures?.projectId, seeded.proj)
    assert.equal(detailDP?.figures?.available, '-45.0000')
    const detailLC = await getEncumbranceDetail(org.orgId, encLC.id, '2026-07-14')
    assert.equal(detailLC?.figures?.locationId, org.locationId)
    assert.equal(detailLC?.figures?.classId, seeded.classId)
    assert.equal(detailLC?.figures?.available, '90.0000')
  } finally {
    routeState.authz = null
    ;(globalThis as Record<string, unknown>).__journalActionsSession = null
    await withBypassContext(() => dropScratchOrg(org.orgId))
    await withBypassContext(() => dropScratchOrg(orgB.orgId))
  }
})
