import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { sql } from "drizzle-orm";
import { BUILTIN_PROJECT_TYPES } from "@openbooks/schema";
import { resolveProjectActualCosts, resolveProjectFinancials } from "./project-financials.ts";
import { db, type SqlExecutor } from "./db.ts";
import { createScratchOrg, dropScratchOrg, type ScratchOrg } from "./test-fixtures.ts";

const root = pathToFileURL(process.cwd() + "/").href;
registerHooks({ resolve(specifier, context, next) {
  if (specifier === "server-only") return { shortCircuit: true, url: "data:text/javascript,export {}" };
  // This worktree's node_modules symlinks to the main checkout's install, so
  // bare @openbooks/engine/* specifiers would test the main checkout's copy.
  // Pin the engine to this tree; third-party packages stay shared.
  if (specifier.startsWith("@openbooks/engine/")) {
    return next(root + "engine/" + specifier.slice("@openbooks/engine/".length), context);
  }
  return next(specifier, context);
}});

const { entityListSource } = await import("../../web/lib/list/entity-sources.ts");

const DB = !!process.env.OPENBOOKS_DB_URL;

/**
 * The project list's "Actual cost" must read the same profile-driven reader
 * as the cockpit Financials tab (F-t03-009: the list showed 36,064.07 while
 * the cockpit showed 56,435.68 for one project — posted-only standard-type
 * legs versus posted+reversed profile-source legs plus adjustments).
 * This pins the batched list reader to the single-project resolver on a
 * fixture carrying exactly the divergent grain: a reversed-status cost and
 * a manual actual_cost adjustment.
 */
const profile = BUILTIN_PROJECT_TYPES.find((t) => t.key === "time_and_materials")!
  .financialProfile;

async function seedProject(
  exec: SqlExecutor,
  org: ScratchOrg,
  code: string,
  postings: { entryNumber: string; amount: string; status: "posted" | "reversed" }[],
  adjustment: string,
): Promise<string> {
  const projectId = randomUUID();
  await exec.execute(sql`
    insert into projects (id, org_id, subsidiary_id, code, name, customer_id, status, is_active, custom)
    values (${projectId}, ${org.orgId}, ${org.subsidiaryId}, ${code},
            ${code}, ${org.customerId}, 'active', true, '{}'::jsonb)`);
  for (const posting of postings) {
    const entryId = randomUUID();
    // The posted-balance trigger requires ≥2 lines, so seed as draft, add
    // lines, then flip to the target status (posted, then reversed).
    await exec.execute(sql`
      insert into journal_entries
        (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, memo, status, origin)
      values
        (${entryId}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId}, ${posting.entryNumber},
         ${org.date}, ${org.periodId}, ${posting.entryNumber}, 'draft', 'manual')`);
    await exec.execute(sql`
      insert into journal_lines
        (id, org_id, entry_id, line_number, account_id, subsidiary_id, project_id, amount, currency, txn_amount, fx_rate)
      values
        (${randomUUID()}, ${org.orgId}, ${entryId}, 1, ${org.accounts.cogs}, ${org.subsidiaryId}, ${projectId}, ${posting.amount}, 'CAD', ${posting.amount}, '1'),
        (${randomUUID()}, ${org.orgId}, ${entryId}, 2, ${org.accounts.ap}, ${org.subsidiaryId}, null, ${`-${posting.amount}`}, 'CAD', ${`-${posting.amount}`}, '1')`);
    await exec.execute(sql`update journal_entries set status = 'posted' where id = ${entryId} and org_id = ${org.orgId}`);
    if (posting.status === 'reversed') {
      // Controlled reversal: a posted mirror-negated entry referencing the
      // original, then the flip. The mirror is itself posted, so both the
      // single-project resolver and the batch reader see it identically.
      const reversalId = randomUUID();
      const reversalNumber = `TIE-REV-${posting.entryNumber}`;
      await exec.execute(sql`
        insert into journal_entries
          (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, memo, status, origin, reverses_entry_id)
        values
          (${reversalId}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId}, ${reversalNumber},
           ${org.date}, ${org.periodId}, ${reversalNumber}, 'draft', 'manual', ${entryId})`);
      await exec.execute(sql`
        insert into journal_lines
          (id, org_id, entry_id, line_number, account_id, subsidiary_id, project_id, amount, currency, txn_amount, fx_rate)
        values
          (${randomUUID()}, ${org.orgId}, ${reversalId}, 1, ${org.accounts.cogs}, ${org.subsidiaryId}, ${projectId}, ${`-${posting.amount}`}, 'CAD', ${`-${posting.amount}`}, '1'),
          (${randomUUID()}, ${org.orgId}, ${reversalId}, 2, ${org.accounts.ap}, ${org.subsidiaryId}, null, ${posting.amount}, 'CAD', ${posting.amount}, '1')`);
      await exec.execute(sql`update journal_entries set status = 'posted' where id = ${reversalId} and org_id = ${org.orgId}`);
      await exec.execute(sql`update journal_entries set status = 'reversed' where id = ${entryId} and org_id = ${org.orgId}`);
    }
  }
  if (adjustment !== "0") {
    await exec.execute(sql`
      insert into project_financial_adjustments
        (org_id, project_id, adjustment_date, measure, amount, reason, source_system, source_ref,
         reverses_adjustment_id, evidence, created_by, updated_by)
      values
        (${org.orgId}, ${projectId}, ${org.date}, 'actual_cost', ${adjustment}, 'batch tie fixture',
         'test', ${randomUUID()}, null, '{}'::jsonb, null, null)`);
  }
  return projectId;
}

test("the batched list actual-cost reader ties the single-project resolver", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const withReversal = await seedProject(db, org, "JOB-TIE-A", [
      { entryNumber: "TIE-A-1", amount: "1000.0000", status: "posted" },
      { entryNumber: "TIE-A-2", amount: "250.0000", status: "reversed" },
    ], "75.0000");
    const plain = await seedProject(db, org, "JOB-TIE-B", [
      { entryNumber: "TIE-B-1", amount: "500.0000", status: "posted" },
    ], "0");

    const singleA = (await resolveProjectFinancials(org.orgId, withReversal, profile)).measures.actual_cost;
    const singleB = (await resolveProjectFinancials(org.orgId, plain, profile)).measures.actual_cost;
    // 1000 posted + 250 reversed − 250 posted mirror + 75 manual adjustment.
    assert.equal(singleA, "1075.0000");
    assert.equal(singleB, "500.0000");

    const batch = await resolveProjectActualCosts(org.orgId, [withReversal, plain]);
    assert.equal(batch.get(withReversal), String(singleA));
    assert.equal(batch.get(plain), String(singleB));

    // The list wires this reader through the projects source enrichment,
    // overwriting the SQL lateral's `actual` key on displayed rows.
    const source = entityListSource("project");
    assert.ok(source?.enrichRows, "projects source enriches rows");
    const rows: Record<string, unknown>[] = [
      { id: withReversal, actual: "0" },
      { id: plain, actual: "0" },
    ];
    await source.enrichRows!(org.orgId, rows);
    assert.equal(rows[0]!.actual, String(singleA));
    assert.equal(rows[1]!.actual, String(singleB));
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
