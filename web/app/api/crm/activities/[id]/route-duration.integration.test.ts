import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

// Activity PATCH validates durationMinutes as non-negative minutes but never
// bounds it as an integer, so an out-of-int32 figure sails through and dies
// in Postgres as a raw integer failure (HTTP 500 — the verb has no catch for
// it) instead of failing closed with a named 422 and nothing written.
// duration_minutes is integer.
const root = pathToFileURL(process.cwd() + '/').href
const state: { orgId: string; actorId: string } = { orgId: '', actorId: '' }
Object.assign(globalThis, { __activityDurationState: state })
const virtual = (source: string) => ({ shortCircuit: true as const, url: 'data:text/javascript,' + encodeURIComponent(source) })
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'server-only') return virtual('export {}')
    if (specifier === 'next/navigation') return virtual('export function redirect() {}; export function notFound() {}; export function useRouter() {}; export function usePathname() { return "" }')
    if (specifier === '../../../../../lib/authz') return virtual(`
      export async function guardPermission() {
        const s = globalThis.__activityDurationState;
        return { user: { orgId: s.orgId, id: s.actorId }, permissions: [], allowedSubsidiaryIds: null };
      }
    `)
    if (specifier === '../../../../../lib/feature-gates') return virtual(`
      export async function guardFeaturePermission() {
        const s = globalThis.__activityDurationState;
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
      insert into crm_activities (org_id, kind, status, subject, duration_minutes)
      values (${org.orgId}, 'call', 'open', 'Probe call', 30)
      returning id`)).rows[0]!.id
  })
  return { org, activityId }
}

async function patch(id: string, body: unknown): Promise<{ status: number; json: unknown }> {
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

async function duration(orgId: string, activityId: string): Promise<number | null> {
  return await withOrgContext(orgId, async () => {
    const rows = (await db.execute<{ duration_minutes: number | null }>(sql`
      select duration_minutes from crm_activities where id = ${activityId}`)).rows
    return rows[0]!.duration_minutes
  })
}

test('PATCH refuses an out-of-int32 duration without writing', { skip: !DB }, async () => {
  const { org, activityId } = await fixture()
  try {
    const result = await patch(activityId, { durationMinutes: '99999999999999999999' })
    assert.equal(result.status, 422, `expected 422, got ${result.status}: ${JSON.stringify(result.json)}`)
    assert.equal(await duration(org.orgId, activityId), 30)
  } finally {
    await dropScratchOrg(org.orgId)
  }
})

test('PATCH still saves an ordinary duration', { skip: !DB }, async () => {
  const { org, activityId } = await fixture()
  try {
    const result = await patch(activityId, { durationMinutes: 45 })
    assert.equal(result.status, 200, JSON.stringify(result.json))
    assert.equal(await duration(org.orgId, activityId), 45)
  } finally {
    await dropScratchOrg(org.orgId)
  }
})
