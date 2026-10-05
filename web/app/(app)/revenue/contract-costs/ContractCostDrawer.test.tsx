import assert from "node:assert/strict";
import test from "node:test";

// jsdom first: the drawer reads browser globals at render.
const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", {
  url: "http://localhost:4800/revenue/contract-costs/test-asset",
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
        // Passthrough links: the drawer test asserts the per-period and
        // trail entry hrefs survive, so the stub must keep them.
        url: "data:text/javascript,export default function Link(p){return globalThis.React.createElement('a',{href:p.href,className:p.className},p.children)}",
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
const messages = (await import("../../../../messages/en")).default as Record<string, unknown>;
const { MoneyProvider } = await import("@/components/money-provider");
const { ContractCostDrawer } = await import("./ContractCostDrawer");
type Payload = import("./view").ContractCostAssetPayload;

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

function payload(): Payload {
  return {
    asset: {
      id: "asset-1",
      contractId: "contract-1",
      contractNumber: "C-9",
      customer: "Acme",
      salesRep: "Rep",
      costType: "commission",
      amount: "1200.0000",
      currency: "USD",
      capitalizedOn: "2026-01-01",
      amortStartOn: "2026-01-01",
      amortEndOn: "2026-12-31",
      method: "straight_line",
      status: "active",
      carrying: "1100.0000",
      capitalizeEntryId: "je-0",
    },
    schedule: [
      {
        month: "2026-01",
        periodId: "period-1",
        periodName: "2026-01",
        amount: "100.0000",
        posted: true,
        entryId: "je-1",
      },
      {
        month: "2026-02",
        periodId: "period-2",
        periodName: "2026-02",
        amount: "100.0000",
        posted: false,
        entryId: null,
      },
    ],
    entries: [
      { id: "je-1", origin: "contract_cost_amortization", postingDate: "2026-01-31", periodName: "2026-01" },
      { id: "je-0", origin: "contract_cost_capitalize", postingDate: "2026-01-01", periodName: "2026-01" },
    ],
  };
}

function stripTab(label: string): HTMLButtonElement {
  const strip = document.querySelector("nav[aria-label='C-9']");
  assert.ok(strip, "the drawer must offer the Schedule/Journal strip");
  const tab = [...strip.querySelectorAll("button")].find((button) => button.textContent === label);
  assert.ok(tab, `the strip must offer the ${label} panel`);
  return tab as HTMLButtonElement;
}

function headingOf(text: string): Element | null {
  return (
    [...document.querySelectorAll("h3")].find((element) => element.textContent === text) ?? null
  );
}

function click(button: HTMLButtonElement) {
  button.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
}

/**
 * The amortization schedule and the journal trail are separate concepts:
 * each renders in its own sub-tab body, per-period entry links survive
 * the split, and the two bodies never share visibility.
 */
test("schedule and journal trail render in separate panels with working entry links", async (t) => {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <MoneyProvider currency="USD">
          <ContractCostDrawer
            payload={payload()}
            canManage={false}
            canApprove={false}
            contracts={[]}
            policy={null}
            baseCurrency="USD"
          />
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

  // Headings collide with tab labels, so visibility reads the headings.
  const scheduleHeading = headingOf("Amortization schedule");
  assert.ok(scheduleHeading, "the schedule keeps its title");
  assert.equal(scheduleHeading.closest("div[hidden]"), null, "the schedule body starts visible");
  const journalHeading = headingOf("Journal trail");
  assert.ok(journalHeading, "the trail keeps its title");
  assert.ok(journalHeading.closest("div[hidden]"), "the journal body starts hidden");

  const postedLink = document.querySelector("a[href='/accounting/journal?entry=je-1']");
  assert.ok(postedLink, "the posted period keeps its journal link on the schedule");
  assert.equal(
    postedLink.closest("div[hidden]"),
    null,
    "the per-period entry link starts visible",
  );

  await act(async () => {
    click(stripTab("Journal trail"));
    await tick();
  });

  assert.equal(
    headingOf("Journal trail")?.closest("div[hidden]"),
    null,
    "selecting the journal tab shows the trail",
  );
  const trailLink = document.querySelector("a[href='/accounting/journal?entry=je-0']");
  assert.ok(trailLink, "the trail keeps its own entry link");
  assert.equal(trailLink.closest("div[hidden]"), null, "the trail link shows on its panel");
  assert.ok(
    headingOf("Amortization schedule")?.closest("div[hidden]"),
    "the schedule body hides while the trail shows",
  );

  await act(async () => {
    click(stripTab("Amortization schedule"));
    await tick();
  });
  assert.equal(
    headingOf("Amortization schedule")?.closest("div[hidden]"),
    null,
    "returning restores the schedule panel",
  );
  assert.ok(
    document.querySelector("a[href='/accounting/journal?entry=je-1']"),
    "the per-period entry link survives the round trip",
  );
});
