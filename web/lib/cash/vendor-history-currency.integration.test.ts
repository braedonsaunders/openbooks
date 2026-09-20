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
const { db, env, withBypass } = await import('@openbooks/engine/src/platform/db.ts')
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { categoryWeekly } = await import('./core')

/**
 * Forecast payment history reads in functional currency: vendor_payment and
 * check totals are transaction-currency denominated, so the monthly median
 * (vendor_payment_history) and the recurring average (vendor_recurring_average)
 * translate every payment at its document FX rate — exactly like the
 * purchasing paid values and the customer-intelligence revenue do. A bare
 * sum silently fuses currencies into the forecast.
 */
function daysBefore(iso: string, days: number): string {
  const t = Date.parse(`${iso}T00:00:00Z`) - days * 86_400_000
  return new Date(t).toISOString().slice(0, 10)
}

async function seedPayment(
  org: Awaited<ReturnType<typeof createScratchOrg>>,
  input: { number: string; currency: string; fxRate: string; total: string; daysAgo?: number },
) {
  const date = daysBefore(org.date, input.daysAgo ?? 0)
  // The history reads every non-voided payment regardless of lifecycle
  // status, so draft headers exercise the identical money expression.
  await db.execute(sql`
    insert into documents(
      id, org_id, kind, document_number, party_id, subsidiary_id, document_date,
      posting_date, currency, fx_rate, status, subtotal, tax_total, total
    ) values (
      ${randomUUID()}, ${org.orgId}, 'vendor_payment', ${input.number}, ${org.vendorId},
      ${org.subsidiaryId}, ${date}, ${date}, ${input.currency},
      ${input.fxRate}, 'draft', ${input.total}, 0, ${input.total}
    )
  `)
}

const WEEKS = ['2026-07-06', '2026-07-13', '2026-07-20', '2026-07-27']
const context = { arWeekly: {}, apWeekly: {}, cashStart: '0.0000', subIds: undefined } as const

test('vendor payment history medians translate at document FX', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const scratch = await withBypass(() => createScratchOrg())
  await withBypass(() => createScratchUser(scratch.orgId, 'Forecaster', 'admin'))
  try {
    await withBypass(async () => {
      await seedPayment(scratch, { number: 'PAY-CAD', currency: 'CAD', fxRate: '1', total: '100' })
      await seedPayment(scratch, { number: 'PAY-USD', currency: 'USD', fxRate: '1.35', total: '100' })
    })
    const category = await withBypass(() => categoryWeekly(
      scratch.orgId,
      { id: randomUUID(), name: 'Vendor median', direction: 'outflow', method: 'vendor_payment_history', partyIds: [scratch.vendorId], historyMonths: 12 },
      scratch.date,
      WEEKS,
      { ...context },
    ))
    assert.equal(
      category.meta.monthlyMedian,
      '235.0000',
      'the median monthly payment reads in functional currency (100 CAD + 100 USD @ 1.35)',
    )
  } finally {
    await withBypass(() => dropScratchOrg(scratch.orgId))
  }
})

test('vendor recurring averages translate at document FX', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const scratch = await withBypass(() => createScratchOrg())
  await withBypass(() => createScratchUser(scratch.orgId, 'Forecaster', 'admin'))
  try {
    await withBypass(async () => {
      await seedPayment(scratch, { number: 'PAY-CAD-1', currency: 'CAD', fxRate: '1', total: '100', daysAgo: 21 })
      await seedPayment(scratch, { number: 'PAY-CAD-2', currency: 'CAD', fxRate: '1', total: '100', daysAgo: 14 })
      await seedPayment(scratch, { number: 'PAY-USD-1', currency: 'USD', fxRate: '1.35', total: '100', daysAgo: 7 })
      await seedPayment(scratch, { number: 'PAY-USD-2', currency: 'USD', fxRate: '1.35', total: '100', daysAgo: 0 })
    })
    const category = await withBypass(() => categoryWeekly(
      scratch.orgId,
      { id: randomUUID(), name: 'Vendor recurring', direction: 'outflow', method: 'vendor_recurring_average', partyIds: [scratch.vendorId], historyMonths: 12 },
      scratch.date,
      WEEKS,
      { ...context },
    ))
    assert.equal(
      category.meta.avgAmount,
      '117.5000',
      'the recurring average reads in functional currency (mean of 100, 100, 135, 135)',
    )
  } finally {
    await withBypass(() => dropScratchOrg(scratch.orgId))
  }
})
