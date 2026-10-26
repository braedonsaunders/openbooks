import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_NAV_ORDER,
  MODULE_BY_KEY,
  defaultNavConfig,
  resolveStoredHref,
} from "./nav-registry.ts";
import { LOCAL_NAVIGATION } from "./local-navigation.ts";
import { reconcileNavConfig } from "./nav-config.ts";
import { APPROVALS_HOME_HREF, APPROVALS_SUBMITTED_HREF } from "./approvals-home.ts";

test("Sales management destinations belong to Customers", () => {
  const sales = LOCAL_NAVIGATION.find((workspace) => workspace.id === "crm-sales")!;
  const config = defaultNavConfig();
  for (const tab of sales.tabs) {
    const module = [...MODULE_BY_KEY.values()].find((candidate) => candidate.href === tab.href)!;
    assert.equal(module.group, "customers", tab.href);
    assert.ok(
      config.groups
        .find((group) => group.id === "customers")!
        .items.some((item) => item.kind === "module" && item.moduleKey === module.key),
      tab.href,
    );
    assert.ok(
      !config.groups
        .find((group) => group.id === "accounting")!
        .items.some((item) => item.kind === "module" && item.moduleKey === module.key),
      tab.href,
    );
  }
});

test("inherited Sales placements move to Customers without overriding company choices", () => {
  const saved = defaultNavConfig();
  const customers = saved.groups.find((group) => group.id === "customers")!;
  const accounting = saved.groups.find((group) => group.id === "accounting")!;
  const sales = customers.items.filter(
    (item) =>
      item.kind === "module" &&
      item.moduleKey !== "crm-sales" &&
      MODULE_BY_KEY.get(item.moduleKey)?.subgroup === "crm-sales",
  );
  assert.equal(sales.length, 4);
  customers.items = customers.items.filter((item) => !sales.includes(item));
  accounting.items.push(...sales);
  Object.assign(sales[0]!, { label: "Salespeople", hidden: true });
  Object.assign(sales[1]!, { placement: "custom", label: "Finance teams" });
  const before = structuredClone(saved);
  const result = reconcileNavConfig(saved);
  assert.deepEqual(saved, before, "reconciliation must not mutate the saved layout");
  const correctedCustomers = result.groups.find((group) => group.id === "customers")!;
  assert.deepEqual(correctedCustomers.items.slice(-3), [sales[0], sales[2], sales[3]]);
  assert.deepEqual(result.groups.find((group) => group.id === "accounting")!.items, [
    ...accounting.items.filter((item) => !sales.includes(item)),
    sales[1],
  ]);
  assert.deepEqual(reconcileNavConfig(result), result, "correction must be idempotent");
});

// Findings persisted before the pack fix carry the
// hand-built "/ar/cockpit" href, which 404s. Stored hrefs resolve through
// the registry at render time so old findings heal without a backfill.
test("stored legacy AR cockpit href resolves to the registry ar href", () => {
  assert.equal(resolveStoredHref("/ar/cockpit"), "/ar");
  assert.equal(resolveStoredHref("/ar/cockpit"), MODULE_BY_KEY.get("ar")?.href);
});

test("live registry hrefs pass through untouched", () => {
  assert.equal(resolveStoredHref("/ar"), "/ar");
  assert.equal(resolveStoredHref("/budgets?budget=1"), "/budgets?budget=1");
  assert.equal(resolveStoredHref("/banking/abc/reconcile/def"), "/banking/abc/reconcile/def");
});

test("non-href stored values resolve to null", () => {
  assert.equal(resolveStoredHref(null), null);
  assert.equal(resolveStoredHref(undefined), null);
  assert.equal(resolveStoredHref(42), null);
  assert.equal(resolveStoredHref("ar"), null);
});

test("Manufacturing setup has one home inside Company Setup", () => {
  const key = "admin-setup-manufacturing";
  assert.equal(MODULE_BY_KEY.has(key), false);
  assert.ok(
    !LOCAL_NAVIGATION.find((workspace) => workspace.id === "manufacturing")!.tabs.some(
      (tab) => tab.href === "/admin/setup/manufacturing",
    ),
  );
  const saved = defaultNavConfig();
  const settings = saved.groups.find((group) => group.id === "settings")!;
  const operations = saved.groups.find((group) => group.id === "operations")!;
  settings.items.push({ kind: "module", moduleKey: key });
  operations.items.push({
    kind: "module",
    moduleKey: key,
    placement: "custom",
    label: "Shop controls",
  });
  const unrelated = { kind: "link" as const, href: "/docs", label: "Our handbook", hidden: true };
  settings.items.push(unrelated);
  const before = structuredClone(saved);
  const result = reconcileNavConfig(saved);
  assert.deepEqual(saved, before);
  assert.ok(
    !result.groups.some((group) =>
      group.items.some((item) => item.kind === "module" && item.moduleKey === key),
    ),
  );
  assert.ok(
    result.groups
      .find((group) => group.id === "settings")!
      .items.some((item) => item.kind === "link" && item.href === unrelated.href && item.hidden),
  );
  assert.deepEqual(reconcileNavConfig(result), result);
});

test("reopen requests stay a permission-gated accounting destination", () => {
  // The reopen surface must remain discoverable through the menu (which the
  // global page search indexes) without ever dropping its duty gate: only
  // holders of the reopen-approval permission decide windows.
  const module = MODULE_BY_KEY.get("close-reopen-requests")!;
  assert.equal(module.href, "/accounting/reopen-requests");
  assert.equal(module.group, "accounting");
  assert.equal(module.requiredPermission, "close.reopen");
  assert.ok(
    DEFAULT_NAV_ORDER.accounting.includes("close-reopen-requests"),
    "the default menu carries it, so page search indexes it",
  );
  assert.ok(!module.localOnly, "it is a real destination, not a local alias");
});

test("the approvals home and submitted view are live Inbox destinations", () => {
  assert.equal(MODULE_BY_KEY.get("approvals")?.href, APPROVALS_HOME_HREF);
  const inbox = LOCAL_NAVIGATION.find((workspace) => workspace.id === "inbox-views")!;
  assert.ok(inbox.tabs.some((tab) => tab.href === APPROVALS_HOME_HREF));
  assert.ok(inbox.tabs.some((tab) => tab.href === APPROVALS_SUBMITTED_HREF));
});
