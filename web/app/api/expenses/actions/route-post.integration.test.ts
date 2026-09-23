import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

// PA1: the expenses actions route `post` branch calls postDocument directly,
// with no caller-owned transaction. The prepare phase used to commit its
// before_post script mutation outside the posting transaction, so posting an
// approved report into a closed period refused the GL work but left the
// script's memo behind on the still-approved report. postDocument now opens
// the transaction itself, so the refusal rolls the mutation back too — and a
// successful post through the route still applies it once with drained
// effects.
const root = pathToFileURL(process.cwd() + '/').href
const state: { orgId: string; actorId: string } = { orgId: '', actorId: '' }
Object.assign(globalThis, { __expenseActionsPostAtomicState: state })
const virtual = (source: string) => ({ shortCircuit: true as const, url: 'data:text/javascript,' + encodeURIComponent(source) })
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'server-only') return virtual('export {}')
    if (specifier === '../../../../lib/authz') return virtual(`
      export async function getAuthz() {
        const s = globalThis.__expenseActionsPostAtomicState;
        return { user: { orgId: s.orgId, id: s.actorId }, permissions: ['expenses.create', 'ap.post'], allowedSubsidiaryIds: null };
      }
      export function can(authz, permission) { return authz.permissions.includes(permission) }
      export function guardSubsidiaryScope() { return null }
    `)
    if (specifier.startsWith('../../../../lib/features')) return virtual(`
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
const { installTrustedTestDatabaseBypass } = await import('@openbooks/engine/src/testing/database-bypass.ts')
installTrustedTestDatabaseBypass()
const { db, withBypassContext, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { createScratchOrg, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { POST } = await import('./route.ts')
const DB = !!process.env.OPENBOOKS_DB_URL

async function post(body: unknown): Promise<{ status: number; json: unknown }> {
  const response = await withOrgContext(state.orgId, () => POST(
    new Request('http://expenses.test/api/expenses/actions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  ))
  return { status: response.status, json: await response.json().catch(() => null) }
}

async function setup() {
  const org = await withBypassContext(() => createScratchOrg())
  state.orgId = org.orgId
  const actorId = randomUUID()
  state.actorId = actorId
  const employeePayable = randomUUID()
  const employeeReceivable = randomUUID()
  const employeeId = randomUUID()
  await withBypassContext(async () => {
    await db.execute(sql`
      insert into accounts (id, org_id, number, name, type, is_summary, is_active, eliminate, reconcilable, required_dimensions, custom, subsidiary_include_children)
      values (${employeePayable}, ${org.orgId}, '2110', 'Employee Reimbursements Payable', 'liability_current_other', false, true, false, false, '[]'::jsonb, '{}'::jsonb, true)`)
    await db.execute(sql`
      insert into accounts (id, org_id, number, name, type, is_summary, is_active, eliminate, reconcilable, required_dimensions, custom, subsidiary_include_children)
      values (${employeeReceivable}, ${org.orgId}, '1400', 'Employee Advances', 'asset_current_other', false, true, false, false, '[]'::jsonb, '{}'::jsonb, true)`)
    await db.execute(sql`
      update orgs
         set settings = jsonb_set(
           jsonb_set(
             jsonb_set(coalesce(settings, '{}'::jsonb), '{controlAccounts,employeePayable}', to_jsonb(${employeePayable}::text), true),
             '{controlAccounts,employeeReceivable}', to_jsonb(${employeeReceivable}::text), true),
           '{features,scripts}', 'true'::jsonb, true)
       where id = ${org.orgId}`)
    await db.execute(sql`
      insert into parties (id, org_id, kind, display_name, is_active, custom)
      values (${employeeId}, ${org.orgId}, 'employee', 'Rae Reporter', true, '{}'::jsonb)`)
    await db.execute(sql`
      insert into employee_roles (id, org_id, party_id) values (${randomUUID()}, ${org.orgId}, ${employeeId})`)
    await db.execute(sql`
      insert into user_scripts
        (org_id, name, trigger_point, document_kind, source, timeout_ms, sort_order, is_active)
      values (
        ${org.orgId}, 'stamp memo', 'before_post', 'expense_report',
        ${'function main(ctx) { return { set: { memo: "scripted-memo" } }; }'},
        2000, 100, true
      )`)
    await db.transaction(async (tx) => {
      await tx.execute(sql`
        insert into app_roles (org_id, key, name, is_built_in, permissions)
        values (${org.orgId}, 'clerk', 'clerk', false, '[]'::jsonb)
        on conflict (org_id, key) do update set updated_at = now()
        returning id`)
      await tx.execute(sql`
        insert into users (id, org_id, email, name, password_hash, is_active)
        values (${actorId}, ${org.orgId}, 'rae@test.local', 'Rae', 'x', true)`)
      await tx.execute(sql`
        insert into role_assignments (org_id, user_id, role_id)
        values (${org.orgId}, ${actorId},
                (select id from app_roles where org_id = ${org.orgId} and key = 'clerk'))`)
    })
  })
  return { org, employeeId }
}

async function seedApprovedReport(orgId: string, employeeId: string, date: string, subsidiaryId: string, number: string): Promise<string> {
  const documentId = randomUUID()
  await withBypassContext(async () => {
    await db.execute(sql`
      insert into documents
        (id, org_id, kind, status, document_number, document_date, party_id, subsidiary_id,
         currency, subtotal, tax_total, total, custom, created_by)
      values (
        ${documentId}, ${orgId}, 'expense_report', 'draft', ${number},
        ${date}, ${employeeId}, ${subsidiaryId},
        'CAD', '42.00', '0', '42.00', '{}'::jsonb, ${state.actorId}
      )`)
    await db.execute(sql`
      insert into document_lines
        (org_id, document_id, line_number, account_id, description,
         amount, quantity, unit_price, tax_amount, settlement_type)
      values
        (${orgId}, ${documentId}, 1, (select id from accounts where org_id = ${orgId} and number = '5000'),
         'Mileage', '42.00', '1', '42.00', '0', 'out_of_pocket')`)
    await db.execute(sql`
      update documents set status = 'approved'
       where id = ${documentId} and org_id = ${orgId}`)
  })
  return documentId
}

async function documentState(documentId: string) {
  return (await withBypassContext(async () =>
    (await db.execute<{
      status: string
      memo: string | null
      script_runs: number
      entry_count: number
      effects: string | null
    }>(sql`
      select d.status, d.memo,
             (select count(*)::int from script_runs r
               where r.target_id = ${documentId}) as script_runs,
             (select count(*)::int from journal_entries
               where source_document_id = ${documentId}) as entry_count,
             (select status from posting_effects
               where document_id = ${documentId}) as effects
        from documents d where d.id = ${documentId}
    `)),
  )).rows[0]!
}

test('a refused route post leaves the report, its memo, and script evidence untouched', { skip: !DB }, async () => {
  const { org, employeeId } = await setup()
  try {
    const documentId = await seedApprovedReport(org.orgId, employeeId, org.date, org.subsidiaryId, 'EXP-ROUTE-RB')
    await withBypassContext(async () => {
      await db.execute(sql`
        insert into period_locks
          (org_id, period_id, book_id, subsidiary_id, module, state,
           locked_at, locked_by, reason, created_by, updated_by)
        values (
          ${org.orgId}, ${org.periodId}, ${org.bookId}, ${org.subsidiaryId},
          'gl', 'closed', now(), ${state.actorId}, 'Route atomicity probe',
          ${state.actorId}, ${state.actorId}
        )`)
    })
    const response = await post({ action: 'post', documentId })
    assert.equal(response.status, 422, `expected 422, got ${response.status}: ${JSON.stringify(response.json)}`)
    assert.match(String((response.json as { error?: string }).error ?? ''), /closed/i)
    assert.deepEqual(
      await documentState(documentId),
      { status: 'approved', memo: null, script_runs: 0, entry_count: 0, effects: null },
      'the refused route post must not leave the script mutation or its evidence behind',
    )
  } finally {
    await dropScratchOrg(org.orgId)
  }
})

test('a successful route post applies the script mutation once with drained effects', { skip: !DB }, async () => {
  const { org, employeeId } = await setup()
  try {
    const documentId = await seedApprovedReport(org.orgId, employeeId, org.date, org.subsidiaryId, 'EXP-ROUTE-OK')
    const response = await post({ action: 'post', documentId })
    assert.equal(response.status, 200, `expected 200, got ${response.status}: ${JSON.stringify(response.json)}`)
    assert.ok((response.json as { entryId?: string }).entryId)
    assert.deepEqual(
      await documentState(documentId),
      { status: 'posted', memo: 'scripted-memo', script_runs: 1, entry_count: 1, effects: 'succeeded' },
      'the route post carries the script mutation, one entry, and drained effects',
    )
  } finally {
    await dropScratchOrg(org.orgId)
  }
})
