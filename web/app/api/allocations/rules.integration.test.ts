import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { NextResponse } from 'next/server'
import test from 'node:test'
import { sql } from 'drizzle-orm'

;(globalThis as typeof globalThis & Record<symbol, unknown>)[Symbol.for('openbooks.alloc-rules-next-response')] = { NextResponse }

// Route tests run the real feature guard (over real Postgres) and A1's real
// service; only the session boundary is mocked, following the account-groups
// pins precedent. Requested permission strings are recorded so the tests pin
// the allocations.read/manage contract.
const stateKey = Symbol.for('openbooks.alloc-rules-route-test')
interface RouteState {
  authz: {
    user: { orgId: string; id: string }
    permissions: Set<string>
    allowedSubsidiaryIds: null
  } | null
  requested: string[]
}
const routeState: RouteState = { authz: null, requested: [] }
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState

const mockAuthz = `
  const state = globalThis[Symbol.for('openbooks.alloc-rules-route-test')]
  export async function guardPermission(permission) {
    state.requested.push(permission)
    if (!state.authz) {
      const { NextResponse } = globalThis[Symbol.for('openbooks.alloc-rules-next-response')]
      return NextResponse.json({ error: 'forbidden' }, { status: 403 })
    }
    return state.authz
  }
  export async function requirePermission(permission) {
    state.requested.push(permission)
    if (!state.authz) throw new Error('forbidden')
    return state.authz
  }
`

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') {
      return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
    }
    const parent = String(context.parentURL)
    if (
      specifier === './authz'
      && (parent.includes('/lib/allocations-gate.ts') || parent.includes('/lib/feature-gates.ts'))
    ) {
      return { url: 'mock:alloc-rules-authz', shortCircuit: true }
    }
    if (specifier.startsWith('@/') && context.parentURL) {
      const parentDir = decodeURIComponent(new URL('.', context.parentURL).href)
      const webRoot = parentDir.lastIndexOf('/web/')
      if (webRoot === -1) return nextResolve(specifier, context)
      return nextResolve(new URL(`${parentDir.slice(0, webRoot + 5)}${specifier.slice(2)}.ts`).href, context)
    }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    if (url === 'mock:alloc-rules-authz') {
      return { format: 'module', source: mockAuthz, shortCircuit: true }
    }
    return nextLoad(url, context)
  },
})

const listRoute = (await import(new URL('./rules/route.ts?alloc-rules-test', import.meta.url).href)) as {
  GET: (req: Request) => Promise<Response>
  POST: (req: Request) => Promise<Response>
}
const detailRoute = (await import(new URL('./rules/[id]/route.ts?alloc-rules-test', import.meta.url).href)) as {
  GET: (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>
  PATCH: (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>
}
const versionsRoute = (await import(new URL('./rules/[id]/versions/route.ts?alloc-rules-test', import.meta.url).href)) as {
  POST: (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>
}
const versionRoute = (await import(
  new URL('./rules/[id]/versions/[versionId]/route.ts?alloc-rules-test', import.meta.url).href
)) as {
  GET: (req: Request, ctx: { params: Promise<{ id: string; versionId: string }> }) => Promise<Response>
  PATCH: (req: Request, ctx: { params: Promise<{ id: string; versionId: string }> }) => Promise<Response>
}
const publishRoute = (await import(
  new URL('./rules/[id]/versions/[versionId]/publish/route.ts?alloc-rules-test', import.meta.url).href
)) as { POST: (req: Request, ctx: { params: Promise<{ id: string; versionId: string }> }) => Promise<Response> }
const retireRoute = (await import(
  new URL('./rules/[id]/versions/[versionId]/retire/route.ts?alloc-rules-test', import.meta.url).href
)) as { POST: (req: Request, ctx: { params: Promise<{ id: string; versionId: string }> }) => Promise<Response> }
const targetsRoute = (await import(
  new URL('./rules/[id]/versions/[versionId]/targets/route.ts?alloc-rules-test', import.meta.url).href
)) as { PUT: (req: Request, ctx: { params: Promise<{ id: string; versionId: string }> }) => Promise<Response> }
const testMatchRoute = (await import(
  new URL('./rules/[id]/test-match/route.ts?alloc-rules-test', import.meta.url).href
)) as { POST: (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response> }
hooks.deregister()

const { db } = await import('@openbooks/engine/src/db.ts')
const { createScratchOrg, dropScratchOrg, seedFlowActors } = await import(
  '@openbooks/engine/src/test-fixtures.ts'
)

interface Fixture {
  orgId: string
  actorId: string
  accountA: string
  accountB: string
}

async function seed(withFeature: boolean): Promise<Fixture> {
  const org = await createScratchOrg()
  const actorId = (await seedFlowActors(org.orgId)).adminId
  if (withFeature) {
    await db.execute(sql`
      update orgs set settings = coalesce(settings, '{}'::jsonb)
        || jsonb_build_object('features', coalesce(settings->'features', '{}'::jsonb) || '{"allocations": true}'::jsonb)
       where id = ${org.orgId}`)
  }
  routeState.authz = {
    user: { orgId: org.orgId, id: actorId },
    permissions: new Set(['allocations.read', 'allocations.manage', 'admin.setup.manage']),
    allowedSubsidiaryIds: null,
  }
  routeState.requested = []
  return { orgId: org.orgId, actorId, accountA: org.accounts.cogs, accountB: org.accounts.revenue }
}

function jsonRequest(url: string, method: string, body?: unknown): Request {
  return new Request(url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

async function read<T>(res: Response): Promise<{ status: number; body: T }> {
  return { status: res.status, body: (await res.json()) as T }
}

test('rules list is feature-gated and permission-pinned', { skip: !process.env.OPENBOOKS_DB_URL }, async (t) => {
  const off = await seed(false)
  t.after(() => dropScratchOrg(off.orgId))
  const gated = await read<{ error: string }>(await listRoute.GET(jsonRequest('http://openbooks.test/api/allocations/rules', 'GET')))
  assert.equal(gated.status, 404)
  assert.deepEqual(routeState.requested, ['allocations.read'])

  const on = await seed(true)
  t.after(() => dropScratchOrg(on.orgId))
  const open = await read<{ rules: unknown[] }>(await listRoute.GET(jsonRequest('http://openbooks.test/api/allocations/rules', 'GET')))
  assert.equal(open.status, 200)
  assert.deepEqual(open.body.rules, [])
  assert.deepEqual(routeState.requested, ['allocations.read'])
})

test('unauthenticated rules access is refused', { skip: !process.env.OPENBOOKS_DB_URL }, async (t) => {
  const f = await seed(true)
  t.after(() => dropScratchOrg(f.orgId))
  routeState.authz = null
  const res = await listRoute.GET(jsonRequest('http://openbooks.test/api/allocations/rules', 'GET'))
  assert.equal(res.status, 403)
})

test('create seeds head + blank draft; head update needs the revision', { skip: !process.env.OPENBOOKS_DB_URL }, async (t) => {
  const f = await seed(true)
  t.after(() => dropScratchOrg(f.orgId))
  const created = await read<{ rule: { id: string }; version: { id: string; versionNo: number }; targets: unknown[] }>(
    await listRoute.POST(jsonRequest('http://openbooks.test/api/allocations/rules', 'POST', {
      key: 'route-rule', name: 'Route rule', mode: 'entry',
    })),
  )
  assert.equal(created.status, 201)
  assert.deepEqual(routeState.requested, ['allocations.manage'])
  assert.equal(created.body.version.versionNo, 1)
  const ruleId = created.body.rule.id

  const badMode = await listRoute.POST(
    jsonRequest('http://openbooks.test/api/allocations/rules', 'POST', { key: 'x', name: 'x', mode: 'nope' }),
  )
  assert.equal(badMode.status, 400)
  const badKey = await listRoute.POST(
    jsonRequest('http://openbooks.test/api/allocations/rules', 'POST', { key: 'Bad Key!', name: 'x', mode: 'entry' }),
  )
  assert.equal(badKey.status, 422)

  const listed = await read<{ rules: { rule: { key: string }; currentVersion: null }[] }>(
    await listRoute.GET(jsonRequest('http://openbooks.test/api/allocations/rules', 'GET')),
  )
  assert.equal(listed.body.rules.length, 1)
  assert.equal(listed.body.rules[0]?.currentVersion, null)

  const detail = await read<{ rule: { key: string }; versions: { id: string }[] }>(
    await detailRoute.GET(jsonRequest(`http://openbooks.test/api/allocations/rules/${ruleId}`, 'GET'), {
      params: Promise.resolve({ id: ruleId }),
    }),
  )
  assert.equal(detail.status, 200)
  assert.equal(detail.body.versions.length, 1)

  const missing = await detailRoute.GET(
    jsonRequest('http://openbooks.test/api/allocations/rules/00000000-0000-0000-0000-000000000000', 'GET'),
    { params: Promise.resolve({ id: '00000000-0000-0000-0000-000000000000' }) },
  )
  assert.equal(missing.status, 404)

  const noRevision = await detailRoute.PATCH(
    jsonRequest(`http://openbooks.test/api/allocations/rules/${ruleId}`, 'PATCH', { name: 'No token' }),
    { params: Promise.resolve({ id: ruleId }) },
  )
  assert.equal(noRevision.status, 409)

  const head = await read<{ rule: { id: string }; revision: string }>(
    await detailRoute.GET(jsonRequest(`http://openbooks.test/api/allocations/rules/${ruleId}`, 'GET'), {
      params: Promise.resolve({ id: ruleId }),
    }),
  )
  const renamed = await read<{ rule: { name: string } }>(
    await detailRoute.PATCH(
      jsonRequest(`http://openbooks.test/api/allocations/rules/${ruleId}`, 'PATCH', {
        name: 'Renamed', expectedRevision: head.body.revision,
      }),
      { params: Promise.resolve({ id: ruleId }) },
    ),
  )
  assert.equal(renamed.status, 200)
  assert.equal(renamed.body.rule.name, 'Renamed')

  const stale = await detailRoute.PATCH(
    jsonRequest(`http://openbooks.test/api/allocations/rules/${ruleId}`, 'PATCH', {
      name: 'Stale', expectedRevision: head.body.revision,
    }),
    { params: Promise.resolve({ id: ruleId }) },
  )
  assert.equal(stale.status, 409)
})

test('version lifecycle: draft edit, publish problems inline, targets, retire', { skip: !process.env.OPENBOOKS_DB_URL }, async (t) => {
  const f = await seed(true)
  t.after(() => dropScratchOrg(f.orgId))
  const created = await read<{ rule: { id: string }; version: { id: string; revision: string } }>(
    await listRoute.POST(jsonRequest('http://openbooks.test/api/allocations/rules', 'POST', {
      key: 'lifecycle', name: 'Lifecycle', mode: 'period',
    })),
  )
  const ruleId = created.body.rule.id
  const v1 = created.body.version.id
  const v1rev = created.body.version.revision

  const branched = await read<{ version: { id: string; versionNo: number; revision: string } }>(
    await versionsRoute.POST(jsonRequest(`http://openbooks.test/api/allocations/rules/${ruleId}/versions`, 'POST', { fromVersionId: v1 }), {
      params: Promise.resolve({ id: ruleId }),
    }),
  )
  assert.equal(branched.status, 201)
  assert.equal(branched.body.version.versionNo, 2)

  const edited = await read<{ version: { memoTemplate: string } }>(
    await versionRoute.PATCH(
      jsonRequest('http://openbooks.test/x', 'PATCH', {
        memoTemplate: 'run {{period.name}}', expectedRevision: branched.body.version.revision,
      }),
      { params: Promise.resolve({ id: ruleId, versionId: branched.body.version.id }) },
    ),
  )
  assert.equal(edited.status, 200)
  assert.equal(edited.body.version.memoTemplate, 'run {{period.name}}')

  const blocked = await read<{ error: string; problems: { code: string }[] }>(
    await publishRoute.POST(jsonRequest('http://openbooks.test/x', 'POST', {}), {
      params: Promise.resolve({ id: ruleId, versionId: branched.body.version.id }),
    }),
  )
  assert.equal(blocked.status, 422)
  assert.ok(blocked.body.problems.length > 0)

  const badTargets = await targetsRoute.PUT(
    jsonRequest('http://openbooks.test/x', 'PUT', { targets: 'nope', expectedRevision: 'whatever' }),
    { params: Promise.resolve({ id: ruleId, versionId: branched.body.version.id }) },
  )
  assert.equal(badTargets.status, 400)

  const refreshed = await read<{ version: { id: string }; revision: string }>(
    await versionRoute.GET(jsonRequest('http://openbooks.test/x', 'GET'), {
      params: Promise.resolve({ id: ruleId, versionId: branched.body.version.id }),
    }),
  )
  const saved = await read<{ targets: { sequence: number }[]; revision: string }>(
    await targetsRoute.PUT(
      jsonRequest('http://openbooks.test/x', 'PUT', {
        expectedRevision: refreshed.body.revision,
        targets: [
          { targetAccountId: f.accountA, fixedPercent: '60.0000' },
          { targetAccountId: f.accountB, fixedPercent: '40.0000' },
        ],
      }),
      { params: Promise.resolve({ id: ruleId, versionId: branched.body.version.id }) },
    ),
  )
  assert.equal(saved.status, 200)
  assert.deepEqual(saved.body.targets.map((row) => row.sequence), [1, 2])

  const published = await read<{ version: { status: string; definitionHash: string }; targets: unknown[] }>(
    await publishRoute.POST(jsonRequest('http://openbooks.test/x', 'POST', {}), {
      params: Promise.resolve({ id: ruleId, versionId: branched.body.version.id }),
    }),
  )
  assert.equal(published.status, 200)
  assert.equal(published.body.version.status, 'published')

  const frozen = await targetsRoute.PUT(
    jsonRequest('http://openbooks.test/x', 'PUT', {
      expectedRevision: v1rev,
      targets: [{ targetAccountId: f.accountA, fixedPercent: '100.0000' }],
    }),
    { params: Promise.resolve({ id: ruleId, versionId: branched.body.version.id }) },
  )
  assert.equal(frozen.status, 422)

  const reasonless = await retireRoute.POST(jsonRequest('http://openbooks.test/x', 'POST', {}), {
    params: Promise.resolve({ id: ruleId, versionId: branched.body.version.id }),
  })
  assert.equal(reasonless.status, 422)

  const retired = await read<{ version: { status: string } }>(
    await retireRoute.POST(jsonRequest('http://openbooks.test/x', 'POST', { reason: 'replaced' }), {
      params: Promise.resolve({ id: ruleId, versionId: branched.body.version.id }),
    }),
  )
  assert.equal(retired.status, 200)
  assert.equal(retired.body.version.status, 'retired')

  const listed = await read<{ rules: { currentVersion: null }[] }>(
    await listRoute.GET(jsonRequest('http://openbooks.test/api/allocations/rules', 'GET')),
  )
  assert.equal(listed.body.rules[0]?.currentVersion, null)
  void v1
})

test('test-match previews entry matches and links period rules to Runs', { skip: !process.env.OPENBOOKS_DB_URL }, async (t) => {
  const f = await seed(true)
  t.after(() => dropScratchOrg(f.orgId))
  const created = await read<{ rule: { id: string }; version: { id: string; revision: string } }>(
    await listRoute.POST(jsonRequest('http://openbooks.test/api/allocations/rules', 'POST', {
      key: 'routematch', name: 'Route match', mode: 'entry',
    })),
  )
  const ruleId = created.body.rule.id
  await versionRoute.PATCH(
    jsonRequest('http://openbooks.test/x', 'PATCH', {
      expectedRevision: created.body.version.revision,
      accountScope: { kind: 'accounts', accountIds: [f.accountA] },
    }),
    { params: Promise.resolve({ id: ruleId, versionId: created.body.version.id }) },
  )
  const withTargets = await read<{ version: { id: string }; revision: string }>(
    await versionRoute.GET(jsonRequest('http://openbooks.test/x', 'GET'), {
      params: Promise.resolve({ id: ruleId, versionId: created.body.version.id }),
    }),
  )
  await targetsRoute.PUT(
    jsonRequest('http://openbooks.test/x', 'PUT', {
      expectedRevision: withTargets.body.revision,
      targets: [{ targetAccountId: f.accountA, fixedPercent: '100.0000' }],
    }),
    { params: Promise.resolve({ id: ruleId, versionId: created.body.version.id }) },
  )
  const hit = await read<{ kind: string; matched: boolean; preview: { sharePercent: string }[] }>(
    await testMatchRoute.POST(
      jsonRequest('http://openbooks.test/x', 'POST', { line: { accountId: f.accountA } }),
      { params: Promise.resolve({ id: ruleId }) },
    ),
  )
  assert.equal(hit.status, 200)
  assert.equal(hit.body.kind, 'match')
  assert.equal(hit.body.matched, true)
  assert.deepEqual(hit.body.preview.map((p) => p.sharePercent), ['100.0000'])

  const period = await read<{ rule: { id: string } }>(
    await listRoute.POST(jsonRequest('http://openbooks.test/api/allocations/rules', 'POST', {
      key: 'routedeep', name: 'Route deep', mode: 'period',
    })),
  )
  const deep = await read<{ kind: string; runsUrl: string }>(
    await testMatchRoute.POST(
      jsonRequest('http://openbooks.test/x', 'POST', { periodId: 'p-1' }),
      { params: Promise.resolve({ id: period.body.rule.id }) },
    ),
  )
  assert.equal(deep.body.kind, 'period')
  assert.ok(deep.body.runsUrl.includes('tab=runs'))
})
