// An approved purchase order viewed without the manage grant and without a
// conversion grant must not offer an Actions button that expands onto
// nothing (the document-drawer "never an empty menu" rule). A viewer that
// does hold a conversion grant keeps the menu with its entries.

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

const { bootJsdomEnvironment } = await import("../../../testing/jsdom-env");
await bootJsdomEnvironment({
  url: "http://localhost:4800/purchase-orders?order=019f0000-0000-4000-8000-000000000004",
  matchMediaMatches: false,
  resizeObserver: false,
});

Object.assign(globalThis, {
  __orderActionsRouter: { push() {}, replace() {}, refresh() {} },
});

const { registerHooks } = await import("node:module");
const { stubModules } = await import("../../../testing/stub-modules");
stubModules({
  navigation:
    "export function useRouter(){return globalThis.__orderActionsRouter}export function usePathname(){return '/purchase-orders'}export function useSearchParams(){return new URLSearchParams()}",
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
        url: "data:text/javascript,export const toast={success(){},error(){},warning(){},info(){}};export function Toaster(){return null}",
      };
    }
    if (specifier.endsWith("/lib/prompt")) {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export async function promptDialog(){return 'test reason'}",
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
const { OrderDrawer } = await import("./OrderDrawer");

const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

const DOC = {
  id: randomUUID(),
  status: "approved",
  document_number: "PO-3040",
  currency: "USD",
  party_id: "vendor-1",
  party_name: "Acme Supplies",
  document_date: "2026-09-17",
  due_date: "2026-10-17",
  memo: "",
  subtotal: "100",
  tax_total: "0",
  total: "100",
  updated_at: "2026-09-17T12:00:00.000000Z",
  custom: {},
  extra_dims: {},
};

function actionsTrigger(): HTMLButtonElement | undefined {
  return [...document.querySelectorAll("button")].find(
    (button) =>
      (button.textContent ?? "").trim() === "Actions" && button.hasAttribute("aria-expanded"),
  ) as HTMLButtonElement | undefined;
}

const LINE = {
  id: randomUUID(),
  item_id: null,
  account_id: "acct-6100",
  description: "Bulk grain",
  quantity: "3040",
  unit: "lb",
  unit_price: "10",
  tax_code_id: null,
  tax_group_id: null,
  department_id: null,
  project_id: null,
  stock_location_id: null,
  extra_dims: {},
};

async function mount(props: {
  canManage: boolean;
  allowedConvertKinds?: readonly string[];
  lines?: (typeof LINE)[];
}) {
  const prior = globalThis.fetch;
  globalThis.fetch = (async () =>
    Response.json({
      approvalState: { status: "approved", pendingWith: [], myActions: null },
      history: [],
      failedRun: null,
      canRetry: false,
      neverSubmitted: false,
    })) as typeof fetch;
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <MoneyProvider currency="USD">
          <OrderDrawer
            order={{ doc: DOC, lines: props.lines ?? [], links: [] } as never}
            initialMode={"view" as never}
            kind="purchase_order"
            parties={[]}
            accounts={[]}
            items={[]}
            taxCodes={[]}
            taxGroups={[]}
            departments={[]}
            projects={[]}
            subsidiaries={[]}
            segments={[]}
            canManage={props.canManage}
            allowedConvertKinds={props.allowedConvertKinds}
            closeHref="/purchase-orders"
          />
        </MoneyProvider>
      </NextIntlClientProvider>,
    );
    await tick();
  });
  await tick(60);
  await tick(60);
  return {
    cleanup: async () => {
      globalThis.fetch = prior;
      await act(async () => {
        root.unmount();
      });
      host.remove();
      for (const node of [...document.body.children]) node.remove();
    },
  };
}

test("an approved PO without manage or convert grants offers no Actions button", async (t) => {
  const view = await mount({ canManage: false, allowedConvertKinds: [] });
  t.after(view.cleanup);
  assert.equal(actionsTrigger(), undefined, "no empty Actions popover is offered");
});

test("an approved PO with a convert grant keeps the Actions menu", async (t) => {
  const view = await mount({ canManage: false, allowedConvertKinds: ["purchase_receipt"] });
  t.after(view.cleanup);
  const trigger = actionsTrigger();
  assert.ok(trigger, "the Actions menu trigger renders for a receiver");
  await act(async () => {
    trigger.click();
    await tick(50);
  });
  const buttons = [...document.querySelectorAll("button")].map(
    (button) => button.textContent?.trim() ?? "",
  );
  assert.ok(
    buttons.some((label) => /Goods receipt/.test(label)),
    "the receipt conversion entry renders",
  );
});

test("an approved PO with the manage grant keeps the Actions menu", async (t) => {
  const view = await mount({ canManage: true });
  t.after(view.cleanup);
  assert.ok(actionsTrigger(), "the Actions menu trigger renders for a manager");
});

test("an approved PO with the manage grant offers Amend with qty/price rows", async (t) => {
  const view = await mount({ canManage: true, lines: [LINE] });
  t.after(view.cleanup);
  const trigger = actionsTrigger();
  assert.ok(trigger, "the Actions menu trigger renders for a manager");
  await act(async () => {
    trigger.click();
    await tick(50);
  });
  const amend = [...document.querySelectorAll("button")].find(
    (button) => (button.textContent ?? "").trim() === "Amend",
  ) as HTMLButtonElement | undefined;
  assert.ok(amend, "the Amend entry renders for an approved purchase order");
  await act(async () => {
    amend.click();
    await tick(50);
  });
  await tick(60);
  const panel = document.querySelector(
    'section[aria-label="Amend approved quantities and prices"]',
  );
  assert.ok(panel, "the amendment panel opens after the reason prompt");
  const inputs = [...panel.querySelectorAll("input")].map(
    (input) => (input as HTMLInputElement).value,
  );
  assert.ok(inputs.includes("3040"), "the line quantity is editable in the panel");
  assert.ok(inputs.includes("10"), "the line unit price is editable in the panel");
});
