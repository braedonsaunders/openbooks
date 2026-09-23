import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import {
  createScratchOrg,
  dropScratchOrg,
  seedFlowActors,
} from "../testing/fixtures.ts";
import type {
  MigrationSource,
  SourceOpeningBalance,
  SourceTrialBalanceRow,
} from "./source.ts";
import { verifyCurrentLedgerState } from "./sync.ts";
import { trueUpResidualGl } from "./trueup.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

test(
  "an old carried balance with no in-range activity produces an opening journal and parity reconciles",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    try {
      await db.execute(sql`
        update accounts
           set custom = jsonb_set(custom, '{parityRef}', '"A"'::jsonb)
         where org_id = ${org.orgId} and id = ${org.accounts.adjustment}
      `);
      await db.execute(sql`
        update accounts
           set custom = jsonb_set(custom, '{parityRef}', '"B"'::jsonb)
         where org_id = ${org.orgId} and id = ${org.accounts.clearing}
      `);

      // $100 cash carried since 2020, no activity after the history start:
      // the cumulative trial balance sees it but no month row ever will.
      const openingDate = org.date;
      const opening: SourceOpeningBalance[] = [
        { accountRef: "A", openingDate, amount: "100.0000" },
        { accountRef: "B", openingDate, amount: "-100.0000" },
      ];
      const source = {
        name: "opening-source",
        refKey: "parityRef",
        baseCurrency: "CAD",
        trialBalance: async (): Promise<SourceTrialBalanceRow[]> => [
          { accountRef: "A", balance: "100.0000" },
          { accountRef: "B", balance: "-100.0000" },
        ],
        monthlyActivity: async () => [],
        openingBalances: async () => opening,
      } as unknown as MigrationSource;
      const control = { actorId, syncRunId: "opening-test-run" };

      const first = await trueUpResidualGl(org.orgId, source, control);
      assert.deepEqual(
        { entries: first.entries, lines: first.lines },
        { entries: 1, lines: 2 },
      );

      const journals = (await db.execute<{
        entryNumber: string;
        postingDate: string;
        memo: string;
        status: string;
      }>(sql`
        select entry_number as "entryNumber", posting_date::text as "postingDate",
               memo, status
          from journal_entries
         where org_id = ${org.orgId} and memo like 'Migration opening balance%'
      `));
      assert.equal(journals.rows.length, 1);
      assert.equal(journals.rows[0]?.postingDate, openingDate);
      assert.equal(journals.rows[0]?.status, "posted");
      assert.match(journals.rows[0]?.entryNumber ?? "", /^OPENING-/);

      // The lines tie to the opening trial balance exactly.
      const lines = (await db.execute<{ ref: string; amount: string }>(sql`
        select a.custom->>'parityRef' as ref, sum(l.amount)::text as amount
          from journal_lines l
          join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id
          join accounts a on a.id = l.account_id and a.org_id = l.org_id
         where l.org_id = ${org.orgId} and e.memo like 'Migration opening balance%'
         group by 1 order by 1
      `));
      assert.deepEqual(lines.rows, [
        { ref: "A", amount: "100.0000" },
        { ref: "B", amount: "-100.0000" },
      ]);

      // A re-sync is idempotent: the posted opening journal ties, so nothing
      // new is posted.
      const retry = await trueUpResidualGl(org.orgId, source, control);
      assert.deepEqual(retry, { entries: 0, lines: 0, byAccount: [] });

      // Parity reconciles: the trial balance matches and no period complains
      // about the opening journal's month.
      const verification = await verifyCurrentLedgerState(source, org.orgId);
      assert.deepEqual(verification.tb.mismatches, []);
      assert.equal(verification.tb.matches, 2);
      assert.deepEqual(verification.periods.mismatches, []);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);
