import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import test from 'node:test'

registerHooks({
  resolve(specifier, _context, next) {
    if (specifier === 'server-only') return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
    return next(specifier)
  },
})

const { sql } = await import('drizzle-orm')
const { db, env, withBypass, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { categoryWeekly } = await import('./core')
const { cashPosition } = await import('./cash-position')
import type { ForecastCategory } from './core'

/**
 * Root-owned documents (null subsidiary) read in unrestricted root-covering
 * cash views alongside attributed rows — the same population the line-side
 * forecast inputs see. Restricted views stay fail-closed and an empty scope
 * reads nothing, even with the limb present.
 */
async function seedPayment(
  org: Awaited<ReturnType<typeof createScratchOrg>>,
  input: { number: string; partyId: string; subsidiaryId: string | null; total: string },
) {
  await db.execute(sql`
    insert into documents(
      id, org_id, kind, document_number, party_id, subsidiary_id, document_date,
      posting_date, currency, fx_rate, status, subtotal, tax_total, total
    ) values (
      ${randomUUID()}, ${org.orgId}, 'vendor_payment', ${input.number}, ${input.partyId},
      ${input.subsidiaryId}, ${org.date}, ${org.date}, 'CAD',
      '1', 'draft', ${input.total}, 0, ${input.total}
    )
  `)
}

const WEEKS = ['2026-07-06', '2026-07-13', '2026-07-20', '2026-07-27']
const baseContext = { arWeekly: {}, apWeekly: {}, cashStart: '0.0000' } as const
const settings = { weeklyCap: '0.0000', restrictToSafe: false } as const

test('unrestricted consolidated cash reads root-owned payments', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const scratch = await withBypass(() => createScratchOrg())
  await withBypass(() => createScratchUser(scratch.orgId, 'Forecaster', 'admin'))
  try {
    const branchId = randomUUID()
    const nullOnlyVendor = randomUUID()
    await withBypass(async () => {
      await db.execute(sql`
        insert into subsidiaries (id, org_id, parent_id, name, base_currency, country)
        values (${branchId}, ${scratch.orgId}, ${scratch.subsidiaryId}, 'Cash branch', 'CAD', 'CA')
      `)
      await db.execute(sql`
        insert into parties (id, org_id, kind, display_name, subsidiary_id)
        values (${nullOnlyVendor}, ${scratch.orgId}, 'organization', 'NULL-DOC-VENDOR', ${scratch.subsidiaryId})
      `)
      await seedPayment(scratch, { number: 'PAY-BRANCH', partyId: scratch.vendorId, subsidiaryId: branchId, total: '100' })
      await seedPayment(scratch, { number: 'PAY-ROOT-NULL', partyId: scratch.vendorId, subsidiaryId: null, total: '400' })
      await seedPayment(scratch, { number: 'PAY-NULLONLY', partyId: nullOnlyVendor, subsidiaryId: null, total: '50' })
    })
    const root = scratch.subsidiaryId
    const all = [root, branchId]
    const historyCat: ForecastCategory = {
      id: randomUUID(), name: 'Vendor median', direction: 'outflow', method: 'vendor_payment_history',
      partyIds: [scratch.vendorId], historyMonths: 12,
    }

    const consolidated = await withBypass(() => categoryWeekly(
      scratch.orgId, { ...historyCat }, scratch.date, WEEKS,
      { ...baseContext, subIds: all, includeNullSubsidiary: true },
    ))
    assert.equal(
      consolidated.meta.monthlyMedian,
      '500.0000',
      'an unrestricted consolidated history medians the root-owned payment with the rest',
    )

    const bare = await withBypass(() => categoryWeekly(
      scratch.orgId, { ...historyCat }, scratch.date, WEEKS, { ...baseContext, subIds: all },
    ))
    assert.equal(bare.meta.monthlyMedian, '100.0000', 'without the limb the root-owned payment drops out')

    const branchOnly = await withBypass(() => categoryWeekly(
      scratch.orgId, { ...historyCat }, scratch.date, WEEKS, { ...baseContext, subIds: [branchId] },
    ))
    assert.equal(branchOnly.meta.monthlyMedian, '100.0000', 'a branch view hides root-owned rows like its cell')

    const empty = await withBypass(() => categoryWeekly(
      scratch.orgId, { ...historyCat }, scratch.date, WEEKS,
      { ...baseContext, subIds: [], includeNullSubsidiary: true },
    ))
    assert.equal(empty.meta.monthlyMedian, '0.0000', 'an empty scope reads nothing even with the limb')

    const position = await withOrgContext(scratch.orgId, () => cashPosition(
      scratch.orgId, 4, settings, scratch.date, all, null, true,
    ))
    assert.ok(
      position.vendorOptions.some((v) => v.id === nullOnlyVendor),
      'the unrestricted consolidated vendor picker lists the vendor known only through root-owned documents',
    )
    const denied = await withOrgContext(scratch.orgId, () => cashPosition(
      scratch.orgId, 4, settings, scratch.date, [branchId], null, false,
    ))
    assert.ok(
      denied.vendorOptions.some((v) => v.id === scratch.vendorId),
      'a branch view still lists vendors through their attributed documents',
    )
    assert.ok(
      !denied.vendorOptions.some((v) => v.id === nullOnlyVendor),
      'a branch view hides the vendor known only through root-owned documents',
    )
  } finally {
    await withBypass(() => dropScratchOrg(scratch.orgId))
  }
})
