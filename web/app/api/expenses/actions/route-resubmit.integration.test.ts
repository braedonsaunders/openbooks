import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

// A double-clicked (or replayed) submit on an already-submitted expense
// report must fail closed as a 4xx with a named error. The engine's
// not-draft refusal is a plain Error, which this route's catch maps to a
// 500 — an operator retry storm against a state that can never succeed.
const root = pathToFileURL(process.cwd() + '/').href
const state: { orgId: string; actorId: string } = { orgId: '', actorId: '' }
Object.assign(globalThis, { __expenseActionsResubmitState: state })
const virtual = (source: string) => ({ shortCircuit: true as const, url: 'data:text/javascript,' + encodeURIComponent(source) })
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'server-only') return virtual('export {}')
    if (specifier === '../../../../lib/authz') return virtual(`
      export async function getAuthz() {
        const s = globalThis.__expenseActionsResubmitState;
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

test('resubmitting an expense report fails closed with a 422, not a 500', { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg())
  state.orgId = org.orgId
  const actorId = randomUUID()
  state.actorId = actorId
  try {
    const documentId = await withBypassContext(async () => {
      const employeeId = randomUUID()
      await db.execute(sql`
        insert into parties (id, org_id, kind, display_name, is_active, custom)
        values (${employeeId}, ${org.orgId}, 'employee', 'Sammy Sloppy', true, '{}'::jsonb)`)
      await db.execute(sql`
        insert into employee_roles (id, org_id, party_id) values (${randomUUID()}, ${org.orgId}, ${employeeId})`)
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
      const documentId = randomUUID()
      await db.execute(sql`
        insert into documents (id, org_id, kind, status, document_number, document_date, party_id, subsidiary_id, currency, subtotal, tax_total, total, custom)
        values (${documentId}, ${org.orgId}, 'expense_report', 'draft', 'EXP-RESUBMIT-1', ${org.date}, ${employeeId}, ${org.subsidiaryId}, 'CAD', '10', '0', '10', '{}'::jsonb)`)
      return documentId
    })
    const first = await post({ action: 'submit', documentId })
    assert.equal(first.status, 200, `first submit must succeed, got ${first.status}: ${JSON.stringify(first.json)}`)
    const second = await post({ action: 'submit', documentId })
    assert.equal(second.status, 422, `resubmit must fail closed with 422, got ${second.status}: ${JSON.stringify(second.json)}`)
    assert.match(String((second.json as { error?: string }).error ?? ''), /draft/i)
  } finally {
    await withBypassContext(async () => {
      await db.execute(sql`delete from employee_roles where org_id = ${org.orgId}`)
    })
    await dropScratchOrg(org.orgId)
  }
})
