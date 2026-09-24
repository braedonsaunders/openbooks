import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

// Behaviour contract for the profile page (/me/profile). The spec builder
// runs over hand-built data: a refused read renders its title and remedy,
// contact facts render verbatim, and the edit dialog renders only with
// its dialog data. Proposal validation stays covered by
// engine/src/hrm/self-service/scope.test.ts ('profile proposals validate
// field by field'), which owns the profile write contract.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
    return nextResolve(specifier, context);
  },
});

const { meProfileSpec } = await import("./view.ts");

function specJson(data: Record<string, unknown>): string {
  return JSON.stringify(meProfileSpec(data as never));
}

const TABS = [{ label: "Profile", href: "/me/profile" }];

function baseData(): Record<string, unknown> {
  return {
    tabs: TABS,
    refusal: null,
    contactFacts: [{ label: "Email", value: "ada@example.com" }],
    addressFacts: [],
    emergencyFacts: [],
    noAddress: "No address on file",
    noEmergency: "No emergency contact on file",
    dialog: null,
    dialogCloseHref: "/me/profile",
  } as unknown as Record<string, unknown>;
}

test("a refused profile read renders the remedy", () => {
  const data = baseData();
  data.refusal = { title: "No profile", message: "ask an administrator for a linked employment" };
  const json = specJson(data);
  assert.ok(json.includes("\"empty-state\""), "the refusal renders through the empty-state block");
  assert.ok(json.includes("No profile"), "the refusal title reaches the page");
  assert.ok(json.includes("ask an administrator for a linked employment"), "the refusal remedy reaches the page");
});

test("facts render verbatim with the dialog gated on its data", () => {
  const json = specJson(baseData());
  assert.ok(json.includes("Email"), "the fact label renders");
  assert.ok(json.includes("ada@example.com"), "the fact value renders verbatim");
  assert.ok(json.includes("No address on file"), "the address empty state renders");
  assert.ok(json.includes('"dialog":null'), "no edit dialog renders without its dialog data");

  const withDialog = baseData();
  withDialog.dialog = { title: "Edit contact" };
  const dialogJson = specJson(withDialog);
  assert.ok(dialogJson.includes("Edit contact"), "the dialog carries its data");
});
