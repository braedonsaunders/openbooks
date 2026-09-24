import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

// Overhead publish must fail closed on invalid input like its sibling
// actions do: an impossible effectiveFrom is refused before any read, and a
// malformed or unknown department id is refused as a 422 instead of escaping
// as a raw Postgres throw (HTTP 500). Department identity itself belongs to
// the publisher, which fails closed through its foreign key — the route only
// shapes the payload and maps storage input failures.
const root = pathToFileURL(process.cwd() + '/').href
const state: { orgId: string; actorId: string; allowedSubsidiaryIds: Set<string> | null } = {
  orgId: '',
  actorId: '',
  allowedSubsidiaryIds: null,
}
Object.assign(globalThis, { __overheadPublishState: state })
const virtual = (source: string) => ({ shortCircuit: true as const, url: 'data:text/javascript,' + encodeURIComponent(source) })
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'server-only') return virtual('export {}')
    if (specifier === '../../../../../lib/authz') return virtual(`
      export async function guardPermission() {
        const s = globalThis.__overheadPublishState;
        return { user: { orgId: s.orgId, id: s.actorId }, permissions: [], allowedSubsidiaryIds: s.allowedSubsidiaryIds };
      }
      export function guardUnrestrictedScope(authz) {
        if (authz?.allowedSubsidiaryIds == null) return null
        return Response.json({ error: 'requires unrestricted subsidiary access' }, { status: 403 })
      }
      export function subsidiariesInScope(authz, ids) {
        const scope = authz?.allowedSubsidiaryIds ?? null
        if (scope === null) return true
        return ids.every((id) => id !== null && id !== undefined && id !== '' && scope.has(id))
      }
    `)
    if (specifier === '../../../../../lib/projects-gate') return virtual(`
      export async function guardProjectsFeature() { return null }
    `)
    if (specifier.startsWith('@/')) return next(root + 'web/' + specifier.slice(2) + '.ts', context)
    return next(specifier, context)
  },
})
const { db, withBypassContext, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { sql } = await import('drizzle-orm')
const { createScratchOrg, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { POST } = await import('./route.ts')
const DB = !!process.env.OPENBOOKS_DB_URL

interface Fixture {
  org: Awaited<ReturnType<typeof createScratchOrg>>
  departmentId: string
}

async function fixture(): Promise<Fixture> {
  const org = await createScratchOrg()
  state.orgId = org.orgId
  state.actorId = randomUUID()
  const departmentId = await withBypassContext(async () => (await db.execute<{ id: string }>(sql`
    insert into departments (org_id, name, is_active)
    values (${org.orgId}, 'Publish Dept', true)
    returning id`)).rows[0]!.id)
  return { org, departmentId }
}

async function post(body: unknown): Promise<{ status: number; json: unknown }> {
  try {
    const response = await withOrgContext(state.orgId, () => POST(
      new Request('http://overhead.test/api/admin/setup/overhead', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    ))
    return { status: response.status, json: await response.json().catch(() => null) }
  } catch (error) {
    // A raw Postgres throw escapes the route as an HTTP 500.
    return { status: 500, json: { thrown: error instanceof Error ? error.message : String(error) } }
  }
}

async function publishedRates(orgId: string) {
  return await withOrgContext(orgId, async () => (await db.execute<{ department_id: string | null }>(sql`
    select department_id from overhead_rates where org_id = ${orgId}`)).rows)
}

test('publish rejects an impossible effectiveFrom instead of throwing', { skip: !DB }, async () => {
  const { org, departmentId } = await fixture()
  try {
    const result = await post({
      action: 'publish',
      effectiveFrom: '2026-02-30',
      rates: [{ departmentId, ratePerHour: '10.5' }],
    })
    assert.equal(result.status, 400, `expected 400, got ${result.status}: ${JSON.stringify(result.json)}`)
    assert.deepEqual(await publishedRates(org.orgId), [], 'refused publish must store no rate rows')
  } finally {
    await dropScratchOrg(org.orgId)
  }
})

test('publish rejects a malformed department id instead of throwing', { skip: !DB }, async () => {
  const { org } = await fixture()
  try {
    const result = await post({
      action: 'publish',
      effectiveFrom: '2026-03-01',
      rates: [{ departmentId: 'not-a-uuid', ratePerHour: '10.5' }],
    })
    assert.equal(result.status, 422, `expected 422, got ${result.status}: ${JSON.stringify(result.json)}`)
    assert.deepEqual(await publishedRates(org.orgId), [], 'refused publish must store no rate rows')
  } finally {
    await dropScratchOrg(org.orgId)
  }
})

test('publish rejects a missing department id before any write', { skip: !DB }, async () => {
  const { org } = await fixture()
  try {
    const result = await post({
      action: 'publish',
      effectiveFrom: '2026-03-01',
      rates: [{ departmentId: null, ratePerHour: '10.5' }],
    })
    assert.equal(result.status, 400, `expected 400, got ${result.status}: ${JSON.stringify(result.json)}`)
    assert.deepEqual(await publishedRates(org.orgId), [], 'refused publish must store no rate rows')
  } finally {
    await dropScratchOrg(org.orgId)
  }
})

test('publish rejects an unknown department instead of throwing', { skip: !DB }, async () => {
  const { org } = await fixture()
  try {
    const result = await post({
      action: 'publish',
      effectiveFrom: '2026-03-01',
      rates: [{ departmentId: randomUUID(), ratePerHour: '10.5' }],
    })
    assert.equal(result.status, 422, `expected 422, got ${result.status}: ${JSON.stringify(result.json)}`)
    assert.deepEqual(await publishedRates(org.orgId), [], 'refused publish must store no rate rows')
  } finally {
    await dropScratchOrg(org.orgId)
  }
})

test('publish still stores rates for a known department', { skip: !DB }, async () => {
  const { org, departmentId } = await fixture()
  try {
    const result = await post({
      action: 'publish',
      effectiveFrom: '2026-03-01',
      rates: [{ departmentId, ratePerHour: '10.5' }],
    })
    assert.equal(result.status, 200, JSON.stringify(result.json))
    assert.deepEqual(await publishedRates(org.orgId), [{ department_id: departmentId }])
  } finally {
    await dropScratchOrg(org.orgId)
  }
})

// H-OVERHEAD: publish-all without rates replaces every department's
// effective-dated rates, so a subsidiary-restricted admin is refused with the
// named org-wide-policy refusal before the live engine runs.
test('restricted publish-all without rates is refused with no rate rows', { skip: !DB }, async () => {
  const { org } = await fixture()
  state.allowedSubsidiaryIds = new Set([org.subsidiaryId])
  try {
    const result = await post({ action: 'publish', effectiveFrom: '2026-03-01' })
    assert.equal(result.status, 403, `expected 403, got ${result.status}: ${JSON.stringify(result.json)}`)
    assert.deepEqual(result.json, { error: 'requires unrestricted subsidiary access' })
    assert.deepEqual(await publishedRates(org.orgId), [], 'refused publish must store no rate rows')
  } finally {
    state.allowedSubsidiaryIds = null
    await dropScratchOrg(org.orgId)
  }
})

async function scopedFixture(): Promise<{
  org: Fixture['org']
  otherSubsidiaryId: string
  otherDepartmentId: string
}> {
  const { org } = await fixture()
  const otherSubsidiaryId = await withBypassContext(async () => (await db.execute<{ id: string }>(sql`
    insert into subsidiaries (org_id, parent_id, name, base_currency, country, tax_ids, is_elimination, is_active, custom)
    values (${org.orgId}, ${org.subsidiaryId}, 'Other Co', 'CAD', 'CA', '{}'::jsonb, false, true, '{}'::jsonb)
    returning id`)).rows[0]!.id)
  await withBypassContext(async () => db.execute(sql`
    update departments set subsidiary_id = ${org.subsidiaryId}
     where org_id = ${org.orgId} and subsidiary_id is null`))
  const otherDepartmentId = await withBypassContext(async () => (await db.execute<{ id: string }>(sql`
    insert into departments (org_id, name, is_active, subsidiary_id)
    values (${org.orgId}, 'Other Dept', true, ${otherSubsidiaryId})
    returning id`)).rows[0]!.id)
  return { org, otherSubsidiaryId, otherDepartmentId }
}

// H-OVERHEAD: an explicit out-of-scope department answers exactly like an
// unknown one, so a restricted caller cannot probe other subsidiaries'
// departments by id; either way no rate row is stored.
test('restricted publish of another subsidiary department answers like unknown', { skip: !DB }, async () => {
  const { org, otherDepartmentId } = await scopedFixture()
  state.allowedSubsidiaryIds = new Set([org.subsidiaryId])
  try {
    const denied = await post({
      action: 'publish',
      effectiveFrom: '2026-03-01',
      rates: [{ departmentId: otherDepartmentId, ratePerHour: '10.5' }],
    })
    assert.equal(denied.status, 422, `expected 422, got ${denied.status}: ${JSON.stringify(denied.json)}`)

    const unknown = await post({
      action: 'publish',
      effectiveFrom: '2026-03-01',
      rates: [{ departmentId: randomUUID(), ratePerHour: '10.5' }],
    })
    assert.equal(unknown.status, 422, `expected 422, got ${unknown.status}: ${JSON.stringify(unknown.json)}`)
    assert.deepEqual(denied.json, unknown.json, 'out-of-scope and unknown must be indistinguishable')
    assert.deepEqual(await publishedRates(org.orgId), [], 'refused publish must store no rate rows')
  } finally {
    state.allowedSubsidiaryIds = null
    await dropScratchOrg(org.orgId)
  }
})
