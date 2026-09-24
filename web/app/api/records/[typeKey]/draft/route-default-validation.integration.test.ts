import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { sql } from 'drizzle-orm'

// E23: draft creation seeded default-expression values (today/now/
// current-user/expression) and persisted them without validation, so a
// misconfigured default stored wrongly-typed data. A draft may be incomplete,
// but it can't be wrongly typed: the route validates at 'draft' stage.

const stateKey = Symbol.for('openbooks.custom-record-draft-validation-test')
const state: { authz: unknown } = { authz: null }
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = state

const mockAuthz = `
  import { NextResponse } from 'next/server';
  const state = globalThis[Symbol.for('openbooks.custom-record-draft-validation-test')]
  export async function guardPermission() {
    if (!state.authz) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
    return state.authz;
  }
`

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') {
      return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
    }
    if (specifier === '../../../../../lib/authz' && context.parentURL?.includes('/api/records/')) {
      return { url: 'mock:custom-record-draft-validation-authz', shortCircuit: true }
    }
    if (specifier.startsWith('@/') && context.parentURL) {
      const webRoot = import.meta.url.slice(0, import.meta.url.indexOf('/web/') + 5)
      return nextResolve(new URL(`${specifier.slice(2)}.ts`, webRoot).href, context)
    }
    if (context.parentURL?.startsWith('mock:') && (specifier.startsWith('@openbooks/') || specifier === 'next/server')) {
      return nextResolve(specifier, { ...context, parentURL: import.meta.url })
    }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    if (url === 'mock:custom-record-draft-validation-authz') {
      return { format: 'module', source: mockAuthz, shortCircuit: true }
    }
    return nextLoad(url, context)
  },
})

const routeUrl = './route.ts?custom-record-draft-validation-test'
const { POST } = (await import(routeUrl)) as typeof import('./route.ts')
hooks.deregister()

const { db, env, withBypass, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { createScratchOrg, dropScratchOrg, seedFlowActors } = await import(
  '@openbooks/engine/src/testing/fixtures.ts',
)

async function seedType(orgId: string, actorId: string, fields: unknown): Promise<string> {
  const typeKey = `draft-${randomUUID().replaceAll('-', '').slice(0, 10)}`
  await withBypass(async () => {
    await db.execute(sql`
      insert into custom_record_types
        (id, org_id, key, name, plural_name, fields, status, created_by, updated_by)
      values
        (${randomUUID()}, ${orgId}, ${typeKey}, 'Draft Validation', 'Draft Validations',
         ${JSON.stringify(fields)}::jsonb, 'published', ${actorId}, ${actorId})
    `)
  })
  return typeKey
}

const section = (fields: unknown[]) => [{ id: 'main', title: 'Details', fields }]

async function draftAs(typeKey: string, orgId: string, actorId: string): Promise<Response> {
  state.authz = {
    user: {
      id: actorId,
      orgId,
      name: 'Draft Admin',
      roles: [{ key: 'admin', name: 'Admin' }],
    },
    permissions: new Set(['records.create']),
    allowedSubsidiaryIds: null,
  }
  try {
    return await withOrgContext(orgId, async () =>
      POST(new Request(`http://localhost/api/records/${typeKey}/draft`, { method: 'POST' }), {
        params: Promise.resolve({ typeKey }),
      }),
    )
  } finally {
    state.authz = null
  }
}

test(
  'a misconfigured default that mistypes a field refuses the draft with a 422',
  { skip: !env.OPENBOOKS_DB_URL },
  async () => {
    const { orgId } = await withBypass(async () => createScratchOrg())
    try {
      const actorId = await withBypass(async () => (await seedFlowActors(orgId)).adminId)
      const typeKey = await seedType(
        orgId,
        actorId,
        section([{ id: 'amount', type: 'number', label: 'Amount', defaultValue: { kind: 'literal', value: 'not-a-number' } }]),
      )
      const response = await draftAs(typeKey, orgId, actorId)
      assert.equal(response.status, 422)
      const body = (await response.json()) as { error: string; errors: unknown[]; issues: { path: string }[] }
      assert.match(body.error, /number/i)
      assert.ok(body.errors.length > 0)
      assert.ok(body.issues.some((issue) => issue.path === 'amount'))
      const rows = await withBypass(async () =>
        db.execute<{ c: number }>(sql`select count(*)::int as c from custom_records where org_id = ${orgId}`),
      )
      assert.equal(Number(rows.rows[0]?.c ?? 0), 0, 'a refused draft must store no row')
    } finally {
      await withBypass(() => dropScratchOrg(orgId))
    }
  },
)

test(
  'a correctly-typed default still drafts',
  { skip: !env.OPENBOOKS_DB_URL },
  async () => {
    const { orgId } = await withBypass(async () => createScratchOrg())
    try {
      const actorId = await withBypass(async () => (await seedFlowActors(orgId)).adminId)
      const typeKey = await seedType(
        orgId,
        actorId,
        section([
          { id: 'title', type: 'text', label: 'Title', defaultValue: { kind: 'literal', value: 'hello' } },
          { id: 'amount', type: 'number', label: 'Amount', defaultValue: { kind: 'literal', value: 42 } },
        ]),
      )
      const response = await draftAs(typeKey, orgId, actorId)
      assert.equal(response.status, 200)
      const body = (await response.json()) as { id: string }
      const row = await withBypass(async () =>
        db.execute<{ data: { title?: string; amount?: number } }>(
          sql`select data from custom_records where id = ${body.id} and org_id = ${orgId}`,
        ),
      )
      assert.deepEqual(row.rows[0]?.data, { title: 'hello', amount: 42 })
    } finally {
      await withBypass(() => dropScratchOrg(orgId))
    }
  },
)
