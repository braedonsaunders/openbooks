import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import ExcelJS from "exceljs";
import { sql } from "drizzle-orm";

// The budget xlsx export stamps the workbook's created/modified properties
// from the org business day. The route, the scenario query, the
// business-day clock, and the office xlsx writer are real; only the
// feature/permission gate is seammed.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
    if (specifier.endsWith("/lib/authz")) {
      return { shortCircuit: true, url: "mock:budget-export-gate" };
    }
    if (specifier.endsWith("/lib/feature-gates")) {
      return { shortCircuit: true, url: "mock:budget-export-features" };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === "mock:budget-export-gate") {
      return {
        format: "module",
        shortCircuit: true,
        source: `import { permissionSetCovers } from '${enginePermissionsUrl}'
          export function can(authz, perm) { return permissionSetCovers(authz.permissions, perm) }`,
      };
    }
    if (url === "mock:budget-export-features") {
      return {
        format: "module",
        shortCircuit: true,
        source: `const key = Symbol.for('openbooks.budget-export-gate')
          export async function guardFeaturePermission() { return globalThis[key] }`,
      };
    }
    return nextLoad(url, context);
  },
});

const gateKey = Symbol.for("openbooks.budget-export-gate");
const enginePermissionsUrl = new URL(
  "../../engine/src/organization/permissions.ts",
  import.meta.url,
).href;
const { db, withBypassContext: withBypass } = await import(
  "@openbooks/engine/src/platform/db.ts"
);
const { createScratchOrg, dropScratchOrg } = await import(
  "@openbooks/engine/src/testing/fixtures.ts"
);
const { businessToday } = await import("@openbooks/engine/src/platform/business-date.ts");
const { GET } = await import("../app/api/budgets/[id]/export/route.ts");

test("the budget xlsx stamps the workbook from the org business day", async () => {
  const scratch = await withBypass(() => createScratchOrg());
  try {
    (globalThis as typeof globalThis & Record<symbol, unknown>)[gateKey] = {
      user: { id: "budget-export-test", orgId: scratch.orgId },
      permissions: new Set(["budgets.read", "data.export"]),
      allowedSubsidiaryIds: null,
    };
    const scenarioId = randomUUID();
    const accountId = randomUUID();
    await withBypass(async () => {
      await db.execute(sql`
        insert into accounts (id, org_id, number, name, type, is_summary, is_active)
        values (${accountId}, ${scratch.orgId}, 'BXE-1', 'Export budget account', 'expense', false, true)
      `);
      await db.execute(sql`
        insert into budget_scenarios (id, org_id, book_id, fiscal_year, name)
        values (${scenarioId}, ${scratch.orgId}, ${scratch.bookId}, 2026, 'Export calendar budget')
      `);
      await db.execute(sql`
        insert into budget_lines (org_id, scenario_id, account_id, period_id, amount)
        values (${scratch.orgId}, ${scenarioId}, ${accountId}, ${scratch.periodId}, '5000.0000')
      `);
    });
    const stamp = await withBypass(() => businessToday(scratch.orgId));

    const response = await GET(
      new Request(`http://openbooks.test/api/budgets/${scenarioId}/export?format=xlsx`),
      { params: Promise.resolve({ id: scenarioId }) },
    );
    assert.equal(response.status, 200);
    const disposition = response.headers.get("content-disposition") ?? "";
    assert.ok(disposition.includes(stamp), "the download filename names the business day");

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(Buffer.from(await response.arrayBuffer()) as unknown as ArrayBuffer);
    for (const property of [workbook.created, workbook.modified] as const) {
      assert.ok(property instanceof Date, "workbook properties arrive as dates");
      assert.equal(property.toISOString().slice(0, 10), stamp);
    }
  } finally {
    await withBypass(() => dropScratchOrg(scratch.orgId));
  }
});
