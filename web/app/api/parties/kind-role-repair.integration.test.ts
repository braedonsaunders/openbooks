import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import test from 'node:test'
import type { SessionUser } from '../../../lib/auth'

// OM-16c: an existing party whose kind outlived its role row (a legacy
// orphan) is repaired by saving the role-bearing kind WITH its role enabled
// in one audited PATCH — the same upsert the drawer sends. The kind↔role
// guard stays enforced: the 200s below come from satisfying it, never from
// bypassing it. Auth follows the update-controls pattern: currentUser reads
// the stubbed session, and every route call runs under withOrgContext.

const session: { user: SessionUser | null } = { user: null }
Object.assign(globalThis, { __partyKindRoleRepairSession: session })
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' }
    if (specifier === './auth' && context.parentURL?.endsWith('/web/lib/authz.ts')) {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export async function currentUser(){return globalThis.__partyKindRoleRepairSession.user}',
      }
    }
    if (specifier.startsWith('@/')) {
      const webRoot = import.meta.url.slice(0, import.meta.url.indexOf('/web/') + 5)
      return next(new URL(`${specifier.slice(2)}.ts`, webRoot).href, context)
    }
    if (specifier.startsWith('@openbooks/engine/')) {
      const root = import.meta.url.slice(0, import.meta.url.indexOf('/web/') + 1)
      return next(new URL(`engine/${specifier.slice('@openbooks/engine/'.length)}`, root).href, context)
    }
    return next(specifier, context)
  },
})

const { sql } = await import('drizzle-orm')
const { db, withBypassContext, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import(
  '@openbooks/engine/src/testing/fixtures.ts'
)
const { PATCH, GET } = await import('./[id]/route.ts')

const params = (id: string) => ({ params: Promise.resolve({ id }) })
const patchRequest = (body: unknown) =>
  new Request('http://audit.local', { method: 'PATCH', body: JSON.stringify(body) })

type Ctx = { orgId: string; actor: string }

async function fixture(): Promise<Ctx & { cleanup: () => Promise<void> }> {
  const org = await withBypassContext(() => createScratchOrg())
  const actor = await withBypassContext(() => createScratchUser(org.orgId, 'Role repairer', 'reviewer'))
  await withBypassContext(() =>
    db.execute(
      sql`update app_roles set permissions='["*"]'::jsonb where org_id=${org.orgId} and key='reviewer'`,
    ),
  )
  session.user = {
    id: actor,
    orgId: org.orgId,
    name: 'Repairer',
    email: 'repairer@example.test',
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

async function revision(orgId: string, partyId: string): Promise<string> {
  const res = await withOrgContext(orgId, () => GET(new Request('http://audit.local'), params(partyId)))
  assert.equal(res.status, 200)
  return (await res.json()).party.updated_at as string
}

async function roleCount(orgId: string, table: 'vendor_roles' | 'customer_roles', partyId: string): Promise<number> {
  const result = await withBypassContext(() =>
    db.execute<{ count: string }>(
      sql`select count(*)::text as count from ${sql.raw(table)} where org_id = ${orgId} and party_id = ${partyId} and is_active`,
    ),
  )
  return Number(result.rows[0]?.count ?? '0')
}

async function patchKind(
  ctx: Ctx,
  partyId: string,
  patchBody: Record<string, unknown>,
): Promise<{ status: number; text: string }> {
  const expectedUpdatedAt = await revision(ctx.orgId, partyId)
  const res = await withOrgContext(ctx.orgId, () =>
    PATCH(patchRequest({ ...patchBody, expectedUpdatedAt }), params(partyId)),
  )
  return { status: res.status, text: await res.text() }
}

test('PATCH repairs an orphan company party to kind vendor with its role', async () => {
  const ctx = await fixture()
  try {
    const partyId = await insertCompanyParty(ctx, 'Acme Industrial Supply')
    assert.equal(await roleCount(ctx.orgId, 'vendor_roles', partyId), 0, 'the orphan starts with no vendor role')

    const first = await patchKind(ctx, partyId, { kind: 'vendor', roles: { vendor: { enabled: true } } })
    assert.equal(first.status, 200, `the repair PATCH must succeed, got ${first.text}`)
    const kind = await withBypassContext(() =>
      db.execute<{ kind: string }>(
        sql`select kind from parties where id = ${partyId} and org_id = ${ctx.orgId}`,
      ),
    )
    assert.equal(kind.rows[0]?.kind, 'vendor', 'the kind is now vendor')
    assert.equal(await roleCount(ctx.orgId, 'vendor_roles', partyId), 1, 'the canonical vendor role now exists')

    const second = await patchKind(ctx, partyId, { kind: 'vendor', roles: { vendor: { enabled: true } } })
    assert.equal(second.status, 200, 'repeating the repair is idempotent')
    assert.equal(await roleCount(ctx.orgId, 'vendor_roles', partyId), 1, 'no duplicate role row is created')
  } finally {
    session.user = null
    await ctx.cleanup()
  }
})

test('PATCH repairs an orphan company party to kind customer with its role', async () => {
  const ctx = await fixture()
  try {
    const partyId = await insertCompanyParty(ctx, 'Acme Industrial Buyer')
    const first = await patchKind(ctx, partyId, { kind: 'customer', roles: { customer: { enabled: true } } })
    assert.equal(first.status, 200, `the repair PATCH must succeed, got ${first.text}`)
    assert.equal(await roleCount(ctx.orgId, 'customer_roles', partyId), 1, 'the canonical customer role now exists')

    const second = await patchKind(ctx, partyId, { kind: 'customer', roles: { customer: { enabled: true } } })
    assert.equal(second.status, 200, 'repeating the repair is idempotent')
  } finally {
    session.user = null
    await ctx.cleanup()
  }
})
