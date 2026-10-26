import assert from "node:assert/strict";
import test from "node:test";
import "../dashboard/_dashboard-render-harness";
import {
  act,
  buttonsContaining,
  click,
  mountDashboard,
  scriptFetch,
  tick,
} from "../dashboard/_dashboard-render-harness";

// A labour line with no cost: "Award and create project" stays disabled
// until the expected cost is entered, and the disabled button names the
// reason beside itself (the shared inline-hint pattern) instead of leaving
// the operator to guess. Entering the cost clears the hint and enables it.
const { QuoteAwardAction } = await import("./QuoteAwardAction");
const React = await import("react");
const messages = (await import("../../../messages/en")).default as Record<string, unknown>;

const QUOTE_ID = "88888888-8888-4888-8888-888888888888";

function preview() {
  return {
    quote: {
      id: QUOTE_ID,
      documentNumber: "QE-200",
      status: "approved",
      customerName: "Acme",
      projectId: null,
      projectName: null,
    },
    awarded: null,
    blocked: null,
    defaults: {
      mode: "new",
      projectId: null,
      name: "Acme — QE-200",
      projectTypeId: null,
      contractValue: null,
    },
    projectTypes: [],
    projects: [],
    existingTasks: [],
    productionQuantitiesAvailable: false,
    lines: [
      {
        lineId: "55555555-5555-4555-8555-555555555555",
        lineNumber: 1,
        description: "Site labour",
        itemId: null,
        itemName: "Labour",
        itemKind: null,
        itemUnit: "hours",
        unit: "hours",
        quantity: "10",
        amount: "1000.00",
        costAmount: null,
        itemDefaultCost: null,
        fxRate: "1",
      },
    ],
    plan: null,
    planError: null,
  };
}

function typeCost(input: HTMLInputElement, value: string) {
  const realm = input.ownerDocument.defaultView!;
  const setter = Object.getOwnPropertyDescriptor(realm.HTMLInputElement.prototype, "value")!.set!;
  setter.call(input, value);
  input.dispatchEvent(new realm.Event("input", { bubbles: true }));
}

test("a costless labour line disables award with the reason beside the button", async (t) => {
  const restore = scriptFetch((url, init) => {
    if (url === `/api/estimates/${QUOTE_ID}/award` && !init?.method)
      return Response.json(preview());
    return null;
  });
  t.after(restore);
  function Host() {
    return <QuoteAwardAction quoteId={QUOTE_ID} docStatus="approved" />;
  }
  const { unmount } = await mountDashboard(<Host />, messages);
  t.after(unmount);
  await tick();
  await act(async () => {});
  await click(buttonsContaining("Award")[0]!);
  await tick();
  await tick();
  const submit = buttonsContaining("Award and create project")[0];
  assert.ok(submit, "the award submit renders in the award drawer");
  assert.equal(submit.disabled, true, "submit stays disabled while the expected cost is missing");
  const describedBy = submit.getAttribute("aria-describedby");
  assert.ok(describedBy, "the disabled submit points at its reason");
  const hint = describedBy ? document.getElementById(describedBy) : null;
  assert.ok(hint, "the reason renders beside the disabled button");
  assert.match(
    hint?.textContent ?? "",
    /Lines without a cost/,
    "the reason names the missing expected cost",
  );

  const costInput = document.querySelector(
    'input[aria-label="Expected cost"]',
  ) as HTMLInputElement | null;
  assert.ok(costInput, "the missing-cost row offers an expected-cost input");
  await act(async () => {
    typeCost(costInput, "500");
    await tick();
  });
  await tick();
  const enabled = buttonsContaining("Award and create project")[0];
  assert.ok(enabled, "the submit still renders after entering the cost");
  assert.equal(enabled.disabled, false, "entering the expected cost enables the submit");
  assert.equal(
    enabled.getAttribute("aria-describedby"),
    null,
    "the reason clears once the cost is entered",
  );
});
