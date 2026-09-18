import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

// A denied dashboard widget must be absent AND unqueried: the loader only
// runs the readers its visible widget set needs, so a caller without the
// permission leaves no trace in the query log (and nothing for timing or
// logs to leak). These tests inject spying readers — production always uses
// the canonical default — and prove the spies are never invoked.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
    if (specifier.startsWith("@/")) {
      return nextResolve(new URL(`../../../${specifier.slice(2)}`, import.meta.url).href, context);
    }
    // Worktree node_modules is a symlink to the main checkout's install, so
    // bare @openbooks self-imports would resolve to MAIN-checkout code (a
    // second db pool without the test bypass). Pin them to this checkout —
    // the same modules a real install resolves — process-wide, so the
    // loader under test and its transitive engine imports agree.
    if (specifier.startsWith("@openbooks/engine/")) {
      return nextResolve(
        new URL(`../../../../engine/${specifier.slice("@openbooks/engine/".length)}`, import.meta.url).href,
        context,
      );
    }
    return nextResolve(specifier, context);
  },
});

const { toUnits } = await import("@openbooks/engine/src/money.ts");
const { withBypass, withOrgContext } = await import("@openbooks/engine/src/db.ts");
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import("@openbooks/engine/src/test-fixtures.ts");
const { loadDashboardMetrics } = await import("./_metrics.ts");
type DashboardMoneyReaders = import("./_metrics.ts").DashboardMoneyReaders;
const { canSeeWidget } = await import("./_widget-access.ts");
const { businessToday } = await import("@openbooks/engine/src/business-date.ts");
type Authz = import("@/lib/authz.ts").Authz;
type OpenItem = import("@/lib/cash/core.ts").OpenItem;

const DB = !!process.env.OPENBOOKS_DB_URL;

function authzFor(orgId: string, userId: string, permissions: string[]): Authz {
  return {
    user: {
      id: userId, email: `${userId}@test`, name: "Denial Prober", orgId,
      roles: [{ key: "staff", name: "staff" }],
      envKind: "sandbox", productionOrgId: orgId, isSuperAdmin: false,
      homeUserId: userId, homeOrgId: orgId,
    },
    permissions: new Set(permissions),
    allowedSubsidiaryIds: null,
  };
}

/** Readers that detonate when invoked, recording the attempt first. */
function denialSpies(calls: string[]): DashboardMoneyReaders {
  return {
    bankBalances: (async () => {
      calls.push("bankBalances");
      throw new Error("bankBalances must not run for a denied widget");
    }) as DashboardMoneyReaders["bankBalances"],
    openItems: (async (...args: Parameters<DashboardMoneyReaders["openItems"]>) => {
      calls.push(`openItems:${args[1]}`);
      throw new Error("openItems must not run for a denied widget");
    }) as DashboardMoneyReaders["openItems"],
  };
}

test("denied AR/AP widgets are gated before the query layer, not just hidden", { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    // A caller with GL sight but no AR/AP grants cannot even name the tiles.
    const deniedId = await withBypass(() => createScratchUser(org.orgId, "Denial Prober", "staff"));
    const denied = authzFor(org.orgId, deniedId as unknown as string, ["dashboard.read", "gl.read"]);
    assert.equal(canSeeWidget(denied, "kpi-open-receivables"), false);
    assert.equal(canSeeWidget(denied, "kpi-overdue-receivables"), false);
    assert.equal(canSeeWidget(denied, "kpi-open-payables"), false);
    assert.equal(canSeeWidget(denied, "kpi-overdue-payables"), false);

    // And the loader — handed only the widgets that survived the filter
    // (here: none of the money tiles) — never invokes their readers. The
    // spies throw on invocation, so a call fails the test, not just an
    // assertion on output.
    const calls: string[] = [];
    const metrics = await withOrgContext(org.orgId, () =>
      loadDashboardMetrics(denied, ["kpi-journal-lines"], denialSpies(calls)),
    );
    assert.deepEqual(calls, [], "no money reader ran for widgets the caller cannot see");
    assert.equal(toUnits(metrics.openReceivables), toUnits("0"));
    assert.equal(toUnits(metrics.overdueReceivables), toUnits("0"));
    assert.equal(toUnits(metrics.openPayables), toUnits("0"));
    assert.equal(toUnits(metrics.overduePayables), toUnits("0"));
    assert.equal(
      metrics.asOfDate,
      await withOrgContext(org.orgId, () => businessToday(org.orgId)),
    );
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId));
  }
});

test("the visible set — not the permission check — selects the queries", { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    // Positive control with canned open items (no fixtures needed): one
    // overdue 600 invoice, one current 400 invoice. If the loader ignored
    // the visible set, the spies below would throw.
    const items: OpenItem[] = [
      { id: "i1", entryId: "e1", docKind: "customer_invoice", docNumber: "INV-1", docId: "d1", partyId: "p1", partyName: "Acme", tranDate: new Date("2024-01-05"), dueDate: new Date("2020-01-01"), remaining: "600.0000" },
      { id: "i2", entryId: "e2", docKind: "customer_invoice", docNumber: "INV-2", docId: "d2", partyId: "p1", partyName: "Acme", tranDate: new Date("2024-01-05"), dueDate: new Date("2099-01-01"), remaining: "400.0000" },
    ];
    const calls: string[] = [];
    const readers: DashboardMoneyReaders = {
      bankBalances: (async () => []) as DashboardMoneyReaders["bankBalances"],
      openItems: (async (...args: Parameters<DashboardMoneyReaders["openItems"]>) => {
        calls.push(`openItems:${args[1]}`);
        return args[1] === "ar" ? items : [];
      }) as DashboardMoneyReaders["openItems"],
    };
    const allowedId = await withBypass(() => createScratchUser(org.orgId, "AR Reader", "staff"));
    const allowed = authzFor(org.orgId, allowedId as unknown as string, ["dashboard.read", "ar.read"]);
    assert.equal(canSeeWidget(allowed, "kpi-open-receivables"), true);
    const metrics = await withOrgContext(org.orgId, () =>
      loadDashboardMetrics(allowed, ["kpi-open-receivables", "kpi-overdue-receivables"], readers),
    );
    // The AR reader ran exactly once; the AP and cash readers never did.
    assert.deepEqual(calls, ["openItems:ar"]);
    assert.equal(toUnits(metrics.openReceivables), toUnits("1000"));
    assert.equal(toUnits(metrics.overdueReceivables), toUnits("600"));
    assert.equal(toUnits(metrics.openPayables), toUnits("0"));
    assert.equal(toUnits(metrics.cashBalance), toUnits("0"));
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId));
  }
});

test("omitting the visible set preserves the pre-filter query behaviour", { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    // Existing callers (and tests) that pass no widget list get the old
    // behaviour: every group queried. If a future change narrows the
    // default, this test — not a production dashboard — says so first.
    const calls: string[] = [];
    const readers: DashboardMoneyReaders = {
      bankBalances: (async () => { calls.push("bankBalances"); return []; }) as DashboardMoneyReaders["bankBalances"],
      openItems: (async (...args: Parameters<DashboardMoneyReaders["openItems"]>) => {
        calls.push(`openItems:${args[1]}`); return [];
      }) as DashboardMoneyReaders["openItems"],
    };
    const fullId = await withBypass(() => createScratchUser(org.orgId, "Full Reader", "admin"));
    const full = authzFor(org.orgId, fullId as unknown as string, ["dashboard.read", "gl.read", "ar.read", "ap.read"]);
    await withOrgContext(org.orgId, () => loadDashboardMetrics(full, undefined, readers));
    assert.ok(calls.includes("bankBalances"), "default still queries cash balances");
    assert.ok(calls.includes("openItems:ar"), "default still queries AR items");
    assert.ok(calls.includes("openItems:ap"), "default still queries AP items");
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId));
  }
});
