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
