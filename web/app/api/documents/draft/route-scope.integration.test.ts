import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { sql } from 'drizzle-orm'

const stateKey = Symbol.for('openbooks.document-draft-scope-test')
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
        const state = globalThis[Symbol.for('openbooks.document-draft-scope-test')];
        const { NextResponse } = await import(${JSON.stringify(nextServer)});
        export async function guardPermission(_permission) {
          if (!state.gate) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
          return state.gate;
        }
      `)
    }
    if (specifier.startsWith('@/') && context.parentURL) {
      const parentDir = decodeURIComponent(new URL('.', context.parentURL).href)
      const webRoot = parentDir.lastIndexOf('/web/')
      if (webRoot === -1) return nextResolve(specifier, context)
      return nextResolve(new URL(parentDir.slice(0, webRoot + 5) + specifier.slice(2) + '.ts').href, context)
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
  const actor = await createScratchUser(org.orgId, 'Document drafter', 'reviewer')
  const other = randomUUID()
  await db.execute(sql`
    insert into subsidiaries (id, org_id, parent_id, name, base_currency, country)
    values (${other}, ${org.orgId}, ${org.subsidiaryId}, 'Entity B', 'CAD', 'CA')
  `)
  const gate = (scope: Set<string> | null) => {
    routeState.gate = {
      user: { orgId: org.orgId, id: actor },
      permissions: new Set(['ap.create']),
      allowedSubsidiaryIds: scope,
    }
  }
  const post = () =>
    POST(
      new Request('http://openbooks.test/api/documents/draft', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'vendor_bill' }),
      }),
    )
  return { org, other, gate, post }
}

async function billDrafts(orgId: string) {
  return (await db.execute<{ id: string; subsidiary_id: string | null }>(sql`
    select id, subsidiary_id from documents
     where org_id = ${orgId} and kind = 'vendor_bill'
  `)).rows
}

test('a restricted document draft lands in their own subsidiary, never the root', { skip: !DB }, async () => {
  const { org, gate, post } = await setup()
  try {
    gate(new Set([org.subsidiaryId]))
    const res = await post()
    assert.equal(res.status, 200)
    const created = (await res.json()) as { id: string }
    const drafts = await billDrafts(org.orgId)
    assert.equal(drafts.length, 1)
    assert.equal(drafts[0]!.id, created.id)
    assert.equal(drafts[0]!.subsidiary_id, org.subsidiaryId)
  } finally {
    routeState.gate = null
    await dropScratchOrg(org.orgId)
  }
})

test('a document draft with no assignable subsidiary refuses by name and stores nothing', { skip: !DB }, async () => {
  const { org, other, gate, post } = await setup()
  try {
    gate(new Set([org.subsidiaryId, other]))
    const res = await post()
    assert.equal(res.status, 422)
    assert.deepEqual(await res.json(), { error: 'subsidiary_required' })
    assert.deepEqual(await billDrafts(org.orgId), [])
  } finally {
    routeState.gate = null
    await dropScratchOrg(org.orgId)
  }
})
