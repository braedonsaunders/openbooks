import assert from "node:assert/strict";
import test from "node:test";
import { orgSettingsAuditAffectsCalculation } from "./settings-staleness.ts";
import { staleCalculationMessage } from "./readiness.ts";

const snapshot = (before: Record<string, unknown>, after: Record<string, unknown>) => ({
  before: { payroll: before },
  after: { payroll: after },
});

test("a net-pay settlement clearing designation does not stale payroll amounts", () => {
  assert.equal(
    orgSettingsAuditAffectsCalculation(
      snapshot(
        {},
        { netPaySettlementClearing: [{ accountId: "clearing", effectiveFrom: "2026-01-01" }] },
      ),
    ),
    false,
  );
});

test("a posting-account edit does not stale a calculated run", () => {
  assert.equal(
    orgSettingsAuditAffectsCalculation(
      snapshot(
        { netPayAccountId: "acct-a", burdenExpenseAccountId: "acct-b" },
        { netPayAccountId: "acct-c", burdenExpenseAccountId: "acct-d" },
      ),
    ),
    false,
  );
});

test("wages-to and statutory liability destinations are posting-only", () => {
  assert.equal(
    orgSettingsAuditAffectsCalculation(
      snapshot(
        { wagesTo: "expense", netPayAccountId: "acct-a" },
        { wagesTo: "labor_clearing", netPayAccountId: "acct-b" },
      ),
    ),
    false,
  );
});

test("a remittance vendor edit does not stale a calculated run", () => {
  assert.equal(
    orgSettingsAuditAffectsCalculation(
      snapshot({ craRemittancePartyId: "vendor-a" }, { craRemittancePartyId: "vendor-b" }),
    ),
    false,
  );
});

test("a labor clearing change saved with the labor costing form does not stale a calculated run", () => {
  const laborCosting = { mode: "post", hoursPerDay: 8 };
  assert.equal(
    orgSettingsAuditAffectsCalculation({
      laborCosting: [laborCosting, laborCosting],
      controlAccounts: { laborClearing: ["acct-a", "acct-b"] },
    }),
    false,
  );
});

test("a control account change alone does not stale a calculated run", () => {
  assert.equal(
    orgSettingsAuditAffectsCalculation({
      controlAccounts: [{ laborClearing: "acct-a" }, { laborClearing: "acct-b" }],
    }),
    false,
  );
});

test("a supplemental tax method change stales a calculated run", () => {
  assert.equal(
    orgSettingsAuditAffectsCalculation(
      snapshot(
        { supplementalTaxMethod: "period_cumulative" },
        { supplementalTaxMethod: "per_run" },
      ),
    ),
    true,
  );
});

test("the wage expense default stales a calculated run, because calculation stamps it on lines", () => {
  assert.equal(
    orgSettingsAuditAffectsCalculation(
      snapshot({ wageExpenseAccountId: "acct-a" }, { wageExpenseAccountId: "acct-b" }),
    ),
    true,
  );
});

test("a country pack or holiday rule change stales a calculated run", () => {
  assert.equal(
    orgSettingsAuditAffectsCalculation(
      snapshot({ countries: ["CA"] }, { countries: ["CA", "US"] }),
    ),
    true,
  );
  assert.equal(
    orgSettingsAuditAffectsCalculation(
      snapshot({ statutoryHolidayPay: false }, { statutoryHolidayPay: true }),
    ),
    true,
  );
});

test("a labor costing rate change stales a calculated run", () => {
  assert.equal(
    orgSettingsAuditAffectsCalculation({
      laborCosting: [{ hoursPerDay: 7.5 }, { hoursPerDay: 8 }],
      controlAccounts: { laborClearing: ["acct-a", "acct-b"] },
    }),
    true,
  );
});

test("a payroll snapshot that mixes posting and calculation keys stales the run", () => {
  assert.equal(
    orgSettingsAuditAffectsCalculation(
      snapshot(
        { netPayAccountId: "acct-a", eftFallbackToCheque: true },
        { netPayAccountId: "acct-b", eftFallbackToCheque: false },
      ),
    ),
    true,
  );
});

test("an unrelated organization setting stales a calculated run", () => {
  assert.equal(orgSettingsAuditAffectsCalculation({ name: ["Old name", "New name"] }), true);
});

test("an unchanged recorded pair does not stale a calculated run", () => {
  assert.equal(orgSettingsAuditAffectsCalculation({ name: ["Same", "Same"] }), false);
});

test("an unrecognised audit record fails closed to stale", () => {
  assert.equal(orgSettingsAuditAffectsCalculation({ reason: "bulk import" }), true);
  assert.equal(orgSettingsAuditAffectsCalculation({}), true);
  assert.equal(orgSettingsAuditAffectsCalculation(null), true);
  assert.equal(orgSettingsAuditAffectsCalculation("settings"), true);
});

test("the stale remedy names the control an approved run offers", () => {
  const message = staleCalculationMessage(["settings"], "approved");
  assert.match(message, /approved/);
  assert.match(message, /withdraw the approval/);
  assert.doesNotMatch(message, /before committing/);
});

test("the stale remedy for a run awaiting approval names the approval decision, not recalculation", () => {
  const message = staleCalculationMessage(["time"], "pending_approval");
  assert.match(message, /awaiting approval/);
  assert.match(message, /approver must decide/);
});

test("the stale remedy for a draft run is recalculation before commit", () => {
  assert.match(staleCalculationMessage(["time"], "draft"), /recalculate before committing$/);
  assert.match(staleCalculationMessage(["time"]), /recalculate before committing$/);
});
