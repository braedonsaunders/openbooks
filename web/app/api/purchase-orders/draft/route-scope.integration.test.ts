import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { sql } from 'drizzle-orm'

// All three order draft routes share one factory and one scope contract: a
// restricted caller drafts in their single allowed subsidiary, or refuses by
// name — never an implicit null the order reads then hide.
const stateKey = Symbol.for('openbooks.order-draft-scope-test')
interface Gate {
  user: { orgId: string; id: string }
  permissions: Set<string>
  allowedSubsidiaryIds: Set<string> | null
}
const routeState: { gate: Gate | null } = { gate: null }
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState

const module_ = (source: string): { shortCircuit: true; format: 'module'; url: string } => ({
  shortCircuit: true,
  format: 'module',
  url: `data:text/javascript,${encodeURIComponent(source)}`,
})

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') {
      return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
    }
    // Re-export the REAL authz module and override only the session gate, so
    // the scope the draft routes resolve is the production resolution. The
    // feature gate stays real and reads the scratch org's flags.
    // The draft routes gate through guardFeaturePermission, which calls the
    // REAL guardPermission via web/lib's own './authz' specifier — intercept
    // that too, or the feature gate would resolve a real session.
    if (specifier === '../../../../lib/authz' ||
        (specifier === './authz' && (context.parentURL ?? '').includes('/web/lib/'))) {
      const real = nextResolve(specifier, context).url
      const nextServer = nextResolve('next/server', context).url
      return module_(`
        export * from ${JSON.stringify(real)};
        const state = globalThis[Symbol.for('openbooks.order-draft-scope-test')];
        const { NextResponse } = await import(${JSON.stringify(nextServer)});
        export async function guardPermission(_permission) {
          if (!state.gate) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
          return state.gate;
        }
      `)
    }
    return nextResolve(specifier, context)
  },
})

const { db } = await import('@openbooks/engine/src/platform/db.ts')
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import(
  '@openbooks/engine/src/testing/fixtures.ts'
)
const { POST: postPurchase } = await import('./route.ts')
const { POST: postSales } = await import('../../sales-orders/draft/route.ts')
const { POST: postEstimate } = await import('../../estimates/draft/route.ts')
hooks.deregister()
const DB = !!process.env.OPENBOOKS_DB_URL

const CASES = [
  { kind: 'purchase_order', post: postPurchase, permission: 'ap.create' },
  { kind: 'sales_order', post: postSales, permission: 'ar.create' },
  { kind: 'quote', post: postEstimate, permission: 'ar.create' },
] as const

async function setup() {
  const org = await createScratchOrg()
  const actor = await createScratchUser(org.orgId, 'Order drafter', 'reviewer')
  const other = randomUUID()
  await db.execute(sql`
    insert into subsidiaries (id, org_id, parent_id, name, base_currency, country)
    values (${other}, ${org.orgId}, ${org.subsidiaryId}, 'Entity B', 'CAD', 'CA')
  `)
  const gate = (permission: string, scope: Set<string> | null) => {
    routeState.gate = {
      user: { orgId: org.orgId, id: actor },
      permissions: new Set([permission]),
      allowedSubsidiaryIds: scope,
    }
  }
  const post = (post: (req: Request) => Promise<Response>, path: string) =>
    post(
      new Request(`http://openbooks.test${path}`, {
        method: 'POST',
        headers: { 'Idempotency-Key': randomUUID() },
      }),
    )
  return { org, other, gate, post }
}

async function orderDrafts(orgId: string, kind: string) {
  return (await db.execute<{ id: string; subsidiary_id: string | null }>(sql`
    select id, subsidiary_id from documents where org_id = ${orgId} and kind = ${kind}
  `)).rows
}

for (const { kind, post, permission } of CASES) {
  test(`${kind} draft lands a restricted caller in their own subsidiary`, { skip: !DB }, async () => {
    const { org, gate, post: run } = await setup()
    try {
      gate(permission, new Set([org.subsidiaryId]))
      const res = await run(post, `/api/${kind === 'quote' ? 'estimates' : kind === 'sales_order' ? 'sales-orders' : 'purchase-orders'}/draft`)
      assert.equal(res.status, 201)
      const created = (await res.json()) as { id: string }
      const drafts = await orderDrafts(org.orgId, kind)
      assert.equal(drafts.length, 1)
      assert.equal(drafts[0]!.id, created.id)
      assert.equal(drafts[0]!.subsidiary_id, org.subsidiaryId)
    } finally {
      routeState.gate = null
      await dropScratchOrg(org.orgId)
    }
  })

  test(`${kind} draft with no assignable subsidiary refuses by name and stores nothing`, { skip: !DB }, async () => {
    const { org, other, gate, post: run } = await setup()
    try {
      gate(permission, new Set([org.subsidiaryId, other]))
      const res = await run(post, `/api/${kind === 'quote' ? 'estimates' : kind === 'sales_order' ? 'sales-orders' : 'purchase-orders'}/draft`)
      assert.equal(res.status, 422)
      assert.deepEqual(await res.json(), { error: 'subsidiary_required' })
      assert.deepEqual(await orderDrafts(org.orgId, kind), [])
    } finally {
      routeState.gate = null
      await dropScratchOrg(org.orgId)
    }
  })
}
