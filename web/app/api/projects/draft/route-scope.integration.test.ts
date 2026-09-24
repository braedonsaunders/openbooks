import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { sql } from 'drizzle-orm'

const stateKey = Symbol.for('openbooks.project-draft-scope-test')
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
    // the scope the draft route resolves is the production resolution.
    // The draft routes gate through guardFeaturePermission, which calls the
    // REAL guardPermission via web/lib's own './authz' specifier — intercept
    // that too, or the feature gate would resolve a real session.
    if (specifier === '../../../../lib/authz' ||
        (specifier === './authz' && (context.parentURL ?? '').includes('/web/lib/'))) {
      const real = nextResolve(specifier, context).url
      const nextServer = nextResolve('next/server', context).url
      return module_(`
        export * from ${JSON.stringify(real)};
        const state = globalThis[Symbol.for('openbooks.project-draft-scope-test')];
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
  const actor = await createScratchUser(org.orgId, 'Project drafter', 'reviewer')
  const other = randomUUID()
  await db.execute(sql`
    insert into subsidiaries (id, org_id, parent_id, name, base_currency, country)
    values (${other}, ${org.orgId}, ${org.subsidiaryId}, 'Entity B', 'CAD', 'CA')
  `)
  const gate = (scope: Set<string> | null) => {
    routeState.gate = {
      user: { orgId: org.orgId, id: actor },
      permissions: new Set(['projects.manage']),
      allowedSubsidiaryIds: scope,
    }
  }
  return { org, other, gate }
}

async function draftProjects(orgId: string) {
  return (await db.execute<{ id: string; subsidiary_id: string | null }>(sql`
    select id, subsidiary_id from projects where org_id = ${orgId} and name = 'New project'
  `)).rows
}

test('a restricted project draft lands in their own subsidiary', { skip: !DB }, async () => {
  const { org, gate } = await setup()
  try {
    gate(new Set([org.subsidiaryId]))
    const res = await POST()
    assert.equal(res.status, 200)
    const created = (await res.json()) as { id: string }
    const drafts = await draftProjects(org.orgId)
    assert.equal(drafts.length, 1)
    assert.equal(drafts[0]!.id, created.id)
    assert.equal(drafts[0]!.subsidiary_id, org.subsidiaryId)
  } finally {
    routeState.gate = null
    await dropScratchOrg(org.orgId)
  }
})

test('a project draft with no assignable subsidiary refuses by name and stores nothing', { skip: !DB }, async () => {
  const { org, other, gate } = await setup()
  try {
    gate(new Set([org.subsidiaryId, other]))
    const res = await POST()
    assert.equal(res.status, 422)
    assert.deepEqual(await res.json(), { error: 'subsidiary_required' })
    assert.deepEqual(await draftProjects(org.orgId), [])
  } finally {
    routeState.gate = null
    await dropScratchOrg(org.orgId)
  }
})
