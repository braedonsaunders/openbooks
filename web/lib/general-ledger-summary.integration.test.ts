import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypassContext, withOrgContext } from "@openbooks/engine/platform/db";
import { createScratchOrg, dropScratchOrg } from "@openbooks/engine/testing/fixtures";
import { glActivityBuckets } from "./gl-summary";
import { generalLedger } from "./reports/ledger-reports";

test(
  "ledger activity buckets preserve partial-month boundaries and statutory journal origins",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const org = await withBypassContext(() => createScratchOrg());
    try {
      const post = async (
        date: string,
        amount: string,
        tag: string,
        origin = "manual",
        isPosted = true,
      ) => {
        const entryId = randomUUID();
        const entry = await db.execute(
          sql`
        insert into journal_entries
          (id, org_id, book_id, subsidiary_id, entry_number, posting_date,
           period_id, memo, status, origin)
        values
          (${entryId}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId},
           ${`SPLIT-BOUNDARY-${tag}`}, ${date}, ${org.periodId}, ${tag}, 'draft', ${origin}) returning id`,
          "objects",
        );
        assert.equal(entry.length, 1);
        const lines = await db.execute(
          sql`
        insert into journal_lines
          (org_id, entry_id, line_number, account_id, subsidiary_id,
           amount, currency, txn_amount, fx_rate)
        values
          (${org.orgId}, ${entryId}, 1, ${org.accounts.bank}, ${org.subsidiaryId},
           ${amount}, 'CAD', ${amount}, '1'),
          (${org.orgId}, ${entryId}, 2, ${org.accounts.revenue}, ${org.subsidiaryId},
           ${`-${amount}`}, 'CAD', ${`-${amount}`}, '1') returning id`,
          "objects",
        );
        assert.equal(lines.length, 2);
        if (isPosted) {
          const posted = await db.execute(
            sql`
          update journal_entries set status = 'posted', posted_at = now()
           where id = ${entryId} and org_id = ${org.orgId} returning id`,
            "objects",
          );
          assert.equal(posted.length, 1);
        }
      };

      await withBypassContext(async () => {
        await post("2026-07-05", "100.0000", "inside");
        await post("2026-07-20", "50.0000", "outside");
        await post("2026-07-07", "10.0000", "close", "closing");
        await post("2026-07-08", "5.0000", "open", "opening");
        await post("2026-07-09", "999.0000", "draft", "manual", false);
      });

      await withOrgContext(org.orgId, async () => {
        const buckets = glActivityBuckets(org.orgId, {
          minDate: "2026-07-01",
          maxDate: "2026-07-10",
          boundaries: [],
          bookId: org.bookId,
        });
        const result = await db.execute<{ amount: string }>(
          sql`
        select coalesce(sum(b.amount), 0)::text as amount
          from ${buckets} b
         where b.account_id = ${org.accounts.revenue}
           and b.subsidiary_id = ${org.subsidiaryId}`,
          "objects",
        );
        assert.equal(result[0]?.amount, "-100.0000");
        for (const [from, to, statementAmount, ledgerAmount] of [
          ["2026-07-01", "2026-07-10", "-100.0000", "-115.0000"],
          ["2026-07-01", "2026-07-31", "-150.0000", "-165.0000"],
          ["2026-07-06", "2026-07-10", "0", "-15.0000"],
        ] as const) {
          for (const includePeriodEndJournals of [false, true]) {
            const activity = glActivityBuckets(org.orgId, {
              minDate: from,
              maxDate: to,
              boundaries: [],
              bookId: org.bookId,
              includePeriodEndJournals,
            });
            const actual = await db.execute<{ amount: string }>(
              sql`
            select coalesce(sum(b.amount), 0)::text as amount from ${activity} b
             where b.account_id = ${org.accounts.revenue} and b.subsidiary_id = ${org.subsidiaryId}`,
              "objects",
            );
            assert.equal(
              actual[0]?.amount,
              includePeriodEndJournals ? ledgerAmount : statementAmount,
            );
          }
          const ledger = await generalLedger(from, to, {
            orgId: org.orgId,
            bookId: org.bookId,
            accountId: org.accounts.bank,
            dims: { subsidiaryIds: [org.subsidiaryId] },
            canSeePayroll: true,
            maxLines: 1,
          });
          assert.equal(ledger.accounts[0]?.closing, to === "2026-07-31" ? "165.0000" : "115.0000");
          assert.equal(ledger.truncated, true);
        }
        const empty = await generalLedger("2026-07-01", "2026-07-31", {
          orgId: org.orgId,
          bookId: org.bookId,
          dims: { subsidiaryIds: [] },
          canSeePayroll: true,
        });
        assert.deepEqual(empty.accounts, []);
      });
    } finally {
      await withBypassContext(() => dropScratchOrg(org.orgId));
    }
  },
);
