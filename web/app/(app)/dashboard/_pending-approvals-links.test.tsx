import assert from "node:assert/strict";
import test from "node:test";

// jsdom first: the widget reads browser globals at render.
const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", {
  url: "http://localhost:4800/dashboard",
});
const globals = globalThis as Record<string, unknown>;
const domWindow = dom.window as unknown as Record<string, unknown>;
for (const key of ["window", "document", "navigator", "Node", "Element", "HTMLElement", "Event", "self"]) {
  if (globals[key] === undefined) globals[key] = domWindow[key];
}

const { registerHooks } = await import("node:module");
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "next/link") {
      // Render a real anchor (href visible) instead of children-only, so the
      // test asserts the row's destination, not just its text. React rides
      // globalThis (assigned below before render), since a data: URL has no
      // base to resolve 'react' from.
      return {
        shortCircuit: true,
        url: "data:text/javascript," + encodeURIComponent(
          "export default function Link(p){return globalThis.React.createElement('a',{href:typeof p.href==='string'?p.href:'#'},p.children)}",
        ),
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
const messages = (await import("../../../messages/en")).default;
const { MoneyProvider } = await import("../../../components/money-provider");
const { WidgetCard } = await import("./_widget-views");
import type { DashboardMetrics } from "./_metrics";

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

// F4T2-6: every pending-approval row deep-links to its record through the
// shared approvals resolver — the same href the inbox row uses — instead of
// the generic list href. A kind with no module surface keeps /inbox.
const BILL_ID = "b0000000-0000-0000-0000-000000000001";
const RUN_ID = "p0000000-0000-0000-0000-000000000002";
const APPROVALS = [
  {
    id: "a0000000-0000-0000-0000-000000000001",
    targetKind: "vendor_bill",
    targetId: BILL_ID,
    amount: "100.00",
    title: "VB-1",
    createdAt: "2026-09-20T12:00:00.000Z",
  },
  {
    id: "a0000000-0000-0000-0000-000000000002",
    targetKind: "pay_run",
    targetId: RUN_ID,
    amount: null,
    title: "PR-1",
    createdAt: "2026-09-21T12:00:00.000Z",
  },
  {
    id: "a0000000-0000-0000-0000-000000000003",
    targetKind: "party_bank_account",
    targetId: "x0000000-0000-0000-0000-000000000003",
    amount: null,
    title: "BA-1",
    createdAt: "2026-09-22T12:00:00.000Z",
  },
];

async function mount() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const data = { asOfDate: null, baseCurrency: "USD", pendingApprovalList: APPROVALS } as unknown as DashboardMetrics;
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <MoneyProvider currency="USD">
          <WidgetCard widgetId="list-pending-approvals" data={data} />
        </MoneyProvider>
      </NextIntlClientProvider>,
    );
    await tick();
  });
  return { host, root };
}

function rowHrefs(host: HTMLElement): string[] {
  return [...host.querySelectorAll("li a")].map((a) => a.getAttribute("href") ?? "");
}

test("pending approval rows deep-link to their records", async (t) => {
  const { host, root } = await mount();
  t.after(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
  });
  await tick();
  const hrefs = rowHrefs(host);
  assert.equal(hrefs.length, 3, `three approval rows must render, got ${JSON.stringify(hrefs)}`);
  assert.ok(hrefs.some((h) => h.includes(`/ap/bills?doc=${BILL_ID}`)), `bill row must deep-link, got ${JSON.stringify(hrefs)}`);
  assert.ok(hrefs.some((h) => h.includes(`/payroll/runs/${RUN_ID}`)), `pay-run row must deep-link, got ${JSON.stringify(hrefs)}`);
  assert.ok(
    hrefs.some((h) => h === "/inbox"),
    `a kind with no record drawer lands on the hub, got ${JSON.stringify(hrefs)}`,
  );
});
