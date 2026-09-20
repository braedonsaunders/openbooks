import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import {
  createScratchOrg,
  dropScratchOrg,
} from "../testing/fixtures.ts";
import { runScenario } from "./scenario.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

/**
 * Anti-false-green for the harness's `gl-month-activity-tieout` check.
 *
 * Dashboards read gl_month_activity, not the lines. The row and line
 * triggers maintain it on every posted write — inserts and flips always, so
 * the only way the aggregate goes stale is rows going missing behind the
 * triggers' back: a wipe that never rebuilt, a bulk path that deleted without
 * re-aggregating. The plant below posts a balanced entry through the normal
 * path, then removes its aggregate rows outright. That is exactly the
 * geometry a missed rebuild leaves: the trial balance still nets (the money
 * is all there) while every aggregate-reading surface understates two
 * accounts.
 */

function check(cp: Awaited<ReturnType<typeof runScenario>>, name: string) {
  const c = cp.checks.find((c) => c.name === name);
  assert.ok(c, `checkpoint must carry the ${name} check`);
  return c;
}

test("gl-month-activity-tieout fails when lines post with no aggregate behind them", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const entryId = randomUUID();
    await db.execute(sql`
      insert into journal_entries
        (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, memo, status, origin, custom)
      values (${entryId}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId}, ${`MTH-PROBE-${entryId.slice(0, 8)}`},
              ${org.date}, ${org.periodId}, 'month-aggregate red-proof probe', 'draft', 'manual', '{}'::jsonb)`);
    await db.execute(sql`
      insert into journal_lines
        (org_id, entry_id, line_number, account_id, subsidiary_id, amount, currency, txn_amount, fx_rate, memo)
      values (${org.orgId}, ${entryId}, 1, ${org.accounts.adjustment}, ${org.subsidiaryId}, '250.0000', 'CAD', '250.0000', 1, 'aggregated debit'),
             (${org.orgId}, ${entryId}, 2, ${org.accounts.clearing}, ${org.subsidiaryId}, '-250.0000', 'CAD', '-250.0000', 1, 'aggregated credit')`);
    await db.execute(sql`
      update journal_entries set status = 'posted', posted_at = now() where id = ${entryId}`);
    // The defect: aggregate rows gone behind the triggers' back.
    await db.execute(sql`delete from gl_month_activity where org_id = ${org.orgId}`);

    const cp = await runScenario(org.orgId, { at: org.date });
    const tie = check(cp, "gl-month-activity-tieout");
    assert.equal(tie.ok, false, `month-aggregate tie-out MUST fail: ${tie.detail}`);
    assert.match(tie.detail, /2 drifted from a direct sum over journal lines/);
    assert.equal(cp.pass, false, "an unaggregated fixture cannot be golden");
    for (const other of cp.checks.filter((c) => c.name !== "gl-month-activity-tieout")) {
      assert.equal(other.ok, true, `${other.name} must stay green here — the money nets, only the aggregate is missing`);
    }
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
