import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";

// The expenses tile reads the pipeline section of expensesDashboard — the
// same reader as the /expenses cockpit — and counts pending_approval only.
// Totals are deliberately untouched (the reader sums raw multi-currency
// totals org-wide; a tile must never present those as a fact).
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
    if (specifier.startsWith("@/")) {
      return nextResolve(new URL(`../../../${specifier.slice(2)}`, import.meta.url).href, context);
    }
    if (specifier.startsWith("@openbooks/engine/")) {
      return nextResolve(
        new URL(`../../../../engine/${specifier.slice("@openbooks/engine/".length)}`, import.meta.url).href,
        context,
      );
    }
    return nextResolve(specifier, context);
  },
});

const { sql } = await import("drizzle-orm");
const { db, withBypass, withOrgContext } = await import("@openbooks/engine/src/platform/db.ts");
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import("@openbooks/engine/src/testing/fixtures.ts");
const { loadDashboardMetrics } = await import("./_metrics.ts");
type Authz = import("@/lib/authz.ts").Authz;
type ScratchOrg = import("@openbooks/engine/src/testing/fixtures.ts").ScratchOrg;

const DB = !!process.env.OPENBOOKS_DB_URL;

function authzFor(orgId: string, userId: string, permissions: string[]): Authz {
  return {
    user: {
      id: userId, email: `${userId}@test`, name: "Expense Watcher", orgId,
      roles: [{ key: "staff", name: "staff" }],
      envKind: "sandbox", productionOrgId: orgId, isSuperAdmin: false,
      homeUserId: userId, homeOrgId: orgId,
    },
    permissions: new Set(["dashboard.read", ...permissions]),
    allowedSubsidiaryIds: null,
  };
}

async function seedReport(org: ScratchOrg, status: string): Promise<void> {
  const id = randomUUID();
  await db.execute(sql`insert into documents(id,org_id,kind,status,document_number,subsidiary_id,document_date,currency,fx_rate,subtotal,tax_total,total,open_balance)
    values(${id},${org.orgId},'expense_report',${status},${id},${org.subsidiaryId},${org.date},'CAD','1','100',0,'100','100')`);
}

test("dashboard expenses tile counts pending_approval reports through the cockpit reader", { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    await withBypass(() => seedReport(org, "pending_approval"));
    await withBypass(() => seedReport(org, "pending_approval"));
    await withBypass(() => seedReport(org, "approved"));
    await withBypass(() => seedReport(org, "draft"));
    const actor = await withBypass(() => createScratchUser(org.orgId, "Expense Reader", "admin"));
    const metrics = await withOrgContext(org.orgId, () =>
      loadDashboardMetrics(authzFor(org.orgId, actor as unknown as string, ["expenses.read"])),
    );
    assert.equal(metrics.pendingExpenses, 2, "approved and draft reports do not count");
    const blind = await withOrgContext(org.orgId, () =>
      loadDashboardMetrics(authzFor(org.orgId, actor as unknown as string, ["gl.read"])),
    );
    assert.equal(blind.pendingExpenses, 0);
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId));
  }
});

test("dashboard expenses tile is honest on empty", { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    const actor = await withBypass(() => createScratchUser(org.orgId, "Expense Reader", "admin"));
    const metrics = await withOrgContext(org.orgId, () =>
      loadDashboardMetrics(authzFor(org.orgId, actor as unknown as string, ["expenses.read"])),
    );
    assert.equal(metrics.pendingExpenses, 0);
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId));
  }
});
