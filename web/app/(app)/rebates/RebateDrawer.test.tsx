import assert from "node:assert/strict";
import test from "node:test";

const { bootJsdomEnvironment } = await import("../../../testing/jsdom-env");
await bootJsdomEnvironment({ url: "http://localhost:4800/rebates", matchMediaMatches: false });

const state = { confirmCalls: 0, pushes: [] as string[] };
Object.assign(globalThis, {
  __rebateTestRouter: {
    push(path: string) {
      state.pushes.push(path);
    },
    refresh() {},
  },
  __rebateConfirmState: state,
});

const { stubModules } = await import("../../../testing/stub-modules");
stubModules({
  navigation: `export function useRouter(){return globalThis.__rebateTestRouter}export function usePathname(){return '/rebates'}export function useSearchParams(){return new URLSearchParams()}`,
});
const { registerHooks } = await import("node:module");
registerHooks({
  resolve(specifier, context, next) {
    const source =
      specifier === "next/link"
        ? `
      export default function Link(p){return globalThis.React.createElement('a',p,p.children)}
    `
        : specifier === "./confirm" && context.parentURL?.endsWith("/web/lib/use-dirty-close.ts")
          ? `
      export async function confirmDialog(){globalThis.__rebateConfirmState.confirmCalls += 1;return false}
    `
          : null;
    if (source === null) return next(specifier, context);
    return { shortCircuit: true, url: `data:text/javascript,${encodeURIComponent(source)}` };
  },
});

const React = await import("react");
Object.assign(globalThis, { React });
const { createRoot } = await import("react-dom/client");
const { act } = await import("react");
const { NextIntlClientProvider } = await import("next-intl");
const messages = (await import("../../../messages/en")).default;
const { MoneyProvider } = await import("../../../components/money-provider");
const { RebateDrawer } = await import("./RebateDrawer");

const drawerData = {
  agreement: {
    id: "agreement-1",
    code: "REB-1",
    name: "Spring rebate",
    status: "approved",
    subsidiary_id: "entity-1",
    side: "vendor",
    activity: "purchase",
    party_id: null,
    class_id: null,
    item_id: null,
    currency: "USD",
    effective_from: "2026-01-01",
    effective_to: "2026-12-31",
    method: "percent",
    tier_basis: "amount",
    tiers: [],
    target_unit_cost: null,
    margin_percent: null,
    stacking: "stack",
    tax_treatment: "outside_scope",
    settlement_tax_code_id: null,
    selection_group: "general",
    accrual_account_id: "a1",
    offset_account_id: "a2",
    fx_account_id: "a3",
    created_by: "operator-1",
  },
  claim: null,
  parties: [],
  banks: [],
  canPost: true,
  today: "2026-09-01",
  baseCurrency: "USD",
  sources: [{ lineId: "line-1", documentId: "document-1", label: "BILL-1 · Materials" }],
  closeHref: "/rebates",
};

test("a cost draft uses the shared decimal fields and cannot close without discarding confirmation", async (t) => {
  state.confirmCalls = 0;
  state.pushes.length = 0;
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
    for (const node of [...document.body.children]) node.remove();
  });

  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <MoneyProvider currency="USD">
          <RebateDrawer data={drawerData as never} />
        </MoneyProvider>
      </NextIntlClientProvider>,
    );
  });
  const costTab = [...document.querySelectorAll("button")].find(
    (button) => button.textContent?.trim() === "Cost evidence",
  );
  assert.ok(costTab);
  await act(async () => costTab.click());
  const moneyFields = [
    ...document.querySelectorAll<HTMLInputElement>('input[inputmode="decimal"]'),
  ];
  assert.equal(moneyFields.length, 2);
  assert.deepEqual(
    moneyFields.map((input) => input.getAttribute("aria-label")),
    ["Cost", "Resale amount"],
  );

  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
    setter?.call(moneyFields[0], "12.34");
    moneyFields[0]!.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
  const close = document.querySelector<HTMLButtonElement>(
    '[role=dialog] button[aria-label="Close"]',
  );
  assert.ok(close);
  await act(async () => close.click());

  assert.equal(state.confirmCalls, 1);
  assert.deepEqual(state.pushes, []);
  assert.ok(
    document.querySelector("[role=dialog]"),
    "the drawer remains open when discard is declined",
  );
});

test("settlement documents open in their customer or vendor document workspace", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as { claimId: string };
    const side = request.claimId.endsWith("customer") ? "customer" : "vendor";
    return new Response(
      JSON.stringify({
        documentId: "settlement-document",
        kind: side === "customer" ? "customer_credit" : "vendor_credit",
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  for (const side of ["customer", "vendor"] as const) {
    state.pushes.length = 0;
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    const data = {
      ...drawerData,
      agreement: { ...drawerData.agreement, side },
      claim: {
        id: `claim-${side}`,
        status: "approved",
        amount: "12.00",
        cutoff_on: "2026-08-31",
        settlement_document_id: null,
      },
    };
    await act(async () => {
      root.render(
        <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
          <MoneyProvider currency="USD">
            <RebateDrawer data={data as never} />
          </MoneyProvider>
        </NextIntlClientProvider>,
      );
    });
    try {
      const prepare = [...document.querySelectorAll("button")].find((button) =>
        button.textContent?.includes("Prepare"),
      );
      assert.ok(prepare);
      await act(async () => prepare.click());
      assert.deepEqual(state.pushes, [
        side === "customer"
          ? "/ar/invoices?doc=settlement-document"
          : "/ap/bills?doc=settlement-document",
      ]);
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }

    const settledData = {
      ...data,
      claim: { ...data.claim!, status: "settled", settlement_document_id: "settled-document" },
    };
    const settledHost = document.createElement("div");
    document.body.appendChild(settledHost);
    const settledRoot = createRoot(settledHost);
    await act(async () => {
      settledRoot.render(
        <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
          <MoneyProvider currency="USD">
            <RebateDrawer data={settledData as never} />
          </MoneyProvider>
        </NextIntlClientProvider>,
      );
    });
    try {
      assert.ok(
        document.querySelector(
          `a[href="${side === "customer" ? "/ar/invoices" : "/ap/bills"}?doc=settled-document"]`,
        ),
      );
    } finally {
      await act(async () => settledRoot.unmount());
      settledHost.remove();
    }
  }
});
