import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
registerHooks({ resolve(specifier, context, next) {
  if (specifier === "server-only") return { shortCircuit: true, url: "data:text/javascript,export {}" };
  return next(specifier, context);
} });
import { sql } from "drizzle-orm";
import { db, withBypass, withOrgContext } from "@openbooks/engine/src/platform/db.ts";
import {
  createScratchOrg,
  dropScratchOrg,
} from "@openbooks/engine/src/testing/fixtures.ts";

const { cashPosition } = await import("./cash-position.ts");

const SETTINGS = { weeklyCap: "0.0000", restrictToSafe: false } as const;

/**
 * A RESTRICTED subsidiary-scoped cash view shows an attributed manual
 * category at full value but hides unattributed org-level models entirely
 * (fail closed): a restricted reader sees neither their names nor their
 * amounts. Whole-org and unrestricted views still show everything.
 */
test("subsidiary cash views attribute manual and formula categories", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    const branchId = randomUUID();
    await withBypass(async () => {
      await db.execute(sql`
        insert into subsidiaries (id, org_id, parent_id, name, base_currency, country)
        values (${branchId}, ${org.orgId}, ${org.subsidiaryId}, 'Cash branch', 'CAD', 'CA')
      `);
      await db.execute(sql`
        update orgs
           set settings = jsonb_set(
             jsonb_set(
               coalesce(settings, '{}'::jsonb),
               '{analytics}',
               coalesce(settings -> 'analytics', '{}'::jsonb),
               true
             ),
             '{analytics,cashflowCategories}',
             ${JSON.stringify([
               { id: "cat-orgwide", name: "Org rent", direction: "outflow", method: "manual_recurring", amount: "700.0000", frequency: "weekly" },
               { id: "cat-branch", name: "Branch rent", direction: "outflow", method: "manual_recurring", amount: "300.0000", frequency: "weekly", subsidiaryIds: [branchId] },
               { id: "cat-formula", name: "Org formula", direction: "inflow", method: "formula_expression", formula: "10" },
             ])}::jsonb,
             true
           )
         where id = ${org.orgId}
      `);
    });
    const ids = (position: { categories: Array<{ id: string }> }) =>
      position.categories.map((c) => c.id).sort();
    await withOrgContext(org.orgId, async () => {
      // Whole-org (unscoped, unrestricted) views show everything.
      const consolidated = await cashPosition(
        org.orgId, 4, SETTINGS, org.date, undefined, null, true,
      );
      assert.deepEqual(ids(consolidated), ["cat-branch", "cat-formula", "cat-orgwide"]);
      const restricted = await cashPosition(
        org.orgId, 4, SETTINGS, org.date, [branchId], new Set([branchId]), false,
      );
      assert.deepEqual(ids(restricted), ["cat-branch"]);
      const branchCat = restricted.categories.find((c) => c.id === "cat-branch")!;
      assert.ok(branchCat.total !== "0.0000", "the attributed category keeps its full value");
      // An unrestricted admin narrowing to one subsidiary keeps today's
      // behavior: narrowing never hides what the caller may read org-wide.
      const narrowed = await cashPosition(
        org.orgId, 4, SETTINGS, org.date, [branchId], null, false,
      );
      assert.deepEqual(ids(narrowed), ["cat-branch", "cat-formula", "cat-orgwide"]);
    });
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId));
  }
});
