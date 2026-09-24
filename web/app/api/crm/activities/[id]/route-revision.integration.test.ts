import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

// F3-71: activity PATCH carried no revision token, so the last writer won
// silently. The route now requires the loader-projected expectedUpdatedAt
// (409 when missing) and compares it against the locked row (409 when
// stale), the same contract as the opportunity route.
const root = pathToFileURL(process.cwd() + '/').href
const state: { orgId: string; actorId: string } = { orgId: '', actorId: '' }
Object.assign(globalThis, { __activityRevisionState: state })
const virtual = (source: string) => ({ shortCircuit: true as const, url: 'data:text/javascript,' + encodeURIComponent(source) })
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'server-only') return virtual('export {}')
    if (specifier === 'next/navigation') return virtual('export function redirect() {}; export function notFound() {}; export function useRouter() {}; export function usePathname() { return "" }')
    if (specifier === '../../../../../lib/authz') return virtual(`
      export async function guardPermission() {
        const s = globalThis.__activityRevisionState;
        return { user: { orgId: s.orgId, id: s.actorId }, permissions: [], allowedSubsidiaryIds: null };
      }
    `)
    if (specifier === '../../../../../lib/feature-gates') return virtual(`
      export async function guardFeaturePermission() {
        const s = globalThis.__activityRevisionState;
        return { user: { orgId: s.orgId, id: s.actorId }, permissions: [], allowedSubsidiaryIds: null };
      }
    `)
    if (specifier.startsWith('@/')) return next(root + 'web/' + specifier.slice(2) + '.ts', context)
    return next(specifier, context)
  },
})
const { db, withBypassContext, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { sql } = await import('drizzle-orm')
const { createScratchOrg, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { loadActivity } = await import('../../../../../lib/crm')
const { PATCH } = await import('./route.ts')
const DB = !!process.env.OPENBOOKS_DB_URL

async function fixture() {
  const org = await createScratchOrg()
  state.orgId = org.orgId
  state.actorId = randomUUID()
  const activityId = await withBypassContext(async () => {
    await db.execute(sql`
      update orgs set settings = jsonb_set(settings, '{features}',
        coalesce(settings->'features','{}'::jsonb) || '{"crm": true}'::jsonb)
       where id = ${org.orgId}`)
    return (await db.execute<{ id: string }>(sql`
      insert into crm_activities (org_id, kind, status, subject)
      values (${org.orgId}, 'call', 'open', 'Original subject')
      returning id`)).rows[0]!.id
  })
  return { org, activityId }
}

type PatchResult = {
  status: number
  json: { error?: unknown; activity?: { subject?: unknown; updated_at?: unknown }; thrown?: unknown } | null
}

async function patch(id: string, body: unknown): Promise<PatchResult> {
  try {
    const response = await withOrgContext(state.orgId, () => PATCH(
      new Request(`http://crm.test/api/crm/activities/${id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ id }) },
    ))
    return { status: response.status, json: await response.json().catch(() => null) }
  } catch (error) {
    return { status: 500, json: { thrown: error instanceof Error ? error.message : String(error) } }
  }
}

async function revisionToken(activityId: string): Promise<string> {
  return await withOrgContext(state.orgId, async () => {
    const loaded = await loadActivity(activityId, state.orgId, null)
    const token = (loaded!.activity as Record<string, unknown>).updated_at
    assert.equal(typeof token, 'string')
    return token as string
  })
}

async function subject(activityId: string): Promise<string | null> {
  return await withOrgContext(state.orgId, async () => {
    const rows = (await db.execute<{ subject: string | null }>(sql`
      select subject from crm_activities where id = ${activityId}`)).rows
    return rows[0]!.subject
  })
}

test('PATCH without a revision token is refused with 409 and writes nothing', { skip: !DB }, async () => {
  const { org, activityId } = await fixture()
  try {
    const result = await patch(activityId, { subject: 'Silent overwrite' })
    assert.equal(result.status, 409, `expected 409, got ${result.status}: ${JSON.stringify(result.json)}`)
    assert.match(String(result.json?.error ?? ''), /revision/i)
    assert.equal(await subject(activityId), 'Original subject')
  } finally {
    await dropScratchOrg(org.orgId)
  }
})

test('PATCH with a stale revision token is refused after a concurrent save', { skip: !DB }, async () => {
  const { org, activityId } = await fixture()
  try {
    const token = await revisionToken(activityId)
    const first = await patch(activityId, { subject: 'First save', expectedUpdatedAt: token })
    assert.equal(first.status, 200, JSON.stringify(first.json))
    const second = await patch(activityId, { subject: 'Second save', expectedUpdatedAt: token })
    assert.equal(second.status, 409, `expected 409, got ${second.status}: ${JSON.stringify(second.json)}`)
    assert.match(String(second.json?.error ?? ''), /changed after you opened it/)
    assert.equal(await subject(activityId), 'First save')
  } finally {
    await dropScratchOrg(org.orgId)
  }
})

test('PATCH with the fresh revision token saves and rotates the token', { skip: !DB }, async () => {
  const { org, activityId } = await fixture()
  try {
    const token = await revisionToken(activityId)
    const result = await patch(activityId, { subject: 'Fresh save', expectedUpdatedAt: token })
    assert.equal(result.status, 200, JSON.stringify(result.json))
    assert.equal(result.json?.activity?.subject, 'Fresh save')
    assert.notEqual(result.json?.activity?.updated_at, token)
  } finally {
    await dropScratchOrg(org.orgId)
  }
})
