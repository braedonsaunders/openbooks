import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { sql } from 'drizzle-orm'
import pg from 'pg'

// The three production surfaces under test import the real authz layer (cookie
// sessions) and `server-only`. Swap those two boundaries for a scratch-org
// identity and keep EVERYTHING else — routes, transactions, advisory fences,
// PostgreSQL — exactly as production runs them.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') {
      return { url: 'data:text/javascript,export {}', format: 'module', shortCircuit: true }
    }
    if (specifier === 'next/navigation') {
      return {
        url: 'data:text/javascript,export function redirect(){throw new Error("redirect")}',
        format: 'module',
        shortCircuit: true,
      }
    }
    if (specifier.endsWith('/lib/authz')) return { url: 'mock:authz', format: 'module', shortCircuit: true }
    if (specifier.startsWith('@/')) {
      // Next's webpack alias (`@/*` → `web/*`, see web/tsconfig.json) restated
      // for this node process.
      const webRoot = new URL('../', import.meta.url)
      const rel = specifier.slice(2)
      for (const candidate of [`${rel}.ts`, `${rel}.tsx`, `${rel}/index.ts`]) {
        try {
          return nextResolve(new URL(candidate, webRoot).href, context)
        } catch {
          // try the next extension candidate
        }
      }
    }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    if (url === 'mock:authz') {
      return {
        format: 'module',
        shortCircuit: true,
        source: `
          const state = globalThis[Symbol.for('openbooks.feature-gating-test')]
          export async function guardPermission() {
            return { user: { id: state.userId, orgId: state.orgId }, permissions: new Set(['*']), allowedSubsidiaryIds: null }
          }
          export function guardSubsidiaryScope(authz, subsidiaryId) {
            if (authz.allowedSubsidiaryIds === null) return null
            if (subsidiaryId !== null && subsidiaryId !== undefined && authz.allowedSubsidiaryIds.has(String(subsidiaryId))) return null
            return new Response(JSON.stringify({ error: 'not found' }), { status: 404, headers: { 'content-type': 'application/json' } })
          }
          export function subsidiariesInScope(authz, ids) {
            return authz.allowedSubsidiaryIds === null || ids.every((id) => id !== null && id !== undefined && authz.allowedSubsidiaryIds.has(id))
          }
        `,
      }
    }
    return nextLoad(url, context)
  },
})

const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

// --- Live interleavings -------------------------------------------------------

const DB = !!process.env.OPENBOOKS_DB_URL

interface Tracked<T> {
  settled: boolean
  value: T | null
  error: unknown
}

/** Settle instead of throw: a racing refusal IS one of the outcomes. */
function track<T>(promise: Promise<T>): Tracked<T> {
  const t: Tracked<T> = { settled: false, value: null, error: null }
  promise.then(
    (value) => {
      t.value = value
      t.settled = true
    },
    (error) => {
      t.error = error
      t.settled = true
    },
  )
  return t
}

/** Unwrap a tracked request outcome, surfacing an unexpected rejection with
 * its cause instead of a null dereference at the assertion site. */
function outcome<T>(t: Tracked<T>, label: string): T {
  assert.ok(t.settled, `${label} never settled`)
  if (t.error !== null) {
    throw new Error(`${label} rejected unexpectedly`, { cause: t.error })
  }
  return t.value as T
}

/** Condition wait with zero fixed delays: pump the event loop until the
 * probe holds, so the interleaving is observed, never timed. */
async function waitForInterleaving(what: string, probe: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    if (await probe()) return
    await new Promise((resolve) => setImmediate(resolve))
  }
  const activity = await db.execute(sql`
    select pid, state, wait_event_type, left(query, 160) as query
      from pg_stat_activity where datname = current_database()`)
  assert.fail(`timed out waiting for ${what}; backends: ${JSON.stringify(activity.rows)}`)
}

/** A dedicated connection holding locks ACROSS another session's open
 * transaction — the rendezvous that turns concurrency into an ordering. */
async function openLockSession(): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: env.OPENBOOKS_DB_URL })
  await client.connect()
  await client.query('begin')
  await client.query("select set_config('app.bypass_rls', 'on', true)")
  return client
}

async function closeLockSession(client: pg.Client | undefined): Promise<void> {
  if (!client) return
  await client.query('rollback').catch(() => undefined)
  await client.end().catch(() => undefined)
}

/** The fence key split into the unsigned (classid, objid) halves pg_locks shows. */
async function fenceHalves(key: string): Promise<{ classid: bigint; objid: bigint }> {
  const r = (await db.execute<{ key: string }>(sql`select hashtextextended(${key}, 0)::text as key`))
  const wide = BigInt.asUintN(64, BigInt(r.rows[0]!.key))
  return { classid: wide >> 32n, objid: wide & 0xffffffffn }
}

/** A backend queued on THIS org's feature-gate fence. */
async function fenceQueued(fence: { classid: bigint; objid: bigint }): Promise<boolean> {
  return (await fenceQueueDepth(fence)) > 0
}

/** How many backends are queued on THIS org's feature-gate fence. */
async function fenceQueueDepth(fence: { classid: bigint; objid: bigint }): Promise<number> {
  const r = (await db.execute<{ n: number }>(sql`
    select count(*)::int as n from pg_locks
     where locktype = 'advisory' and granted = false
       and classid::bigint = ${fence.classid} and objid::bigint = ${fence.objid}`))
  return r.rows[0]!.n
}

/** Any backend other than ours and the holder is parked on a lock. */
async function someBackendParked(): Promise<boolean> {
  const r = (await db.execute<{ n: number }>(sql`
    select count(*)::int as n from pg_stat_activity
     where datname = current_database()
       and wait_event_type = 'Lock'
       and pid <> pg_backend_pid()`))
  return (r.rows[0]?.n ?? 0) > 0
}

const state = { orgId: '', userId: '' }
;(globalThis as Record<symbol, unknown>)[Symbol.for('openbooks.feature-gating-test')] = state

/**
 * The production fence identity (`featureGateLockKey`, web/lib/features.ts),
 * restated locally so this regression stays runnable against trees without
 * that export — there it must fail on BEHAVIOUR (the disable and the
 * activation both applying), not on an import. The structural test above pins
 * the exact literal in the production source, so the two cannot drift.
 */
const featureGateLockKey = (orgId: string): string => `openbooks:feature-gate:${orgId}`

const { db, env } = await import('@openbooks/engine/src/db.ts')
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/test-fixtures.ts')
const { isFeatureEnabled } = await import('./features.ts')
const { PUT: putFeaturesRoute } = await import('../app/api/admin/setup/features/route.ts') as {
  PUT: (req: Request) => Promise<Response>
}
const { PATCH: patchProjectRoute } = await import('../app/api/projects/[id]/route.ts') as {
  PATCH: (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>
}
const { POST: postDraftRoute } = await import('../app/api/projects/draft/route.ts') as unknown as {
  POST: (req: Request) => Promise<Response>
}

/** Disabling `projects` must also disable `timeTracking` in the same request:
 * the registry default leaves timeTracking resolved-on, and the toggle route
 * refuses to leave a stored-on child silently suppressed by its parent. */
const DISABLE_PROJECTS = { timeTracking: false, projects: false }

function putFeatures(features: Record<string, boolean>): Promise<Response> {
  return putFeaturesRoute(new Request('http://openbooks.test/api/admin/setup/features', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ features }),
  }))
}

function activateProject(id: string): Promise<Response> {
  return patchProjectRoute(new Request(`http://openbooks.test/api/projects/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Rig 12', isActive: true }),
  }), { params: Promise.resolve({ id }) })
}

function createDraft(): Promise<Response> {
  return postDraftRoute(new Request('http://openbooks.test/api/projects/draft', { method: 'POST' }))
}

async function storedFeatures(orgId: string): Promise<string> {
  const r = (await db.execute<{ f: string }>(sql`
    select coalesce(settings->'features', '{}'::jsonb)::text as f from orgs where id = ${orgId}`))
  return r.rows[0]!.f
}

async function projectRow(projectId: string): Promise<{
  is_active: boolean
  status: string
  name: string
  updated_at: string
}> {
  const r = (await db.execute<{
    is_active: boolean
    status: string
    name: string
    updated_at: string
  }>(sql`
    select is_active, status, name, updated_at::text as updated_at
      from projects where id = ${projectId}`))
  return r.rows[0]!
}

async function featureToggleAudits(orgId: string): Promise<number> {
  const r = (await db.execute<{ n: number }>(sql`
    select count(*)::int as n from audit_log
     where org_id = ${orgId} and table_name = 'orgs' and action = 'update'
       and changes->'after' ? 'features'`))
  return r.rows[0]!.n
}

async function startScenario() {
  const org = await createScratchOrg()
  state.orgId = org.orgId
  state.userId = await createScratchUser(org.orgId, 'Feature Gate Controller', 'admin')
  try {
    assert.equal(await isFeatureEnabled(org.orgId, 'projects'), true, 'scratch org starts with projects enabled')
  } catch (error) {
    await dropScratchOrg(org.orgId)
    throw error
  }
  return org
}

// --- Structural contract (runs everywhere, no database needed) ---------------

test('disable blockers are evaluated inside the transaction, behind the feature-gate fence', () => {
  const route = source('../app/api/admin/setup/features/route.ts')
  const tx = route.indexOf('withOrgTransaction(')
  const fence = route.indexOf('await acquireFeatureGateLock(')
  const blockers = route.indexOf('featureDisableBlocked(')
  assert.ok(tx > -1 && fence > -1 && blockers > -1)
  assert.ok(fence > tx, 'the fence must be acquired inside the toggle transaction')
  assert.ok(blockers > fence, 'every blocker evaluation must sit behind the fence')
  assert.equal(
    route.indexOf('featureDisableBlocked(', blockers + 1),
    -1,
    'no blocker check may remain outside the fenced transaction',
  )
})

test('project activation and creation take the same fence before changing active state', () => {
  for (const [path, write] of [
    ['../app/api/projects/[id]/route.ts', 'update projects set'],
    ['../app/api/projects/draft/route.ts', '.insert(schema.projects)'],
  ] as const) {
    const route = source(path)
    const tx = route.indexOf('withOrgTransaction(')
    const fence = route.indexOf('await acquireFeatureGateLock(')
    const gate = route.indexOf('isFeatureEnabled(')
    const mutation = route.indexOf(write)
    assert.ok(tx > -1 && fence > tx, `${path}: the mutation runs in an org transaction`)
    assert.ok(gate > fence, `${path}: the gate is re-checked after the fence`)
    assert.ok(mutation > gate, `${path}: the active-state write follows the gated re-check`)
  }
  const lib = source('./features.ts')
  assert.match(lib, /export function featureGateLockKey\(orgId: string\): string/)
  assert.match(lib, /return `openbooks:feature-gate:\$\{orgId\}`/)
  assert.match(lib, /pg_advisory_xact_lock\(hashtextextended\(\$\{featureGateLockKey\(orgId\)\}, 0\)\)/)
})

test('serial order disable-then-activate: the disable applies, the stale-guard activation is refused', { skip: !DB }, async () => {
  const org = await startScenario()
  try {
    const draft = await createDraft()
    assert.equal(draft.status, 200)
    const projectId = ((await draft.json()) as { id: string }).id

    const disable = await putFeatures(DISABLE_PROJECTS)
    assert.equal(disable.status, 200, 'a disable with no blocker must succeed')
    assert.equal(await isFeatureEnabled(org.orgId, 'projects'), false)

    // The activation's entry-guard read happened while the feature was still
    // on in earlier requests; here it fires AFTER the disable committed, so
    // the entry guard itself refuses — and the project stays inactive.
    const patch = await activateProject(projectId)
    assert.equal(patch.status, 404)

    const row = await projectRow(projectId)
    assert.equal(row.is_active, false, 'refused activation must leave the project inactive')
    assert.equal(row.name, 'New project', 'refused activation must not touch the row')
    assert.equal(await featureToggleAudits(org.orgId), 1, 'exactly the successful disable audited')
  } finally {
    await dropScratchOrg(org.orgId)
  }
})

test('serial order activate-then-disable: the activation applies, the disable is blocked by its own now-true blocker', { skip: !DB }, async () => {
  const org = await startScenario()
  let holder: pg.Client | undefined
  try {
    const draft = await createDraft()
    assert.equal(draft.status, 200)
    const projectId = ((await draft.json()) as { id: string }).id

    // Park the activation behind the fence, then release it: the activation
    // lands whole while the feature is still on (the allow side).
    holder = await openLockSession()
    await holder.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [featureGateLockKey(org.orgId)])
    const fence = await fenceHalves(featureGateLockKey(org.orgId))
    const patchPromise = activateProject(projectId)
    const patch = track(patchPromise)
    await waitForInterleaving(
      'the activation to queue on the feature-gate fence or finish',
      async () => patch.settled || fenceQueued(fence),
    )
    await closeLockSession(holder)
    holder = undefined

    const patchResponse = await patchPromise
    assert.ok(patch.settled, 'the parked activation finished once the fence freed')
    assert.equal(patchResponse.status, 200, 'activating while the feature is enabled must succeed')

    const featuresBefore = await storedFeatures(org.orgId)
    const auditsBefore = await featureToggleAudits(org.orgId)
    const disable = await putFeatures(DISABLE_PROJECTS)
    assert.equal(disable.status, 409)
    assert.deepEqual(await disable.json(), { error: 'feature-blocked', key: 'projects' })

    assert.equal(await isFeatureEnabled(org.orgId, 'projects'), true, 'the blocked disable must not flip the gate')
    assert.equal(await storedFeatures(org.orgId), featuresBefore, 'the losing disable writes nothing')
    assert.equal(await featureToggleAudits(org.orgId), auditsBefore, 'the losing disable audits nothing')
    const row = await projectRow(projectId)
    assert.equal(row.is_active, true, 'feature on with its active dependent: the consistent branch')
  } finally {
    await closeLockSession(holder)
    await dropScratchOrg(org.orgId)
  }
})

test('draft creation joins the fence: it queues behind a held feature-gate lock before inserting', { skip: !DB }, async () => {
  const org = await startScenario()
  let holder: pg.Client | undefined
  try {
    holder = await openLockSession()
    await holder.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [featureGateLockKey(org.orgId)])

    const draft = track(createDraft())
    const fence = await fenceHalves(featureGateLockKey(org.orgId))
    await waitForInterleaving(
      'draft creation to queue on the feature-gate fence (create participates in the lock contract)',
      async () => !draft.settled && fenceQueued(fence),
    )

    // Nothing may exist yet while the fence is held: the insert cannot have
    // jumped the gate.
    const before = (await db.execute<{ n: number }>(sql`
      select count(*)::int as n from projects where org_id = ${org.orgId}`)).rows[0]!.n
    assert.equal(before, 0, 'no project row may appear while another session holds the fence')

    await closeLockSession(holder)
    holder = undefined

    await waitForInterleaving('draft creation to finish after release', async () => draft.settled)
    const response = draft.value as Response
    assert.equal(response.status, 200)
    const row = await projectRow(((await response.json()) as { id: string }).id)
    assert.equal(row.is_active, false, 'the placeholder starts inactive')
  } finally {
    await closeLockSession(holder)
    await dropScratchOrg(org.orgId)
  }
})

test('adversarial interleave: a disable parked mid-flight and an activation landing cannot both apply', { skip: !DB }, async () => {
  const org = await startScenario()
  let holder: pg.Client | undefined
  try {
    const draft = await createDraft()
    const projectId = ((await draft.json()) as { id: string }).id

    // Hold BOTH serialization points the two generations of this code use:
    // the feature-gate fence (post-fix) and the orgs row the toggle updates
    // (which a pre-fence toggle parks on AFTER its unfenced blocker check).
    holder = await openLockSession()
    await holder.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [featureGateLockKey(org.orgId)])
    await holder.query('select id from orgs where id = $1 for update', [org.orgId])

    const featuresBefore = await storedFeatures(org.orgId)
    const auditsBefore = await featureToggleAudits(org.orgId)
    const rowBefore = await projectRow(projectId)
    const fence = await fenceHalves(featureGateLockKey(org.orgId))

    const disablePromise = putFeatures(DISABLE_PROJECTS)
    const disable = track(disablePromise)
    await waitForInterleaving(
      'the disable to park behind the held locks (blockers not yet evaluated under the fence)',
      async () => !disable.settled && someBackendParked(),
    )

    // Fire the activation INTO that pause: exactly the window where the old
    // pre-transaction blocker check let both operations apply. Wait until it
    // has either landed (the pre-fence world) or parked behind the disable on
    // the fence (queue depth 2), so the release always finds both past their
    // entry guards.
    const activatePromise = activateProject(projectId)
    const activate = track(activatePromise)
    await waitForInterleaving(
      'the activation to queue on the fence or land',
      async () => activate.settled || (await fenceQueueDepth(fence)) >= 2,
    )

    await closeLockSession(holder)
    holder = undefined

    await Promise.all([disablePromise.catch(() => undefined), activatePromise.catch(() => undefined)])
    const disableResponse = outcome(disable, 'the disable request')
    const activateResponse = outcome(activate, 'the activation request')
    const featureOn = await isFeatureEnabled(org.orgId, 'projects')
    const row = await projectRow(projectId)

    if (disableResponse.status === 200) {
      // Disable won the fence: the queued activation must have been refused
      // by the in-transaction gate re-check, leaving no active dependent.
      assert.equal(activateResponse.status, 404,
        'an activation queued behind a winning disable must be refused, not applied')
      assert.equal(featureOn, false)
      assert.equal(row.is_active, false, 'the refused activation must leave the project inactive')
      assert.equal(row.updated_at, rowBefore.updated_at, 'the refused activation wrote nothing')
      assert.equal(await featureToggleAudits(org.orgId), auditsBefore + 1, 'only the winning disable audited')
    } else {
      // Activation won the fence: the disable's blockers, re-evaluated under
      // the fence against committed reality, must refuse it whole.
      assert.equal(disableResponse.status, 409)
      assert.deepEqual(await disableResponse.json(), { error: 'feature-blocked', key: 'projects' })
      assert.equal(activateResponse.status, 200)
      assert.equal(featureOn, true)
      assert.equal(row.is_active, true, 'activation landed with the feature still enabled')
      assert.equal(await storedFeatures(org.orgId), featuresBefore, 'the losing disable writes nothing')
      assert.equal(await featureToggleAudits(org.orgId), auditsBefore, 'the losing disable audits nothing')
    }
    assert.ok(
      !(featureOn === false && row.is_active === true),
      `invariant violated: feature off with an active dependent project (disable=${disableResponse.status}, activate=${activateResponse.status})`,
    )
  } finally {
    await closeLockSession(holder)
    await dropScratchOrg(org.orgId)
  }
})
