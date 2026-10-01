import assert from "node:assert/strict";
import test from "node:test";

// Behaviour contract for the benefits page (/me/benefits). The spec
// builder runs over hand-built data: a refused read renders its title
// and remedy, and the elect/change dialogs render only with their dialog
// data. Row scoping to the login stays covered by
// engine/src/hrm/self-service/scope.test.ts and the benefits workspace
// integration tests, which own the service reads.
const { meBenefitsSpec } = await import("./view.ts");

function specJson(data: Record<string, unknown>): string {
  return JSON.stringify(meBenefitsSpec(data as never));
}

const TABS = [{ label: "Benefits", href: "/me/benefits" }];

function baseData(): Record<string, unknown> {
  return {
    tabs: TABS,
    refusal: null,
    dialog: null,
    changeDialog: null,
    dialogCloseHref: "/me/benefits",
  } as unknown as Record<string, unknown>;
}

test("a refused benefits read renders the remedy", () => {
  const data = baseData();
  data.refusal = { title: "No benefits", message: "ask an administrator for a linked employment" };
  const json = specJson(data);
  assert.ok(json.includes("\"empty-state\""), "the refusal renders through the empty-state block");
  assert.ok(json.includes("No benefits"), "the refusal title reaches the page");
  assert.ok(json.includes("ask an administrator for a linked employment"), "the refusal remedy reaches the page");
});

test("the dialogs render only with their dialog data", () => {
  const json = specJson(baseData());
  assert.ok(json.includes("\"hrm-benefit-dialog\""), "the elect dialog widget renders");
  assert.ok(json.includes("\"hrm-benefit-change-dialog\""), "the change dialog widget renders");
  assert.ok(json.includes('"dialog":null'), "no dialog carries data it was not given");

  const withDialog = baseData();
  withDialog.dialog = { title: "Elect coverage" };
  const dialogJson = specJson(withDialog);
  assert.ok(dialogJson.includes("Elect coverage"), "the dialog carries its data");
});

test("award history uses distinct native paid, pending and reversed lists", () => {
  const json = specJson(baseData());
  for (const source of ["me_benefit_awards_paid", "me_benefit_awards_pending", "me_benefit_awards_reversed"]) {
    assert.equal(json.split(`\"source\":\"${source}\"`).length - 1, 1, `${source} is registered once`);
  }
  assert.ok(json.includes('"source":"me_benefits_elections"'), "the original coverage list remains native");
});

test("a refused award read preserves its remedy without claiming an empty payment history", () => {
  const data = baseData();
  data.awardsRefusal = { title: "Reward history unavailable", message: "Link your active employment before reading rewards." };
  const json = specJson(data);
  assert.ok(json.includes("Link your active employment before reading rewards."), "the computed remedy reaches the page");
  assert.ok(!json.includes('"source":"me_benefit_awards_'), "unknown payment history is not rendered as three empty lists");
  assert.ok(json.includes('"source":"me_benefits_elections"'), "coverage remains independently available");
});
