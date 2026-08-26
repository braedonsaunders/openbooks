import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import type { PoolClient, QueryResult } from "pg";
import { deriveConsolidatedRates, runAutoElimination, runOwnershipConsolidation } from "./consolidation.ts";
import { db, pool, withOrgTransaction } from "./db.ts";
import {
  createScratchOrg,
  dropScratchOrg,
  seedFlowActors,
  type ScratchOrg,
} from "./test-fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

type TreeUpdateResult = PromiseSettledResult<QueryResult>;

/** Poll until some other backend is waiting on a lock held by `blockerPid`. */
async function waitForBlockedBy(blockerPid: number, hint: string): Promise<number> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const state = await pool.query<{ pid: number }>(
      "select pid from pg_stat_activity where pg_blocking_pids(pid) @> array[$1::int]::int[] and pid <> $1",
      [blockerPid],
    );
    if (state.rows[0]) return Number(state.rows[0]!.pid);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for a backend blocked by ${blockerPid} (${hint})`);
}

/**
 * Minimal first-use ownership fixture: one 80%-owned CAD child with posted
 * opening equity (1000) and period profit (100), one elimination subsidiary,
 * the seven consolidation accounts, and one active full-method policy.
 */
async function seedOwnershipConsolidationFixture(org: ScratchOrg): Promise<{
  childId: string;
  eliminationId: string;
  interestId: string;
  accounts: Map<string, string>;
}> {
  const childId = randomUUID();
  const eliminationId = randomUUID();
  await db.execute(sql`
      insert into subsidiaries
        (id,org_id,parent_id,name,base_currency,country,tax_ids,is_elimination,is_active,custom)
      values
        (${childId},${org.orgId},${org.subsidiaryId},'Owned Co','CAD','CA','{}'::jsonb,false,true,'{}'::jsonb),
        (${eliminationId},${org.orgId},${org.subsidiaryId},'Ownership eliminations','CAD','CA','{}'::jsonb,true,true,'{}'::jsonb)
    `);
  const defs = [
    ["investment", "1400", "Investment in subsidiary", "asset_current_other"],
    ["equityIncome", "4020", "Equity income", "income_other"],
    ["nciEquity", "3100", "Non-controlling interest", "equity"],
    ["nciIncome", "6100", "Profit attributable to NCI", "expense_other"],
    ["goodwill", "1500", "Goodwill", "asset_fixed"],
    ["fairValue", "1510", "Fair value adjustment", "asset_fixed"],
    ["childEquity", "3000", "Child share capital", "equity"],
  ] as const;
  const accounts = new Map<string, string>();
  for (const [key, number, name, type] of defs) {
    const id = randomUUID();
    accounts.set(key, id);
    await db.execute(sql`
        insert into accounts
          (id,org_id,number,name,type,is_summary,is_active,eliminate,reconcilable,required_dimensions,custom,subsidiary_include_children)
        values (${id},${org.orgId},${number},${name},${type},false,true,false,false,'[]'::jsonb,'{}'::jsonb,true)
      `);
  }
  const capital = randomUUID();
  const profit = randomUUID();
  await db.execute(sql`
      insert into journal_entries
        (id,org_id,book_id,subsidiary_id,entry_number,posting_date,period_id,memo,status,origin)
      values
        (${capital},${org.orgId},${org.bookId},${childId},'OWN-CAP','2026-07-01',${org.periodId},'Opening equity','draft','manual'),
        (${profit},${org.orgId},${org.bookId},${childId},'OWN-PROFIT',${org.date},${org.periodId},'Period profit','draft','manual')
    `);
  await db.execute(sql`
      insert into journal_lines
        (org_id,entry_id,line_number,account_id,subsidiary_id,amount,currency,txn_amount,fx_rate)
      values
        (${org.orgId},${capital},1,${org.accounts.bank},${childId},'1000','CAD','1000','1'),
        (${org.orgId},${capital},2,${accounts.get("childEquity")!},${childId},'-1000','CAD','-1000','1'),
        (${org.orgId},${profit},1,${org.accounts.bank},${childId},'100','CAD','100','1'),
        (${org.orgId},${profit},2,${org.accounts.revenue},${childId},'-100','CAD','-100','1')
    `);
  await db.execute(sql`
      update journal_entries set status='posted', posted_at=now()
       where id in (${capital}, ${profit})
    `);
  const interestId = randomUUID();
  await db.execute(sql`
      insert into subsidiary_ownership_interests
        (id,org_id,parent_subsidiary_id,subsidiary_id,effective_from,ownership_percent,method,
         acquisition_date,acquisition_cost,fair_value_net_assets,acquisition_rate,nci_measurement,
         investment_account_id,equity_income_account_id,nci_equity_account_id,nci_income_account_id,
         goodwill_account_id,fair_value_adjustment_account_id)
      values (${interestId},${org.orgId},${org.subsidiaryId},${childId},'2026-07-01','80','full',
              '2026-07-01','900','1000','1','proportionate',${accounts.get("investment")!},
              ${accounts.get("equityIncome")!},${accounts.get("nciEquity")!},${accounts.get("nciIncome")!},
              ${accounts.get("goodwill")!},${accounts.get("fairValue")!})
    `);
  return { childId, eliminationId, interestId, accounts };
}

/** Account-number to posted-amount totals for a set of ownership entries. */
async function ownershipEntryBalances(entryIds: string[]): Promise<{ number: string; amount: string }[]> {
  const balances = (await db.execute<{ number: string; amount: string }>(sql`
      select a.number,coalesce(sum(l.amount),0)::text amount
        from journal_lines l join journal_entries e on e.id=l.entry_id
        join accounts a on a.id=l.account_id
       where e.id=any(${`{${entryIds.join(",")}}`}::uuid[])
       group by a.number order by a.number
    `));
  return balances.rows;
}

const settleTreeUpdate = (promise: Promise<QueryResult>): Promise<TreeUpdateResult> =>
  promise.then(
    (value): TreeUpdateResult => ({ status: "fulfilled", value }),
    (reason): TreeUpdateResult => ({ status: "rejected", reason }),
  );

/** Node's assert rejects-regex matches only the top message; Drizzle wraps
 * the database error in `cause`, so tests must unwrap it before matching. */
const errorText = (error: unknown): string => {
  const cause = (error as { cause?: unknown })?.cause;
  return String(
    (cause instanceof Error ? cause.message : undefined)
      ?? (error instanceof Error ? error.message : error),
  );
};

async function openTreeTransaction(): Promise<{ client: PoolClient; pid: number }> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("select set_config('app.bypass_rls', 'on', true)");
    const backend = await client.query<{ pid: number }>("select pg_backend_pid() as pid");
    return { client, pid: Number(backend.rows[0]!.pid) };
  } catch (error) {
    client.release(error as Error);
    throw error;
  }
}

/** Observe a deterministic interleaving: the second update either finishes
 * (the vulnerable trigger) or parks behind the first transaction's tree fence. */
async function observeTreeFence(
  blockerPid: number,
  waiterPid: number,
  update: Promise<TreeUpdateResult>,
): Promise<{ blocked: boolean; result?: TreeUpdateResult }> {
  let result: TreeUpdateResult | undefined;
  void update.then((settled) => {
    result = settled;
  });
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (result) return { blocked: false, result };
    const lockState = await pool.query<{ blocked: boolean }>(
      "select $1::int = any(pg_blocking_pids($2::int)) as blocked",
      [blockerPid, waiterPid],
    );
    if (lockState.rows[0]?.blocked) return { blocked: true };
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out observing subsidiary tree fence for backend ${waiterPid}`);
}

/**
 * Hold the first reparent open while the second starts on another session.
 * The first transaction then commits, allowing the serialized second trigger
 * to recheck the now-current tree before its own commit.
 */
async function raceTreeReparents(
  orgId: string,
  first: { subsidiaryId: string; parentId: string },
  second: { subsidiaryId: string; parentId: string },
): Promise<{ blocked: boolean; second: TreeUpdateResult }> {
  const transactionA = await openTreeTransaction();
  const transactionB = await openTreeTransaction();
  let openA = true;
  let openB = true;
  try {
    await transactionA.client.query(
      "update subsidiaries set parent_id = $1 where org_id = $2 and id = $3",
      [first.parentId, orgId, first.subsidiaryId],
    );
    const secondUpdate = settleTreeUpdate(
      transactionB.client.query(
        "update subsidiaries set parent_id = $1 where org_id = $2 and id = $3",
        [second.parentId, orgId, second.subsidiaryId],
      ),
    );
    const observation = await observeTreeFence(
      transactionA.pid,
      transactionB.pid,
      secondUpdate,
    );

    await transactionA.client.query("commit");
    openA = false;
    const secondResult = observation.result ?? await secondUpdate;
    if (secondResult.status === "fulfilled") {
      await transactionB.client.query("commit");
    } else {
      await transactionB.client.query("rollback");
    }
    openB = false;
    return { blocked: observation.blocked, second: secondResult };
  } finally {
    if (openA) await transactionA.client.query("rollback").catch(() => undefined);
    if (openB) await transactionB.client.query("rollback").catch(() => undefined);
    transactionA.client.release();
    transactionB.client.release();
  }
}

function assertCycleRejected(result: TreeUpdateResult): void {
  assert.equal(result.status, "rejected", "one incompatible reparent must be rejected");
  if (result.status === "rejected") {
    assert.match(String(result.reason), /subsidiary hierarchy contains a cycle/);
  }
}

test(
  "subsidiary reparents serialize before cycle checks and preserve root invariants",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const [twoA, twoB, longA, longB, longC, validA, validB, validC, validD] =
        Array.from({ length: 9 }, () => randomUUID()) as [
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
        ];
      await db.execute(sql`
      insert into subsidiaries
        (id, org_id, parent_id, name, base_currency, country, tax_ids, is_elimination, is_active, custom)
      values
        (${twoA}, ${org.orgId}, ${org.subsidiaryId}, 'Two A', 'CAD', 'CA', '{}'::jsonb, false, true, '{}'::jsonb),
        (${twoB}, ${org.orgId}, ${org.subsidiaryId}, 'Two B', 'CAD', 'CA', '{}'::jsonb, false, true, '{}'::jsonb),
        (${longA}, ${org.orgId}, ${org.subsidiaryId}, 'Long A', 'CAD', 'CA', '{}'::jsonb, false, true, '{}'::jsonb),
        (${longB}, ${org.orgId}, ${longA}, 'Long B', 'CAD', 'CA', '{}'::jsonb, false, true, '{}'::jsonb),
        (${longC}, ${org.orgId}, ${org.subsidiaryId}, 'Long C', 'CAD', 'CA', '{}'::jsonb, false, true, '{}'::jsonb),
        (${validA}, ${org.orgId}, ${org.subsidiaryId}, 'Valid A', 'CAD', 'CA', '{}'::jsonb, false, true, '{}'::jsonb),
        (${validB}, ${org.orgId}, ${org.subsidiaryId}, 'Valid B', 'CAD', 'CA', '{}'::jsonb, false, true, '{}'::jsonb),
        (${validC}, ${org.orgId}, ${org.subsidiaryId}, 'Valid C', 'CAD', 'CA', '{}'::jsonb, false, true, '{}'::jsonb),
        (${validD}, ${org.orgId}, ${org.subsidiaryId}, 'Valid D', 'CAD', 'CA', '{}'::jsonb, false, true, '{}'::jsonb)`);

      const twoNode = await raceTreeReparents(
        org.orgId,
        { subsidiaryId: twoA, parentId: twoB },
        { subsidiaryId: twoB, parentId: twoA },
      );
      assert.equal(
        twoNode.blocked,
        true,
        "the second two-node reparent must wait for the org tree fence",
      );
      assertCycleRejected(twoNode.second);

      const longer = await raceTreeReparents(
        org.orgId,
        { subsidiaryId: longA, parentId: longC },
        { subsidiaryId: longC, parentId: longB },
      );
      assert.equal(
        longer.blocked,
        true,
        "the second longer-cycle reparent must wait for the org tree fence",
      );
      assertCycleRejected(longer.second);

      const valid = await raceTreeReparents(
        org.orgId,
        { subsidiaryId: validA, parentId: validB },
        { subsidiaryId: validC, parentId: validD },
      );
      assert.equal(valid.blocked, true, "valid same-org reparents still serialize at storage");
      assert.equal(
        valid.second.status,
        "fulfilled",
        "independent valid reparents must both commit",
      );

      const parents = await db.execute<{ id: string; parent_id: string }>(sql`
      select id::text as id, parent_id::text as parent_id
        from subsidiaries
       where org_id = ${org.orgId}
         and id in (${twoA}, ${twoB}, ${longA}, ${longC}, ${validA}, ${validC})`);
      assert.deepEqual(
        new Map(parents.rows.map((row) => [row.id, row.parent_id])),
        new Map([
          [twoA, twoB],
          [twoB, org.subsidiaryId],
          [longA, longC],
          [longC, org.subsidiaryId],
          [validA, validB],
          [validC, validD],
        ]),
      );

      await assert.rejects(
        db.execute(sql`
          update subsidiaries set parent_id = ${validB} where id = ${org.subsidiaryId}`),
        (error: unknown) => /the root subsidiary cannot be moved/.test(errorText(error)),
      );
      await assert.rejects(
        db.execute(sql`
          update subsidiaries set is_active = false where id = ${org.subsidiaryId}`),
        (error: unknown) => /the root subsidiary cannot be inactive/.test(errorText(error)),
      );
      await assert.rejects(
        db.execute(sql`delete from subsidiaries where id = ${org.subsidiaryId}`),
        (error: unknown) => /the root subsidiary cannot be deleted/.test(errorText(error)),
      );
      const root = await db.execute<{ parent_id: string | null; is_active: boolean }>(sql`
      select parent_id::text as parent_id, is_active
        from subsidiaries
       where org_id = ${org.orgId} and id = ${org.subsidiaryId}`);
      assert.deepEqual(root.rows[0], { parent_id: null, is_active: true });
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

/** Poll until some backend is waiting on an ungranted advisory lock. */
async function waitForAdvisoryWait(): Promise<boolean> {
  for (let attempt = 0; attempt < 400; attempt++) {
    const waiting = (await db.execute<{ n: number }>(sql`
      select count(*)::int as n from pg_locks where locktype = 'advisory' and not granted`));
    if ((waiting.rows[0]?.n ?? 0) > 0) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

test("foreign-currency eliminations are exact, balanced, and safely rerunnable", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = (await seedFlowActors(org.orgId)).adminId;
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

    const first = await runAutoElimination(org.orgId, org.periodId, actorId);
    assert.equal(first.lineCount, 2);
    const firstLines = (await db.execute<{ number: string; amount: string }>(sql`
      select a.number, l.amount
        from journal_lines l join accounts a on a.id = l.account_id
       where l.entry_id = ${first.entryId}
       order by a.number`));
    assert.deepEqual(firstLines.rows, [
      { number: "1100", amount: "-120.0000" },
      { number: "2000", amount: "120.0000" },
    ]);

    const second = await runAutoElimination(org.orgId, org.periodId, actorId);
    assert.equal(second.lineCount, 2);
    assert.notEqual(second.entryId, first.entryId);
    const proof = (await db.execute<{ reversals: number; effective_balance: string; ar_elimination: string; ap_elimination: string }>(sql`
      select
        count(distinct e.id) filter (where reverses_entry_id = ${first.entryId} and status = 'posted')::int as reversals,
        coalesce(sum(l.amount), 0)::text as effective_balance,
        coalesce(sum(l.amount) filter (where l.account_id = ${org.accounts.ar}), 0)::text as ar_elimination,
        coalesce(sum(l.amount) filter (where l.account_id = ${org.accounts.ap}), 0)::text as ap_elimination
      from journal_entries e
      join journal_lines l on l.entry_id = e.id
      where e.org_id = ${org.orgId} and e.subsidiary_id = ${eliminationSubsidiaryId}
        and e.status in ('posted', 'reversed') and e.origin = 'intercompany'`));
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
    await assert.rejects(
      runAutoElimination(org.orgId, org.periodId, actorId),
      /residual 0\.0001/,
    );
    const afterFailure = (await db.execute<{ n: number }>(sql`
      select count(*)::int as n from journal_entries
       where org_id = ${org.orgId} and subsidiary_id = ${eliminationSubsidiaryId}
         and origin = 'intercompany' and status in ('posted', 'reversed')`));
    assert.equal(afterFailure.rows[0]!.n, 3);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("ownership consolidation uses exact period identity and reverses reruns", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    const childId = randomUUID();
    const eliminationId = randomUUID();
    await db.execute(sql`
      insert into subsidiaries
        (id,org_id,parent_id,name,base_currency,country,tax_ids,is_elimination,is_active,custom)
      values
        (${childId},${org.orgId},${org.subsidiaryId},'Owned Co','CAD','CA','{}'::jsonb,false,true,'{}'::jsonb),
        (${eliminationId},${org.orgId},${org.subsidiaryId},'Ownership eliminations','CAD','CA','{}'::jsonb,true,true,'{}'::jsonb)
    `);
    const defs = [
      ["investment", "1400", "Investment in subsidiary", "asset_current_other"],
      ["equityIncome", "4020", "Equity income", "income_other"],
      ["nciEquity", "3100", "Non-controlling interest", "equity"],
      ["nciIncome", "6100", "Profit attributable to NCI", "expense_other"],
      ["goodwill", "1500", "Goodwill", "asset_fixed"],
      ["fairValue", "1510", "Fair value adjustment", "asset_fixed"],
      ["childEquity", "3000", "Child share capital", "equity"],
    ] as const;
    const accounts = new Map<string, string>();
    for (const [key, number, name, type] of defs) {
      const id = randomUUID();
      accounts.set(key, id);
      await db.execute(sql`
        insert into accounts
          (id,org_id,number,name,type,is_summary,is_active,eliminate,reconcilable,required_dimensions,custom,subsidiary_include_children)
        values (${id},${org.orgId},${number},${name},${type},false,true,false,false,'[]'::jsonb,'{}'::jsonb,true)
      `);
    }
    const capital = randomUUID();
    const profit = randomUUID();
    const adjustmentProfit = randomUUID();
    const calendar = (await db.execute<{ fiscal_calendar_id: string }>(sql`
      select fiscal_calendar_id
        from accounting_periods
       where id = ${org.periodId}
    `));
    const adjustmentPeriodId = randomUUID();
    await db.execute(sql`
      insert into accounting_periods
        (id, org_id, fiscal_calendar_id, fiscal_year, period_number, name,
         starts_on, ends_on, is_adjustment, custom)
      values (
        ${adjustmentPeriodId}, ${org.orgId},
        ${calendar.rows[0]!.fiscal_calendar_id},
        2026, 13, 'FY26 Adjustment', '2026-07-01', '2026-07-31', true,
        '{}'::jsonb
      )
    `);
    await db.execute(sql`
      insert into journal_entries
        (id,org_id,book_id,subsidiary_id,entry_number,posting_date,period_id,memo,status,origin)
      values
        (${capital},${org.orgId},${org.bookId},${childId},'OWN-CAP','2026-07-01',${org.periodId},'Opening equity','draft','manual'),
        (${profit},${org.orgId},${org.bookId},${childId},'OWN-PROFIT',${org.date},${org.periodId},'Period profit','draft','manual'),
        (${adjustmentProfit},${org.orgId},${org.bookId},${childId},'OWN-ADJUSTMENT',${org.date},${adjustmentPeriodId},'Adjustment-period profit','draft','manual')
    `);
    await db.execute(sql`
      insert into journal_lines
        (org_id,entry_id,line_number,account_id,subsidiary_id,amount,currency,txn_amount,fx_rate)
      values
        (${org.orgId},${capital},1,${org.accounts.bank},${childId},'1000','CAD','1000','1'),
        (${org.orgId},${capital},2,${accounts.get("childEquity")!},${childId},'-1000','CAD','-1000','1'),
        (${org.orgId},${profit},1,${org.accounts.bank},${childId},'100','CAD','100','1'),
        (${org.orgId},${profit},2,${org.accounts.revenue},${childId},'-100','CAD','-100','1'),
        (${org.orgId},${adjustmentProfit},1,${org.accounts.bank},${childId},'900','CAD','900','1'),
        (${org.orgId},${adjustmentProfit},2,${org.accounts.revenue},${childId},'-900','CAD','-900','1')
    `);
    await db.execute(sql`
      update journal_entries
         set status='posted', posted_at=now()
       where id in (${capital}, ${profit}, ${adjustmentProfit})
    `);
    const interestId = randomUUID();
    await db.execute(sql`
      insert into subsidiary_ownership_interests
        (id,org_id,parent_subsidiary_id,subsidiary_id,effective_from,ownership_percent,method,
         acquisition_date,acquisition_cost,fair_value_net_assets,acquisition_rate,nci_measurement,
         investment_account_id,equity_income_account_id,nci_equity_account_id,nci_income_account_id,
         goodwill_account_id,fair_value_adjustment_account_id)
      values (${interestId},${org.orgId},${org.subsidiaryId},${childId},'2026-07-01','80','full',
              '2026-07-01','900','1000','1','proportionate',${accounts.get("investment")!},
              ${accounts.get("equityIncome")!},${accounts.get("nciEquity")!},${accounts.get("nciIncome")!},
              ${accounts.get("goodwill")!},${accounts.get("fairValue")!})
    `);

    const first = await runOwnershipConsolidation(
      org.orgId,
      org.periodId,
      actorId,
    );
    assert.equal(first.entryIds.length, 2);
    const firstBalances = (await db.execute<{ number: string; amount: string }>(sql`
      select a.number,coalesce(sum(l.amount),0)::text amount
        from journal_lines l join journal_entries e on e.id=l.entry_id
        join accounts a on a.id=l.account_id
       where e.id=any(${`{${first.entryIds.join(",")}}`}::uuid[])
       group by a.number order by a.number
    `));
    assert.deepEqual(firstBalances.rows, [
      { number: "1400", amount: "-900.0000" },
      { number: "1500", amount: "100.0000" },
      { number: "3000", amount: "1000.0000" },
      { number: "3100", amount: "-220.0000" },
      { number: "6100", amount: "20.0000" },
    ]);
    const firstUnbalanced = (await db.execute(sql`
      select entry_id from journal_lines where entry_id=any(${`{${first.entryIds.join(",")}}`}::uuid[])
       group by entry_id having sum(amount)<>0
    `));
    assert.equal(firstUnbalanced.rows.length, 0);

    const second = await runOwnershipConsolidation(
      org.orgId,
      org.periodId,
      actorId,
    );
    assert.equal(second.entryIds.length, 4);
    const rerun = (await db.execute<{ reversals: number; replacements: number; balance: string }>(sql`
      select
        count(distinct e.id) filter (where oce.kind='reversal')::int reversals,
        count(distinct e.id) filter (where oce.kind<>'reversal')::int replacements,
        coalesce(sum(l.amount),0)::text balance
       from ownership_consolidation_entries oce
       join journal_entries e on e.id=oce.journal_entry_id
       join journal_lines l on l.entry_id=e.id
      where oce.run_id=${second.runId}
    `));
    assert.deepEqual(rerun.rows[0], { reversals: 2, replacements: 2, balance: "0.0000" });

    await assert.rejects(
      db.execute(sql`
        insert into subsidiary_ownership_interests
          (org_id,parent_subsidiary_id,subsidiary_id,effective_from,ownership_percent,method,acquisition_date,
           investment_account_id,equity_income_account_id,goodwill_account_id,fair_value_adjustment_account_id)
        values (${org.orgId},${org.subsidiaryId},${childId},'2026-07-15','100','full','2026-07-15',
                ${accounts.get("investment")!},${accounts.get("equityIncome")!},${accounts.get("goodwill")!},${accounts.get("fairValue")!})
      `),
        (error: unknown) => /overlap/.test(errorText(error)),
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("derived consolidated FX refresh is all-or-nothing and respects manual overrides", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const usdSubsidiaryId = randomUUID();
    const eurSubsidiaryId = randomUUID();
    await db.execute(sql`
      insert into subsidiaries
        (id, org_id, parent_id, name, base_currency, country, tax_ids, is_elimination, is_active, custom)
      values
        (${usdSubsidiaryId}, ${org.orgId}, ${org.subsidiaryId}, 'US Co', 'USD', 'US', '{}'::jsonb, false, true, '{}'::jsonb),
        (${eurSubsidiaryId}, ${org.orgId}, ${org.subsidiaryId}, 'Euro Co', 'EUR', 'DE', '{}'::jsonb, false, true, '{}'::jsonb)`);
    // Spot coverage for USD→CAD only, dated before the period so the average
    // falls back to the carried current rate. EUR→CAD has no spot history at
    // all — the API's wrapped derivation (web/app/api/consolidation drives
    // deriveConsolidatedRates inside withOrgTransaction) must refuse without
    // committing ANY pair, leaving no partially refreshed period behind.
    await db.execute(sql`
      insert into fx_rates (org_id, from_currency, to_currency, as_of, rate_type, rate)
      values (${org.orgId}, 'USD', 'CAD', '2026-06-20', 'spot', '0.7300000000')`);

    await assert.rejects(
      withOrgTransaction(org.orgId, () => deriveConsolidatedRates(org.orgId, org.periodId)),
      /no spot rate for EUR→CAD/,
    );
    const partial = (await db.execute<{ n: number }>(sql`
      select count(*)::int as n from consolidated_fx_rates where org_id = ${org.orgId}`));
    assert.equal(partial.rows[0]!.n, 0);

    // With every needed pair covered, the same wrapped call commits the whole
    // period at once. USD retains the prior-period control above (average
    // falls back to current), while EUR's two in-period observations exercise
    // PostgreSQL's wider-scale avg(numeric) result and prove it is normalized
    // to the persisted numeric(19,10) FX boundary.
    await db.execute(sql`
      insert into fx_rates (org_id, from_currency, to_currency, as_of, rate_type, rate)
      values
        (${org.orgId}, 'EUR', 'CAD', '2026-07-10', 'spot', '0.6400000000'),
        (${org.orgId}, 'EUR', 'CAD', '2026-07-20', 'spot', '0.6800000000')`);
    const written = await withOrgTransaction(org.orgId, () =>
      deriveConsolidatedRates(org.orgId, org.periodId),
    );
    assert.equal(written, 2);
    const expected = [
      {
        from_currency: "EUR",
        current_rate: "0.6800000000",
        average_rate: "0.6600000000",
        historical_rate: "0.6800000000",
      },
      {
        from_currency: "USD",
        current_rate: "0.7300000000",
        average_rate: "0.7300000000",
        historical_rate: "0.7300000000",
      },
    ];
    const firstPass = (await db.execute<{
      from_currency: string;
      current_rate: string;
      average_rate: string;
      historical_rate: string;
    }>(sql`
      select from_currency, current_rate, average_rate, historical_rate
        from consolidated_fx_rates
       where org_id = ${org.orgId} and period_id = ${org.periodId}
       order by from_currency`));
    assert.deepEqual(firstPass.rows, expected);

    // A newer USD spot arrives, but a controller pins USD→CAD to 'manual':
    // the rerun refreshes derived pairs only and never touches pinned rows.
    await db.execute(sql`
      insert into fx_rates (org_id, from_currency, to_currency, as_of, rate_type, rate)
      values (${org.orgId}, 'USD', 'CAD', '2026-06-28', 'spot', '0.7500000000')`);
    await db.execute(sql`
      update consolidated_fx_rates set source = 'manual'
       where org_id = ${org.orgId} and period_id = ${org.periodId} and from_currency = 'USD'`);
    const rewritten = await withOrgTransaction(org.orgId, () =>
      deriveConsolidatedRates(org.orgId, org.periodId),
    );
    assert.equal(rewritten, 2);
    const secondPass = (await db.execute<{
      from_currency: string;
      current_rate: string;
      average_rate: string;
      historical_rate: string;
    }>(sql`
      select from_currency, current_rate, average_rate, historical_rate
        from consolidated_fx_rates
       where org_id = ${org.orgId} and period_id = ${org.periodId}
       order by from_currency`));
    assert.deepEqual(secondPass.rows, expected);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("auto-elimination aggregates only the destination book's own activity", { skip: !DB }, async () => {
  // Regression (fnd_mt9f3f3d_i49xeh): with identical +100/-100 intercompany
  // activity in a primary AND a secondary book, the primary-book adjustment
  // must be -100/+100 — never -200/+200 folded in from the alternate ledger.
  const org = await createScratchOrg();
  try {
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    const eliminationSubsidiaryId = randomUUID();
    await db.execute(sql`
      insert into subsidiaries
        (id, org_id, parent_id, name, base_currency, country, tax_ids, is_elimination, is_active, custom)
      values
        (${eliminationSubsidiaryId}, ${org.orgId}, ${org.subsidiaryId}, 'Eliminations', 'CAD', 'CA', '{}'::jsonb, true, true, '{}'::jsonb)`);
    await db.execute(sql`
      update accounts set eliminate = true
       where id in (${org.accounts.ar}, ${org.accounts.ap})`);

    const secondaryBookId = randomUUID();
    await db.execute(sql`
      insert into accounting_books (id, org_id, code, name, is_primary, is_active, posts_gl)
      values (${secondaryBookId}, ${org.orgId}, 'SEC', 'Secondary statutory', false, true, true)`);

    const postPair = async (bookId: string, tag: string) => {
      const entry = randomUUID();
      await db.execute(sql`
        insert into journal_entries
          (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, memo, status, origin)
        values (${entry}, ${org.orgId}, ${bookId}, ${org.subsidiaryId}, ${tag}, ${org.date}, ${org.periodId}, ${tag}, 'draft', 'manual')`);
      await db.execute(sql`
        insert into journal_lines
          (org_id, entry_id, line_number, account_id, subsidiary_id, amount, currency, txn_amount, fx_rate)
        values
          (${org.orgId}, ${entry}, 1, ${org.accounts.ar}, ${org.subsidiaryId}, '100.0000', 'CAD', '100.0000', '1'),
          (${org.orgId}, ${entry}, 2, ${org.accounts.ap}, ${org.subsidiaryId}, '-100.0000', 'CAD', '-100.0000', '1')`);
      await db.execute(sql`update journal_entries set status = 'posted', posted_at = now() where id = ${entry}`);
    };
    await postPair(org.bookId, "IC-PRI");
    await postPair(secondaryBookId, "IC-SEC");

    const result = await runAutoElimination(org.orgId, org.periodId, actorId);
    assert.equal(result.lineCount, 2);
    const entry = (await db.execute<{ book_id: string }>(sql`
      select book_id from journal_entries where id = ${result.entryId}`));
    assert.equal(entry.rows[0]!.book_id, org.bookId, "the elimination lands in the primary book");
    const lines = (await db.execute<{ number: string; amount: string }>(sql`
      select a.number, l.amount::text as amount
        from journal_lines l join accounts a on a.id = l.account_id
       where l.entry_id = ${result.entryId}
       order by a.number`));
    assert.deepEqual(lines.rows, [
      { number: "1100", amount: "-100.0000" },
      { number: "2000", amount: "100.0000" },
    ]);
    const secondaryEliminations = (await db.execute<{ n: number }>(sql`
      select count(*)::int as n from journal_entries
       where org_id = ${org.orgId} and book_id = ${secondaryBookId} and origin = 'intercompany'`));
    assert.equal(secondaryEliminations.rows[0]!.n, 0, "the secondary book keeps its own ledger");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("ownership consolidation reads activity and acquisition equity from the primary book only", { skip: !DB }, async () => {
  // Regression (fnd_mt9f3f3d_i49xeh): profit (+100 vs +900) and acquisition-
  // date equity (-1000 vs -4000) exist in BOTH books; every adjustment must
  // derive from the primary book alone.
  const org = await createScratchOrg();
  try {
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    const childId = randomUUID();
    const eliminationId = randomUUID();
    await db.execute(sql`
      insert into subsidiaries
        (id,org_id,parent_id,name,base_currency,country,tax_ids,is_elimination,is_active,custom)
      values
        (${childId},${org.orgId},${org.subsidiaryId},'Owned Co','CAD','CA','{}'::jsonb,false,true,'{}'::jsonb),
        (${eliminationId},${org.orgId},${org.subsidiaryId},'Ownership eliminations','CAD','CA','{}'::jsonb,true,true,'{}'::jsonb)
    `);
    const secondaryBookId = randomUUID();
    await db.execute(sql`
      insert into accounting_books (id, org_id, code, name, is_primary, is_active, posts_gl)
      values (${secondaryBookId}, ${org.orgId}, 'SEC', 'Secondary statutory', false, true, true)`);
    const defs = [
      ["investment", "1400", "Investment in subsidiary", "asset_current_other"],
      ["equityIncome", "4020", "Equity income", "income_other"],
      ["nciEquity", "3100", "Non-controlling interest", "equity"],
      ["nciIncome", "6100", "Profit attributable to NCI", "expense_other"],
      ["goodwill", "1500", "Goodwill", "asset_fixed"],
      ["fairValue", "1510", "Fair value adjustment", "asset_fixed"],
      ["childEquity", "3000", "Child share capital", "equity"],
    ] as const;
    const accounts = new Map<string, string>();
    for (const [key, number, name, type] of defs) {
      const id = randomUUID();
      accounts.set(key, id);
      await db.execute(sql`
        insert into accounts
          (id,org_id,number,name,type,is_summary,is_active,eliminate,reconcilable,required_dimensions,custom,subsidiary_include_children)
        values (${id},${org.orgId},${number},${name},${type},false,true,false,false,'[]'::jsonb,'{}'::jsonb,true)
      `);
    }
    const postEntry = async (bookId: string, tag: string, debitAccount: string, creditAccount: string, amount: string, postingDate?: string) => {
      const entry = randomUUID();
      await db.execute(sql`
        insert into journal_entries
          (id,org_id,book_id,subsidiary_id,entry_number,posting_date,period_id,memo,status,origin)
        values (${entry},${org.orgId},${bookId},${childId},${tag},${postingDate ?? org.date},${org.periodId},${tag},'draft','manual')`);
      await db.execute(sql`
        insert into journal_lines
          (org_id,entry_id,line_number,account_id,subsidiary_id,amount,currency,txn_amount,fx_rate)
        values
          (${org.orgId},${entry},1,${debitAccount},${childId},${amount},'CAD',${amount},'1'),
          (${org.orgId},${entry},2,${creditAccount},${childId},${"-" + amount},'CAD',${"-" + amount},'1')`);
      await db.execute(sql`update journal_entries set status='posted', posted_at=now() where id=${entry}`);
    };
    // Primary book: opening equity 1000 and period profit 100.
    await postEntry(org.bookId, "OWN-CAP", org.accounts.bank, accounts.get("childEquity")!, "1000", "2026-07-01");
    await postEntry(org.bookId, "OWN-PROFIT", org.accounts.bank, org.accounts.revenue, "100");
    // Secondary statutory book: its own equity 4000 and profit 900.
    await postEntry(secondaryBookId, "OWN-CAP-SEC", org.accounts.bank, accounts.get("childEquity")!, "4000", "2026-07-01");
    await postEntry(secondaryBookId, "OWN-PROFIT-SEC", org.accounts.bank, org.accounts.revenue, "900");

    const interestId = randomUUID();
    await db.execute(sql`
      insert into subsidiary_ownership_interests
        (id,org_id,parent_subsidiary_id,subsidiary_id,effective_from,ownership_percent,method,
         acquisition_date,acquisition_cost,fair_value_net_assets,acquisition_rate,nci_measurement,
         investment_account_id,equity_income_account_id,nci_equity_account_id,nci_income_account_id,
         goodwill_account_id,fair_value_adjustment_account_id)
      values (${interestId},${org.orgId},${org.subsidiaryId},${childId},'2026-07-01','80','full',
              '2026-07-01','900','1000','1','proportionate',${accounts.get("investment")!},
              ${accounts.get("equityIncome")!},${accounts.get("nciEquity")!},${accounts.get("nciIncome")!},
              ${accounts.get("goodwill")!},${accounts.get("fairValue")!})
    `);

    const run = await runOwnershipConsolidation(org.orgId, org.periodId, actorId);
    assert.equal(run.entryIds.length, 2);
    const books = (await db.execute<{ book_id: string }>(sql`
      select distinct book_id from journal_entries where id = any(${`{${run.entryIds.join(",")}}`}::uuid[])`));
    assert.deepEqual(books.rows, [{ book_id: org.bookId }], "every adjustment lands in the primary book");
    const balances = (await db.execute<{ number: string; amount: string }>(sql`
      select a.number,coalesce(sum(l.amount),0)::text amount
        from journal_lines l join journal_entries e on e.id=l.entry_id
        join accounts a on a.id=l.account_id
       where e.id=any(${`{${run.entryIds.join(",")}}`}::uuid[])
       group by a.number order by a.number
    `));
    assert.deepEqual(balances.rows, [
      { number: "1400", amount: "-900.0000" },
      { number: "1500", amount: "100.0000" },
      { number: "3000", amount: "1000.0000" },
      { number: "3100", amount: "-220.0000" },
      { number: "6100", amount: "20.0000" },
    ]);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("a source posting committing mid-run stays out of the generation and is absorbed on retry", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  let clientB: import("pg").PoolClient | undefined;
  try {
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    const eliminationSubsidiaryId = randomUUID();
    await db.execute(sql`
      insert into subsidiaries
        (id, org_id, parent_id, name, base_currency, country, tax_ids, is_elimination, is_active, custom)
      values
        (${eliminationSubsidiaryId}, ${org.orgId}, ${org.subsidiaryId}, 'Eliminations', 'CAD', 'CA', '{}'::jsonb, true, true, '{}'::jsonb)`);
    await db.execute(sql`
      update accounts set eliminate = true
       where id in (${org.accounts.ar}, ${org.accounts.ap})`);
    const pair = async (client: { query: (text: string, values?: unknown[]) => Promise<unknown> }, tag: string, ar: string) => {
      const entry = randomUUID();
      await client.query(
        `insert into journal_entries (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, memo, status, origin)
         values ($1,$2,$3,$4,$5,$6,$7,$8,'draft','manual')`,
        [entry, org.orgId, org.bookId, org.subsidiaryId, tag, org.date, org.periodId, tag],
      );
      await client.query(
        `insert into journal_lines (org_id, entry_id, line_number, account_id, subsidiary_id, amount, currency, txn_amount, fx_rate)
         values ($1,$2,1,$3,$4,$5,'CAD',$5,'1'), ($1,$2,2,$6,$4,$7,'CAD',$7,'1')`,
        [org.orgId, entry, org.accounts.ar, org.subsidiaryId, ar, org.accounts.ap, `-${ar}`],
      );
      await client.query(`update journal_entries set status='posted', posted_at=now() where id=$1`, [entry]);
      return entry;
    };
    await pair(pool, "IC-A", "100.0000");

    // Park the run on its very first statement: client B holds the session-
    // level twin of the run's xact lock, so the REPEATABLE READ snapshot is
    // pinned before any deciding read happens.
    const lockKey = `elimination:${org.orgId}:${org.periodId}`;
    clientB = await pool.connect();
    await clientB.query(`select pg_advisory_lock(hashtextextended($1, 0))`, [lockKey]);
    const runP = runAutoElimination(org.orgId, org.periodId, actorId);
    assert.ok(
      await waitForAdvisoryWait(),
      "the elimination run must park on its advisory lock before reading activity",
    );

    // A source posting COMMITS while the run sits blocked behind the lock.
    await pair(clientB, "IC-LATE", "50.0000");
    await clientB.query(`select pg_advisory_unlock(hashtextextended($1, 0))`, [lockKey]);

    const first = await runP;
    assert.equal(first.lineCount, 2);
    const firstLines = (await db.execute<{ number: string; amount: string }>(sql`
      select a.number, l.amount::text as amount
        from journal_lines l join accounts a on a.id = l.account_id
       where l.entry_id = ${first.entryId}
       order by a.number`));
    assert.deepEqual(firstLines.rows, [
      { number: "1100", amount: "-100.0000" },
      { number: "2000", amount: "100.0000" },
    ], "the mid-run commit is excluded wholesale from this generation");

    // Invalidate-and-retry: the replacement reverses the stale generation once
    // and absorbs the concurrent posting completely.
    const second = await runAutoElimination(org.orgId, org.periodId, actorId);
    const retryTotals = (await db.execute<{ number: string; total: string }>(sql`
      select a.number, sum(l.amount)::text as total
        from journal_lines l
        join journal_entries e on e.id = l.entry_id
        join accounts a on a.id = l.account_id
       where e.id = ${second.entryId}
       group by a.number order by a.number`));
    assert.deepEqual(retryTotals.rows, [
      { number: "1100", total: "-150.0000" },
      { number: "2000", total: "150.0000" },
    ]);
    const reversals = (await db.execute<{ n: number }>(sql`
      select count(*)::int as n from journal_entries
       where reverses_entry_id = ${first.entryId} and status = 'posted'`));
    assert.equal(reversals.rows[0]!.n, 1, "the stale generation is reversed exactly once");
  } finally {
    if (clientB) {
      await clientB
        .query(`select pg_advisory_unlock(hashtextextended($1, 0))`, [`elimination:${org.orgId}:${org.periodId}`])
        .catch(() => undefined);
      clientB.release();
    }
    await dropScratchOrg(org.orgId);
  }
});

test("a fault after the prior reversal rolls back entries and evidence together", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    const eliminationSubsidiaryId = randomUUID();
    await db.execute(sql`
      insert into subsidiaries
        (id, org_id, parent_id, name, base_currency, country, tax_ids, is_elimination, is_active, custom)
      values
        (${eliminationSubsidiaryId}, ${org.orgId}, ${org.subsidiaryId}, 'Eliminations', 'CAD', 'CA', '{}'::jsonb, true, true, '{}'::jsonb)`);
    await db.execute(sql`
      update accounts set eliminate = true
       where id in (${org.accounts.ar}, ${org.accounts.ap})`);
    const postPair = async (tag: string) => {
      const entry = randomUUID();
      await db.execute(sql`
        insert into journal_entries
          (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, memo, status, origin)
        values (${entry}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId}, ${tag}, ${org.date}, ${org.periodId}, ${tag}, 'draft', 'manual')`);
      await db.execute(sql`
        insert into journal_lines
          (org_id, entry_id, line_number, account_id, subsidiary_id, amount, currency, txn_amount, fx_rate)
        values
          (${org.orgId}, ${entry}, 1, ${org.accounts.ar}, ${org.subsidiaryId}, '100.0000', 'CAD', '100.0000', '1'),
          (${org.orgId}, ${entry}, 2, ${org.accounts.ap}, ${org.subsidiaryId}, '-100.0000', 'CAD', '-100.0000', '1')`);
      await db.execute(sql`update journal_entries set status='posted', posted_at=now() where id=${entry}`);
    };
    await postPair("IC-A");
    const first = await runAutoElimination(org.orgId, org.periodId, actorId);
    assert.ok(first.entryId);

    // Fault injection during replacement: occupy the exact entry number the
    // next generation will take (a manual-origin row the engine's counters
    // ignore) so the replacement INSERT hits journal_entries_org_number AFTER
    // the prior reversal has already executed inside the transaction.
    const blocker = randomUUID();
    await db.execute(sql`
      insert into journal_entries
        (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, memo, status, origin)
      values (${blocker}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId}, 'ELIM-2026-07-2', ${org.date}, ${org.periodId}, 'number collision fault', 'draft', 'manual')`);

    await assert.rejects(
      runAutoElimination(org.orgId, org.periodId, actorId),
        (error: unknown) => /journal_entries_org_number/.test(errorText(error)),
    );

    const gen1 = (await db.execute<{ status: string }>(sql`
      select status from journal_entries where id = ${first.entryId}`));
    assert.equal(gen1.rows[0]!.status, "posted", "the prior generation was never marked reversed");
    const strayReversals = (await db.execute<{ n: number }>(sql`
      select count(*)::int as n from journal_entries where reverses_entry_id = ${first.entryId}`));
    assert.equal(strayReversals.rows[0]!.n, 0, "no half-applied reversal survived the fault");
    const elimEntries = (await db.execute<{ n: number }>(sql`
      select count(*)::int as n from journal_entries
       where org_id = ${org.orgId} and subsidiary_id = ${eliminationSubsidiaryId}
         and origin = 'intercompany' and status in ('posted', 'reversed')`));
    assert.equal(elimEntries.rows[0]!.n, 1, "the failed run left exactly the pre-fault evidence");
    const auditRows = (await db.execute<{ n: number }>(sql`
      select count(*)::int as n from audit_log
       where org_id = ${org.orgId} and request_id = 'auto_elimination'`));
    assert.equal(auditRows.rows[0]!.n, 1, "audit evidence matches the committed generations only");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("an ownership fault after the prior reversal rolls back entries, run status, and evidence together", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    const childId = randomUUID();
    const eliminationId = randomUUID();
    await db.execute(sql`
      insert into subsidiaries
        (id,org_id,parent_id,name,base_currency,country,tax_ids,is_elimination,is_active,custom)
      values
        (${childId},${org.orgId},${org.subsidiaryId},'Owned Co','CAD','CA','{}'::jsonb,false,true,'{}'::jsonb),
        (${eliminationId},${org.orgId},${org.subsidiaryId},'Ownership eliminations','CAD','CA','{}'::jsonb,true,true,'{}'::jsonb)
    `);
    const defs = [
      ["investment", "1400", "Investment in subsidiary", "asset_current_other"],
      ["equityIncome", "4020", "Equity income", "income_other"],
      ["nciEquity", "3100", "Non-controlling interest", "equity"],
      ["nciIncome", "6100", "Profit attributable to NCI", "expense_other"],
      ["goodwill", "1500", "Goodwill", "asset_fixed"],
      ["fairValue", "1510", "Fair value adjustment", "asset_fixed"],
      ["childEquity", "3000", "Child share capital", "equity"],
    ] as const;
    const accounts = new Map<string, string>();
    for (const [key, number, name, type] of defs) {
      const id = randomUUID();
      accounts.set(key, id);
      await db.execute(sql`
        insert into accounts
          (id,org_id,number,name,type,is_summary,is_active,eliminate,reconcilable,required_dimensions,custom,subsidiary_include_children)
        values (${id},${org.orgId},${number},${name},${type},false,true,false,false,'[]'::jsonb,'{}'::jsonb,true)
      `);
    }
    const capital = randomUUID();
    const profit = randomUUID();
    await db.execute(sql`
      insert into journal_entries
        (id,org_id,book_id,subsidiary_id,entry_number,posting_date,period_id,memo,status,origin)
      values
        (${capital},${org.orgId},${org.bookId},${childId},'OWN-CAP','2026-07-01',${org.periodId},'Opening equity','draft','manual'),
        (${profit},${org.orgId},${org.bookId},${childId},'OWN-PROFIT',${org.date},${org.periodId},'Period profit','draft','manual')
    `);
    await db.execute(sql`
      insert into journal_lines
        (org_id,entry_id,line_number,account_id,subsidiary_id,amount,currency,txn_amount,fx_rate)
      values
        (${org.orgId},${capital},1,${org.accounts.bank},${childId},'1000','CAD','1000','1'),
        (${org.orgId},${capital},2,${accounts.get("childEquity")!},${childId},'-1000','CAD','-1000','1'),
        (${org.orgId},${profit},1,${org.accounts.bank},${childId},'100','CAD','100','1'),
        (${org.orgId},${profit},2,${org.accounts.revenue},${childId},'-100','CAD','-100','1')
    `);
    await db.execute(sql`
      update journal_entries set status='posted', posted_at=now()
       where id in (${capital}, ${profit})
    `);
    const interestId = randomUUID();
    await db.execute(sql`
      insert into subsidiary_ownership_interests
        (id,org_id,parent_subsidiary_id,subsidiary_id,effective_from,ownership_percent,method,
         acquisition_date,acquisition_cost,fair_value_net_assets,acquisition_rate,nci_measurement,
         investment_account_id,equity_income_account_id,nci_equity_account_id,nci_income_account_id,
         goodwill_account_id,fair_value_adjustment_account_id)
      values (${interestId},${org.orgId},${org.subsidiaryId},${childId},'2026-07-01','80','full',
              '2026-07-01','900','1000','1','proportionate',${accounts.get("investment")!},
              ${accounts.get("equityIncome")!},${accounts.get("nciEquity")!},${accounts.get("nciIncome")!},
              ${accounts.get("goodwill")!},${accounts.get("fairValue")!})
    `);
    const first = await runOwnershipConsolidation(org.orgId, org.periodId, actorId);
    assert.equal(first.entryIds.length, 2);

    // Fault injector: armed between runs, it aborts the FIRST replacement
    // post — reversal posts carry the 'Ownership consolidation reversal'
    // memo and pass untouched — i.e. strictly after every prior reversal has
    // executed inside the run's transaction.
    await db.execute(sql`
      create or replace function consol_slice_fault_injector() returns trigger language plpgsql as $fn$
      begin
        if coalesce(current_setting('openbooks.consol_slice_fault', true), 'off') = 'on'
           and new.memo like 'Ownership consolidation %'
           and new.memo <> 'Ownership consolidation reversal' then
          raise exception 'injected consolidation fault during replacement';
        end if;
        return new;
      end $fn$`);
    await db.execute(sql`
      create trigger consolidation_slice_fault
        before insert on journal_entries
        for each row execute function consol_slice_fault_injector()`);
    try {
      await db.execute(sql`select set_config('openbooks.consol_slice_fault', 'on', false)`);
      await assert.rejects(
        runOwnershipConsolidation(org.orgId, org.periodId, actorId),
        (error: unknown) => /injected consolidation fault during replacement/.test(errorText(error)),
      );
    } finally {
      await db.execute(sql`select set_config('openbooks.consol_slice_fault', 'off', false)`);
      await db.execute(sql`drop trigger if exists consolidation_slice_fault on journal_entries`);
      await db.execute(sql`drop function if exists consol_slice_fault_injector()`);
    }

    const runs = (await db.execute<{ status: string; error: string | null }>(sql`
      select status, error from ownership_consolidation_runs
       where org_id = ${org.orgId} and period_id = ${org.periodId}
       order by started_at, id`));
    assert.equal(runs.rows.length, 2);
    assert.deepEqual(runs.rows[0], { status: "posted", error: null });
    assert.equal(runs.rows[1]!.status, "failed", "the aborted attempt lands terminal-failed");
    assert.ok(runs.rows[1]!.error, "the failed run records its error — never stuck 'running'");
    const evidence = (await db.execute<{ kind: string; run_id: string }>(sql`
      select kind, run_id from ownership_consolidation_entries where org_id = ${org.orgId} order by kind`));
    assert.deepEqual(evidence.rows, [
      { kind: "acquisition", run_id: first.runId },
      { kind: "nci_income", run_id: first.runId },
    ], "evidence carries the committed generation only");
    const priorStatus = (await db.execute<{ n: number }>(sql`
      select count(*)::int as n from journal_entries
       where id = any(${`{${first.entryIds.join(",")}}`}::uuid[]) and status = 'posted'`));
    assert.equal(priorStatus.rows[0]!.n, 2, "prior entries were never marked reversed");
    const strayReversals = (await db.execute<{ n: number }>(sql`
      select count(*)::int as n from journal_entries where reverses_entry_id = any(${`{${first.entryIds.join(",")}}`}::uuid[])`));
    assert.equal(strayReversals.rows[0]!.n, 0, "no half-applied reversal survived the fault");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("a first-use policy edit inside the consolidation window waits and is rejected as used", { skip: !DB }, async () => {
  // Regression (fnd_mt97klqv_y5e7a4): the run reads the effective policy,
  // computes, and inserts its first ownership_consolidation_entries later,
  // while ownership_interest_guard freezes a policy row only once COMMITTED
  // evidence exists. A material edit committing inside that window used to
  // pass the guard's EXISTS check (the run's evidence was still
  // uncommitted) and left posted journals calculated from the old terms
  // beside a live policy recording new terms. The run now holds a FOR SHARE
  // row lock on every policy row it consumes from the read until commit, so
  // the edit waits for the run and then faces the immutability check against
  // the now-committed evidence.
  const org = await createScratchOrg();
  const park = await openTreeTransaction();
  const editor = await openTreeTransaction();
  let runP: Promise<{ runId: string; entryIds: string[] }> | undefined;
  try {
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    const { interestId, accounts } = await seedOwnershipConsolidationFixture(org);

    // Park the run AFTER its policy read but BEFORE its first evidence
    // insert: every ownership journal line references one of these accounts,
    // and the journal-line account guard takes FOR SHARE on the account row,
    // which waits for this transaction's FOR UPDATE.
    const accountIds = [...accounts.values()];
    await park.client.query(
      "select id from accounts where id = any($1::uuid[]) for update",
      [accountIds],
    );
    runP = runOwnershipConsolidation(org.orgId, org.periodId, actorId);
    void runP.catch(() => undefined);
    const runPid = await waitForBlockedBy(
      park.pid,
      "ownership run parked between its policy read and first evidence insert",
    );

    // Material policy edit from a second live session, strictly before any
    // evidence is committed: it must wait on the run's policy row lock.
    const edit = settleTreeUpdate(
      editor.client.query(
        "update subsidiary_ownership_interests set ownership_percent = '60' where id = $1",
        [interestId],
      ),
    );
    const observation = await observeTreeFence(runPid, editor.pid, edit);
    assert.equal(
      observation.blocked,
      true,
      "the material policy edit must wait on the consolidation's policy row lock",
    );

    // Release the park: the run posts its first generation from the pinned
    // 80% terms and commits. The editor then wakes and its guard re-check
    // must reject the edit against the committed evidence.
    await park.client.query("rollback");
    const run = await runP;
    assert.equal(run.entryIds.length, 2);
    const editOutcome = await edit;
    assert.equal(
      editOutcome.status,
      "rejected",
      "the used-policy immutability check must reject the edit after the run commits",
    );
    if (editOutcome.status === "rejected") {
      assert.match(String(editOutcome.reason), /used ownership policy is immutable/);
    }
    await editor.client.query("rollback").catch(() => undefined);

    assert.deepEqual(await ownershipEntryBalances(run.entryIds), [
      { number: "1400", amount: "-900.0000" },
      { number: "1500", amount: "100.0000" },
      { number: "3000", amount: "1000.0000" },
      { number: "3100", amount: "-220.0000" },
      { number: "6100", amount: "20.0000" },
    ], "the committed generation was calculated from the pinned 80% terms");
    const live = (await db.execute<{ ownership_percent: string }>(sql`
      select ownership_percent::text from subsidiary_ownership_interests where id = ${interestId}`));
    assert.equal(
      live.rows[0]!.ownership_percent,
      "80.0000000000",
      "the live policy still records the terms the evidence was calculated from",
    );

    // Once first evidence exists, every material mutation is rejected at the
    // storage level; only tuple-preserving rewrites pass.
    await assert.rejects(
      db.execute(sql`
        update subsidiary_ownership_interests set ownership_percent = '60' where id = ${interestId}`),
        (error: unknown) => /used ownership policy is immutable/.test(errorText(error)),
    );
    await db.execute(sql`
      update subsidiary_ownership_interests set ownership_percent = ownership_percent where id = ${interestId}`);
  } finally {
    await park.client.query("rollback").catch(() => undefined);
    if (runP) await runP.catch(() => undefined);
    await editor.client.query("rollback").catch(() => undefined);
    park.client.release();
    editor.client.release();
    await dropScratchOrg(org.orgId);
  }
});

test("a policy edit committing before the run's snapshot fails the run closed and the retry adopts the new terms", { skip: !DB }, async () => {
  // Regression (fnd_mt97klqv_y5e7a4), the other interleaving: the material
  // edit commits while the run is still parked ahead of its first statement,
  // so the pinned REPEATABLE READ snapshot predates the new policy terms.
  // The locking policy read must refuse to compute a generation from a row
  // that changed underneath it — serialization failure, run recorded failed,
  // zero evidence — and the retry must consolidate the committed new terms.
  const org = await createScratchOrg();
  let holder: import("pg").PoolClient | undefined;
  try {
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    const { interestId } = await seedOwnershipConsolidationFixture(org);

    const lockKey = `ownership:${org.orgId}:${org.periodId}`;
    holder = await pool.connect();
    await holder.query(`select pg_advisory_lock(hashtextextended($1, 0))`, [lockKey]);
    const runP = runOwnershipConsolidation(org.orgId, org.periodId, actorId);
    assert.ok(
      await waitForAdvisoryWait(),
      "the run must park on its advisory lock before reading the policy",
    );

    // The material edit lands and commits before the run reads anything.
    await db.execute(sql`
      update subsidiary_ownership_interests set ownership_percent = '60' where id = ${interestId}`);
    await holder.query(`select pg_advisory_unlock(hashtextextended($1, 0))`, [lockKey]);

    await assert.rejects(
      runP,
        (error: unknown) => /could not serialize access/.test(errorText(error)),
      "a run whose pinned policy row changed underneath it must fail closed",
    );
    const failedRuns = (await db.execute<{ n: number }>(sql`
      select count(*)::int as n from ownership_consolidation_runs
       where org_id = ${org.orgId} and status = 'failed'`));
    assert.equal(failedRuns.rows[0]!.n, 1, "the aborted attempt is recorded terminal-failed");
    const evidence = (await db.execute<{ n: number }>(sql`
      select count(*)::int as n from ownership_consolidation_entries where org_id = ${org.orgId}`));
    assert.equal(evidence.rows[0]!.n, 0, "no evidence survives the aborted run");
    const strayJournals = (await db.execute<{ n: number }>(sql`
      select count(*)::int as n from journal_entries
       where org_id = ${org.orgId} and origin = 'translation'`));
    assert.equal(strayJournals.rows[0]!.n, 0, "no half-posted ownership journals survive the aborted run");

    // The retry consolidates the committed 60% generation.
    const retry = await runOwnershipConsolidation(org.orgId, org.periodId, actorId);
    assert.equal(retry.entryIds.length, 2);
    assert.deepEqual(await ownershipEntryBalances(retry.entryIds), [
      { number: "1400", amount: "-900.0000" },
      { number: "1500", amount: "300.0000" },
      { number: "3000", amount: "1000.0000" },
      { number: "3100", amount: "-440.0000" },
      { number: "6100", amount: "40.0000" },
    ], "the retry adopts the committed 60% terms");
    const live = (await db.execute<{ ownership_percent: string }>(sql`
      select ownership_percent::text from subsidiary_ownership_interests where id = ${interestId}`));
    assert.equal(live.rows[0]!.ownership_percent, "60.0000000000");
  } finally {
    if (holder) {
      await holder
        .query(`select pg_advisory_unlock(hashtextextended($1, 0))`, [`ownership:${org.orgId}:${org.periodId}`])
        .catch(() => undefined);
      holder.release();
    }
    await dropScratchOrg(org.orgId);
  }
});

