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
 * Anti-false-green for the harness's AR/AP `subledger-gl-tieout` check. The
 * subledger side reconstructs open items reachable from posted documents, so
 * an open-item line on a control account with no document behind it lands in
 * GL but in neither subledger nor direct-JE buckets. This test posts exactly
 * that geometry — a balanced entry with an undocumented open-item leg on the
 * receivable control — and requires the tie-out to fail with the exact 75.00
 * residual while every other check stays green.
 *
 * Cutoff mechanics: with no closed period the harness cuts off at the end of
 * the month before the latest posting, so the July probe needs an explicitly
 * seeded August period plus a later balanced decoy to stay in scope.
 */

function check(cp: Awaited<ReturnType<typeof runScenario>>, name: string) {
  const c = cp.checks.find((c) => c.name === name);
  assert.ok(c, `checkpoint must carry the ${name} check`);
  return c;
}

test("subledger-gl-tieout fails on an open-item line with no document behind it", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const cal = await db.execute<{ id: string }>(sql`
      select fiscal_calendar_id as id from accounting_periods where id = ${org.periodId}`);
    const augPeriodId = randomUUID();
    await db.execute(sql`
      insert into accounting_periods (id, org_id, fiscal_year, period_number, name, starts_on, ends_on, is_adjustment, fiscal_calendar_id)
      values (${augPeriodId}, ${org.orgId}, 2026, 8, '2026-08', '2026-08-01', '2026-08-31', false, ${cal.rows[0]!.id})`);

    const entryId = randomUUID();
    await db.execute(sql`
      insert into journal_entries
        (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, memo, status, origin, custom)
      values (${entryId}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId}, ${`TIE-PROBE-${entryId.slice(0, 8)}`},
              ${org.date}, ${org.periodId}, 'tieout probe', 'draft', 'probe', '{}'::jsonb)`);
    await db.execute(sql`
      insert into journal_lines
        (org_id, entry_id, line_number, account_id, subsidiary_id, amount, currency, txn_amount, fx_rate, is_open_item, memo)
      values (${org.orgId}, ${entryId}, 1, ${org.accounts.ar}, ${org.subsidiaryId}, '75.0000', 'CAD', '75.0000', 1, true, 'undocumented open item'),
             (${org.orgId}, ${entryId}, 2, ${org.accounts.clearing}, ${org.subsidiaryId}, '-75.0000', 'CAD', '-75.0000', 1, false, 'offset')`);
    await db.execute(sql`
      update journal_entries set status = 'posted', posted_at = now() where id = ${entryId}`);

    // Balanced August decoy so the cutoff keeps July in scope.
    const decoyId = randomUUID();
    await db.execute(sql`
      insert into journal_entries
        (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, memo, status, origin, custom)
      values (${decoyId}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId}, ${`TIE-DECOY-${decoyId.slice(0, 8)}`},
              '2026-08-10', ${augPeriodId}, 'cutoff decoy', 'draft', 'probe', '{}'::jsonb)`);
    await db.execute(sql`
      insert into journal_lines
        (org_id, entry_id, line_number, account_id, subsidiary_id, amount, currency, txn_amount, fx_rate, memo)
      values (${org.orgId}, ${decoyId}, 1, ${org.accounts.cogs}, ${org.subsidiaryId}, '5.0000', 'CAD', '5.0000', 1, 'decoy'),
             (${org.orgId}, ${decoyId}, 2, ${org.accounts.clearing}, ${org.subsidiaryId}, '-5.0000', 'CAD', '-5.0000', 1, 'decoy')`);
    await db.execute(sql`
      update journal_entries set status = 'posted', posted_at = now() where id = ${decoyId}`);

    const cp = await runScenario(org.orgId, { at: org.date });
    const tie = check(cp, "subledger-gl-tieout");
    assert.equal(tie.ok, false, `tie-out MUST fail on the orphan open item: ${tie.detail}`);
    assert.match(tie.detail, /worst \|GL − subledger − directJE\| = 75\.0000/, "detail must state the exact residual");
    assert.equal(cp.pass, false, "a diverged fixture cannot be golden");
    for (const other of cp.checks.filter((c) => c.name !== "subledger-gl-tieout")) {
      assert.equal(other.ok, true, `${other.name} must stay green here — only the tie-out fires`);
    }
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
