import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { runAutoElimination } from "./consolidation.ts";
import { db } from "./db.ts";
import { createScratchOrg, dropScratchOrg } from "./test-fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

test("foreign-currency eliminations are exact, balanced, and safely rerunnable", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const foreignSubsidiaryId = randomUUID();
    const eliminationSubsidiaryId = randomUUID();
    await db.execute(sql`
      insert into subsidiaries
        (id, org_id, parent_id, name, base_currency, country, tax_ids, is_elimination, is_active, custom)
      values
        (${foreignSubsidiaryId}, ${org.orgId}, ${org.subsidiaryId}, 'US Co', 'USD', 'US', '{}'::jsonb, false, true, '{}'::jsonb),
        (${eliminationSubsidiaryId}, ${org.orgId}, ${org.subsidiaryId}, 'Eliminations', 'CAD', 'CA', '{}'::jsonb, true, true, '{}'::jsonb)`);
    await db.execute(sql`
      update accounts set eliminate = true
       where id in (${org.accounts.ar}, ${org.accounts.ap})`);
    await db.execute(sql`
      insert into consolidated_fx_rates
        (org_id, period_id, from_currency, to_currency, current_rate, average_rate, historical_rate, source)
      values (${org.orgId}, ${org.periodId}, 'USD', 'CAD', '1.2000000000', '1.1900000000', '1.1000000000', 'manual')`);

    const cadEntry = randomUUID();
    const usdEntry = randomUUID();
    await db.execute(sql`
      insert into journal_entries
        (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, memo, status, origin)
      values
        (${cadEntry}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId}, 'IC-CAD', ${org.date}, ${org.periodId}, 'CAD intercompany', 'draft', 'manual'),
        (${usdEntry}, ${org.orgId}, ${org.bookId}, ${foreignSubsidiaryId}, 'IC-USD', ${org.date}, ${org.periodId}, 'USD intercompany', 'draft', 'manual')`);
    await db.execute(sql`
      insert into journal_lines
        (org_id, entry_id, line_number, account_id, subsidiary_id, amount, currency, txn_amount, fx_rate)
      values
        (${org.orgId}, ${cadEntry}, 1, ${org.accounts.ar}, ${org.subsidiaryId}, '120.0000', 'CAD', '120.0000', '1'),
        (${org.orgId}, ${cadEntry}, 2, ${org.accounts.bank}, ${org.subsidiaryId}, '-120.0000', 'CAD', '-120.0000', '1'),
        (${org.orgId}, ${usdEntry}, 1, ${org.accounts.ap}, ${foreignSubsidiaryId}, '-100.0000', 'USD', '-100.0000', '1'),
        (${org.orgId}, ${usdEntry}, 2, ${org.accounts.bank}, ${foreignSubsidiaryId}, '100.0000', 'USD', '100.0000', '1')`);
    await db.execute(sql`update journal_entries set status = 'posted', posted_at = now() where id in (${cadEntry}, ${usdEntry})`);

    const first = await runAutoElimination(org.orgId, org.periodId);
    assert.equal(first.lineCount, 2);
    const firstLines = (await db.execute(sql`
      select a.number, l.amount
        from journal_lines l join accounts a on a.id = l.account_id
       where l.entry_id = ${first.entryId}
       order by a.number`)) as unknown as { rows: { number: string; amount: string }[] };
    assert.deepEqual(firstLines.rows, [
      { number: "1100", amount: "-120.0000" },
      { number: "2000", amount: "120.0000" },
    ]);

    const second = await runAutoElimination(org.orgId, org.periodId);
    assert.equal(second.lineCount, 2);
    assert.notEqual(second.entryId, first.entryId);
    const proof = (await db.execute(sql`
      select
        count(distinct e.id) filter (where reverses_entry_id = ${first.entryId} and status = 'posted')::int as reversals,
        coalesce(sum(l.amount), 0)::text as effective_balance,
        coalesce(sum(l.amount) filter (where l.account_id = ${org.accounts.ar}), 0)::text as ar_elimination,
        coalesce(sum(l.amount) filter (where l.account_id = ${org.accounts.ap}), 0)::text as ap_elimination
      from journal_entries e
      join journal_lines l on l.entry_id = e.id
      where e.org_id = ${org.orgId} and e.subsidiary_id = ${eliminationSubsidiaryId}
        and e.status = 'posted' and e.origin = 'intercompany'`)) as unknown as {
      rows: { reversals: number; effective_balance: string; ar_elimination: string; ap_elimination: string }[];
    };
    assert.deepEqual(proof.rows[0], {
      reversals: 1,
      effective_balance: "0.0000",
      ar_elimination: "-120.0000",
      ap_elimination: "120.0000",
    });

    // A non-netting intercompany residual must fail before creating or
    // reversing any elimination evidence.
    const brokenEntry = randomUUID();
    await db.execute(sql`
      insert into journal_entries
        (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, memo, status, origin)
      values (${brokenEntry}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId}, 'IC-BROKEN', ${org.date}, ${org.periodId}, 'Broken pair', 'draft', 'manual')`);
    await db.execute(sql`
      insert into journal_lines
        (org_id, entry_id, line_number, account_id, subsidiary_id, amount, currency, txn_amount, fx_rate)
      values
        (${org.orgId}, ${brokenEntry}, 1, ${org.accounts.ar}, ${org.subsidiaryId}, '0.0001', 'CAD', '0.0001', '1'),
        (${org.orgId}, ${brokenEntry}, 2, ${org.accounts.bank}, ${org.subsidiaryId}, '-0.0001', 'CAD', '-0.0001', '1')`);
    await db.execute(sql`update journal_entries set status = 'posted', posted_at = now() where id = ${brokenEntry}`);
    await assert.rejects(runAutoElimination(org.orgId, org.periodId), /residual 0\.0001/);
    const afterFailure = (await db.execute(sql`
      select count(*)::int as n from journal_entries
       where org_id = ${org.orgId} and subsidiary_id = ${eliminationSubsidiaryId}
         and origin = 'intercompany' and status = 'posted'`)) as unknown as { rows: { n: number }[] };
    assert.equal(afterFailure.rows[0]!.n, 3);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
