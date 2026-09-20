import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'
registerHooks({ resolve(specifier, context, next) { return specifier === 'server-only' ? { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' } : next(specifier, context) } })
const { db, env, withBypass } = await import('@openbooks/engine/src/platform/db.ts')
const { sql } = await import('drizzle-orm')
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { createSetupRecord } = await import('./write.ts')

// F-t09-016: an overlapping income-tax-rate create 400s with the raw Postgres
// exclusion-constraint text echoed verbatim. It must 409 with a typed overlap
// code the drawer can localize, and never surface pg text.
test('overlapping income-tax-rate create conflicts typed instead of echoing Postgres', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypass(() => createScratchOrg())
  const actor = await withBypass(() => createScratchUser(org.orgId, 'Setup Admin', 'admin'))
  await withBypass(() => db.execute(sql`update app_roles set permissions = '["*"]'::jsonb where org_id = ${org.orgId} and key = 'admin'`))
  const asAdmin = { orgId: org.orgId, id: actor as unknown as string, permissions: ['*'] as Iterable<string> }
  try {
    // The drawer always sends an explicit isActive (checked by default), so the
    // API payload mirrors it: the exclusion constraint only guards active rows.
    const first = await withBypass(() => createSetupRecord(asAdmin, 'income-tax-rates', {
      jurisdiction: 'US-CA',
      ratePercent: '9.30',
      effectiveFrom: '2026-01-01',
      isActive: true,
    }))
    assert.equal(first.status, 200)
    const retry = await withBypass(() => createSetupRecord(asAdmin, 'income-tax-rates', {
      jurisdiction: 'US-CA',
      ratePercent: '9.30',
      effectiveFrom: '2026-06-01',
      isActive: true,
    }))
    assert.equal(retry.status, 409)
    assert.equal(retry.body.code, 'overlap')
    assert.doesNotMatch(String(retry.body.error), /exclusion|conflicting key|SQLSTATE|gist/i)
  } finally { await withBypass(() => dropScratchOrg(org.orgId)) }
})
