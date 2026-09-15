import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

const root = pathToFileURL(process.cwd() + "/").href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, url: "data:text/javascript,export {}" };
    }
    return nextResolve(specifier, context);
  },
});

const { sql } = await import("drizzle-orm");
const { db, withBypassContext, withOrgContext } = (await import(root + "engine/src/db.ts")) as typeof import("@openbooks/engine/src/db.ts");
const { createScratchOrg, dropScratchOrg } = (await import(root + "engine/src/test-fixtures.ts")) as typeof import("@openbooks/engine/src/test-fixtures.ts");
const { glActivityBuckets } = (await import(root + "web/lib/gl-summary.ts")) as typeof import("./gl-summary");

test(
  "split-month GL buckets exclude postings after the requested end date",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const org = await withBypassContext(() => createScratchOrg());
    try {
      const post = async (date: string, amount: string, tag: string) => {
        const entryId = randomUUID();
        await db.execute(sql`
          insert into journal_entries
            (id, org_id, book_id, subsidiary_id, entry_number, posting_date,
             period_id, memo, status, origin)
          values
            (${entryId}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId},
             ${`SPLIT-BOUNDARY-${tag}`}, ${date}, ${org.periodId}, ${tag}, 'draft', 'manual')`);
        await db.execute(sql`
          insert into journal_lines
            (org_id, entry_id, line_number, account_id, subsidiary_id,
             amount, currency, txn_amount, fx_rate)
          values
            (${org.orgId}, ${entryId}, 1, ${org.accounts.bank}, ${org.subsidiaryId},
             ${amount}, 'CAD', ${amount}, '1'),
            (${org.orgId}, ${entryId}, 2, ${org.accounts.revenue}, ${org.subsidiaryId},
             ${`-${amount}`}, 'CAD', ${`-${amount}`}, '1')`);
        await db.execute(sql`
          update journal_entries set status = 'posted', posted_at = now()
           where id = ${entryId} and org_id = ${org.orgId}`);
      };

      await withBypassContext(async () => {
        await post("2026-07-05", "100.0000", "inside");
        await post("2026-07-20", "50.0000", "outside");
      });

      await withOrgContext(org.orgId, async () => {
        const buckets = glActivityBuckets(org.orgId, {
          minDate: "2026-07-01",
          maxDate: "2026-07-10",
          boundaries: [],
          bookId: org.bookId,
        });
        const result = await db.execute<{ amount: string }>(sql`
          select coalesce(sum(b.amount), 0)::text as amount
            from ${buckets} b
           where b.account_id = ${org.accounts.revenue}
             and b.subsidiary_id = ${org.subsidiaryId}`);
        assert.equal(result.rows[0]?.amount, "-100.0000");
      });
    } finally {
      await withBypassContext(() => dropScratchOrg(org.orgId));
    }
  },
);
