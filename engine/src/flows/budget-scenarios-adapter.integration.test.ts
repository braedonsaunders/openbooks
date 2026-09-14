import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db, withOrg } from "../db.ts";
import {
  createScratchOrg,
  dropScratchOrg,
} from "../test-fixtures.ts";
import { budgetScenariosFlowAdapter } from "./budget-scenarios-adapter.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

async function seedScenario(orgId: string, bookId: string, periodId: string, name: string): Promise<string> {
  const fy = (await db.execute<{ fiscal_year: number }>(
    sql`select fiscal_year from accounting_periods where id = ${periodId}`,
  )).rows[0]!.fiscal_year;
  const id = randomUUID();
  await db.execute(sql`
    insert into budget_scenarios (id, org_id, book_id, fiscal_year, name, kind, status)
    values (${id}, ${orgId}, ${bookId}, ${fy}, ${name}, 'budget', 'draft')`);
  return id;
}

test("budget findCandidateIds stays inside the ambient tenant", { skip: !DB }, async () => {
  const a = await createScratchOrg();
  const b = await createScratchOrg();
  try {
    const [idA, idB] = await Promise.all([
      seedScenario(a.orgId, a.bookId, a.periodId, "Tenant A Budget"),
      seedScenario(b.orgId, b.bookId, b.periodId, "Tenant B Budget"),
    ]);
    // Before the org predicate this query read every tenant: a scheduled
    // fan-out for org A could fire on org B's scenarios. The documents
    // adapter already fails closed here; budgets must match that contract.
    const idsA = await withOrg(a.orgId, () => budgetScenariosFlowAdapter.findCandidateIds!(50));
    assert.ok(idsA.includes(idA), "own scenario is a candidate");
    assert.ok(!idsA.includes(idB), "another tenant's scenario is never a candidate");
    const idsB = await withOrg(b.orgId, () => budgetScenariosFlowAdapter.findCandidateIds!(50));
    assert.ok(idsB.includes(idB));
    assert.ok(!idsB.includes(idA));
  } finally {
    await dropScratchOrg(a.orgId);
    await dropScratchOrg(b.orgId);
  }
});

test("budget findCandidateIds fails closed without a tenant context", { skip: !DB }, async () => {
  await assert.rejects(
    budgetScenariosFlowAdapter.findCandidateIds!(10),
    /ambient tenant context/,
  );
});
