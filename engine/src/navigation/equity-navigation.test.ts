import assert from "node:assert/strict";
import test from "node:test";
import { LOCAL_NAVIGATION } from "./local-navigation.ts";
import { NAV_MODULES } from "./nav-registry.ts";

test("Equity opens on its overview, keeps six working views on the strip and puts the structure records in More", () => {
  const equity = LOCAL_NAVIGATION.find((workspace) => workspace.id === "equity")!;
  assert.ok(equity, "Equity has a local workspace");
  assert.equal(equity.feature, "equity");
  assert.deepEqual(
    equity.tabs.map((tab) => [tab.href, tab.secondary === true]),
    [
      ["/equity", false],
      ["/equity?view=captable", false],
      ["/equity?view=securities", false],
      ["/equity?view=rounds", false],
      ["/equity?view=waterfall", false],
      ["/equity?view=compensation", false],
      ["/equity?view=classes", true],
      ["/equity?view=plans", true],
      ["/equity?view=stakeholders", true],
    ],
  );
  for (const tab of equity.tabs) {
    assert.equal(tab.permission, "equity.read", tab.href);
    assert.equal(tab.ns, "equity", tab.href);
    assert.deepEqual(
      tab.carry,
      ["asOf", "asOfPeriod"],
      `${tab.href} keeps the as-of date between views`,
    );
  }
});

test("Equity views stay on the local strip: the main menu keeps the one Equity entry point", () => {
  const modules = NAV_MODULES.filter((module) => module.href.startsWith("/equity"));
  assert.deepEqual(
    modules.map((module) => [module.key, module.href, module.featureKey]),
    [["equity", "/equity", "equity"]],
  );
});
