// A purchase order with a pending Flow gate shows Approve/Reject in the
// document drawer for the assigned approver even without the edit grant —
// decided through the same native gate path the Inbox uses. A viewer the
// gate's prevent-self-approval excludes sees "Awaiting another approver"
// with no decision actions, never an Approve that refuses on click.

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

const { bootJsdomEnvironment } = await import("../../../testing/jsdom-env");
await bootJsdomEnvironment({ url: "http://localhost:4800/purchase-orders?order=019f0000-0000-4000-8000-000000000004", matchMediaMatches: false, resizeObserver: false });

Object.assign(globalThis, {
  __orderGateRouter: { push() {}, replace() {}, refresh() {} },
});

const { registerHooks } = await import("node:module");
const { stubModules } = await import("../../../testing/stub-modules");
stubModules({ navigation: "export function useRouter(){return globalThis.__orderGateRouter}export function usePathname(){return '/purchase-orders'}export function useSearchParams(){return new URLSearchParams()}" });
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
  status: "pending_approval",
  document_number: "PO-2001",
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

function stateFor(approvalState: Record<string, unknown>) {
  return {
    approvalState,
    history: [],
    failedRun: null,
    canRetry: false,
    neverSubmitted: false,
  };
}

async function mount(approvalState: Record<string, unknown>) {
  const prior = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.includes("/api/flows/record-state")) return Response.json(stateFor(approvalState));
    return Response.json({});
  }) as typeof fetch;
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <MoneyProvider currency="USD">
          <OrderDrawer
            order={{ doc: DOC, lines: [], links: [] } as never}
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
            canManage={false}
            closeHref="/purchase-orders"
          />
        </MoneyProvider>
      </NextIntlClientProvider>,
    );
    await tick();
  });
  await tick(60);
  await tick(60);
  // Drawer header actions sit behind the "Actions" menu popover: open it,
  // then wait (bounded) for ApprovalActions to resolve record-state.
  const trigger = [...document.querySelectorAll("button")].find(
    (button) => (button.textContent ?? "").trim() === "Actions" && button.hasAttribute("aria-expanded"),
  );
  assert.ok(trigger, "the Actions menu trigger renders");
  await act(async () => {
    (trigger as HTMLButtonElement).click();
    await tick(50);
  });
  // The Approvals *tab* always names "Approvals", so the settle wait keys
  // on decision buttons and the SoD/pending chips — never bare /Approve/.
  for (let i = 0; i < 40; i++) {
    const names = [...document.querySelectorAll("button")].map((b) => b.textContent?.trim() ?? "");
    const text = document.body.textContent ?? "";
    if (names.includes("Approve") || names.includes("Reject") || /Awaiting another approver|Pending with/.test(text)) break;
    await tick(50);
  }
  // The drawer shell portals to document.body, so assertions read the body.
  const buttons = [...document.querySelectorAll("button")].map((button) => button.textContent?.trim() ?? "");
  return {
    text: document.body.textContent ?? "",
    buttons,
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

test("PO drawer offers Approve to a read-only gate assignee", async () => {
  const view = await mount({
    status: "pending",
    pendingWith: [{ name: "Casey Controller", gateId: "gate-1", since: "2026-09-01T10:00:00.000Z" }],
    myActions: { gateId: "gate-1", signatureRequired: false },
  });
  try {
    assert.ok(view.buttons.includes("Approve"), "the gate decision must render outside the edit grant");
    assert.ok(view.buttons.includes("Reject"), "reject renders with its reason field");
  } finally {
    await view.cleanup();
  }
});

test("PO drawer withholds Approve from a SoD-blocked viewer", async () => {
  const view = await mount({
    status: "pending",
    pendingWith: [{ name: "Casey Controller", gateId: "gate-1", since: "2026-09-01T10:00:00.000Z" }],
    myActions: null,
    awaitingAnotherApprover: true,
  });
  try {
    assert.match(view.text, /Awaiting another approver/, "the SoD outcome renders in advance");
    assert.ok(!view.buttons.includes("Approve"), "no Approve action is offered to the blocked viewer");
    assert.ok(!view.buttons.includes("Reject"), "no Reject action is offered to the blocked viewer");
  } finally {
    await view.cleanup();
  }
});
