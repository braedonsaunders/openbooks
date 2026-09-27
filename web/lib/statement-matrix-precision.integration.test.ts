import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
const { sql } = await import('drizzle-orm')
const { db, env, withBypass, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { createScratchOrg, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
import type { ScratchOrg } from '@openbooks/engine/src/testing/fixtures.ts'
const { resolveSubsidiaryView } = await import('./consolidation')
const { statementMatrix } = await import('./statement-matrix')

async function postManual(org: ScratchOrg, tag: string, date: string, periodId: string, subId: string, lines: [string, string][]) {
  const entry = randomUUID()
  await db.execute(sql`insert into journal_entries
    (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, memo, status, origin)
    values (${entry}, ${org.orgId}, ${org.bookId}, ${subId}, ${tag}, ${date}, ${periodId}, ${tag}, 'draft', 'manual')`)
  for (let i = 0; i < lines.length; i++) {
    const [accountId, amount] = lines[i]!
    await db.execute(sql`insert into journal_lines
      (org_id, entry_id, line_number, account_id, subsidiary_id, amount, currency, txn_amount, fx_rate)
      values (${org.orgId}, ${entry}, ${i + 1}, ${accountId}, ${subId}, ${amount}, 'CAD', ${amount}, '1')`)
  }
  await db.execute(sql`update journal_entries set status = 'posted', posted_at = now() where id = ${entry}`)
  return entry
}

/**
 * Translated consolidated columns multiply each line by a 10dp rate and
 * cash-basis columns by a fractional settled share — both carry material
 * digits past 4dp, which the exact-decimal tree rollup cannot hold. Column
 * sums must be rounded to ledger scale once, in SQL, before the rollup.
 */
test('translated matrix columns round to 4dp instead of throwing', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const scratch = await withBypass(() => createScratchOrg())
  try {
    const usdId = randomUUID()
    await withBypass(async () => {
      await db.execute(sql`insert into subsidiaries
        (id, org_id, parent_id, name, base_currency, country, tax_ids, is_elimination, is_active, custom)
        values (${usdId}, ${scratch.orgId}, ${scratch.subsidiaryId}, 'US Co', 'USD', 'US', '{}'::jsonb, false, true, '{}'::jsonb)`)
      await db.execute(sql`insert into consolidated_fx_rates
        (org_id, period_id, from_currency, to_currency, current_rate, average_rate, historical_rate, source)
        values (${scratch.orgId}, ${scratch.periodId}, 'USD', 'CAD', '1.2345678901', '1.2345678901', '1.2345678901', 'manual')`)
      await postManual(scratch, 'MATRIX-FX', scratch.date, scratch.periodId, usdId, [
        [scratch.accounts.bank, '100.0000'],
        [scratch.accounts.revenue, '-100.0000'],
      ])
    })
    const matrix = await withBypass(() => withOrgContext(scratch.orgId, async () => {
      const view = await resolveSubsidiaryView(scratch.subsidiaryId, '2026-07-31')
      return statementMatrix({
        orgId: scratch.orgId, types: ['income'], mode: 'flow',
        period: { from: '2026-07-01', to: '2026-07-31' }, periodLabel: 'July 2026',
        subsidiary: view.subsidiary,
      })
    }))
    const revenue = matrix.rows.find((r) => r.id === scratch.accounts.revenue)
    assert.ok(revenue)
    // round(100 x 1.2345678901, 4) = 123.4568, reader-signed positive.
    assert.deepEqual(revenue.values, ['123.4568'])
  } finally {
    await withBypass(() => dropScratchOrg(scratch.orgId))
  }
})

test('cash-basis matrix columns round fractional settled shares to 4dp', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const scratch = await withBypass(() => createScratchOrg())
  try {
    await withBypass(async () => {
      // Invoice 30 (open-item AR leg) + payment 10 through the bank: the
      // settled share 10/30 does not terminate, so the recognized revenue
      // line carries digits past 4dp.
      const inv = randomUUID()
      await db.execute(sql`insert into journal_entries
        (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, memo, status, origin)
        values (${inv}, ${scratch.orgId}, ${scratch.bookId}, ${scratch.subsidiaryId}, 'MATRIX-INV', ${scratch.date}, ${scratch.periodId}, 'inv', 'draft', 'manual')`)
      await db.execute(sql`insert into journal_lines
        (org_id, entry_id, line_number, account_id, subsidiary_id, amount, currency, txn_amount, fx_rate, is_open_item)
        values (${scratch.orgId}, ${inv}, 1, ${scratch.accounts.ar}, ${scratch.subsidiaryId}, '30', 'CAD', '30', '1', true),
               (${scratch.orgId}, ${inv}, 2, ${scratch.accounts.revenue}, ${scratch.subsidiaryId}, '-30', 'CAD', '-30', '1', false)`)
      await db.execute(sql`update journal_entries set status = 'posted', posted_at = now() where id = ${inv}`)
      const pay = randomUUID()
      await db.execute(sql`insert into journal_entries
        (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, memo, status, origin)
        values (${pay}, ${scratch.orgId}, ${scratch.bookId}, ${scratch.subsidiaryId}, 'MATRIX-PAY', ${scratch.date}, ${scratch.periodId}, 'pay', 'draft', 'manual')`)
      await db.execute(sql`insert into journal_lines
        (org_id, entry_id, line_number, account_id, subsidiary_id, amount, currency, txn_amount, fx_rate, is_open_item)
        values (${scratch.orgId}, ${pay}, 1, ${scratch.accounts.bank}, ${scratch.subsidiaryId}, '10', 'CAD', '10', '1', false),
               (${scratch.orgId}, ${pay}, 2, ${scratch.accounts.ar}, ${scratch.subsidiaryId}, '-10', 'CAD', '-10', '1', true)`)
      await db.execute(sql`update journal_entries set status = 'posted', posted_at = now() where id = ${pay}`)
      const arLine = (await db.execute<{ id: string }>(sql`select id from journal_lines where entry_id = ${inv} and is_open_item`)).rows[0]!.id
      const payArLine = (await db.execute<{ id: string }>(sql`select id from journal_lines where entry_id = ${pay} and is_open_item`)).rows[0]!.id
      await db.execute(sql`insert into applications
        (org_id, from_line_id, to_line_id, amount, applied_on, source_amount, source_transaction_amount,
         source_transaction_currency, target_transaction_amount, target_transaction_currency,
         settlement_rate, settlement_rate_source, settlement_rate_reference)
        values (${scratch.orgId}, ${payArLine}, ${arLine}, '10', ${scratch.date}, '10', '10', 'CAD', '10', 'CAD',
          '1', 'same_currency', 'MATRIX-TEST')`)
    })
    // Scoped like the translated case above: the web request-org resolver
    // denies unscoped reads under pooled RLS, so a bare call returns zero
    // rows instead of the settled share.
    const matrix = await withBypass(() => withOrgContext(scratch.orgId, async () => statementMatrix({
      orgId: scratch.orgId, types: ['income'], mode: 'flow', basis: 'cash',
      period: { from: '2026-07-01', to: '2026-07-31' }, periodLabel: 'July 2026',
    })))
    const revenue = matrix.rows.find((r) => r.id === scratch.accounts.revenue)
    assert.ok(revenue)
    // 30 recognized at a 1/3 share = 10.0000, reader-signed positive.
    assert.deepEqual(revenue.values, ['10.0000'])
  } finally {
    await withBypass(() => dropScratchOrg(scratch.orgId))
  }
})


const consolidatedRows = [
  { label: "statement matrix control loss", register: async () => {
        const assert = (await import("node:assert/strict")).default;
        const { randomUUID } = await import("node:crypto");
        const test = (await import("node:test")).default;
        type StatementSubsidiaryContext = import("./statement-matrix").StatementSubsidiaryContext;
        const { sql } = await import("drizzle-orm");
        const { db, env, withBypass, withOrgContext } =
          await import("@openbooks/engine/src/platform/db.ts");
        const { createScratchOrg, dropScratchOrg } =
          await import("@openbooks/engine/src/testing/fixtures.ts");
        const { statementMatrix } = await import("./statement-matrix");
        
        
        test(
          "disposed foreign subsidiary retains pre-disposal income and frozen balances without future rates",
          { skip: !env.OPENBOOKS_DB_URL },
          async () => {
            const org = await withBypass(() => createScratchOrg());
            try {
              const child = randomUUID(),
                equity = randomUUID();
              await withBypass(async () => {
                await db.execute(
                  sql`insert into subsidiaries(id,org_id,parent_id,name,base_currency,country,is_active,is_elimination) values(${child},${org.orgId},${org.subsidiaryId},'Disposed foreign entity','USD','US',true,false)`,
                );
                await db.execute(
                  sql`insert into accounts(id,org_id,number,name,type,is_active,is_summary) values(${equity},${org.orgId},'LOSS-EQ','Historic equity','equity',true,false)`,
                );
                for (const [date, amount, credit] of [
                  ["2026-07-01", "1000", equity],
                  ["2026-07-15", "100", org.accounts.revenue],
                  ["2026-07-25", "900", org.accounts.revenue],
                ]) {
                  const id = randomUUID();
                  await db.execute(
                    sql`insert into journal_entries(id,org_id,book_id,subsidiary_id,entry_number,posting_date,period_id,status,origin) values(${id},${org.orgId},${org.bookId},${child},${id},${date},${org.periodId},'draft','manual')`,
                  );
                  await db.execute(
                    sql`insert into journal_lines(org_id,entry_id,line_number,account_id,subsidiary_id,amount,currency,txn_amount,fx_rate) values(${org.orgId},${id},1,${org.accounts.bank},${child},${amount},'USD',${amount},1),(${org.orgId},${id},2,${credit},${child},-${amount}::numeric,'USD',-${amount}::numeric,1)`,
                  );
                  await db.execute(
                    sql`update journal_entries set status='posted',posted_at=now() where org_id=${org.orgId} and id=${id}`,
                  );
                }
              });
              const subsidiary: StatementSubsidiaryContext = {
                ids: [org.subsidiaryId, child],
                rates: [
                  {
                    subsidiaryId: child,
                    currency: "USD",
                    periodFrom: "2026-07-01",
                    periodTo: "2026-07-31",
                    averageRate: "1.2",
                    currentRate: "1.3",
                    historicalRate: "0.9",
                  },
                ],
                controlLosses: [
                  {
                    subsidiaryId: child,
                    through: "2026-07-20",
                    closingRate: "1.1",
                    factor: "1",
                  },
                ],
              };
              await withBypass(() =>
                withOrgContext(org.orgId, async () => {
                  const flow = await statementMatrix({
                    orgId: org.orgId,
                    types: ["income"],
                    mode: "flow",
                    period: { from: "2026-07-01", to: "2026-08-31" },
                    periodLabel: "Through August",
                    subsidiary,
                  });
                  assert.deepEqual(
                    flow.rows.find((r) => r.id === org.accounts.revenue)?.values,
                    ["120.0000"],
                  );
                  const later = await statementMatrix({
                    orgId: org.orgId,
                    types: ["income"],
                    mode: "flow",
                    period: { from: "2026-08-01", to: "2026-08-31" },
                    periodLabel: "August",
                    subsidiary,
                  });
                  assert.ok(
                    !later.rows.find((r) => r.id === org.accounts.revenue) ||
                      later.rows
                        .find((r) => r.id === org.accounts.revenue)!
                        .values.every((value) => value === "0.0000"),
                  );
                  const balance = await statementMatrix({
                    orgId: org.orgId,
                    types: ["asset_bank", "equity"],
                    mode: "balance",
                    period: { from: "2026-08-01", to: "2026-08-31" },
                    periodLabel: "August",
                    subsidiary,
                  });
                  assert.deepEqual(
                    balance.rows.find((r) => r.id === org.accounts.bank)?.values,
                    ["1210.0000"],
                  );
                  assert.deepEqual(balance.rows.find((r) => r.id === equity)?.values, [
                    "900.0000",
                  ]);
                  // A comparative before disposal still translates using its own period.
                  const before = await statementMatrix({
                    orgId: org.orgId,
                    types: ["asset_bank"],
                    mode: "balance",
                    period: { from: "2026-07-01", to: "2026-07-10" },
                    periodLabel: "Before sale",
                    subsidiary,
                  });
                  assert.deepEqual(
                    before.rows.find((r) => r.id === org.accounts.bank)?.values,
                    ["1300.0000"],
                  );
                  // Missing pre-disposal history must still refuse; a cutoff is no waiver.
                  await assert.rejects(
                    () =>
                      statementMatrix({
                        orgId: org.orgId,
                        types: ["income"],
                        mode: "flow",
                        period: { from: "2026-06-01", to: "2026-08-31" },
                        periodLabel: "Missing June",
                        subsidiary,
                      }),
                    /exchange rates/,
                  );
                }),
              );
            } finally {
              await withBypass(() => dropScratchOrg(org.orgId));
            }
          },
        );
  } },
  { label: "statement matrix draft columns", register: async () => {
        const assert = (await import("node:assert/strict")).default;
        const { randomUUID } = await import("node:crypto");
        const test = (await import("node:test")).default;
        const { sql } = await import('drizzle-orm')
        const { db, env, withBypass, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
        const { createScratchOrg, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
        const { statementMatrix } = await import('./statement-matrix')
        
        /**
         * Breakout columns must come from the same posted set the aggregation reads.
         * A draft entry tagging an otherwise-inactive department must not mint a
         * zero-valued column (which, at the 24-column cap, can displace a real one),
         * and draft-only untagged lines must not mint an "Unassigned" column.
         */
        test('department breakout ignores draft entries when discovering columns', { skip: !env.OPENBOOKS_DB_URL }, async () => {
          const scratch = await withBypass(() => createScratchOrg())
          try {
            const deptA = randomUUID(), deptB = randomUUID()
            const postEntry = randomUUID(), draftEntry = randomUUID()
            await withBypass(async () => {
              await db.execute(sql`insert into departments (id, org_id, name, is_active)
                values (${deptA}, ${scratch.orgId}, 'AAA Posted Dept', true),
                       (${deptB}, ${scratch.orgId}, 'ZZZ Draft Dept', true)`)
              await db.execute(sql`insert into journal_entries
                (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, memo, status, origin)
                values (${postEntry}, ${scratch.orgId}, ${scratch.bookId}, ${scratch.subsidiaryId},
                  'MATRIX-POSTED', ${scratch.date}, ${scratch.periodId}, 'posted', 'draft', 'manual'),
                  (${draftEntry}, ${scratch.orgId}, ${scratch.bookId}, ${scratch.subsidiaryId},
                  'MATRIX-DRAFT', ${scratch.date}, ${scratch.periodId}, 'draft', 'draft', 'manual')`)
              await db.execute(sql`insert into journal_lines
                (org_id, entry_id, line_number, account_id, subsidiary_id, department_id, amount, currency, txn_amount, fx_rate)
                values (${scratch.orgId}, ${postEntry}, 1, ${scratch.accounts.bank}, ${scratch.subsidiaryId}, ${deptA}, '100', 'CAD', '100', '1'),
                  (${scratch.orgId}, ${postEntry}, 2, ${scratch.accounts.revenue}, ${scratch.subsidiaryId}, ${deptA}, '-100', 'CAD', '-100', '1'),
                  (${scratch.orgId}, ${draftEntry}, 1, ${scratch.accounts.bank}, ${scratch.subsidiaryId}, ${deptB}, '50', 'CAD', '50', '1'),
                  (${scratch.orgId}, ${draftEntry}, 2, ${scratch.accounts.revenue}, ${scratch.subsidiaryId}, ${deptB}, '-50', 'CAD', '-50', '1')`)
              await db.execute(sql`update journal_entries set status = 'posted', posted_at = now() where id = ${postEntry}`)
            })
            // Scoped like the cash-basis precision case (F-coord-005): the web
            // request-org resolver denies unscoped reads under pooled RLS, so a bare
            // call returns zero rows and mints no columns at all.
            const matrix = await withBypass(() => withOrgContext(scratch.orgId, async () => statementMatrix({
              orgId: scratch.orgId, types: ['income'], mode: 'flow',
              period: { from: '2026-07-01', to: '2026-07-31' }, periodLabel: 'July 2026',
              breakout: 'department',
            })))
            assert.deepEqual(matrix.columns.map((c) => c.label), ['AAA Posted Dept'])
            assert.equal(matrix.truncated, false)
          } finally {
            await withBypass(() => dropScratchOrg(scratch.orgId))
          }
        })
        
        test('department breakout ignores draft-only untagged lines for the Unassigned column', { skip: !env.OPENBOOKS_DB_URL }, async () => {
          const scratch = await withBypass(() => createScratchOrg())
          try {
            const deptA = randomUUID()
            const postEntry = randomUUID(), draftEntry = randomUUID()
            await withBypass(async () => {
              await db.execute(sql`insert into departments (id, org_id, name, is_active)
                values (${deptA}, ${scratch.orgId}, 'AAA Posted Dept', true)`)
              await db.execute(sql`insert into journal_entries
                (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, memo, status, origin)
                values (${postEntry}, ${scratch.orgId}, ${scratch.bookId}, ${scratch.subsidiaryId},
                  'MATRIX-POSTED', ${scratch.date}, ${scratch.periodId}, 'posted', 'draft', 'manual'),
                  (${draftEntry}, ${scratch.orgId}, ${scratch.bookId}, ${scratch.subsidiaryId},
                  'MATRIX-DRAFT', ${scratch.date}, ${scratch.periodId}, 'draft', 'draft', 'manual')`)
              await db.execute(sql`insert into journal_lines
                (org_id, entry_id, line_number, account_id, subsidiary_id, department_id, amount, currency, txn_amount, fx_rate)
                values (${scratch.orgId}, ${postEntry}, 1, ${scratch.accounts.bank}, ${scratch.subsidiaryId}, ${deptA}, '100', 'CAD', '100', '1'),
                  (${scratch.orgId}, ${postEntry}, 2, ${scratch.accounts.revenue}, ${scratch.subsidiaryId}, ${deptA}, '-100', 'CAD', '-100', '1'),
                  (${scratch.orgId}, ${draftEntry}, 1, ${scratch.accounts.bank}, ${scratch.subsidiaryId}, null, '50', 'CAD', '50', '1'),
                  (${scratch.orgId}, ${draftEntry}, 2, ${scratch.accounts.revenue}, ${scratch.subsidiaryId}, null, '-50', 'CAD', '-50', '1')`)
              await db.execute(sql`update journal_entries set status = 'posted', posted_at = now() where id = ${postEntry}`)
            })
            const matrix = await withBypass(() => withOrgContext(scratch.orgId, async () => statementMatrix({
              orgId: scratch.orgId, types: ['income'], mode: 'flow',
              period: { from: '2026-07-01', to: '2026-07-31' }, periodLabel: 'July 2026',
              breakout: 'department',
            })))
            assert.deepEqual(matrix.columns.map((c) => c.label), ['AAA Posted Dept'])
          } finally {
            await withBypass(() => dropScratchOrg(scratch.orgId))
          }
        })
  } },
] as const;

for (const row of consolidatedRows) await row.register();
