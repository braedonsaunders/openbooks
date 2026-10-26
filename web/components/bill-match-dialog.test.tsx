import assert from "node:assert/strict";
import test from "node:test";
import { stubModules } from "../testing/stub-modules.ts";
import { bootJsdomEnvironment } from "../testing/jsdom-env.ts";

declare global {
  var __matchCalls: { url: string; init?: RequestInit }[] | undefined;
}

// The match dialog lists each unmatched stocked line with its open
// purchase-order lines and goods receipts, links the chosen ones, and
// keeps a refusal open in the dialog with the server's message.

// jsdom first: the dialog portals into document.body at render.
const { registerHooks } = await import("node:module");
await bootJsdomEnvironment({ url: "http://localhost:4800/ap/bills", matchMediaMatches: false });

stubModules({
  navigation: {
    source:
      "export function useRouter(){return {push(){},refresh(){}}}export function usePathname(){return '/ap/bills'}export function useSearchParams(){return new URLSearchParams()}",
  },
  intl: false,
  authz: false,
  features: false,
});

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "sonner") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export const toast={success(){},error(){}};export function Toaster(){return null}",
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
const messages = (await import("../messages/en")).default;
const { BillMatchDialog } = await import("./bill-match-dialog");

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

const CANDIDATES = {
  billNumber: "BILL-00001",
  billStatus: "approved",
  lines: [
    {
      billLineId: "bill-line-1",
      lineNumber: 1,
      itemId: "item-1",
      itemCode: "GRN-ETH-GUJI",
      itemName: "Guji",
      quantity: "2432.00000000",
      unit: "lb",
      matched: null,
      candidates: [
        {
          purchaseOrderId: "po-1",
          purchaseOrderNumber: "PO-00002",
          purchaseOrderLineId: "po-line-1",
          purchaseOrderLineNumber: 1,
          unit: "lb",
          unitPrice: "6",
          billableQuantity: "2432.0000",
          receipts: [
            {
              id: "rcpt-1",
              documentNumber: "RCPT-00001",
              documentDate: "2025-12-01",
              status: "approved",
            },
          ],
        },
      ],
    },
    {
      billLineId: "bill-line-2",
      lineNumber: 2,
      itemId: "item-2",
      itemCode: "GRN-GUA-ANT",
      itemName: "Antigua",
      quantity: "2128.00000000",
      unit: "lb",
      matched: null,
      candidates: [
        {
          purchaseOrderId: "po-1",
          purchaseOrderNumber: "PO-00002",
          purchaseOrderLineId: "po-line-2",
          purchaseOrderLineNumber: 2,
          unit: "lb",
          unitPrice: "5",
          billableQuantity: "2128.0000",
          receipts: [
            {
              id: "rcpt-1",
              documentNumber: "RCPT-00001",
              documentDate: "2025-12-01",
              status: "approved",
            },
          ],
        },
      ],
    },
  ],
};

function scriptFetch(handler: (url: string, init?: RequestInit) => Response | null) {
  const prior = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    (globalThis.__matchCalls ??= []).push({ url, init });
    return handler(url, init) ?? Response.json({});
  }) as typeof fetch;
  return () => {
    globalThis.fetch = prior;
  };
}

async function renderDialog(
  t: { after: (fn: () => void | Promise<void>) => void },
  onMatched: () => void,
) {
  globalThis.__matchCalls = [];
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  t.after(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
  });
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <BillMatchDialog billId="bill-id" onClose={() => {}} onMatched={onMatched} />
      </NextIntlClientProvider>,
    );
    await tick();
  });
  await tick();
  await tick();
}

function buttonsNamed(name: string): HTMLButtonElement[] {
  return [...document.querySelectorAll("button")].filter(
    (b) => b.textContent?.trim() === name,
  ) as HTMLButtonElement[];
}

async function click(button: HTMLButtonElement) {
  await act(async () => {
    button.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await tick();
  });
  await tick();
}

test("the dialog links the chosen lines and reports the match", async (t) => {
  let matched = false;
  const restoreFetch = scriptFetch((url, init) => {
    if (url === "/api/documents/bill-id/bill-match") {
      if ((init?.method ?? "GET") === "POST") {
        const body = JSON.parse(String(init?.body)) as {
          matches: { billLineId: string; purchaseOrderLineId: string }[];
        };
        assert.equal(body.matches.length, 2);
        return Response.json({ ok: true, matched: body.matches });
      }
      return Response.json(CANDIDATES);
    }
    return null;
  });
  t.after(restoreFetch);
  await renderDialog(t, () => {
    matched = true;
  });
  assert.match(document.body.textContent ?? "", /GRN-ETH-GUJI/);
  assert.match(document.body.textContent ?? "", /PO-00002 line 1/);
  assert.match(document.body.textContent ?? "", /RCPT-00001 \(2025-12-01\)/);
  const confirm = buttonsNamed("Match lines")[0];
  assert.ok(confirm, "both single-candidate lines preselect, so Match lines enables");
  await click(confirm);
  await tick();
  assert.equal(matched, true, "a successful match reports through onMatched");
});

test("a refused match stays open with the server message", async (t) => {
  const restoreFetch = scriptFetch((url, init) => {
    if (url === "/api/documents/bill-id/bill-match") {
      if ((init?.method ?? "GET") === "POST") {
        return Response.json(
          { error: "purchase order PO-00002 line 1 has only 0 received and unbilled" },
          { status: 422 },
        );
      }
      return Response.json(CANDIDATES);
    }
    return null;
  });
  t.after(restoreFetch);
  let matched = false;
  await renderDialog(t, () => {
    matched = true;
  });
  const confirm = buttonsNamed("Match lines")[0];
  assert.ok(confirm);
  await click(confirm);
  await tick();
  assert.equal(matched, false);
  const alert = document.querySelector('[role="alert"]');
  assert.ok(alert, "the refusal must read in the dialog, not as a toast");
  assert.match(alert.textContent ?? "", /only 0 received and unbilled/);
});
