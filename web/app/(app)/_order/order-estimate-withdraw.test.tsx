// A quote awaiting approval offers Withdraw submission to the viewer who
// submitted it and to an approver of the kind, never to another estimator who
// holds only the create grant: the engine refuses that viewer, so the drawer
// must not offer the button.

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

const { bootJsdomEnvironment } = await import("../../../testing/jsdom-env");
await bootJsdomEnvironment({
  url: "http://localhost:4800/estimates?estimate=019f0000-0000-4000-8000-000000000005",
  matchMediaMatches: false,
  resizeObserver: false,
});

Object.assign(globalThis, {
  __estimateWithdrawRouter: { push() {}, replace() {}, refresh() {} },
});

const { registerHooks } = await import("node:module");
const { stubModules } = await import("../../../testing/stub-modules");
stubModules({
  navigation:
    "export function useRouter(){return globalThis.__estimateWithdrawRouter}export function usePathname(){return '/estimates'}export function useSearchParams(){return new URLSearchParams()}",
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
  status: "pending_approval",
  document_number: "EST-3001",
  currency: "USD",
  party_id: "customer-1",
  party_name: "Northwind Traders",
  document_date: "2026-10-01",
  due_date: "2026-10-31",
  memo: "",
  subtotal: "2400",
  tax_total: "0",
  total: "2400",
  updated_at: "2026-10-01T12:00:00.000000Z",
  custom: {},
  extra_dims: {},
};

const APPROVAL_STATE = {
  status: "pending_approval",
  pendingWith: [{ name: "Casey Controller", gateId: "gate-1", since: "2026-10-01T10:00:00.000Z" }],
  myActions: null,
};

async function mount(
  viewer: { submittedByViewer: boolean; canManage: boolean; canApprove: boolean },
  kind: "quote" | "sales_order" | "purchase_order" = "quote",
) {
  const prior = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    if (url.includes("/api/flows/record-state")) {
      return Response.json({
        approvalState: APPROVAL_STATE,
        history: [],
        failedRun: null,
        canRetry: false,
        neverSubmitted: false,
        submittedByViewer: viewer.submittedByViewer,
      });
    }
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
            kind={kind}
            parties={[]}
            accounts={[]}
            items={[]}
            taxCodes={[]}
            taxGroups={[]}
            departments={[]}
            projects={[]}
            subsidiaries={[]}
            segments={[]}
            canManage={viewer.canManage}
            canApprove={viewer.canApprove}
            closeHref="/estimates"
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
    (button) =>
      (button.textContent ?? "").trim() === "Actions" && button.hasAttribute("aria-expanded"),
  );
  assert.ok(trigger, "the Actions menu trigger renders");
  await act(async () => {
    (trigger as HTMLButtonElement).click();
    await tick(50);
  });
  for (let i = 0; i < 40; i++) {
    const text = document.body.textContent ?? "";
    if (/Pending with/.test(text)) break;
    await tick(50);
  }
  const buttons = [...document.querySelectorAll("button")].map(
    (button) => button.textContent?.trim() ?? "",
  );
  return {
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

test("a quote's submitter is offered Withdraw submission", async () => {
  const view = await mount({ submittedByViewer: true, canManage: true, canApprove: false });
  try {
    assert.ok(
      view.buttons.includes("Withdraw submission"),
      "the preparer must be able to recall their own quote",
    );
  } finally {
    await view.cleanup();
  }
});

test("an approver of quotes is offered Withdraw submission for a colleague's submission", async () => {
  const view = await mount({ submittedByViewer: false, canManage: false, canApprove: true });
  try {
    assert.ok(
      view.buttons.includes("Withdraw submission"),
      "the approve grant may withdraw a submission it did not make",
    );
  } finally {
    await view.cleanup();
  }
});

test("another estimator with only the create grant is not offered Withdraw submission", async () => {
  const view = await mount({ submittedByViewer: false, canManage: true, canApprove: false });
  try {
    assert.ok(
      !view.buttons.includes("Withdraw submission"),
      "a colleague without the approve grant would be refused, so no button renders",
    );
  } finally {
    await view.cleanup();
  }
});

for (const kind of ["sales_order", "purchase_order"] as const) {
  test(`the submitter of a pending ${kind} is offered Withdraw submission`, async () => {
    const view = await mount({ submittedByViewer: true, canManage: true, canApprove: true }, kind);
    try {
      assert.ok(view.buttons.includes("Withdraw submission"));
    } finally {
      await view.cleanup();
    }
  });
}

test("a quote submitter whose authoring and issue grants were removed is not offered withdrawal", async () => {
  const view = await mount({ submittedByViewer: true, canManage: false, canApprove: false });
  try {
    assert.ok(!view.buttons.includes("Withdraw submission"));
  } finally {
    await view.cleanup();
  }
});
