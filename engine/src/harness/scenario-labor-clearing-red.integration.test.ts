import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { createScratchOrg, dropScratchOrg, type ScratchOrg } from "../testing/fixtures.ts";
import { runScenario } from "../golden/scenario.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

/**
 * Anti-false-green for the harness's `labor-clearing` check. Standards credit
 * clearing at approval and payroll/variance must wash it back to zero per
 * settled month (as of the cutoff, so the live month never fails the gate).
 * Unwashed standards are the defect geometry: a balanced entry whose clearing
 * leg leaves a monthly residue.
 *
 * Cutoff mechanics: with no closed period the harness cuts off at the end of
 * the month before the latest posting, so the July probe needs a balanced
 * August decoy that avoids the clearing account, keeping July in scope.
 */

function check(cp: Awaited<ReturnType<typeof runScenario>>, name: string) {
  const c = cp.checks.find((c) => c.name === name);
  assert.ok(c, `checkpoint must carry the ${name} check`);
  return c;
}

async function configure(org: ScratchOrg) {
  await db.execute(sql`update orgs set settings = jsonb_set(settings, '{controlAccounts}',
    coalesce(settings->'controlAccounts', '{}'::jsonb) || ${JSON.stringify({
      laborClearing: org.accounts.clearing,
    })}::jsonb) where id = ${org.orgId}`);
}

async function postBalanced(
  org: ScratchOrg, postingDate: string, periodId: string, ref: string,
  legs: [string, string][],
) {
  const entryId = randomUUID();
  await db.execute(sql`
    insert into journal_entries
      (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, memo, status, origin, custom)
    values (${entryId}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId}, ${`${ref}-${entryId.slice(0, 8)}`},
            ${postingDate}, ${periodId}, 'labor probe', 'draft', 'probe', '{}'::jsonb)`);
  for (const [i, leg] of legs.entries()) {
    await db.execute(sql`
      insert into journal_lines
        (org_id, entry_id, line_number, account_id, subsidiary_id, amount, currency, txn_amount, fx_rate, memo)
      values (${org.orgId}, ${entryId}, ${i + 1}, ${leg[0]}, ${org.subsidiaryId}, ${leg[1]}, 'CAD', ${leg[1]}, 1, 'labor probe')`);
  }
  await db.execute(sql`
    update journal_entries set status = 'posted', posted_at = now() where id = ${entryId}`);
}

async function seedAugustDecoy(org: ScratchOrg) {
  const cal = await db.execute<{ id: string }>(sql`
    select fiscal_calendar_id as id from accounting_periods where id = ${org.periodId}`);
  const augPeriodId = randomUUID();
  await db.execute(sql`
    insert into accounting_periods (id, org_id, fiscal_year, period_number, name, starts_on, ends_on, is_adjustment, fiscal_calendar_id)
    values (${augPeriodId}, ${org.orgId}, 2026, 8, '2026-08', '2026-08-01', '2026-08-31', false, ${cal.rows[0]!.id})`);
  // Decoy avoids the clearing account so only July carries a residue.
  await postBalanced(org, "2026-08-10", augPeriodId, "LAB-DECOY", [
    [org.accounts.cogs, "5.0000"],
    [org.accounts.bank, "-5.0000"],
  ]);
}

test("labor-clearing fails on unwashed standards with the exact monthly residue", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    await configure(org);
    await postBalanced(org, org.date, org.periodId, "LAB-STD", [
      [org.accounts.cogs, "250.0000"],
      [org.accounts.clearing, "-250.0000"],
    ]);
    await seedAugustDecoy(org);

    const cp = await runScenario(org.orgId, { at: org.date });
    const labor = check(cp, "labor-clearing");
    assert.equal(labor.ok, false, `unwashed standards MUST fail the gate: ${labor.detail}`);
    assert.match(labor.detail, /2026-07-01 = -250\.0000/, "detail must name the worst month and exact residue");
    assert.equal(cp.pass, false, "a diverged fixture cannot be golden");
    for (const other of cp.checks.filter((c) => c.name !== "labor-clearing")) {
      assert.equal(other.ok, true, `${other.name} must stay green here — only labor-clearing fires`);
    }
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("labor-clearing holds when payroll washes standards to zero", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    await configure(org);
    await postBalanced(org, org.date, org.periodId, "LAB-STD", [
      [org.accounts.cogs, "250.0000"],
      [org.accounts.clearing, "-250.0000"],
    ]);
    await postBalanced(org, org.date, org.periodId, "LAB-PAY", [
      [org.accounts.clearing, "250.0000"],
      [org.accounts.bank, "-250.0000"],
    ]);
    await seedAugustDecoy(org);

    const cp = await runScenario(org.orgId, { at: org.date });
    const labor = check(cp, "labor-clearing");
    assert.equal(labor.ok, true, `washed clearing must hold: ${labor.detail}`);
    assert.match(labor.detail, /0 settled months with clearing residue/);
    assert.equal(cp.pass, true, "the whole fixture must pass on settled clearing");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
