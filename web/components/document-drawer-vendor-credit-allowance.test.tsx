import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { stubModules } from "../testing/stub-modules.ts";
import { bootJsdomEnvironment } from "../testing/jsdom-env.ts";

declare global {
  var __drawerRouter: { push(url: string): void; refresh(): void } | undefined;
  var __drawerToasts: { kind: string; message: string }[] | undefined;
}

// A stocked vendor-credit line with no warehouse must still reach the
// receipt-or-allowance choice: the AP loader used to omit the drawer's
// inventory flag, and the return cell used to require a warehouse the
// vendor-credit grid cannot set — so the "Returns receipt" header rendered
// with no usable cell and the draft could never be posted. Real component
// coverage (only the network is scripted).

// jsdom first: the drawer reads browser globals at render.
const { registerHooks } = await import("node:module");
await bootJsdomEnvironment({ url: "http://localhost:4800/ap/bills", matchMediaMatches: false });

stubModules({
  navigation: {
    source:
      "export function useRouter(){return globalThis.__drawerRouter}export function usePathname(){return '/ap/bills'}export function useSearchParams(){return new URLSearchParams()}",
  },
  intl: false,
  authz: false,
  features: false,
});

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "next/link") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export default function Link(p){return p.children}",
      };
    }
    if (specifier === "sonner") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export const toast={success(){},error(){},warning(){}};export function Toaster(){return null}",
      };
    }
    if (specifier === "@/lib/confirm" || specifier.endsWith("/lib/confirm")) {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export async function confirmDialog(){return true}",
      };
    }
    if (specifier === "@/lib/prompt" || specifier.endsWith("/lib/prompt")) {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export async function promptDialog(){return null}",
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
const { MoneyProvider } = await import("./money-provider");
const { DocumentDrawer } = await import("./document-drawer");
const { DOC_KINDS } = await import("../lib/document-kinds");

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

// Stable across renders, like the server-loaded picker arrays production
// passes (see document-drawer-dirty.test.tsx).
const SEGMENTS: never[] = [];

function scriptFetch(handler: (url: string, init?: RequestInit) => Response | null) {
  const prior = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    return handler(url, init) ?? Response.json({});
  }) as typeof fetch;
  return () => {
    globalThis.fetch = prior;
  };
}

const STOCKED_ITEM = "damaged-bags-item";
const WAREHOUSE = "warehouse-main";

async function mountCreditDrawer({
  stockLocationId,
  sources,
}: {
  stockLocationId: string | null;
  sources: Record<string, unknown>[];
}) {
  globalThis.__drawerRouter = { push() {}, refresh() {} };
  globalThis.__drawerToasts = [];
  const restoreFetch = scriptFetch((url) =>
    url.startsWith("/api/inventory/returnable-sources") ? Response.json({ sources }) : null,
  );
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const vendorId = randomUUID();
  const doc = {
    id: randomUUID(),
    kind: "vendor_credit",
    status: "draft",
    document_number: "VCRED-00001",
    currency: "USD",
    party_id: vendorId,
    updated_at: "2026-09-17T12:00:00.000000Z",
    document_date: "2026-09-17",
    subsidiary_id: null,
    subtotal: "737.20",
    tax_total: "0.00",
    total: "737.20",
  };
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <MoneyProvider currency="USD">
          <DocumentDrawer
            payload={{
              doc,
              lines: [
                {
                  id: randomUUID(),
                  line_number: 1,
                  account_id: randomUUID(),
                  item_id: STOCKED_ITEM,
                  description: "Damaged bags",
                  quantity: "4",
                  unit_price: "184.30",
                  amount: "737.20",
                  stock_location_id: stockLocationId,
                  custom: {},
                },
              ],
            }}
            config={DOC_KINDS["vendor_credit"]!}
            basePath="/ap/bills"
            recordType="vendor_credit"
            parties={[]}
            accounts={[]}
            taxCodes={[]}
            taxGroups={[]}
            cards={[]}
            bankAccounts={[]}
            departments={[]}
            projects={[]}
            locations={[]}
            classes={[]}
            items={[{ id: STOCKED_ITEM, has_inventory_profile: true }]}
            subsidiaries={[]}
            headerDefs={[]}
            lineDefs={[]}
            segments={SEGMENTS}
            canCreate
            canPost
            initialMode="edit"
            layout={{ header: { groups: [] }, lines: { columns: [] }, actions: [] } as never}
          />
        </MoneyProvider>
      </NextIntlClientProvider>,
    );
    await tick();
  });
  await tick();
  await tick();
  return {
    host,
    async done() {
      await act(async () => root.unmount());
      host.remove();
      restoreFetch();
    },
  };
}

/** The return column's native select on the credit's stocked line. The drawer
 *  renders through a body portal, so queries run against the document. */
function returnCellSelect(): HTMLSelectElement {
  const grid = document.querySelector('[role="grid"]');
  assert.ok(grid, "the draft renders its lines grid");
  const selects = [...grid.querySelectorAll("select")];
  const match = selects.find((select) =>
    [...select.options].some((option) => option.value === "allowance"),
  );
  assert.ok(match, "the stocked line offers the return choice cell");
  return match as HTMLSelectElement;
}

test("a warehouseless stocked credit line offers the allowance with no receipts to return", async (t) => {
  const { done } = await mountCreditDrawer({ stockLocationId: null, sources: [] });
  t.after(done);

  assert.match(
    document.body.textContent ?? "",
    /Returns receipt/,
    "the return column header renders",
  );
  const select = returnCellSelect();
  const options = [...select.options].map((option) => [option.value, option.textContent?.trim()]);
  assert.ok(
    options.some(([value]) => value === ""),
    "the unfinished choice stays selectable",
  );
  assert.ok(
    options.some(
      ([value, label]) => value === "allowance" && label === "Allowance — no goods returned",
    ),
    "the allowance (no goods returned) is offered with no receipt in the list",
  );
});

test("a warehoused stocked credit line offers its receipt beside the allowance", async (t) => {
  const movementId = randomUUID();
  const { done } = await mountCreditDrawer({
    stockLocationId: WAREHOUSE,
    sources: [
      {
        movementId,
        movedAt: "2026-09-10",
        documentNumber: "BILL-00041",
        remaining: "10",
        lotId: null,
        lotCode: null,
        serialId: null,
        serialCode: null,
        itemId: STOCKED_ITEM,
        stockLocationId: WAREHOUSE,
      },
    ],
  });
  t.after(done);

  const select = returnCellSelect();
  const options = [...select.options].map((option) => [option.value, option.textContent?.trim()]);
  assert.ok(
    options.some(([value, label]) => value === movementId && label?.includes("BILL-00041")),
    "goods returned picks the receipt the warehouse received",
  );
  assert.ok(
    options.some(([value]) => value === "allowance"),
    "the allowance stays offered beside the receipt",
  );
});
