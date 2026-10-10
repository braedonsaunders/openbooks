import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { resolveEngineSpecifier } from '../../../../../../testing/engine-resolve-hooks'
import type { SessionUser } from '../../../../../../lib/auth'

// Removing a native role deletes its row with an audit trail. A role with
// open activity refuses by name and offers deactivation as the remedy; a
// clean role removes and its stored kind falls back to its base.
const session: { user: SessionUser | null } = { user: null }
Object.assign(globalThis, { __partyRoleRemoveSession: session })
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === './auth' && context.parentURL?.endsWith('/web/lib/authz.ts')) {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export async function currentUser(){return globalThis.__partyRoleRemoveSession.user}',
      }
    }
    const engineUrl = resolveEngineSpecifier(specifier)
    if (engineUrl) return next(engineUrl, context)
    return next(specifier, context)
  },
})

const { sql } = await import('drizzle-orm')
const { db, withBypassContext, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import(
  '@openbooks/engine/src/testing/fixtures.ts'
)
const { POST } = await import('./route.ts')

type Ctx = { orgId: string; actor: string }

async function fixture(): Promise<Ctx & { cleanup: () => Promise<void> }> {
  const org = await withBypassContext(() => createScratchOrg())
  const actor = await withBypassContext(() => createScratchUser(org.orgId, 'Role remover', 'reviewer'))
  await withBypassContext(() =>
    db.execute(
      sql`update app_roles set permissions='["*"]'::jsonb where org_id=${org.orgId} and key='reviewer'`,
    ),
  )
  session.user = {
    id: actor,
    orgId: org.orgId,
    name: 'Remover',
    email: 'remover@example.test',
    roles: [],
    isSuperAdmin: false,
    envKind: 'production',
    productionOrgId: org.orgId,
    homeOrgId: org.orgId,
    homeUserId: actor,
  }
  return { orgId: org.orgId, actor, cleanup: () => dropScratchOrg(org.orgId) }
}

async function insertVendorParty(ctx: Ctx, name: string, kind = 'vendor'): Promise<string> {
  const id = randomUUID()
  await withBypassContext(() =>
    db.execute(sql`
      insert into parties (id, org_id, kind, display_name, subsidiary_id, is_active, custom, created_by, updated_by)
      select ${id}, ${ctx.orgId}, ${kind}, ${name}, s.id, true, '{}'::jsonb, ${ctx.actor}, ${ctx.actor}
        from subsidiaries s
       where s.org_id = ${ctx.orgId} and s.parent_id is null
       limit 1
    `),
  )
  await withBypassContext(() => db.execute(sql`
    insert into vendor_roles (org_id, party_id, is_active, created_by, updated_by)
    values (${ctx.orgId}, ${id}, true, ${ctx.actor}, ${ctx.actor})`))
  return id
}

async function insertOpenBill(ctx: Ctx, partyId: string): Promise<void> {
  await withBypassContext(() => db.execute(sql`
    insert into documents (id, org_id, kind, document_number, party_id, document_date, currency, status, open_balance)
    values (${randomUUID()}, ${ctx.orgId}, 'vendor_bill', 'BILL-1', ${partyId}, '2026-09-01', 'USD', 'approved', '250.0000')`))
}

const removeRequest = (partyId: string, body: unknown) =>
  new Request('http://remove.local', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

async function postRemove(ctx: Ctx, partyId: string, body: unknown) {
  return withOrgContext(ctx.orgId, () =>
    POST(removeRequest(partyId, body), { params: Promise.resolve({ id: partyId }) }),
  )
}

test('a clean vendor role removes with its kind falling back to company', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const ctx = await fixture()
  try {
    const partyId = await insertVendorParty(ctx, 'Mistake Vendor Co')

    const res = await postRemove(ctx, partyId, { role: 'vendor' })
    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), { removed: true, kind: 'company' })

    const stored = (await withBypassContext(() => db.execute<{ kind: string }>(sql`
      select kind from parties where id = ${partyId} and org_id = ${ctx.orgId}`))).rows[0]
    assert.equal(stored?.kind, 'company')
    const roles = (await withBypassContext(() => db.execute<{ n: string }>(sql`
      select count(*)::text as n from vendor_roles where org_id = ${ctx.orgId} and party_id = ${partyId}`))).rows[0]
    assert.equal(Number(roles?.n ?? '1'), 0, 'the role row is deleted, not deactivated')

    const audit = (await withBypassContext(() => db.execute<{ changes: unknown }>(sql`
      select changes from audit_log
       where org_id = ${ctx.orgId} and table_name = 'parties' and row_id = ${partyId} and action = 'update'
       order by at desc limit 1`))).rows[0]?.changes as
      { source: string; role: string; before: { kind: string }; after: { kind: string; role: null } }
    assert.equal(audit.source, 'role-remove')
    assert.equal(audit.role, 'vendor')
    assert.equal(audit.before.kind, 'vendor')
    assert.deepEqual(audit.after, { kind: 'company', role: null })

    const rerun = await postRemove(ctx, partyId, { role: 'vendor' })
    assert.equal(rerun.status, 422, 'removing twice fails closed on the missing role')
  } finally {
    session.user = null
    await ctx.cleanup()
  }
})

test('a vendor role with an open bill refuses with the deactivate remedy', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const ctx = await fixture()
  try {
    const partyId = await insertVendorParty(ctx, 'Busy Vendor Co')
    await insertOpenBill(ctx, partyId)

    const res = await postRemove(ctx, partyId, { role: 'vendor' })
    assert.equal(res.status, 422)
    const body = (await res.json()) as { error: string }
    assert.match(body.error, /open bill/)
    assert.match(body.error, /[Dd]eactivate the vendor role instead/)

    const roles = (await withBypassContext(() => db.execute<{ n: string }>(sql`
      select count(*)::text as n from vendor_roles where org_id = ${ctx.orgId} and party_id = ${partyId}`))).rows[0]
    assert.equal(Number(roles?.n ?? '0'), 1, 'the refused removal writes nothing')
  } finally {
    session.user = null
    await ctx.cleanup()
  }
})
