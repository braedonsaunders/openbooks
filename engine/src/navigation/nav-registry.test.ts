import test from "node:test";
import assert from "node:assert/strict";
import { MODULE_BY_KEY, defaultNavConfig, resolveStoredHref } from "./nav-registry.ts";
import { LOCAL_NAVIGATION } from "./local-navigation.ts";
import { reconcileNavConfig } from "./nav-config.ts";

test("Sales management destinations belong to Customers", () => {
  const sales = LOCAL_NAVIGATION.find((workspace) => workspace.id === 'crm-sales')!;
  const config = defaultNavConfig();
  for (const tab of sales.tabs) {
    const module = [...MODULE_BY_KEY.values()].find((candidate) => candidate.href === tab.href)!;
    assert.equal(module.group, 'customers', tab.href);
    assert.ok(config.groups.find((group) => group.id === 'customers')!.items.some((item) => item.kind === 'module' && item.moduleKey === module.key), tab.href);
    assert.ok(!config.groups.find((group) => group.id === 'accounting')!.items.some((item) => item.kind === 'module' && item.moduleKey === module.key), tab.href);
  }
});

test("inherited Sales placements move to Customers without overriding company choices", () => {
  const saved = defaultNavConfig();
  const customers = saved.groups.find((group) => group.id === 'customers')!;
  const accounting = saved.groups.find((group) => group.id === 'accounting')!;
  const sales = customers.items.filter((item) => item.kind === 'module' && item.moduleKey !== 'crm-sales' && MODULE_BY_KEY.get(item.moduleKey)?.subgroup === 'crm-sales');
  assert.equal(sales.length, 4);
  customers.items = customers.items.filter((item) => !sales.includes(item));
  accounting.items.push(...sales);
  Object.assign(sales[0]!, { label: 'Salespeople', hidden: true });
  Object.assign(sales[1]!, { placement: 'custom', label: 'Finance teams' });
  const before = structuredClone(saved);
  const result = reconcileNavConfig(saved);
  assert.deepEqual(saved, before, 'reconciliation must not mutate the saved layout');
  const correctedCustomers = result.groups.find((group) => group.id === 'customers')!;
  assert.deepEqual(correctedCustomers.items.slice(-3), [sales[0], sales[2], sales[3]]);
  assert.deepEqual(result.groups.find((group) => group.id === 'accounting')!.items, [...accounting.items.filter((item) => !sales.includes(item)), sales[1]]);
  assert.deepEqual(reconcileNavConfig(result), result, 'correction must be idempotent');
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

 test("Manufacturing setup belongs to Company Setup and preserves customized placements", () => {
  const module=MODULE_BY_KEY.get('admin-setup-manufacturing')!;
  assert.equal(module.href,'/admin/setup/manufacturing');
  assert.equal(module.group,'settings');
  assert.equal(module.featureKey,'manufacturing');
  assert.equal(module.requiredPermission,'admin.setup.manage');
  assert.equal(module.menuParent,undefined);
  assert.ok(!LOCAL_NAVIGATION.find(workspace=>workspace.id==='manufacturing')!.tabs.some(tab=>tab.href===module.href));
  const saved=defaultNavConfig();
  const settings=saved.groups.find(group=>group.id==='settings')!;
  const operations=saved.groups.find(group=>group.id==='operations')!;
  settings.items=settings.items.filter(item=>!(item.kind==='module' && item.moduleKey===module.key));
  const inherited={kind:'module' as const,moduleKey:module.key,label:'Production setup',hidden:true};
  const custom={kind:'module' as const,moduleKey:module.key,placement:'custom' as const,label:'Shop controls'};
  operations.items.push(inherited,custom);
  const result=reconcileNavConfig(saved);
  assert.ok(result.groups.find(group=>group.id==='settings')!.items.some(item=>item.kind==='module' && item.moduleKey===module.key && item.hidden && item.label===inherited.label));
  assert.ok(result.groups.find(group=>group.id==='operations')!.items.some(item=>item.kind==='module' && item.moduleKey===module.key && item.placement==='custom'));
  assert.deepEqual(reconcileNavConfig(result),result);
 });
