import assert from "node:assert/strict";
import test from "node:test";

// jsdom first: the section reads browser globals at render.
const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", {
  url: "http://localhost:4800/parties/test-party",
});
const globals = globalThis as Record<string, unknown>;
const domWindow = dom.window as unknown as Record<string, unknown>;
for (const key of ["window", "document", "navigator", "Node", "Element", "HTMLElement", "Event", "self"]) {
  if (globals[key] === undefined) globals[key] = domWindow[key];
}
if (typeof window.matchMedia !== "function") {
  window.matchMedia = (() => ({
    matches: false,
    media: "",
    addEventListener() {},
    removeEventListener() {},
  })) as typeof window.matchMedia;
}

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
const React = await import("react");
Object.assign(globalThis, { React });
const { createRoot } = await import("react-dom/client");
const { act } = await import("react");
const { NextIntlClientProvider } = await import("next-intl");
const messages = (await import("../../../messages/en")).default as Record<string, unknown>;
const { BillingRelationshipsSection } = await import("./BillingRelationshipsSection");

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

function populatedPayload() {
  return {
    summary: {
      billToPartyId: "bill-1",
      billToName: "Bill Co",
      payerPartyId: "payer-1",
      payerName: "Payer Co",
      consolidationGroupId: "group-1",
      groupCode: "GRP",
      groupName: "Group",
      groupCadence: "monthly",
    },
    relationships: [
      {
        id: "rel-1",
        billToPartyId: "bill-1",
        billToName: "Bill Co",
        payerPartyId: "payer-1",
        payerName: "Payer Co",
        groupId: "group-1",
        groupCode: "GRP",
        groupName: "Group",
        effectiveFrom: "2026-01-01",
        effectiveTo: null,
      },
    ],
    children: [
      {
        childPartyId: "child-1",
        childName: "Child Co",
        billToPartyId: "bill-1",
        payerPartyId: "payer-1",
        effectiveFrom: "2026-01-01",
        effectiveTo: null,
        groupCode: "GRP",
      },
    ],
    groups: [
      {
        id: "group-1",
        code: "GRP",
        name: "Group",
        payerPartyId: "payer-1",
        cadence: "monthly",
        cutoffDay: 15,
        grouping: "by_child",
        billingSubsidiaryName: null,
      },
    ],
    parties: [
      { id: "bill-1", name: "Bill Co" },
      { id: "payer-1", name: "Payer Co" },
    ],
    canManage: true,
  };
}

function stubFetch() {
  const priorFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/billing-relationships")) return Response.json(populatedPayload());
    return Response.json({}, { status: 404 });
  }) as typeof fetch;
  return () => {
    globalThis.fetch = priorFetch;
  };
}

function stripTab(label: string): HTMLButtonElement {
  const strip = document.querySelector("nav[aria-label='Billing']");
  assert.ok(strip, "the billing section must offer its sub-tab strip");
  const tab = [...strip.querySelectorAll("button")].find((button) =>
    button.textContent?.includes(label),
  );
  assert.ok(tab, `the strip must offer the ${label} panel`);
  return tab as HTMLButtonElement;
}

function click(button: HTMLButtonElement) {
  button.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
}

/**
 * Children, relationships, and consolidation groups are separate concepts:
 * with all three populated, each renders in its own sub-tab body and no
 * two tables share the visible body. An open relationship draft survives
 * switching panels with its values intact.
 */
test("populated billing concepts render in separate panels with a durable draft", async (t) => {
  const restore = stubFetch();
  t.after(restore);
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <BillingRelationshipsSection partyId="party-1" editable />
      </NextIntlClientProvider>,
    );
    await tick();
    await tick();
  });
  // The section defers its load past mount, so let the fetch resolve too.
  await act(async () => {
    await tick();
    await tick();
  });
  t.after(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
  });

  // The strip names all three populated concepts.
  assert.ok(stripTab("Customers billed through here"), "the strip names children");
  assert.ok(stripTab("Billing relationships"), "the strip names relationships");
  assert.ok(stripTab("Consolidation details"), "the strip names groups");

  const hiddenGuard = (text: string): Element | null => {
    const match = [...document.querySelectorAll("td, dt")].find(
      (element) => element.textContent === text,
    );
    return match?.closest("div[hidden]") ?? null;
  };

  // Relationships focus by default; the other tables stay mounted but hidden.
  assert.equal(hiddenGuard("Bill Co"), null, "the relationship row starts visible");
  assert.ok(hiddenGuard("Child Co"), "the children table starts hidden");
  assert.ok(hiddenGuard("GRP · Group · cut-off day 15"), "the groups list starts hidden");

  await act(async () => {
    click(stripTab("Customers billed through here"));
    await tick();
  });
  assert.equal(hiddenGuard("Child Co"), null, "selecting children shows its table");
  assert.ok(hiddenGuard("Bill Co"), "the relationships table hides with its panel");
  assert.ok(
    [...document.querySelectorAll("td")].some(
      (cell) => cell.textContent === "2026-01-01 → No end date",
    ),
    "the children rows keep their effective-dated windows",
  );

  await act(async () => {
    click(stripTab("Billing relationships"));
    await tick();
  });
  const addButton = [...document.querySelectorAll("button")].find(
    (button) => button.textContent === "Add billing relationship",
  ) as HTMLButtonElement | undefined;
  assert.ok(addButton, "the relationships panel offers its form");
  await act(async () => {
    click(addButton);
    await tick();
  });
  const cancelButton = () =>
    [...document.querySelectorAll("button")].find((button) => button.textContent === "Cancel");
  assert.ok(cancelButton(), "opening the form shows the draft");

  await act(async () => {
    click(stripTab("Consolidation details"));
    await tick();
  });
  assert.equal(
    hiddenGuard("GRP · Group · cut-off day 15"),
    null,
    "selecting groups shows its mechanics",
  );
  await act(async () => {
    click(stripTab("Billing relationships"));
    await tick();
  });
  assert.ok(cancelButton(), "the open draft survives switching panels");
});
