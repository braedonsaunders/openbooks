import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

// Behaviour contract for the /me overview. The spec builder runs over
// hand-built data: an unlinked login reads the refusal state with its
// remedy (the R8 history lives here in comment only), and the surfaces
// bind their rows with the tab strip in the header. Row scoping to the
// login and license/notes redaction stay covered by
// engine/src/hrm/self-service/scope.test.ts and the qualifications
// workspace tests, which own the service reads.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
    return nextResolve(specifier, context);
  },
});

const { meSpec } = await import("./view.ts");

function specJson(data: Record<string, unknown>): string {
  return JSON.stringify(meSpec(data as never));
}

const TABS = [{ label: "Overview", href: "/me" }];

function baseData(): Record<string, unknown> {
  return {
    tabs: TABS,
    refusal: null,
    balances: [],
    balancesEmpty: "No balances",
    extensions: [],
    extensionsTitle: "",
    payExplain: "",
    timeKindLabel: "Time",
    unlimitedLabel: "Unlimited",
    valueKindLabel: "Value",
  } as unknown as Record<string, unknown>;
}

test("an unlinked login reads the refusal state", () => {
  const data = baseData();
  data.refusal = { title: "No employment link", message: "ask an administrator to link this login to a person record" };
  const json = specJson(data);
  assert.ok(json.includes("\"empty-state\""), "the refusal renders through the empty-state block");
  assert.ok(json.includes("No employment link"), "the refusal title reaches the page");
  assert.ok(
    json.includes("ask an administrator to link this login to a person record"),
    "the refusal remedy reaches the page",
  );
});

test("the surfaces bind their rows with the tab strip in the header", () => {
  const json = specJson(baseData());
  assert.ok(json.includes("\"module-home-tabs\""), "the header carries the tab strip");
  assert.ok(json.includes("/me"), "the strip links the overview surface");
  assert.ok(json.includes("\"hrm-leave-balances\""), "the balances widget renders");
  assert.ok(json.includes("No balances"), "the balances empty state resolves from its data");
});
