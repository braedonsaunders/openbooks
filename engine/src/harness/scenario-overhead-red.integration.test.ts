import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../db.ts";
import {
  createScratchOrg,
  dropScratchOrg,
  type ScratchOrg,
} from "../test-fixtures.ts";
import { runScenario } from "./scenario.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

/**
 * Anti-false-green for the harness's overhead gates. Both checks must fire on
 * the ledger geometries they were built for — geometries a balanced entry can
 * legally carry, so no kernel bypass is needed, only raw inserts of the kind
 * a buggy overhead run would produce:
 *
 * - `overhead-pair-zero`: an overhead_applied entry that balances overall but
 *   leaves one account moved (DR 100 / CR 60 / CR 40 across two accounts).
 * - `overhead-burdens-jobs`: an overhead_applied entry that nets to zero per
 *   account yet is applied backwards (the project-tagged leg is a CREDIT, so
 *   the P&L looks right while job cost is understated by the whole amount —
 *   the exact case TRUST.md documents).
 */

function check(cp: Awaited<ReturnType<typeof runScenario>>, name: string) {
  const c = cp.checks.find((c) => c.name === name);
  assert.ok(c, `checkpoint must carry the ${name} check`);
  return c;
}

async function postOverheadEntry(
  org: ScratchOrg,
  tag: string,
  lines: { accountId: string; amount: string; projectId?: string }[],
): Promise<void> {
  const entryId = randomUUID();
  await db.execute(sql`
    insert into journal_entries
      (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, memo, status, origin, custom)
    values (${entryId}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId}, ${`${tag}-${entryId.slice(0, 8)}`},
            ${org.date}, ${org.periodId}, 'overhead red-proof probe', 'draft', 'overhead_applied', '{}'::jsonb)`);
  // All legs go in ONE multi-row statement: the line guard requires the
  // entry to balance within each statement, so interim single-leg inserts
  // are refused even though the finished entry would balance.
  const rows = lines.map(
    (line, i) =>
      sql`(${org.orgId}, ${entryId}, ${i + 1}, ${line.accountId}, ${org.subsidiaryId}, ${line.projectId ?? null}, ${line.amount}, 'CAD', ${line.amount}, 1, 'probe')`,
  );
  await db.execute(sql`
    insert into journal_lines
      (org_id, entry_id, line_number, account_id, subsidiary_id, project_id, amount, currency, txn_amount, fx_rate, memo)
    values ${sql.join(rows, sql`, `)}`);
  await db.execute(sql`
    update journal_entries set status = 'posted', posted_at = now() where id = ${entryId}`);
}

async function makeProject(orgId: string): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    insert into projects (id, org_id, name) values (${id}, ${orgId}, 'Overhead Probe Project')`);
  return id;
}

test("overhead-pair-zero fails when an overhead entry moves one account", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    await postOverheadEntry(org, "OVH-PAIR-PROBE", [
      { accountId: org.accounts.cogs, amount: "100.0000" },
      { accountId: org.accounts.cogs, amount: "-60.0000" },
      { accountId: org.accounts.clearing, amount: "-40.0000" },
    ]);

    const cp = await runScenario(org.orgId, { at: org.date });
    const pair = check(cp, "overhead-pair-zero");
    assert.equal(pair.ok, false, `pair-zero MUST fail: ${pair.detail}`);
    assert.match(pair.detail, /2 accounts moved/, "detail must name both moved accounts");
    assert.equal(cp.pass, false, "a drifted fixture cannot be golden");
    for (const other of cp.checks.filter((c) => c.name !== "overhead-pair-zero")) {
      assert.equal(other.ok, true, `${other.name} must stay green here — only pair-zero fires`);
    }
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("overhead-burdens-jobs fails on backwards application that nets to zero", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const projectId = await makeProject(org.orgId);
    // Backwards on ONE account: the project-tagged leg is a CREDIT. The
    // account nets to zero, so pair-zero stays green while the direction
    // gate must fire — the exact invisible-on-a-trial-balance geometry.
    await postOverheadEntry(org, "OVH-DIR-PROBE", [
      { accountId: org.accounts.cogs, amount: "100.0000" },
      { accountId: org.accounts.cogs, amount: "-100.0000", projectId },
    ]);

    const cp = await runScenario(org.orgId, { at: org.date });
    const dir = check(cp, "overhead-burdens-jobs");
    assert.equal(dir.ok, false, `direction gate MUST fail: ${dir.detail}`);
    assert.match(dir.detail, /-100\.00/, "detail must state the negative tagged total");
    assert.equal(check(cp, "overhead-pair-zero").ok, true, "pair-zero must stay green — the pair nets");
    assert.equal(cp.pass, false, "a backwards fixture cannot be golden");
    for (const other of cp.checks.filter(
      (c) => c.name !== "overhead-burdens-jobs" && c.name !== "overhead-pair-zero",
    )) {
      assert.equal(other.ok, true, `${other.name} must stay green here — only the direction gate fires`);
    }
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
