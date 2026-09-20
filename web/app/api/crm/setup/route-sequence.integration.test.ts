import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import { NextRequest } from 'next/server'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

// CRM-setup POST funneled status sequence numbers through `Number(...) || 0`
// with no integer check, so an out-of-int32 figure or a fractional value
// sailed through and died in Postgres as a raw integer failure (HTTP 500)
// instead of failing closed with a named 422 and nothing written.
const root = pathToFileURL(process.cwd() + '/').href
const state: { orgId: string; actorId: string } = { orgId: '', actorId: '' }
Object.assign(globalThis, { __crmSetupSequenceState: state })
const virtual = (source: string) => ({ shortCircuit: true as const, url: 'data:text/javascript,' + encodeURIComponent(source) })
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'server-only') return virtual('export {}')
    if (specifier === 'next/navigation') return virtual('export function redirect() {}; export function notFound() {}; export function useRouter() {}; export function usePathname() { return "" }')
    if (specifier === '../../../../lib/feature-gates') return virtual(`
      export async function guardFeaturePermission() {
        const s = globalThis.__crmSetupSequenceState;
        return { user: { orgId: s.orgId, id: s.actorId }, permissions: [], allowedSubsidiaryIds: null };
      }
    `)
    if (specifier.startsWith('@/')) return next(root + 'web/' + specifier.slice(2) + '.ts', context)
    return next(specifier, context)
  },
})
const { db, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { sql } = await import('drizzle-orm')
const { createScratchOrg, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { POST } = await import('./route.ts')
const DB = !!process.env.OPENBOOKS_DB_URL

async function fixture() {
  const org = await createScratchOrg()
  state.orgId = org.orgId
  state.actorId = randomUUID()
  await db.execute(sql`
    update orgs set settings = jsonb_set(settings, '{features}',
      coalesce(settings->'features','{}'::jsonb) || '{"crm": true}'::jsonb)
     where id = ${org.orgId}`)
  return { org }
}

async function post(body: unknown): Promise<{ status: number; json: unknown }> {
  try {
    const response = await withOrgContext(state.orgId, () => POST(
      new NextRequest('http://crm.test/api/crm/setup', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    ))
    return { status: response.status, json: await response.json().catch(() => null) }
  } catch (error) {
    return { status: 500, json: { thrown: error instanceof Error ? error.message : String(error) } }
  }
}

async function probeCount(): Promise<number> {
  const rows = (await db.execute<{ n: number }>(sql`
    select count(*)::int as n from crm_account_statuses where org_id = ${state.orgId} and name = 'Probe'`)).rows
  return rows[0]!.n
}

function saveAction(sequence: unknown) {
  return { action: 'save-account-status', name: 'Probe', lifecycleStage: 'lead', sequence }
}

test('POST refuses an out-of-int32 sequence without writing', { skip: !DB }, async () => {
  const { org } = await fixture()
  try {
    const result = await post(saveAction('99999999999999999999'))
    assert.equal(result.status, 422, `expected 422, got ${result.status}: ${JSON.stringify(result.json)}`)
    assert.equal(await probeCount(), 0)
  } finally {
    await dropScratchOrg(org.orgId)
  }
})

test('POST refuses a fractional sequence without writing', { skip: !DB }, async () => {
  const { org } = await fixture()
  try {
    const result = await post(saveAction('1.5'))
    assert.equal(result.status, 422, `expected 422, got ${result.status}: ${JSON.stringify(result.json)}`)
    assert.equal(await probeCount(), 0)
  } finally {
    await dropScratchOrg(org.orgId)
  }
})

test('POST still saves an ordinary sequence', { skip: !DB }, async () => {
  const { org } = await fixture()
  try {
    const result = await post(saveAction('3'))
    assert.equal(result.status, 200, JSON.stringify(result.json))
    const rows = (await db.execute<{ sequence: number }>(sql`
      select sequence from crm_account_statuses where org_id = ${state.orgId} and name = 'Probe'`)).rows
    assert.equal(rows[0]!.sequence, 3)
  } finally {
    await dropScratchOrg(org.orgId)
  }
})
