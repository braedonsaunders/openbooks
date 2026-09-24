import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

// Behaviour contract for the reviews page (/me/reviews). The spec builder
// runs over hand-built data: a refused read renders its title and remedy,
// the self and manager review tables bind their rows, and the goal dialog
// renders only with its dialog data. Calibration stripping stays covered
// by engine/src/hrm/self-service/my-workspace.integration.test.ts
// ('a shared manager review reaches the subject with calibration
// stripped'), which owns the service shape — the spec renders what the
// loader carries, never more.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
    return nextResolve(specifier, context);
  },
});

const { meReviewsSpec } = await import("./view.ts");

function specJson(data: Record<string, unknown>): string {
  return JSON.stringify(meReviewsSpec(data as never));
}

const TABS = [{ label: "Reviews", href: "/me/reviews" }];

function baseData(): Record<string, unknown> {
  return {
    tabs: TABS,
    refusal: null,
    goalDialog: null,
    goalDialogCloseHref: "/me/reviews",
  } as unknown as Record<string, unknown>;
}

test("a refused reviews read renders the remedy", () => {
  const data = baseData();
  data.refusal = { title: "No reviews", message: "ask an administrator for a linked employment" };
  const json = specJson(data);
  assert.ok(json.includes("\"empty-state\""), "the refusal renders through the empty-state block");
  assert.ok(json.includes("No reviews"), "the refusal title reaches the page");
  assert.ok(json.includes("ask an administrator for a linked employment"), "the refusal remedy reaches the page");
});

test("the self and manager tables bind with the goal dialog gated on its data", () => {
  const json = specJson(baseData());
  assert.ok(json.includes("\"selfRows\""), "the self review table binds its rows");
  assert.ok(json.includes("\"sharedRows\""), "the shared review table binds its rows");
  assert.ok(json.includes("\"goalRows\""), "the goals table binds its rows");
  assert.ok(json.includes('"dialog":null'), "no goal dialog renders without its dialog data");

  const withDialog = baseData();
  withDialog.goalDialog = { title: "Update goal" };
  const dialogJson = specJson(withDialog);
  assert.ok(dialogJson.includes("\"hrm-goal-dialog\""), "the goal dialog widget renders");
  assert.ok(dialogJson.includes("Update goal"), "the dialog carries its data");
});
