import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

declare global {
  var __payToasts: { kind: string; message: string }[] | undefined;
  var __payRouter: { push(url: string): void; refresh(): void } | undefined;
}

// PaymentDrawer on the shared action path. Two deltas over the old code get
// their own guards here: a refused delete toasted without pinning (and a
// non-JSON body threw past the busy reset), and a refused auto-apply toasted
// without pinning. The void 202 pending-approval branch moved from an HTTP
// status read to the body's status field — same wire signal, so its toast is
// covered as a preservation test. (Save/post pins were already covered by
// PaymentDrawer.test.tsx source guards, migrated to the shared path there.)

// jsdom first: the drawer reads browser globals at render.
const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", {
  url: "http://localhost:4800/ap/payments",
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
if (!window.HTMLElement.prototype.scrollIntoView) {
  window.HTMLElement.prototype.scrollIntoView = function () {};
}
if (typeof window.requestAnimationFrame !== "function") {
  window.requestAnimationFrame = ((cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 16)) as unknown as typeof window.requestAnimationFrame;
  window.cancelAnimationFrame = ((id: number) => clearTimeout(id)) as unknown as typeof window.cancelAnimationFrame;
}

const { registerHooks } = await import("node:module");
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "next/navigation") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export function useRouter(){return globalThis.__payRouter}export function usePathname(){return '/ap/payments'}export function useSearchParams(){return new URLSearchParams()}",
      };
    }
    if (specifier === "next/link") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export default function Link(p){return p.children}",
      };
    }
    if (specifier === "sonner") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export const toast={success(m){(globalThis.__payToasts??=[]).push({kind:'success',message:String(m)})},error(m){(globalThis.__payToasts??=[]).push({kind:'error',message:String(m)})},warning(m){(globalThis.__payToasts??=[]).push({kind:'warning',message:String(m)})},info(m){(globalThis.__payToasts??=[]).push({kind:'info',message:String(m)})}};export function Toaster(){return null}",
      };
    }
    if (specifier.endsWith("/lib/confirm")) {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export async function confirmDialog(){return true}",
      };
    }
    if (specifier.endsWith("/lib/prompt")) {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export async function promptDialog(){return 'duplicate payment'}",
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
const { PaymentDrawer } = await import("./PaymentDrawer");

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

function scriptFetch(handler: (url: string, init?: RequestInit) => Response | null) {
  const prior = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    return handler(url, init) ?? Response.json({});
  }) as typeof fetch;
  return () => {
    globalThis.fetch = prior;
  };
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

function approvalFixture() {
  return Response.json({
    approvalState: { status: "none", pendingWith: [], myActions: null },
    history: [],
    failedRun: null,
    canRetry: false,
    neverSubmitted: true,
  });
}

async function mountPayment(doc: Record<string, unknown>, initialOpenItems: unknown[] = [], initialMode?: string) {
  globalThis.__payToasts = [];
  globalThis.__payRouter = { push() {}, refresh() {} };
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <MoneyProvider currency="USD">
          <PaymentDrawer
            payment={{ doc, bankAccountId: null, allocations: [], applied: [] }}
            initialOpenItems={initialOpenItems as never}
            parties={[]}
            bankAccounts={[]}
            side="ap"
            basePath="/ap/payments"
            initialMode={initialMode as never}
          />
        </MoneyProvider>
      </NextIntlClientProvider>,
    );
    await tick();
  });
  await tick();
  await tick();
  return {
    unmount: async () => {
      await act(async () => {
        root.unmount();
      });
      host.remove();
    },
  };
}

const DRAFT_DOC = () => ({
  id: randomUUID(),
  kind: "vendor_payment",
  status: "draft",
  document_number: "PAY-00031",
  currency: "USD",
  party_id: "33333333-3333-4333-8333-333333333333",
  party_name: "Acme Corp",
  updated_at: "2026-09-17T12:00:00.000000Z",
  document_date: "2026-09-17",
  total: "250.00",
});

test("a refused delete pins the reason instead of toasting into the void", async (t) => {
  const doc = DRAFT_DOC();
  const restoreFetch = scriptFetch((url, init) => {
    if (url === `/api/payments/${doc.id}` && init?.method === "DELETE") {
      return Response.json({ error: "Payment has allocations applied" }, { status: 422 });
    }
    if (url.includes("/api/flows/record-state")) return approvalFixture();
    return null;
  });
  t.after(restoreFetch);
  const { unmount } = await mountPayment(doc);
  t.after(unmount);
  const menu = buttonsNamed("Actions")[0];
  assert.ok(menu, "record actions must live behind the Actions menu");
  await click(menu);
  const del = buttonsNamed("Delete")[0];
  assert.ok(del, "a draft payment must offer Delete");
  await click(del);
  await tick();
  const alert = document.querySelector('[role="alert"]');
  assert.ok(alert, "the delete refusal must pin as an alert, not vanish with the toast");
  assert.match(alert.textContent ?? "", /Payment has allocations applied/, "the alert must carry the server reason");
  const toasts = globalThis.__payToasts ?? [];
  assert.ok(
    toasts.some((toast) => toast.kind === "error" && /allocations applied/.test(toast.message)),
    "the delete refusal must also toast",
  );
  assert.equal(del.disabled, false, "busy must release after the refusal");
});

test("a void landing as pending approval still toasts submit, not voided", async (t) => {
  const doc = { ...DRAFT_DOC(), status: "posted" };
  const restoreFetch = scriptFetch((url, init) => {
    if (url === `/api/documents/${doc.id}/void` && init?.method === "POST") {
      return Response.json({ ok: true, status: "pending_approval" }, { status: 202 });
    }
    if (url.includes("/api/flows/record-state")) return approvalFixture();
    return null;
  });
  t.after(restoreFetch);
  const { unmount } = await mountPayment(doc);
  t.after(unmount);
  const menu = buttonsNamed("Actions")[0];
  assert.ok(menu, "record actions must live behind the Actions menu");
  await click(menu);
  const voidButton = buttonsNamed("Void")[0];
  assert.ok(voidButton, "a posted payment must offer Void");
  await click(voidButton);
  await tick();
  const toasts = globalThis.__payToasts ?? [];
  assert.ok(
    toasts.some((toast) => toast.kind === "success" && /Submit for approval/.test(toast.message)),
    "a pending-approval void must toast submit, never voided",
  );
  assert.ok(
    toasts.every((toast) => toast.kind !== "error"),
    "an accepted void must never toast an error",
  );
  assert.equal(document.querySelector('[role="alert"]'), null, "an accepted void pins nothing");
});

test("a refused auto-apply pins instead of toasting into the void", async (t) => {
  const doc = DRAFT_DOC();
  const restoreFetch = scriptFetch((url, init) => {
    if (url === "/api/payments/suggest" && init?.method === "POST") {
      return Response.json({ error: "No open items in USD" }, { status: 422 });
    }
    if (url.includes("/api/flows/record-state")) return approvalFixture();
    return null;
  });
  t.after(restoreFetch);
  const { unmount } = await mountPayment(doc, [
    {
      lineId: "l1",
      entryNumber: "BILL-1",
      postingDate: "2026-09-01",
      dueDate: null,
      documentNumber: "BILL-1",
      documentKind: "vendor_bill",
      referenceNumber: null,
      amount: "250.00",
      applied: "0.00",
      open: "250.00",
      currency: "USD",
      transactionAmount: "250.00",
      transactionOpen: "250.00",
    },
  ], "edit");
  t.after(unmount);
  const apply = buttonsNamed("Auto-apply")[0];
  assert.ok(apply, "edit mode with open items must offer Auto-apply");
  await click(apply);
  await tick();
  const alert = document.querySelector('[role="alert"]');
  assert.ok(alert, "the auto-apply refusal must pin as an alert, not vanish with the toast");
  assert.match(alert.textContent ?? "", /No open items in USD/, "the alert must carry the server reason");
});
