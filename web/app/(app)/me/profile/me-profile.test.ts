import assert from "node:assert/strict";
import test from "node:test";

// Behaviour contract for the profile page (/me/profile). The spec builder
// runs over hand-built data: a refused read renders its title and remedy,
// contact facts render verbatim, and the edit dialog renders only with
// its dialog data. Proposal validation stays covered by
// engine/src/hrm/self-service/scope.test.ts ('profile proposals validate
// field by field'), which owns the profile write contract.
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
    bankTitle: "Direct deposit",
    bankFacts: [],
    noBank: "No bank details on file",
    bankEditButton: "Update bank details",
    bankEditHref: "/me/profile?bank=1",
    bankDialogOpen: false,
    bankDialogCloseHref: "/me/profile",
    bankDialog: null,
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

test("the bank panel and dialog wire through masked data only", () => {
  const data = baseData();
  data.bankFacts = [{ label: "First Bank •••• 6789", value: "Active" }];
  data.bankDialog = { title: "Direct deposit" };
  const json = specJson(data);
  assert.ok(json.includes("Direct deposit"), "the bank panel title renders");
  assert.ok(json.includes("•••• 6789"), "the masked echo renders, never the number");
  assert.ok(json.includes("/me/profile?bank=1"), "the bank edit entry opens the bank dialog");
});
