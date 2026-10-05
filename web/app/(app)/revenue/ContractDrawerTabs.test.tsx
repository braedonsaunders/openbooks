import assert from "node:assert/strict";
import test from "node:test";

// jsdom first: the drawer reads browser globals at render.
const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", {
  url: "http://localhost:4800/revenue/contracts/test-contract",
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

const { registerHooks } = await import("node:module");
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "next/link") {
      return {
        shortCircuit: true,
        // Record links render nothing here: tab separation is asserted on
        // the tables and headings, never on navigation targets.
        url: "data:text/javascript,export default function Link(){ return null }",
      };
    }
    return next(specifier, context);
  },
});

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
const React = await import("react");
Object.assign(globalThis, { React });
const { createRoot } = await import("react-dom/client");
const { act } = await import("react");
const { NextIntlClientProvider } = await import("next-intl");
const messages = (await import("../../../messages/en")).default as Record<string, unknown>;
const { MoneyProvider } = await import("@/components/money-provider");
const { ContractDrawer } = await import("./ContractDrawer");
type Payload = import("./_lib").ContractPayload;

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

function payload(): Payload {
  return {
    contract: {
      id: "contract-1",
      contract_number: "C-9",
      customer: "Acme",
      status: "active",
      currency: "USD",
      total_transaction_price: "1200.0000",
      starts_on: "2026-01-01",
      ends_on: "2026-12-31",
      scope: "invoice",
      source: null,
      sourceInvoiceId: null,
      sourceInvoiceNumber: null,
    },
    obligations: [
      {
        id: "ob-1",
        description: "Annual plan",
        allocated_price: "1200.0000",
        recognition_starts_on: "2026-01-01",
        recognition_ends_on: "2026-12-31",
        status: "open",
        method: "straight_line_even",
        rule_name: "straight-line",
        legacy_unverified: false,
        fair_value_flag: null,
        fair_value_low: null,
        fair_value_high: null,
        planned: "1200.0000",
        recognized: "100.0000",
        lines: [
          {
            period_name: "2026-01",
            period_ends_on: "2026-01-31",
            planned_amount: "100.0000",
            recognized_amount: "100.0000",
            journal_entry_id: "je-1",
          },
        ],
      },
    ],
    billings: [
      { id: "bill-1", document_number: "INV-1", amount: "1200.0000", billed_on: "2026-01-05" },
    ],
    position: {
      billed: "1200.0000",
      recognized: "100.0000",
      remaining: "1100.0000",
      net: "1100.0000",
      side: "liability",
    },
  };
}

function textOf(text: string): Element | null {
  const all = Array.from(document.querySelectorAll("span, h3, button"));
  return all.find((element) => element.textContent === text) ?? null;
}

function twoObligationPayload(): Payload {
  const base = payload();
  const [firstBase] = base.obligations;
  assert.ok(firstBase, "the base payload carries one obligation");
  const second = {
    ...firstBase,
    id: "ob-2",
    description: "Annual plan B",
    allocated_price: "600.0000",
    planned: "600.0000",
    recognized: "50.0000",
    lines: [
      {
        period_name: "2026-02",
        period_ends_on: "2026-02-28",
        planned_amount: "50.0000",
        recognized_amount: "50.0000",
        journal_entry_id: "je-2",
      },
    ],
  };
  return {
    ...base,
    obligations: [
      { ...firstBase, id: "ob-1", description: "Annual plan A" },
      second,
    ],
  };
}

function stripTab(label: string): HTMLButtonElement {
  const strip = document.querySelector("nav[aria-label='Contract sections']");
  assert.ok(strip, "the drawer must offer the Overview/Obligations strip");
  const tab = Array.from(strip.querySelectorAll("button")).find(
    (button) => button.textContent === label,
  );
  assert.ok(tab, `the strip must offer the ${label} sub-tab`);
  return tab as HTMLButtonElement;
}

function selectorButton(description: string): HTMLButtonElement {
  const selector = document.querySelector("section[aria-label='Obligations']");
  assert.ok(selector, "the obligations body must offer the selector list");
  const option = Array.from(selector.querySelectorAll("button")).find((button) =>
    button.textContent?.includes(description),
  );
  assert.ok(option, `the selector must name ${description}`);
  return option as HTMLButtonElement;
}

function click(button: HTMLButtonElement) {
  button.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
}

/**
 * Billings and recognition schedules are separate concepts: the billings
 * table and the obligation schedule table must render in separate sub-tab
 * bodies, with exactly one body visible at a time.
 */
test("billings and obligation schedules render in separate sub-tab bodies", async (t) => {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <MoneyProvider currency="USD">
          <ContractDrawer payload={payload()} canRun={false} />
        </MoneyProvider>
      </NextIntlClientProvider>,
    );
    await tick();
    await tick();
  });
  t.after(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
  });

  const strip = document.querySelector("nav[aria-label='Contract sections']");
  assert.ok(strip, "the drawer must offer the Overview/Obligations strip");
  assert.match(strip.textContent ?? "", /Overview/, "the overview sub-tab names billings");
  assert.match(strip.textContent ?? "", /Obligations/, "the obligations sub-tab names schedules");

  const billingsHeading = textOf("Billings");
  assert.ok(billingsHeading, "the billings table keeps its heading");
  assert.equal(
    billingsHeading.closest("div[hidden]"),
    null,
    "the billings body starts visible, not stacked under a hidden guard",
  );

  const scheduleHeading = textOf("Recognition schedule");
  assert.ok(scheduleHeading, "the obligation schedule keeps its title");
  assert.ok(
    scheduleHeading.closest("div[hidden]"),
    "the schedule body starts hidden behind the Obligations sub-tab",
  );
});

/**
 * Obligations follow the parent-child workflow: the selector names each
 * obligation once, and selecting one shows only its recognition schedule
 * in the focused pane — the sibling obligation's periods never render.
 */
test("selecting an obligation shows only its recognition schedule", async (t) => {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <MoneyProvider currency="USD">
          <ContractDrawer payload={twoObligationPayload()} canRun={false} />
        </MoneyProvider>
      </NextIntlClientProvider>,
    );
    await tick();
    await tick();
  });
  t.after(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
  });

  await act(async () => {
    click(stripTab("Obligations"));
    await tick();
  });

  assert.ok(
    selectorButton("Annual plan A"),
    "the selector names the first obligation",
  );
  assert.ok(
    selectorButton("Annual plan B"),
    "the selector names the second obligation",
  );

  // The focused pane is the single detail section named for the selection:
  // the sibling obligation's pane never renders beside it.
  let pane = document.querySelector("section[aria-label='Annual plan A']");
  assert.ok(pane, "the default selection focuses the first obligation");
  assert.equal(
    document.querySelector("section[aria-label='Annual plan B']"),
    null,
    "the sibling obligation renders no schedule pane",
  );
  assert.match(
    pane.textContent ?? "",
    /2026-01/,
    "the focused pane shows the selected obligation's period",
  );

  await act(async () => {
    click(selectorButton("Annual plan B"));
    await tick();
  });

  pane = document.querySelector("section[aria-label='Annual plan B']");
  assert.ok(pane, "selecting the second obligation focuses its pane");
  assert.equal(
    document.querySelector("section[aria-label='Annual plan A']"),
    null,
    "the first obligation's pane leaves with its selection",
  );
  assert.match(
    pane.textContent ?? "",
    /2026-02/,
    "the focused pane shows the newly selected obligation's period",
  );
  assert.doesNotMatch(
    pane.textContent ?? "",
    /2026-01/,
    "the previously selected period leaves the focused pane",
  );
});
