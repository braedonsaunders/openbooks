import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { createScratchOrg, dropScratchOrg } from '@openbooks/engine/src/testing/fixtures.ts'

// Same seam as web/lib/setup-feature-fence.integration.test.ts: shim the RSC
// `server-only` marker (this file runs from the root, one file per process).
const root = pathToFileURL(process.cwd() + '/').href
registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' }
  void root
  return next(specifier, context)
} })
const { featureDisableBlocked, featureDisableStatuses } = await import('./features')

/**
 * Turning `allocations` off hides every binding moment but keeps rules,
 * versions, runs, and lineage — so the switch is never blocked. The counts
 * tell the operator what goes dark: active rules and previewed (not yet
 * posted) runs.
 */
test('allocations disable is never blocked and counts active rules plus previewed runs', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await createScratchOrg()
  try {
    assert.deepEqual(await featureDisableStatuses(org.orgId, ['allocations']), {
      allocations: { blocked: false, impacts: [] },
    })

    const rule = (await db.execute<{ id: string }>(sql`
      insert into allocation_rules (org_id, key, name, mode, is_active)
      values (${org.orgId}, 'fenced-rule', 'Fenced rule', 'period', true)
      returning id`)).rows[0]!
    await db.execute(sql`
      insert into allocation_rules (org_id, key, name, mode, is_active)
      values (${org.orgId}, 'fenced-retired', 'Fenced retired rule', 'period', false)`)
    const version = (await db.execute<{ id: string }>(sql`
      insert into allocation_rule_versions (org_id, rule_id, version_no, status, effective_from)
      values (${org.orgId}, ${rule.id}, 1, 'draft', '2026-01-01')
      returning id`)).rows[0]!
    await db.execute(sql`
      insert into allocation_runs (org_id, rule_id, version_id, definition_hash, period_id, book_id, status)
      values (${org.orgId}, ${rule.id}, ${version.id}, 'fenced', ${org.periodId}, ${org.bookId}, 'previewed')`)
    await db.execute(sql`
      insert into allocation_runs (org_id, rule_id, version_id, definition_hash, period_id, book_id, status)
      values (${org.orgId}, ${rule.id}, ${version.id}, 'fenced', ${org.periodId}, ${org.bookId}, 'posted')`)

    assert.deepEqual(await featureDisableStatuses(org.orgId, ['allocations']), {
      allocations: {
        blocked: false,
        impacts: [
          { labelKey: 'activeAllocationRules', count: 1 },
          { labelKey: 'previewedAllocationRuns', count: 1 },
        ],
      },
    })
    assert.equal(await featureDisableBlocked(org.orgId, 'allocations'), false)
  } finally {
    await dropScratchOrg(org.orgId)
  }
})
