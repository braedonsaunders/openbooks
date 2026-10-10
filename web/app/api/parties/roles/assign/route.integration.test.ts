import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { resolveEngineSpecifier } from '../../../../../testing/engine-resolve-hooks'
import type { SessionUser } from '../../../../../lib/auth'

// Bulk role assignment promotes every role-less party in the named slice
// through the native role command, audited per party. Re-running is safe:
// promoted parties leave the slice, so the second run assigns nothing.
const session: { user: SessionUser | null } = { user: null }
Object.assign(globalThis, { __partyBulkAssignSession: session })
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === './auth' && context.parentURL?.endsWith('/web/lib/authz.ts')) {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export async function currentUser(){return globalThis.__partyBulkAssignSession.user}',
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
  const actor = await withBypassContext(() => createScratchUser(org.orgId, 'Role assigner', 'reviewer'))
  await withBypassContext(() =>
    db.execute(
      sql`update app_roles set permissions='["*"]'::jsonb where org_id=${org.orgId} and key='reviewer'`,
    ),
  )
  session.user = {
    id: actor,
    orgId: org.orgId,
    name: 'Assigner',
    email: 'assigner@example.test',
    roles: [],
    isSuperAdmin: false,
    envKind: 'production',
    productionOrgId: org.orgId,
    homeOrgId: org.orgId,
    homeUserId: actor,
  }
  return { orgId: org.orgId, actor, cleanup: () => dropScratchOrg(org.orgId) }
}

async function insertCompanyParty(ctx: Ctx, name: string): Promise<string> {
  const id = randomUUID()
  await withBypassContext(() =>
    db.execute(sql`
      insert into parties (id, org_id, kind, display_name, subsidiary_id, is_active, custom, created_by, updated_by)
      select ${id}, ${ctx.orgId}, 'company', ${name}, s.id, true, '{}'::jsonb, ${ctx.actor}, ${ctx.actor}
        from subsidiaries s
       where s.org_id = ${ctx.orgId} and s.parent_id is null
       limit 1
    `),
  )
  return id
}

async function roleCount(orgId: string, table: 'vendor_roles' | 'customer_roles', partyId: string): Promise<number> {
  const result = await withBypassContext(() =>
    db.execute<{ count: string }>(
      sql`select count(*)::text as count from ${sql.raw(table)} where org_id = ${orgId} and party_id = ${partyId} and is_active`,
    ),
  )
  return Number(result.rows[0]?.count ?? '0')
}

const assignRequest = (body: unknown) =>
  new Request('http://assign.local', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

test('bulk assignment promotes every role-less party and audits each one', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const ctx = await fixture()
  try {
    // Scratch orgs ship seeded role-less parties, so the slice is scoped by
    // the endpoint's own search text — the same isolation the directory uses.
    const first = await insertCompanyParty(ctx, 'Assign First Co')
    const second = await insertCompanyParty(ctx, 'Assign Second Co')
    const already = await insertCompanyParty(ctx, 'Assign Already Vendor Co')
    await withBypassContext(() => db.execute(sql`
      insert into vendor_roles (org_id, party_id, is_active, created_by, updated_by)
      values (${ctx.orgId}, ${already}, true, ${ctx.actor}, ${ctx.actor})`))

    const res = await withOrgContext(ctx.orgId, () => POST(assignRequest({ role: 'vendor', q: 'Assign' })))
    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), { assigned: 2, total: 2 })
    assert.equal(await roleCount(ctx.orgId, 'vendor_roles', first), 1)
    assert.equal(await roleCount(ctx.orgId, 'vendor_roles', second), 1)
    assert.equal(await roleCount(ctx.orgId, 'vendor_roles', already), 1, 'the pre-roled party is untouched')

    const audits = (await withBypassContext(() => db.execute<{ n: string }>(sql`
      select count(*)::text as n from audit_log
       where org_id = ${ctx.orgId} and table_name = 'parties' and changes->>'source' = 'bulk-role-assign'
         and row_id in (${first}, ${second}, ${already})`))).rows[0]?.n
    assert.equal(Number(audits), 2, 'each promotion carries its own audit evidence')

    const rerun = await withOrgContext(ctx.orgId, () => POST(assignRequest({ role: 'vendor', q: 'Assign' })))
    assert.equal(rerun.status, 200)
    assert.deepEqual(await rerun.json(), { assigned: 0, total: 0 }, 'promoted parties left the slice')
  } finally {
    session.user = null
    await ctx.cleanup()
  }
})

test('bulk assignment refuses an invalid role and an empty slice', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const ctx = await fixture()
  try {
    const bad = await withOrgContext(ctx.orgId, () => POST(assignRequest({ role: 'partner' })))
    assert.equal(bad.status, 422)

    const empty = await withOrgContext(ctx.orgId, () => POST(assignRequest({ role: 'customer', q: 'zzz-no-such-party' })))
    assert.equal(empty.status, 200)
    assert.deepEqual(await empty.json(), { assigned: 0, total: 0 })
  } finally {
    session.user = null
    await ctx.cleanup()
  }
})
