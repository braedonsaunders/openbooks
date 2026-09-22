import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const page = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");
const actions = readFileSync(new URL("./ChangeActions.tsx", import.meta.url), "utf8");
const groupTabs = readFileSync(
  new URL("../../../../components/module-home/group-tabs.ts", import.meta.url),
  "utf8",
);
const leases = readFileSync(
  new URL("../../assets/leases/page.tsx", import.meta.url),
  "utf8",
);
const leaseDrawer = readFileSync(
  new URL("../../assets/leases/LeaseDrawer.tsx", import.meta.url),
  "utf8",
);
const contractDrawer = readFileSync(
  new URL("../../revenue/ContractDrawer.tsx", import.meta.url),
  "utf8",
);

test("the register is Accounting events, not ASC 250 Accounting Changes", () => {
  assert.match(page, /lifecycle\.pageTitle/);
  assert.match(page, /lifecycle\.pageDescription/);
  assert.doesNotMatch(page, /Accounting changes/);
  assert.doesNotMatch(page, /Approved changes retain the original accounting/);
  assert.match(page, /canManage=\{false\}/);
});

test("pending decisions leave the register for Inbox", () => {
  assert.match(actions, /href="\/inbox"/);
  assert.match(actions, /lifecycle\.reviewInbox/);
  assert.doesNotMatch(actions, /\/approvals/);
});

test("Accounting events is not a daily Accounting strip tab", () => {
  assert.doesNotMatch(
    groupTabs,
    /href: '\/accounting\/changes'/,
  );
  assert.match(groupTabs, /href: '\/close'/);
});

test("source records keep propose locally and name the history Accounting events", () => {
  assert.match(leases, /Accounting events/);
  assert.doesNotMatch(leases, /Accounting changes/);
  assert.match(leaseDrawer, /Accounting events/);
  assert.doesNotMatch(leaseDrawer, /Change evidence/);
  assert.match(leaseDrawer, /financialChangeEventLabel/);
  assert.match(contractDrawer, /Accounting events/);
  assert.match(contractDrawer, /financialChangeEventLabel/);
});
