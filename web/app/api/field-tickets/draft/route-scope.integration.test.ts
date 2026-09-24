import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { sql } from 'drizzle-orm'

const stateKey = Symbol.for('openbooks.field-ticket-draft-scope-test')
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
    // the scope the draft factory receives is the production resolution.
    // The draft routes gate through guardFeaturePermission, which calls the
    // REAL guardPermission via web/lib's own './authz' specifier — intercept
    // that too, or the feature gate would resolve a real session.
    if (specifier === '../../../../lib/authz' ||
        (specifier === './authz' && (context.parentURL ?? '').includes('/web/lib/'))) {
      const real = nextResolve(specifier, context).url
      const nextServer = nextResolve('next/server', context).url
      return module_(`
        export * from ${JSON.stringify(real)};
        const state = globalThis[Symbol.for('openbooks.field-ticket-draft-scope-test')];
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
const { POST } = await import('./route.ts')
hooks.deregister()
const DB = !!process.env.OPENBOOKS_DB_URL

async function setup() {
  const org = await createScratchOrg()
  const actor = await createScratchUser(org.orgId, 'Ticket drafter', 'reviewer')
  await db.execute(sql`
    update orgs set settings = jsonb_set(settings, '{features}',
      coalesce(settings->'features', '{}'::jsonb) || '{"fieldTickets":true}'::jsonb)
     where id = ${org.orgId}
  `)
  const other = randomUUID()
  await db.execute(sql`
    insert into subsidiaries (id, org_id, parent_id, name, base_currency, country)
    values (${other}, ${org.orgId}, ${org.subsidiaryId}, 'Entity B', 'CAD', 'CA')
  `)
  const gate = (scope: Set<string> | null) => {
    routeState.gate = {
      user: { orgId: org.orgId, id: actor },
      permissions: new Set(['time.manage']),
      allowedSubsidiaryIds: scope,
    }
  }
  return { org, actor, other, gate }
}

async function draftCount(orgId: string): Promise<{ total: number; unscoped: number }> {
  const rows = await db.execute<{ total: string; unscoped: string }>(sql`
    select count(*)::text as total,
           count(*) filter (where subsidiary_id is null)::text as unscoped
      from documents where org_id = ${orgId} and kind = 'field_ticket'
  `)
  return { total: Number(rows.rows[0]?.total ?? 0), unscoped: Number(rows.rows[0]?.unscoped ?? 0) }
}

test('a restricted drafter lands in their own subsidiary, never an org-wide draft', { skip: !DB }, async () => {
  const { org, gate } = await setup()
  try {
    gate(new Set([org.subsidiaryId]))
    const res = await POST()
    assert.equal(res.status, 200)
    const created = (await res.json()) as { id: string }
    const row = (await db.execute<{ subsidiary_id: string | null }>(sql`
      select subsidiary_id from documents where id = ${created.id} and org_id = ${org.orgId}
    `)).rows[0]
    assert.equal(row?.subsidiary_id, org.subsidiaryId)
    const counts = await draftCount(org.orgId)
    assert.equal(counts.unscoped, 0, 'no org-wide draft may be minted for a restricted caller')
  } finally {
    routeState.gate = null
    await dropScratchOrg(org.orgId)
  }
})

test('a draft with no assignable subsidiary refuses by name and stores nothing', { skip: !DB }, async () => {
  const { org, other, gate } = await setup()
  try {
    gate(new Set([org.subsidiaryId, other]))
    const res = await POST()
    assert.equal(res.status, 422)
    assert.deepEqual(await res.json(), { error: 'subsidiary_required' })
    assert.deepEqual(await draftCount(org.orgId), { total: 0, unscoped: 0 })
  } finally {
    routeState.gate = null
    await dropScratchOrg(org.orgId)
  }
})
