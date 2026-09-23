import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

// F-user-003: an expense report that is pending_approval or approved-but-
// unposted must be editable — Edit cancels the open gates and returns the
// report to draft (submitter or admin) behind a visible confirm. The server
// half is the `recall` action on /api/expenses/actions.
const root = pathToFileURL(process.cwd() + '/').href
const state: {
  orgId: string
  actorId: string
  roles: { key: string; name: string }[]
  permissions: string[]
} = { orgId: '', actorId: '', roles: [], permissions: [] }
Object.assign(globalThis, { __expenseActionsRecallState: state })
const virtual = (source: string) => ({ shortCircuit: true as const, url: 'data:text/javascript,' + encodeURIComponent(source) })
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'server-only') return virtual('export {}')
    if (specifier === '../../../../lib/authz') return virtual(`
      export async function getAuthz() {
        const s = globalThis.__expenseActionsRecallState;
        return { user: { orgId: s.orgId, id: s.actorId, roles: s.roles }, permissions: new Set(s.permissions), allowedSubsidiaryIds: null };
      }
      export function can(authz, permission) { return authz.permissions.has(permission) }
      export function guardSubsidiaryScope() { return null }
    `)
    if (specifier === '../../../../lib/features') return virtual(`
      export async function isFeatureEnabled() { return true }
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
const { POST } = await import('./route.ts')
// The route's web/lib chain (documents → org-scope → auth → request-org)
// registers the app RLS resolver at import time, replacing the preloaded
// trusted-test boundary for this process. Re-install the boundary AFTER the
// web imports so scratch fixtures keep their documented cross-org authority;
// the route calls under test scope themselves explicitly (withOrgContext /
// withOrgTransaction) and are unaffected.
const { installTrustedTestDatabaseBypass } = await import('@openbooks/engine/src/testing/database-bypass.ts')
installTrustedTestDatabaseBypass()
const DB = !!process.env.OPENBOOKS_DB_URL

async function post(body: unknown): Promise<{ status: number; json: Record<string, unknown> | null }> {
  const response = await withOrgContext(state.orgId, () => POST(
    new Request('http://expenses.test/api/expenses/actions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  ))
  return { status: response.status, json: (await response.json().catch(() => null)) as Record<string, unknown> | null }
}

async function revision(id: string): Promise<string> {
  return (await db.execute<{ revision: string }>(sql`select ${documentRevisionCounterSql(sql`revision_seq`)} as revision from documents where id = ${id} and org_id = ${state.orgId}`)).rows[0]!.revision
}

async function statusOf(id: string): Promise<string> {
  return (await db.execute<{ status: string }>(sql`select status from documents where id = ${id} and org_id = ${state.orgId}`)).rows[0]!.status
}

async function gateStatus(id: string): Promise<string> {
  return (await db.execute<{ status: string }>(sql`select status from flow_gates where id = ${id}`)).rows[0]!.status
}

async function runStatus(id: string): Promise<string> {
  return (await db.execute<{ status: string }>(sql`select status from flow_runs where id = ${id}`)).rows[0]!.status
}

function as(actorId: string, roles: { key: string; name: string }[]) {
  state.actorId = actorId
  state.roles = roles
  state.permissions = ['expenses.create', 'ap.post']
}

/** A submitted expense report with one waiting run and one pending gate. */
async function submittedReport(orgId: string, submitterId: string, scratch: { date: string; subsidiaryId: string }, status: 'pending_approval' | 'approved'): Promise<{ id: string; runId: string; gateId: string }> {
  const employeeId = randomUUID()
  await db.execute(sql`
    insert into parties (id, org_id, kind, display_name, is_active, custom)
    values (${employeeId}, ${orgId}, 'employee', 'Sammy Sloppy', true, '{}'::jsonb)`)
  await db.execute(sql`insert into employee_roles (id, org_id, party_id) values (${randomUUID()}, ${orgId}, ${employeeId})`)
  const id = randomUUID()
  await db.execute(sql`
    insert into documents (id, org_id, kind, status, document_number, document_date, party_id, subsidiary_id, currency, subtotal, tax_total, total, custom, created_by, submitted_by, submitted_at)
    values (${id}, ${orgId}, 'expense_report', ${status}, ${'EXP-' + id.slice(0, 8)}, ${scratch.date}, ${employeeId}, ${scratch.subsidiaryId}, 'CAD', '875.50', '0', '875.50', '{}'::jsonb, ${submitterId}, ${submitterId}, now())`)
  const runId = randomUUID()
  const gateId = randomUUID()
  const flowId = randomUUID()
  await db.execute(sql`
    insert into flows (id, org_id, name, subject_kind, enabled, graph, created_by)
    values (${flowId}, ${orgId}, 'Expense approval', 'expense_report', true, '{"nodes":[],"edges":[]}'::jsonb, ${submitterId})`)
  await db.execute(sql`
    insert into flow_runs (id, org_id, flow_id, subject_kind, subject_id, trigger, status, context, created_by)
    values (${runId}, ${orgId}, ${flowId}, 'expense_report', ${id}, 'on_submit', 'waiting', '{}'::jsonb, ${submitterId})`)
  await db.execute(sql`
    insert into flow_gates (id, org_id, flow_id, run_id, node_id, subject_kind, subject_id, title, group_key, status, assignee_role)
    values (${gateId}, ${orgId}, ${flowId}, ${runId}, 'gate-1', 'expense_report', ${id}, 'Manager approval', ${runId + ':gate-1'}, 'pending', 'approver')`)
  return { id, runId, gateId }
}

async function fixture(): Promise<{ orgId: string; submitterId: string; scratch: { date: string; subsidiaryId: string }; cleanup: () => Promise<void> }> {
  const org = await createScratchOrg()
  state.orgId = org.orgId
  const submitterId = await createScratchUser(org.orgId, 'Sammy Sloppy', 'accountant')
  const scratch = { date: org.date, subsidiaryId: org.subsidiaryId }
  const cleanup = async () => {
    // Role rows predate the wipe's table list; user rows are referenced by
    // documents/flows FKs, so park + unassign first, wipe the org (which
    // clears every referencing row), then delete the users and roles.
    await db.execute(sql`delete from employee_roles where org_id = ${org.orgId}`)
    await db.execute(sql`update users set is_active = false where org_id = ${org.orgId}`)
    await db.execute(sql`delete from role_assignments where org_id = ${org.orgId}`)
    await dropScratchOrg(org.orgId)
    await db.execute(sql`delete from users where org_id = ${org.orgId}`)
    await db.execute(sql`delete from app_roles where org_id = ${org.orgId}`)
  }
  return { orgId: org.orgId, submitterId, scratch, cleanup }
}

test('recall returns a pending report to draft and cancels its open gate and run', { skip: !DB }, async () => {
  const { orgId, submitterId, scratch, cleanup } = await fixture()
  try {
    as(submitterId, [{ key: 'accountant', name: 'accountant' }])
    const { id, runId, gateId } = await submittedReport(orgId, submitterId, scratch, 'pending_approval')
    const response = await post({ action: 'recall', documentId: id, expectedUpdatedAt: await revision(id) })
    assert.equal(response.status, 200, JSON.stringify(response.json))
    assert.equal(response.json?.ok, true)
    assert.equal(response.json?.cancelledGates, 1)
    assert.equal(response.json?.cancelledRuns, 1)
    assert.equal(await statusOf(id), 'draft')
    assert.equal(await gateStatus(gateId), 'cancelled')
    assert.equal(await runStatus(runId), 'cancelled')
    // A recall is terminal for the editor's token: the revision must advance.
    const recallAgain = await post({ action: 'recall', documentId: id, expectedUpdatedAt: await revision(id) })
    assert.equal(recallAgain.status, 422, 'a draft is no longer recallable')
  } finally {
    await cleanup()
  }
})

test('recall refuses a stranger but allows an admin', { skip: !DB }, async () => {
  const { orgId, submitterId, scratch, cleanup } = await fixture()
  try {
    as(submitterId, [{ key: 'accountant', name: 'accountant' }])
    const { id, gateId } = await submittedReport(orgId, submitterId, scratch, 'pending_approval')
    const outsiderId = await createScratchUser(orgId, 'Outsider O', 'viewer')
    as(outsiderId, [{ key: 'viewer', name: 'viewer' }])
    const refused = await post({ action: 'recall', documentId: id, expectedUpdatedAt: await revision(id) })
    assert.equal(refused.status, 403, JSON.stringify(refused.json))
    assert.equal(await statusOf(id), 'pending_approval')
    assert.equal(await gateStatus(gateId), 'pending')
    const adminId = await createScratchUser(orgId, 'Ada Admin', 'admin')
    as(adminId, [{ key: 'admin', name: 'admin' }])
    const allowed = await post({ action: 'recall', documentId: id, expectedUpdatedAt: await revision(id) })
    assert.equal(allowed.status, 200, JSON.stringify(allowed.json))
    assert.equal(await statusOf(id), 'draft')
  } finally {
    await cleanup()
  }
})

test('recall refuses the creator when someone else submitted', async () => {
  const { orgId, submitterId, scratch, cleanup } = await fixture()
  try {
    as(submitterId, [{ key: 'accountant', name: 'accountant' }])
    const { id, gateId } = await submittedReport(orgId, submitterId, scratch, 'pending_approval')
    // The draft was created by an assistant but submitted by someone else:
    // authorship alone must not recall another user's submission.
    const creatorId = await createScratchUser(orgId, 'Creator C', 'accountant')
    await db.execute(sql`update documents set created_by = ${creatorId} where id = ${id} and org_id = ${orgId}`)
    as(creatorId, [{ key: 'accountant', name: 'accountant' }])
    const refused = await post({ action: 'recall', documentId: id, expectedUpdatedAt: await revision(id) })
    assert.equal(refused.status, 403, JSON.stringify(refused.json))
    assert.equal(await statusOf(id), 'pending_approval')
    assert.equal(await gateStatus(gateId), 'pending')
    // The actual submitter still recalls.
    as(submitterId, [{ key: 'accountant', name: 'accountant' }])
    const allowed = await post({ action: 'recall', documentId: id, expectedUpdatedAt: await revision(id) })
    assert.equal(allowed.status, 200, JSON.stringify(allowed.json))
    assert.equal(await statusOf(id), 'draft')
  } finally {
    await cleanup()
  }
})

test('recall keeps decided gates as history when reopening an approved report', { skip: !DB }, async () => {
  const { orgId, submitterId, scratch, cleanup } = await fixture()
  try {
    as(submitterId, [{ key: 'accountant', name: 'accountant' }])
    const { id, runId, gateId } = await submittedReport(orgId, submitterId, scratch, 'approved')
    await db.execute(sql`update flow_gates set status = 'approved', decided_by = ${submitterId}, decided_at = now() where id = ${gateId}`)
    await db.execute(sql`update flow_runs set status = 'completed', finished_at = now() where id = ${runId}`)
    const response = await post({ action: 'recall', documentId: id, expectedUpdatedAt: await revision(id) })
    assert.equal(response.status, 200, JSON.stringify(response.json))
    assert.equal(response.json?.cancelledGates, 0)
    assert.equal(response.json?.cancelledRuns, 0)
    assert.equal(await statusOf(id), 'draft')
    assert.equal(await gateStatus(gateId), 'approved', 'a decided gate stands as history')
    assert.equal(await runStatus(runId), 'completed')
  } finally {
    await cleanup()
  }
})

test('recall fails closed on wrong state and stale revisions', { skip: !DB }, async () => {
  const { orgId, submitterId, scratch, cleanup } = await fixture()
  try {
    as(submitterId, [{ key: 'accountant', name: 'accountant' }])
    const draftId = randomUUID()
    await db.execute(sql`
      insert into documents (id, org_id, kind, status, document_number, document_date, subsidiary_id, currency, subtotal, tax_total, total, custom, created_by)
      values (${draftId}, ${orgId}, 'expense_report', 'draft', 'EXP-DRAFT', ${scratch.date}, ${scratch.subsidiaryId}, 'CAD', '10', '0', '10', '{}'::jsonb, ${submitterId})`)
    assert.equal((await post({ action: 'recall', documentId: draftId, expectedUpdatedAt: await revision(draftId) })).status, 422)
    const { id } = await submittedReport(orgId, submitterId, scratch, 'pending_approval')
    assert.equal((await post({ action: 'recall', documentId: id })).status, 409, 'a missing revision must fail closed')
    assert.equal((await post({ action: 'recall', documentId: id, expectedUpdatedAt: '2000-01-01T00:00:00.000Z' })).status, 409, 'a stale revision must fail closed')
    assert.equal(await statusOf(id), 'pending_approval')
  } finally {
    await cleanup()
  }
})
