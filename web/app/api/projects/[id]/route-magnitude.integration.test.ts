import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

// Project PATCH validates contractValue to 4dp but never bounds its
// magnitude, so a pasted 20-digit figure sails through validation and dies in
// Postgres as a raw numeric(19,4) overflow (HTTP 500 — the verb has no catch)
// instead of failing closed with a named 422.
const root = pathToFileURL(process.cwd() + '/').href
const state: { orgId: string; actorId: string } = { orgId: '', actorId: '' }
Object.assign(globalThis, { __projectPatchMagnitudeState: state })
const virtual = (source: string) => ({ shortCircuit: true as const, url: 'data:text/javascript,' + encodeURIComponent(source) })
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'server-only') return virtual('export {}')
    if (specifier === 'next/navigation') return virtual('export function redirect() {}')
    if (specifier === '../../../../lib/authz') return virtual(`
      export async function guardPermission() {
        const s = globalThis.__projectPatchMagnitudeState;
        return { user: { orgId: s.orgId, id: s.actorId }, permissions: [], allowedSubsidiaryIds: null };
      }
      export function guardSubsidiaryScope() { return null }
      export function subsidiariesInScope() { return true }
    `)
    if (specifier.startsWith('@/')) return next(root + 'web/' + specifier.slice(2) + '.ts', context)
    return next(specifier, context)
  },
})
const { db, withOrgContext } = await import('@openbooks/engine/src/db.ts')
const { sql } = await import('drizzle-orm')
const { createScratchOrg, dropScratchOrg } = await import('@openbooks/engine/src/test-fixtures.ts')
const { PATCH } = await import('./route.ts')
const DB = !!process.env.OPENBOOKS_DB_URL

async function fixture() {
  const org = await createScratchOrg()
  state.orgId = org.orgId
  state.actorId = randomUUID()
  await db.execute(sql`
    update orgs set settings = jsonb_set(settings, '{features}',
      coalesce(settings->'features','{}'::jsonb) || '{"projects": true}'::jsonb)
     where id = ${org.orgId}`)
  const projectId = (await db.execute<{ id: string }>(sql`
    insert into projects (org_id, name, is_active, contract_value)
    values (${org.orgId}, 'Magnitude Project', true, '100.0000')
    returning id`)).rows[0]!.id
  return { org, projectId }
}

async function patch(id: string, body: unknown): Promise<{ status: number; json: unknown }> {
  try {
    const response = await withOrgContext(state.orgId, () => PATCH(
      new Request(`http://projects.test/api/projects/${id}`, {
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

async function contractValue(projectId: string): Promise<string | null> {
  const rows = (await db.execute<{ contract_value: string | null }>(sql`
    select contract_value::text as contract_value from projects where id = ${projectId}`)).rows
  return rows[0]!.contract_value
}

test('PATCH refuses a contract value wider than numeric(19,4) without writing', { skip: !DB }, async () => {
  const { org, projectId } = await fixture()
  try {
    const result = await patch(projectId, { contractValue: '99999999999999999999' })
    assert.equal(result.status, 422, `expected 422, got ${result.status}: ${JSON.stringify(result.json)}`)
    assert.equal(await contractValue(projectId), '100.0000')
  } finally {
    await dropScratchOrg(org.orgId)
  }
})

test('PATCH still saves a column-maximum contract value with identical read-back', { skip: !DB }, async () => {
  const { org, projectId } = await fixture()
  try {
    const result = await patch(projectId, { contractValue: '999999999999999.9999' })
    assert.equal(result.status, 200, JSON.stringify(result.json))
    assert.equal(await contractValue(projectId), '999999999999999.9999')
  } finally {
    await dropScratchOrg(org.orgId)
  }
})
