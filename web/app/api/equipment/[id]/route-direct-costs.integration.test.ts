import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

// Equipment ROI double-counted reversed direct costs: the metric summed
// only positive expense lines across posted and reversed entries, so a
// +100 expense and its −100 reversal still read as 100 direct cost. The
// metric now sums signed amounts, netting reversals to zero.
const root = pathToFileURL(process.cwd() + '/').href
const state: { orgId: string; actorId: string } = { orgId: '', actorId: '' }
Object.assign(globalThis, { __equipmentConcurrencyState: state })
const virtual = (source: string) => ({ shortCircuit: true as const, url: 'data:text/javascript,' + encodeURIComponent(source) })
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'server-only') return virtual('export {}')
    if (specifier === '../../../../lib/feature-gates') return virtual(`
      export async function guardFeaturePermission() {
        const s = globalThis.__equipmentConcurrencyState;
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
const { GET } = await import('./route.ts')

async function fixture(status = 'draft') {
  const org = await createScratchOrg()
  state.orgId = org.orgId
  state.actorId = randomUUID()
  const unitId = (await db.execute<{ id: string }>(sql`
    insert into equipment_units (org_id, name, unit_number, status, subsidiary_id, purchase_price)
    values (${org.orgId}, 'Test Unit', 'TEST-001', ${status}, ${org.subsidiaryId}, '100.0000')
    returning id`)).rows[0]!.id
  return { org, unitId }
}

test('reversed direct costs net to zero instead of hiding behind a positive filter', async () => {
  const { org, unitId } = await fixture()
  try {
    // A +100 expense and its −100 reversal must read as zero direct cost,
    // not 100. Both entries balance through the clearing account.
    for (const [entryId, costAmount] of [
      [randomUUID(), '100.0000'],
      [randomUUID(), '-100.0000'],
    ] as const) {
      const entryNumber = `EQ-DIRECT-${costAmount.startsWith('-') ? 'REV' : 'EXP'}`
      await db.execute(sql`insert into journal_entries
        (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, memo, status, origin)
        values (${entryId}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId}, ${entryNumber}, ${org.date}, ${org.periodId}, 'direct cost', 'draft', 'manual')`)
      const contra = costAmount.startsWith('-') ? '100.0000' : '-100.0000'
      // One statement: the balance trigger reads the entry per statement.
      await db.execute(sql`insert into journal_lines
        (org_id, entry_id, line_number, account_id, subsidiary_id, amount, currency, txn_amount, equipment_unit_id)
        values (${org.orgId}, ${entryId}, 1, ${org.accounts.cogs}, ${org.subsidiaryId}, ${costAmount}, 'CAD', ${costAmount}, ${unitId}),
               (${org.orgId}, ${entryId}, 2, ${org.accounts.clearing}, ${org.subsidiaryId}, ${contra}, 'CAD', ${contra}, null)`)
      await db.execute(sql`update journal_entries set status = 'posted' where id = ${entryId} and org_id = ${org.orgId}`)
    }
    const response = await withOrgContext(state.orgId, () =>
      GET(new Request(`http://equipment.test/api/equipment/${unitId}`), { params: Promise.resolve({ id: unitId }) }),
    )
    assert.equal(response.status, 200)
    const body = (await response.json()) as { metrics: { direct_costs: string } }
    assert.equal(body.metrics.direct_costs, '0.0000')
  } finally {
    await dropScratchOrg(org.orgId)
  }
})
