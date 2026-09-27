import assert from "node:assert/strict";
import test from "node:test";

// jsdom first: the widget reads browser globals at render.
const { bootJsdomEnvironment } = await import("../../../testing/jsdom-env");
await bootJsdomEnvironment({ url: "http://localhost:4800/dashboard", scrollIntoView: false, resizeObserver: false });

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

// Every pending-approval row links to the record href the server resolved
// for it (the same href the inbox row uses); a row whose kind has no record
// surface keeps the widget's generic list href.
const BILL_HREF = "/ap/bills?doc=b0000000-0000-0000-0000-000000000001";
const APPROVALS = [
  {
    id: "a0000000-0000-0000-0000-000000000001",
    targetKind: "vendor_bill",
    targetId: "b0000000-0000-0000-0000-000000000001",
    href: BILL_HREF,
    amount: "100.00",
    title: "VB-1",
    createdAt: "2026-09-20T12:00:00.000Z",
  },
  {
    id: "a0000000-0000-0000-0000-000000000002",
    targetKind: "unlinked_kind",
    targetId: "x0000000-0000-0000-0000-000000000002",
    href: null,
    amount: null,
    title: "UK-1",
    createdAt: "2026-09-21T12:00:00.000Z",
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

test("pending approval rows link to their resolved record, else the list", async (t) => {
  const { host, root } = await mount();
  t.after(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
  });
  await tick();
  assert.deepEqual(rowHrefs(host), [BILL_HREF, "/inbox?tab=all"]);
});
