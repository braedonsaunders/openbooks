import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { sql } from "drizzle-orm";
import { BUILTIN_PROJECT_TYPES } from "@openbooks/schema";
import { resolveProjectActualCosts, resolveProjectFinancials } from "./project-financials.ts";
import { db, withBypassContext, withOrgContext, type SqlExecutor } from "./db.ts";
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

const { entityListSource, plannedPageClauses } = await import("../../web/lib/list/entity-sources.ts");

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
const builtinTm = BUILTIN_PROJECT_TYPES.find((t) => t.key === "time_and_materials")!;
const profile = builtinTm.financialProfile;

async function seedProject(
  exec: SqlExecutor,
  org: ScratchOrg,
  code: string,
  postings: { entryNumber: string; amount: string; status: "posted" | "reversed" }[],
  adjustment: string,
  projectTypeId: string | null = null,
): Promise<string> {
  const projectId = randomUUID();
  await exec.execute(sql`
    insert into projects (id, org_id, subsidiary_id, code, name, customer_id, status, is_active, project_type_id, custom)
    values (${projectId}, ${org.orgId}, ${org.subsidiaryId}, ${code},
            ${code}, ${org.customerId}, 'active', true, ${projectTypeId}, '{}'::jsonb)`);
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
  // Fixture seeding runs under bypass (exactly what the pooled fixture path
  // does): the shared cluster enforces RLS and CI's superuser role hides
  // it. Reads stay tenant-scoped via withOrgContext — the production read
  // path — so the tie proves what the list actually serves.
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const [withReversal, plain] = await withBypassContext(async () => [
      await seedProject(db, org, "JOB-TIE-A", [
        { entryNumber: "TIE-A-1", amount: "1000.0000", status: "posted" },
        { entryNumber: "TIE-A-2", amount: "250.0000", status: "reversed" },
      ], "75.0000"),
      await seedProject(db, org, "JOB-TIE-B", [
        { entryNumber: "TIE-B-1", amount: "500.0000", status: "posted" },
      ], "0"),
    ]);

    await withOrgContext(org.orgId, async () => {
      const singleA = (await resolveProjectFinancials(org.orgId, withReversal, profile)).measures.actual_cost;
      const singleB = (await resolveProjectFinancials(org.orgId, plain, profile)).measures.actual_cost;
      // 1000 posted + 250 reversed − 250 posted mirror + 75 manual adjustment.
      assert.equal(singleA, "1075.0000");
      assert.equal(singleB, "500.0000");

      const batch = await resolveProjectActualCosts(org.orgId, [withReversal, plain]);
      assert.equal(batch.get(withReversal), String(singleA));
      assert.equal(batch.get(plain), String(singleB));

      // The list wires this reader through the projects source enrichment,
      // overwriting the SQL `actual` placeholder on displayed rows.
      const source = entityListSource("project");
      assert.ok(source?.enrichRows, "projects source enriches rows");
      const rows: Record<string, unknown>[] = [
        { id: withReversal, actual: "0" },
        { id: plain, actual: "0" },
      ];
      await source.enrichRows!(org.orgId, rows);
      assert.equal(rows[0]!.actual, String(singleA));
      assert.equal(rows[1]!.actual, String(singleB));
    });
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

/**
 * F-t03-013: the batched reader must resolve each project's own type profile
 * in one lookup (no per-project `loadProjectType`), and sort-by-actual must
 * plan from the same reader — one aggregate over the filtered id set, never
 * a correlated per-row sum over journal_lines.
 */
async function seedProjectType(
  exec: SqlExecutor,
  org: ScratchOrg,
  actualCost: unknown,
  billingMethod: string | null,
): Promise<string> {
  const typeId = randomUUID();
  await exec.execute(sql`
    insert into project_types (id, org_id, key, name, billing_method, invoicing_profile, backup_profile)
    values (${typeId}, ${org.orgId}, ${`TEST-${typeId.slice(0, 8)}`}, 'Batch test type',
            ${billingMethod}, ${JSON.stringify(builtinTm.invoicingProfile)}::jsonb,
            ${JSON.stringify(builtinTm.backupProfile)}::jsonb)`);
  await exec.execute(sql`
    insert into project_financial_profile_versions (org_id, project_type_id, effective_from, financial_profile, reason)
    values (${org.orgId}, ${typeId}, '2026-01-01',
            ${JSON.stringify({ ...profile, actualCost })}::jsonb, 'batch reader fixture')`);
  return typeId;
}

test("the batched reader resolves per-type profiles and plans actual-cost sorts without journal scans", { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const { pricey, cheap, unpriced, broken } = await withBypassContext(async () => {
      const pricey = await seedProject(db, org, "JOB-SORT-A", [
        { entryNumber: "SORT-A-1", amount: "1000.0000", status: "posted" },
      ], "75.0000");
      const cheap = await seedProject(db, org, "JOB-SORT-B", [
        { entryNumber: "SORT-B-1", amount: "500.0000", status: "posted" },
      ], "0");
      // A custom type whose actual-cost source matches nothing: its legs must
      // price at zero even though the org holds posted cost lines for it.
      const noneType = await seedProjectType(db, org, { source: "none" }, "time_and_materials");
      const unpriced = await seedProject(db, org, "JOB-SORT-C", [
        { entryNumber: "SORT-C-1", amount: "1000.0000", status: "posted" },
      ], "0", noneType);
      // A type row missing its billing method keeps the page zero instead of
      // failing it, mirroring the single loader's throw-then-catch. A dangling
      // type id cannot be inserted: projects_project_type_id_fkey refuses it.
      const brokenType = await seedProjectType(db, org, { source: "none" }, "");
      const broken = await seedProject(db, org, "JOB-SORT-E", [
        { entryNumber: "SORT-E-1", amount: "900.0000", status: "posted" },
      ], "0", brokenType);
      return { pricey, cheap, unpriced, broken };
    });

    await withOrgContext(org.orgId, async () => {
      const batch = await resolveProjectActualCosts(org.orgId, [pricey, cheap, unpriced, broken]);
      assert.equal(batch.get(pricey), "1075.0000");
      assert.equal(batch.get(cheap), "500.0000");
      const singleUnpriced = (await resolveProjectFinancials(org.orgId, unpriced, { ...profile, actualCost: { source: "none" } as never })).measures.actual_cost;
      assert.equal(singleUnpriced, "0.0000");
      assert.equal(batch.get(unpriced), String(singleUnpriced));
      assert.equal(batch.get(broken), "0.0000");

      const source = entityListSource("project");
      assert.ok(source?.orderedPageIds, "projects source plans actual-cost sorts");
      const ctx = {
        orgId: org.orgId,
        tableSql: sql`projects p`,
        baseJoins: sql``,
        where: sql`p.org_id = ${org.orgId} and p.is_active`,
      };
      assert.equal(await source.orderedPageIds!({ ...ctx, sort: "name", dir: "asc" }), null);
      // The two zero-cost projects tie; their relative order follows the uuid
      // tiebreak, so pin the ordered ranks and the tied pair as a set.
      const desc = await source.orderedPageIds!({ ...ctx, sort: "actual", dir: "desc" });
      assert.deepEqual(desc?.slice(0, 2), [pricey, cheap]);
      assert.deepEqual(new Set(desc?.slice(2)), new Set([unpriced, broken]));
      const asc = await source.orderedPageIds!({ ...ctx, sort: "actual", dir: "asc" });
      assert.deepEqual(new Set(asc?.slice(0, 2)), new Set([unpriced, broken]));
      assert.deepEqual(asc?.slice(2), [cheap, pricey]);

      // The shared planned-page clauses read the planned order back through
      // real SQL — the same shape the list view pages with.
      const idExpr = sql`p.id`;
      const descClauses = plannedPageClauses([...desc!], idExpr);
      const descPage = (await db.execute<{ id: string }>(sql`
        select p.id from projects p where ${descClauses.where} order by ${descClauses.order} limit 2`)).rows;
      assert.deepEqual(descPage.map((r) => r.id), [pricey, cheap], "planned desc page");
      const ascClauses = plannedPageClauses([...asc!], idExpr);
      const ascPage = (await db.execute<{ id: string }>(sql`
        select p.id from projects p where ${ascClauses.where} order by ${ascClauses.order} limit 2`)).rows;
      assert.deepEqual(new Set(ascPage.map((r) => r.id)), new Set([unpriced, broken]), "planned asc page pair");
    });
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
