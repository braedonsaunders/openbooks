import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { sql } from 'drizzle-orm'
import { db, withOrgContext } from '@openbooks/engine/src/platform/db.ts'
import { mulDecimal } from '@openbooks/engine/src/money/money.ts'
import { presentationAmountSql } from './fx-presentation'

test('SQL presentation matches exact bigint conversion at positive and negative ties and beyond safe integers', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const amounts = ['0.0001', '-0.0001', '1.2345', '-1.2345', '9007199254740993.0001', '-9007199254740993.0001']
  const rates = ['0.5000000000', '1.5000000000', '1.2345678901']
  await withOrgContext(randomUUID(), async () => {
    for (const amount of amounts) for (const rate of rates) {
      const result = await db.execute<{ amount: string }>(sql`select (${presentationAmountSql(sql`${amount}::numeric`, sql`'EUR'`, 'CAD', sql`${rate}::numeric`)})::text as amount`)
      assert.equal(result.rows[0]!.amount, mulDecimal(amount, rate), `${amount} × ${rate}`)
    }
    const sameCurrency = await db.execute<{ amount: string }>(sql`select (${presentationAmountSql(sql`'1.2345'::numeric`, sql`'CAD'`, 'CAD', sql`null::numeric`)})::text as amount`)
    assert.equal(sameCurrency.rows[0]!.amount, '1.2345', 'native currency never requires a rate')
  })
})

test('batched dated rates preserve preceding coverage, inverse quotes and direct ties', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const { createScratchOrg, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
  const { withBypass } = await import('@openbooks/engine/src/platform/db.ts')
  const { flowRates, MissingExchangeRateError } = await import('./fx-presentation')
  const org = await withBypass(() => createScratchOrg())
  try {
    await withBypass(async () => {
      await db.execute(sql`insert into fx_rates (org_id, from_currency, to_currency, as_of, rate_type, rate, source)
        values (${org.orgId}, 'USD', 'CAD', '2020-01-10', 'spot', 1.1, 'manual'),
          (${org.orgId}, 'USD', 'CAD', '2026-01-10', 'spot', 1.2, 'manual'),
          (${org.orgId}, 'CAD', 'USD', '2026-02-11', 'spot', 2, 'manual'),
          (${org.orgId}, 'USD', 'CAD', '2026-02-11', 'spot', 1.4, 'manual'),
          (${org.orgId}, 'USD', 'CAD', '2026-02-21', 'spot', 1.6, 'manual'),
          (${org.orgId}, 'EUR', 'CAD', '2026-02-15', 'spot', 1.7, 'manual')`)
    })
    await withOrgContext(org.orgId, async () => {
      const rates = await flowRates(org.orgId, [
        { func: 'USD', date: '2026-02-01' }, { func: 'USD', date: '2026-02-20' },
        { func: 'USD', date: '2026-02-28' }, { func: 'EUR', date: '2026-02-20' },
      ])
      assert.equal(rates.rateAt('USD', '2026-02-01'), '1.2000000000')
      assert.equal(rates.rateAt('USD', '2026-02-20'), '1.4000000000')
      assert.equal(rates.rateAt('USD', '2026-02-28'), '1.6000000000')
      assert.equal(rates.rateAt('EUR', '2026-02-20'), '1.7000000000')
      const uncovered = await flowRates(org.orgId, [{ func: 'EUR', date: '2026-02-01' }])
      assert.throws(() => uncovered.rateAt('EUR', '2026-02-01'), MissingExchangeRateError)
    })
  } finally { await withBypass(() => dropScratchOrg(org.orgId)) }
})
