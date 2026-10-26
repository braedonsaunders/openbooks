import assert from "node:assert/strict";
import test from "node:test";
import { buildTaxWorkspaceTabs } from "./workspace-tabs-state";

const labels = { filings: "Tax Filings", oss: "OSS Returns", provisions: "Provisions" };

test("the Tax workspace links its enabled peer pages and marks the current section", () => {
  const tabs = buildTaxWorkspaceTabs("oss", true, labels);

  assert.deepEqual(
    tabs.map(({ href, active }) => [href, active]),
    [
      ["/tax", false],
      ["/tax/oss", true],
      ["/tax/provisions", false],
    ],
  );
});

test("the Tax workspace omits OSS when cross-border tax is disabled", () => {
  const tabs = buildTaxWorkspaceTabs("provisions", false, labels);

  assert.deepEqual(
    tabs.map(({ href, active }) => [href, active]),
    [
      ["/tax", false],
      ["/tax/provisions", true],
    ],
  );
});
