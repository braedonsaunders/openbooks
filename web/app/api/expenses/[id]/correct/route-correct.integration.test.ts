import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

// F-user-003: a posted expense report follows the same amend/reverse
// contract as bills — Correct creates the correcting revision, never
// "void and re-key". POST /api/expenses/[id]/correct is the dedicated
// correction workflow (the generic documents route 422s expense reports).
const root = pathToFileURL(process.cwd() + '/').href
const state: {
  orgId: string
  actorId: string
  roles: { key: string; name: string }[]
  permissions: string[]
} = { orgId: '', actorId: '', roles: [], permissions: [] }
Object.assign(globalThis, { __expenseCorrectState: state })
const virtual = (source: string) => ({ shortCircuit: true as const, url: 'data:text/javascript,' + encodeURIComponent(source) })
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'server-only') return virtual('export {}')
    if (specifier === '../../../../../lib/feature-gates') return virtual(`
      export async function guardFeaturePermission() {
        const s = globalThis.__expenseCorrectState;
        return { user: { orgId: s.orgId, id: s.actorId, roles: s.roles, isSuperAdmin: false }, permissions: new Set(s.permissions), allowedSubsidiaryIds: null };
      }
    `)
    if (specifier.startsWith('@/')) return next(root + 'web/' + specifier.slice(2) + '.ts', context)
    // Pin the engine to THIS checkout: the environment shares node_modules
    // with the main checkout, so an unmapped @openbooks/engine import would
    // silently exercise main's engine instead of the branch under test.
    if (specifier.startsWith('@openbooks/engine/')) return next(root + specifier.slice('@openbooks/'.length), context)
    return next(specifier, context)
  },
})
const { sql } = await import('drizzle-orm')
const { db, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { documentRevisionCounterSql } = await import('@openbooks/engine/src/records/revision.ts')
const { submitAndReleaseIfUngated } = await import('@openbooks/engine/src/flows/submit.ts')
const { postDocument } = await import("@openbooks/engine/src/ledger/posting-document.ts");
const { POST } = await import('./route.ts')
// The route's web/lib chain (documents → org-scope → auth → request-org)
// registers the app RLS resolver at import time, replacing the preloaded
// trusted-test boundary for this process (see route-recall). Re-install it
// AFTER the web imports; the route scopes itself explicitly.
const { installTrustedTestDatabaseBypass } = await import('@openbooks/engine/src/testing/database-bypass.ts')
installTrustedTestDatabaseBypass()
const DB = !!process.env.OPENBOOKS_DB_URL

function as(actorId: string, permissions: string[] = ['expenses.create', 'ap.post']) {
  state.actorId = actorId
  state.roles = [{ key: 'accountant', name: 'accountant' }]
  state.permissions = permissions
}

async function correct(id: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> | null }> {
  const response = await withOrgContext(state.orgId, () => POST(
    new Request(`http://expenses.test/api/expenses/${id}/correct`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  ))
  return { status: response.status, json: (await response.json().catch(() => null)) as Record<string, unknown> | null }
}

async function revision(id: string): Promise<string> {
  return (await db.execute<{ revision: string }>(sql`select ${documentRevisionCounterSql(sql`revision_seq`)} as revision from documents where id = ${id} and org_id = ${state.orgId}`)).rows[0]!.revision
}

async function statusOf(id: string): Promise<string> {
  return (await db.execute<{ status: string }>(sql`select status from documents where id = ${id} and org_id = ${state.orgId}`)).rows[0]!.status
}

interface PostedFixture {
  orgId: string
  actorId: string
  employeeId: string
  cogs: string
  id: string
  cleanup: () => Promise<void>
}

/** A truly posted expense report: submitted, auto-approved, GL-posted. */
async function postedFixture(): Promise<PostedFixture> {
  const org = await createScratchOrg()
  state.orgId = org.orgId
  const actorId = await createScratchUser(org.orgId, 'Sammy Sloppy', 'accountant')
  as(actorId)
  const employeePayable = randomUUID()
  await db.execute(sql`
    insert into accounts (id, org_id, number, name, type, is_summary, is_active, eliminate, reconcilable, required_dimensions, custom, subsidiary_include_children)
    values (${employeePayable}, ${org.orgId}, '2400', 'Employee Payable', 'liability_current_other', false, true, false, false, '[]'::jsonb, '{}'::jsonb, true)`)
  await db.execute(sql`
    update orgs
       set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{controlAccounts,employeePayable}', to_jsonb(${employeePayable}::text), true)
     where id = ${org.orgId}`)
  // The void reversal posts into the org's business today: seed an open
  // period covering it (scratch orgs ship only 2026-07).
  const calendar = (await db.execute<{ id: string }>(sql`select id from fiscal_calendars where org_id = ${org.orgId} and is_default limit 1`)).rows[0]!.id
  await db.execute(sql`
    insert into accounting_periods (id, org_id, fiscal_year, period_number, name, starts_on, ends_on, is_adjustment, fiscal_calendar_id)
    values (${randomUUID()}, ${org.orgId}, 2026, 9, '2026-09', '2026-09-01', '2026-09-30', false, ${calendar})`)
  const employeeId = randomUUID()
  await db.execute(sql`
    insert into parties (id, org_id, kind, display_name, is_active, custom)
    values (${employeeId}, ${org.orgId}, 'employee', 'Sammy Sloppy', true, '{}'::jsonb)`)
  await db.execute(sql`insert into employee_roles (id, org_id, party_id) values (${randomUUID()}, ${org.orgId}, ${employeeId})`)
  const id = randomUUID()
  await db.execute(sql`
    insert into documents (id, org_id, kind, status, document_number, document_date, party_id, subsidiary_id, currency, subtotal, tax_total, total, custom, created_by)
    values (${id}, ${org.orgId}, 'expense_report', 'draft', 'EXP-POSTED', ${org.date}, ${employeeId}, ${org.subsidiaryId}, 'CAD', '875.50', '0', '875.50', '{}'::jsonb, ${actorId})`)
  await db.execute(sql`
    insert into document_lines (id, org_id, document_id, line_number, account_id, description, quantity, unit_price, amount, tax_amount)
    values (${randomUUID()}, ${org.orgId}, ${id}, 1, ${org.accounts.cogs}, 'Travel', '1', '875.50', '875.50', '0')`)
  await withOrgContext(org.orgId, () => submitAndReleaseIfUngated('expense_report', id, actorId))
  assert.equal(await statusOf(id), 'approved')
  await postDocument(id, { control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank, employeePayable } })
  assert.equal(await statusOf(id), 'posted')
  const cleanup = async () => {
    await db.execute(sql`delete from employee_roles where org_id = ${org.orgId}`)
    await db.execute(sql`update users set is_active = false where org_id = ${org.orgId}`)
    await db.execute(sql`delete from role_assignments where org_id = ${org.orgId}`)
    await dropScratchOrg(org.orgId)
    await db.execute(sql`delete from users where org_id = ${org.orgId}`)
    await db.execute(sql`delete from app_roles where org_id = ${org.orgId}`)
  }
  return { orgId: org.orgId, actorId, employeeId, cogs: org.accounts.cogs, id, cleanup }
}

const REASON = 'correct the travel total after the final receipts arrived'

test('correct creates the correcting revision and voids the posted source', { skip: !DB }, async () => {
  const { actorId, cogs, id, cleanup } = await postedFixture()
  try {
    as(actorId)
    const response = await correct(id, {
      expectedUpdatedAt: await revision(id),
      amendmentReason: REASON,
      memo: 'updated memo',
      // 0171 requires settlement on every newly written line (the drawer
      // sends it); the correction still proves the amount change 875.50 →
      // 900.00, not the settlement gate.
      lines: [{ accountId: cogs, amount: '900.00', description: 'updated line', settlementType: 'out_of_pocket' }],
    })
    assert.equal(response.status, 201, JSON.stringify(response.json))
    assert.equal(response.json?.ok, true)
    assert.equal(response.json?.voidStatus, 'voided')
    const correctionId = String(response.json?.correctionId)
    assert.match(String(response.json?.correctionNumber), /^EXP-/)
    assert.equal(await statusOf(id), 'voided')
    assert.equal(await statusOf(correctionId), 'draft')
    const replacement = (await db.execute<{ memo: string; total: string; custom: Record<string, unknown> }>(
      sql`select memo, total::text as total, custom from documents where id = ${correctionId}`,
    )).rows[0]!
    assert.equal(replacement.memo, 'updated memo')
    assert.equal(replacement.total, '900.0000')
    assert.equal(replacement.custom.correctionOf, id)
    assert.equal(replacement.custom.correctionReason, REASON)
    const lines = (await db.execute<{ amount: string; description: string }>(
      sql`select amount::text as amount, description from document_lines where document_id = ${correctionId} and org_id = ${state.orgId} order by line_number`,
    )).rows
    assert.deepEqual(lines.map((l) => [l.description, l.amount]), [['updated line', '900.0000']])
    const link = (await db.execute<{ linkType: string; reason: string }>(
      sql`select link_type as "linkType", reason from document_links where from_document_id = ${correctionId} and to_document_id = ${id} and org_id = ${state.orgId}`,
    )).rows[0]
    assert.equal(link?.linkType, 'reverses')
    assert.equal(link?.reason, REASON)
  } finally {
    await cleanup()
  }
})

test('correct fails closed on reason, state, revision, and repeat calls', { skip: !DB }, async () => {
  const { actorId, id, cleanup } = await postedFixture()
  try {
    as(actorId)
    const good = { expectedUpdatedAt: await revision(id), amendmentReason: REASON }
    assert.equal((await correct(id, { expectedUpdatedAt: await revision(id) })).status, 422, 'a missing reason must fail')
    assert.equal((await correct(id, { ...good, amendmentReason: 'short' })).status, 422, 'a short reason must fail')
    assert.equal((await correct(id, { amendmentReason: REASON })).status, 409, 'a missing revision must fail closed')
    assert.equal((await correct(id, { ...good, expectedUpdatedAt: '2000-01-01T00:00:00.000Z' })).status, 409, 'a stale revision must fail closed')
    assert.equal(await statusOf(id), 'posted')
    // A reason-only correction still yields a faithful, postable draft.
    const reasonOnly = await correct(id, { expectedUpdatedAt: await revision(id), amendmentReason: REASON })
    assert.equal(reasonOnly.status, 201, JSON.stringify(reasonOnly.json))
    const faithful = (await db.execute<{ memo: string; total: string }>(
      sql`select memo, total::text as total from documents where id = ${String(reasonOnly.json?.correctionId)}`,
    )).rows[0]!
    assert.equal(faithful.total, '875.5000', 'an unedited correction copies the posted totals')
  } finally {
    await cleanup()
  }
})

test('a standing correction edge conflicts with a second correction', { skip: !DB }, async () => {
  const { orgId, actorId, id, cleanup } = await postedFixture()
  try {
    as(actorId)
    // Simulate the gated-void window: a concurrent correction's `reverses`
    // edge already stands while the source is still posted. Correction
    // lineage is immutable, so the simulation rows stay for the org wipe.
    const subsidiaryId = (await db.execute<{ id: string }>(sql`select subsidiary_id as id from documents where id = ${id}`)).rows[0]!.id
    const dummyId = randomUUID()
    await db.execute(sql`
      insert into documents (id, org_id, kind, status, document_number, document_date, subsidiary_id, currency, subtotal, tax_total, total, custom, created_by)
      values (${dummyId}, ${orgId}, 'expense_report', 'draft', 'EXP-DUMMY', '2026-07-15', ${subsidiaryId}, 'CAD', '1', '0', '1', '{}'::jsonb, ${actorId})`)
    await db.execute(sql`
      insert into document_links (org_id, from_document_id, to_document_id, link_type, reason, requested_by, requested_at, created_by, updated_by)
      values (${orgId}, ${dummyId}, ${id}, 'reverses', ${REASON}, ${actorId}, now(), ${actorId}, ${actorId})`)
    const conflict = await correct(id, { expectedUpdatedAt: await revision(id), amendmentReason: REASON })
    assert.equal(conflict.status, 409, JSON.stringify(conflict.json))
    assert.match(String(conflict.json?.error), /correction/i)
    assert.equal(await statusOf(id), 'posted', 'the conflict writes nothing')
  } finally {
    await cleanup()
  }
})

test('correct refuses non-posted reports and under-permissioned callers', { skip: !DB }, async () => {
  const { actorId, id, cleanup } = await postedFixture()
  try {
    as(actorId, ['expenses.create'])
    const forbidden = await correct(id, { expectedUpdatedAt: await revision(id), amendmentReason: REASON })
    assert.equal(forbidden.status, 403, JSON.stringify(forbidden.json))
    assert.equal(await statusOf(id), 'posted')
    as(actorId)
    await db.execute(sql`update documents set status = 'approved' where id = ${id} and org_id = ${state.orgId}`)
    const wrongState = await correct(id, { expectedUpdatedAt: await revision(id), amendmentReason: REASON })
    assert.equal(wrongState.status, 422, JSON.stringify(wrongState.json))
  } finally {
    await cleanup()
  }
})
