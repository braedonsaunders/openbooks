import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { sql } from 'drizzle-orm'
// Worktree-relative imports: the @openbooks/* aliases resolve to the main
// checkout through the symlinked node_modules, which does not yet carry the
// allocation report entities this test executes (fleet A10 owns them).
import { db, pool, withBypass, withOrgContext } from '../../engine/src/db.ts'
import { createScratchOrg, dropScratchOrg } from '../../engine/src/test-fixtures.ts'
import { REPORT_ENTITY_MAP } from '../../packages/reports/src/entities.ts'
import { runCustomQuery } from '../../packages/reports/src/run.ts'
import { BUILT_IN_REPORT_DEFINITION_MAP } from '../../packages/reports/src/built-ins.ts'

// Same seam as web/lib/custom-report-books.test.ts: shim the RSC
// `server-only` marker (this file runs from the root, one file per process).
registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' }
  return next(specifier, context)
} })

/**
 * The allocation report entities execute against the real 0160 tables: a
 * posted run with one lineage row reads back through the entity FROM clauses
 * (rules, versions, periods, books, accounts, dimensions), and both built-in
 * reports run end to end. Column/expression typos in the catalog can only
 * surface here — the compiler tests never touch Postgres.
 */
test('allocation run and lineage entities read back a posted run', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const scratch = await withBypass(() => createScratchOrg())
  try {
    await withBypass(async () => {
      const rule = (await db.execute<{ id: string }>(sql`
        insert into allocation_rules (org_id, key, name, mode, is_active)
        values (${scratch.orgId}, 'report-proof', 'Report proof', 'period', true)
        returning id`)).rows[0]!
      const version = (await db.execute<{ id: string }>(sql`
        insert into allocation_rule_versions (org_id, rule_id, version_no, status, effective_from, definition_hash)
        values (${scratch.orgId}, ${rule.id}, 1, 'published', '2026-01-01', 'proof')
        returning id`)).rows[0]!
      const run = (await db.execute<{ id: string }>(sql`
        insert into allocation_runs
          (org_id, rule_id, version_id, definition_hash, period_id, book_id,
           status, trigger_kind, source_total, allocated_total, residual, started_at, completed_at)
        values (${scratch.orgId}, ${rule.id}, ${version.id}, 'proof', ${scratch.periodId}, ${scratch.bookId},
                'posted', 'manual', '100.0000', '100.0000', '0.0000', now(), now())
        returning id`)).rows[0]!
      await db.execute(sql`
        insert into allocation_lineage
          (org_id, mode, rule_id, version_id, definition_hash, run_id, amount, share, driver_value, driver_total)
        values (${scratch.orgId}, 'period', ${rule.id}, ${version.id}, 'proof', ${run.id},
                '100.0000', '1.0000000000', '5.0000', '5.0000')`)
    })

    await withOrgContext(scratch.orgId, async () => {
      const runs = await runCustomQuery(pool, {
        entity: 'allocation_runs',
        mode: 'rows',
        columns: ['rule_name', 'rule_key', 'period', 'book', 'status', 'source_total', 'allocated_total', 'residual'],
      }, { orgId: scratch.orgId, entityMap: REPORT_ENTITY_MAP })
      assert.equal(runs.rowCount, 1)
      const row = Object.fromEntries(runs.groups[0]!.rows[0]!.map((cell, i) => [runs.groups[0]!.columns[i], cell]))
      assert.equal(row['Rule'], 'Report proof')
      assert.equal(row['Rule key'], 'report-proof')
      assert.equal(row['Status'], 'posted')
      assert.equal(row['Source total'], '100.00')
      assert.equal(row['Allocated'], '100.00')
      assert.equal(row['Residual'], '0.00')

      const lineage = await runCustomQuery(pool, {
        entity: 'allocation_lineage',
        mode: 'rows',
        columns: ['rule_name', 'mode', 'amount', 'share', 'driver_value'],
      }, { orgId: scratch.orgId, entityMap: REPORT_ENTITY_MAP })
      assert.equal(lineage.rowCount, 1)
      const lrow = Object.fromEntries(lineage.groups[0]!.rows[0]!.map((cell, i) => [lineage.groups[0]!.columns[i], cell]))
      assert.equal(lrow['Rule'], 'Report proof')
      assert.equal(lrow['Mode'], 'period')
      assert.equal(lrow['Amount'], '100.00')

      // Both built-ins run verbatim against the same rows.
      const summary = await runCustomQuery(
        pool, BUILT_IN_REPORT_DEFINITION_MAP['allocation-summary']!.query,
        { orgId: scratch.orgId, entityMap: REPORT_ENTITY_MAP },
      )
      assert.equal(summary.rowCount, 1)
      const srow = summary.groups[0]!.rows[0]!
      assert.deepEqual(srow.slice(0, 3), ['Report proof', '2026-07', 'posted'])

      const trace = await runCustomQuery(
        pool, BUILT_IN_REPORT_DEFINITION_MAP['allocation-lineage']!.query,
        { orgId: scratch.orgId, entityMap: REPORT_ENTITY_MAP },
      )
      assert.equal(trace.rowCount, 1)
    })
  } finally {
    await withBypass(() => dropScratchOrg(scratch.orgId))
  }
})
