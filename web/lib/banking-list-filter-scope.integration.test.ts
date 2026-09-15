import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { sql } from 'drizzle-orm'

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') {
      return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
    }
    return nextResolve(specifier, context)
  },
})

const { db, env, withBypass } = await import('@openbooks/engine/src/db.ts')
const { createScratchOrg, dropScratchOrg } = await import('@openbooks/engine/src/test-fixtures.ts')
const { entityListSource } = await import('./list/entity-sources.ts')

test('banking account filter options honor the caller subsidiary scope', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const scratch = await withBypass(() => createScratchOrg())
  try {
    const hiddenSubsidiary = randomUUID()
    const visibleAccount = randomUUID()
    const hiddenAccount = randomUUID()
    await withBypass(async () => {
      await db.execute(sql`
        insert into subsidiaries (id, org_id, parent_id, name, base_currency, country)
        values (${hiddenSubsidiary}, ${scratch.orgId}, ${scratch.subsidiaryId}, 'Hidden banking entity', 'CAD', 'CA')
      `)
      await db.execute(sql`
        insert into accounts
          (id, org_id, number, name, type, reconcilable, currency_restriction, subsidiary_id)
        values
          (${visibleAccount}, ${scratch.orgId}, '1097', 'Visible bank', 'asset_bank', true, 'CAD', ${scratch.subsidiaryId}),
          (${hiddenAccount}, ${scratch.orgId}, '1096', 'Hidden bank', 'asset_bank', true, 'CAD', ${hiddenSubsidiary})
      `)
      await db.execute(sql`
        insert into reconciliations (id, org_id, account_id, through_date, currency, statement_balance)
        values
          (${randomUUID()}, ${scratch.orgId}, ${visibleAccount}, ${scratch.date}, 'CAD', '0'),
          (${randomUUID()}, ${scratch.orgId}, ${hiddenAccount}, ${scratch.date}, 'CAD', '0')
      `)
      await db.execute(sql`
        insert into bank_statements (id, org_id, account_id, source, statement_date, raw_file_ref)
        values
          (${randomUUID()}, ${scratch.orgId}, ${visibleAccount}, 'manual', ${scratch.date}, 'audit-log:visible'),
          (${randomUUID()}, ${scratch.orgId}, ${hiddenAccount}, 'manual', ${scratch.date}, 'audit-log:hidden')
      `)
    })

    for (const recordType of ['bank_reconciliation', 'bank_statement'] as const) {
      const source = entityListSource(recordType)
      assert.ok(source)
      const accountFilter = source.quickFilters?.find((filter) => filter.filterKey === 'account_id')
      assert.ok(accountFilter?.loadOptions)
      const loadOptions = accountFilter.loadOptions as (
        orgId: string,
        allowedSubsidiaryIds: ReadonlySet<string> | null,
      ) => Promise<{ value: string; label: string }[]>
      const options = await loadOptions(scratch.orgId, new Set([scratch.subsidiaryId]))
      assert.deepEqual(options.map((option) => option.value), [visibleAccount])
    }
  } finally {
    await withBypass(() => dropScratchOrg(scratch.orgId))
  }
})
