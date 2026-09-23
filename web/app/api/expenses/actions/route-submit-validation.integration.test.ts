import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

// Ordinary submission refusals — a report with no employee and a correction
// whose linked void is still open — are request-state failures. The engine
// raises named domain errors (ExpenseValidationError, SubmitError) and this
// route maps them to 422 with the message; they must never surface as 500.
const root = pathToFileURL(process.cwd() + '/').href
const state: { orgId: string; actorId: string } = { orgId: '', actorId: '' }
Object.assign(globalThis, { __expenseActionsSubmitValidationState: state })
const virtual = (source: string) => ({ shortCircuit: true as const, url: 'data:text/javascript,' + encodeURIComponent(source) })
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'server-only') return virtual('export {}')
    if (specifier === '../../../../lib/authz') return virtual(`
      export async function getAuthz() {
        const s = globalThis.__expenseActionsSubmitValidationState;
        return { user: { orgId: s.orgId, id: s.actorId }, permissions: ['expenses.create', 'ap.post'], allowedSubsidiaryIds: null };
      }
      export function can(authz, permission) { return authz.permissions.includes(permission) }
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
const { installTrustedTestDatabaseBypass } = await import('@openbooks/engine/src/testing/database-bypass.ts')
installTrustedTestDatabaseBypass()
const { db, withBypassContext, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { createScratchOrg, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { POST } = await import('./route.ts')

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

async function setup(): Promise<{ orgId: string; employeeId: string; date: string; subsidiaryId: string; periodId: string; bookId: string; accounts: { bank: string; adjustment: string }; cleanup: () => Promise<void> }> {
  const org = await withBypassContext(() => createScratchOrg())
  state.orgId = org.orgId
  const actorId = randomUUID()
  state.actorId = actorId
  const employeeId = await withBypassContext(async () => {
    const partyId = randomUUID()
    await db.execute(sql`
      insert into parties (id, org_id, kind, display_name, is_active, custom)
      values (${partyId}, ${org.orgId}, 'employee', 'Sammy Sloppy', true, '{}'::jsonb)`)
    await db.execute(sql`
      insert into employee_roles (id, org_id, party_id) values (${randomUUID()}, ${org.orgId}, ${partyId})`)
    await db.transaction(async (tx) => {
      const role = (await tx.execute<{ id: string }>(sql`
        insert into app_roles (org_id, key, name, is_built_in, permissions)
        values (${org.orgId}, 'clerk', 'clerk', false, '[]'::jsonb)
        on conflict (org_id, key) do update set updated_at = now()
        returning id`))
      await tx.execute(sql`
        insert into users (id, org_id, email, name, password_hash, is_active)
        values (${actorId}, ${org.orgId}, 'sammy@test.local', 'Sammy', 'x', true)`)
      await tx.execute(sql`
        insert into role_assignments (org_id, user_id, role_id)
        values (${org.orgId}, ${actorId}, ${role.rows[0]!.id})`)
    })
    return partyId
  })
  const cleanup = async () => {
    await withBypassContext(async () => {
      await db.execute(sql`delete from employee_roles where org_id = ${org.orgId}`)
    })
    await dropScratchOrg(org.orgId)
  }
  return { orgId: org.orgId, employeeId, date: org.date, subsidiaryId: org.subsidiaryId, periodId: org.periodId, bookId: org.bookId, accounts: org.accounts, cleanup }
}

test('submitting a report with no employee fails with 422, not 500', async () => {
  const { orgId, date, subsidiaryId, cleanup } = await setup()
  try {
    const documentId = randomUUID()
    await withBypassContext(async () => {
      await db.execute(sql`
        insert into documents (id, org_id, kind, status, document_number, document_date, subsidiary_id, currency, subtotal, tax_total, total, custom)
        values (${documentId}, ${orgId}, 'expense_report', 'draft', 'EXP-NOEMP-1', ${date}, ${subsidiaryId},
                'CAD', '10', '0', '10', '{}'::jsonb)`)
    })
    const response = await post({ action: 'submit', documentId })
    assert.equal(response.status, 422, `expected 422, got ${response.status}: ${JSON.stringify(response.json)}`)
    assert.match(String((response.json as { error?: string }).error ?? ''), /employee/i)
  } finally {
    await cleanup()
  }
})

test('submitting a correction with an open linked void fails with 422, not 500', async () => {
  const { orgId, employeeId, date, subsidiaryId, periodId, bookId, accounts, cleanup } = await setup()
  try {
    const sourceId = randomUUID()
    const correctionId = randomUUID()
    const entryId = randomUUID()
    await withBypassContext(async () => {
      await db.execute(sql`
        insert into journal_entries
          (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, memo, status, origin, created_by, updated_by)
        values
          (${entryId}, ${orgId}, ${bookId}, ${subsidiaryId}, 'SRC-ENTRY-1', ${date}, ${periodId}, 'source entry', 'draft', 'manual', ${state.actorId}, ${state.actorId})`)
      await db.execute(sql`
        insert into journal_lines
          (org_id, entry_id, line_number, account_id, subsidiary_id, amount, currency, txn_amount, fx_rate, memo)
        values
          (${orgId}, ${entryId}, 1, ${accounts.bank}, ${subsidiaryId}, '10', 'CAD', '10', 1, 'source'),
          (${orgId}, ${entryId}, 2, ${accounts.adjustment}, ${subsidiaryId}, '-10', 'CAD', '-10', 1, 'source')`)
      await db.execute(sql`
        update journal_entries set status = 'posted' where id = ${entryId} and org_id = ${orgId}`)
      await db.execute(sql`
        insert into documents (id, org_id, kind, status, document_number, document_date, posted_entry_id, posting_period_id, party_id, subsidiary_id, currency, subtotal, tax_total, total, custom)
        values (${sourceId}, ${orgId}, 'expense_report', 'posted', 'EXP-SRC-1', ${date}, ${entryId}, ${periodId}, ${employeeId}, ${subsidiaryId}, 'CAD', '10', '0', '10', '{}'::jsonb)`)
      await db.execute(sql`
        insert into documents (id, org_id, kind, status, document_number, document_date, party_id, subsidiary_id, currency, subtotal, tax_total, total, custom)
        values (${correctionId}, ${orgId}, 'expense_report', 'draft', 'EXP-CORR-1', ${date}, ${employeeId}, ${subsidiaryId}, 'CAD', '10', '0', '10', '{}'::jsonb)`)
      await db.execute(sql`
        insert into document_links (org_id, from_document_id, to_document_id, link_type, reason, requested_by, requested_at)
        values (${orgId}, ${correctionId}, ${sourceId}, 'reverses', 'amount entered wrong', ${state.actorId}, now())`)
    })
    const response = await post({ action: 'submit', documentId: correctionId })
    assert.equal(response.status, 422, `expected 422, got ${response.status}: ${JSON.stringify(response.json)}`)
    assert.match(String((response.json as { error?: string }).error ?? ''), /void is approved/i)
  } finally {
    await cleanup()
  }
})
