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
const state: { orgId: string; actorId: string } = { orgId: '', actorId: '' }
Object.assign(globalThis, { __overheadPublishState: state })
const virtual = (source: string) => ({ shortCircuit: true as const, url: 'data:text/javascript,' + encodeURIComponent(source) })
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'server-only') return virtual('export {}')
    if (specifier === '../../../../../lib/authz') return virtual(`
      export async function guardPermission() {
        const s = globalThis.__overheadPublishState;
        return { user: { orgId: s.orgId, id: s.actorId }, permissions: [], allowedSubsidiaryIds: null };
      }
    `)
    if (specifier === '../../../../../lib/projects-gate') return virtual(`
      export async function guardProjectsFeature() { return null }
    `)
    if (specifier.startsWith('@/')) return next(root + 'web/' + specifier.slice(2) + '.ts', context)
    return next(specifier, context)
  },
})
const { db, withOrgContext } = await import('@openbooks/engine/src/db.ts')
const { sql } = await import('drizzle-orm')
const { createScratchOrg, dropScratchOrg } = await import('@openbooks/engine/src/test-fixtures.ts')
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
  const departmentId = (await db.execute<{ id: string }>(sql`
    insert into departments (org_id, name, is_active)
    values (${org.orgId}, 'Publish Dept', true)
    returning id`)).rows[0]!.id
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
  return (await db.execute<{ department_id: string | null }>(sql`
    select department_id from overhead_rates where org_id = ${orgId}`)).rows
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
