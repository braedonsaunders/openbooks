import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

declare global {
  var __payToasts: { kind: string; message: string }[] | undefined;
  var __payRouter: { push(url: string): void; refresh(): void } | undefined;
  var __payConfirmCalls: { title: string; message: string; confirmLabel: string }[] | undefined;
}

// PaymentDrawer on the shared action path. Two deltas over the old code get
// their own guards here: a refused delete toasted without pinning (and a
// non-JSON body threw past the busy reset), and a refused auto-apply toasted
// without pinning. The void 202 pending-approval branch moved from an HTTP
// status read to the body's status field — same wire signal, so its toast is
// covered as a preservation test.

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
        url: "data:text/javascript,export async function confirmDialog(options){(globalThis.__payConfirmCalls??=[]).push(options);return true}",
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

async function mountPayment(
  doc: Record<string, unknown>,
  initialOpenItems: unknown[] = [],
  initialMode?: string,
  bankAccountId: string | null = null,
  allocations: unknown[] = [],
  locale = "en",
  localeMessages: typeof messages = messages,
) {
  globalThis.__payToasts = [];
  globalThis.__payRouter = { push() {}, refresh() {} };
  globalThis.__payConfirmCalls = [];
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale={locale} messages={localeMessages} timeZone="UTC">
        <MoneyProvider currency="USD">
          <PaymentDrawer
            payment={{ doc, bankAccountId, allocations: allocations as never, applied: [] }}
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
  let voidBody: unknown;
  const restoreFetch = scriptFetch((url, init) => {
    if (url === `/api/documents/${doc.id}/void` && init?.method === "POST") {
      voidBody = JSON.parse(String(init.body));
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
  assert.deepEqual(voidBody, {
    reason: "duplicate payment",
    expectedUpdatedAt: doc.updated_at,
  });
  assert.equal(document.querySelector('[role="alert"]'), null, "an accepted void pins nothing");
});

test("a refused void sends the drawer revision and pins the server reason", async (t) => {
  const doc = { ...DRAFT_DOC(), status: "posted" };
  let voidBody: unknown;
  const restoreFetch = scriptFetch((url, init) => {
    if (url === `/api/documents/${doc.id}/void` && init?.method === "POST") {
      voidBody = JSON.parse(String(init.body));
      return Response.json({ error: "The posting period is closed; use an open period." }, { status: 409 });
    }
    if (url.includes("/api/flows/record-state")) return approvalFixture();
    return null;
  });
  t.after(restoreFetch);
  const { unmount } = await mountPayment(doc);
  t.after(unmount);
  await click(buttonsNamed("Actions")[0]!);
  const voidAction = buttonsNamed("Void")[0];
  assert.ok(voidAction, "a posted payment offers the controlled void action");
  await click(voidAction);
  assert.deepEqual(voidBody, { reason: "duplicate payment", expectedUpdatedAt: doc.updated_at });
  assert.match(document.querySelector('[role="alert"]')?.textContent ?? "", /posting period is closed/i);
  assert.ok(
    (globalThis.__payToasts ?? []).some((toast) => toast.kind === "error" && /posting period is closed/i.test(toast.message)),
    "the server refusal is also announced as an error toast",
  );
  await click(buttonsNamed("Actions")[0]!);
  const retry = buttonsNamed("Void")[0];
  assert.ok(retry);
  assert.equal(retry.disabled, false, "a refused void releases its action for correction and retry");
});

test("a non-JSON post refusal keeps its fallback visible and releases the action", async (t) => {
  const doc = { ...DRAFT_DOC(), kind: "customer_payment" };
  let postBody: unknown;
  const restoreFetch = scriptFetch((url, init) => {
    if (url === "/api/payments/post-with-applications" && init?.method === "POST") {
      postBody = JSON.parse(String(init.body));
      return new Response("upstream proxy error", { status: 422, headers: { "content-type": "text/html" } });
    }
    if (url.includes("/api/flows/record-state")) return approvalFixture();
    return null;
  });
  t.after(restoreFetch);
  const item = {
    lineId: "invoice-line-1",
    entryNumber: "INV-1",
    postingDate: "2026-09-01",
    dueDate: null,
    documentNumber: "INV-1",
    documentKind: "customer_invoice",
    referenceNumber: null,
    amount: "250.00",
    applied: "0.00",
    open: "250.00",
    currency: "USD",
    transactionAmount: "250.00",
    transactionApplied: "0.00",
    transactionOpen: "250.00",
  };
  const { unmount } = await mountPayment(
    doc,
    [item],
    undefined,
    "bank-account-1",
    [{
      openLineId: "invoice-line-1",
      sourceTransactionAmount: "250.00",
      targetTransactionAmount: "250.00",
      settlementRate: "1",
      settlementRateSource: "same_currency",
      settlementRateReference: "same currency",
    }],
  );
  t.after(unmount);
  const actions = buttonsNamed("Actions")[0];
  assert.ok(actions);
  await click(actions);
  const post = [...document.querySelectorAll("button")].find((button) => /Pay & post/.test(button.textContent ?? "")) as HTMLButtonElement | undefined;
  assert.ok(post, "a valid draft payment offers Pay & post");
  assert.equal(post.disabled, false);
  await click(post);
  assert.deepEqual(postBody, {
    documentId: doc.id,
    expectedUpdatedAt: doc.updated_at,
    allocations: [{
      openLineId: "invoice-line-1",
      sourceTransactionAmount: "250.0000",
      targetTransactionAmount: "250.0000",
      settlementRate: "1",
      settlementRateSource: "same_currency",
      settlementRateReference: "same currency",
    }],
  });
  assert.match(document.querySelector('[role="alert"]')?.textContent ?? "", /Posting failed/);
  assert.doesNotMatch(document.querySelector('[role="alert"]')?.textContent ?? "", /SyntaxError|Unexpected token/);
  assert.ok(
    (globalThis.__payToasts ?? []).some((toast) => toast.kind === "error" && /Posting failed/.test(toast.message)),
    "the refused post remains announced after its persistent alert is rendered",
  );
  assert.equal(post.disabled, false, "the action is available again after the non-JSON refusal");
});

test("the drawer title shows the business reference instead of a sync handle", async (t) => {
  const doc = {
    ...DRAFT_DOC(),
    document_number: "salesInvoice:cf83a37e-8376-f111-a5be-7ced8d265cbd",
    reference_number: "RCPT-84",
  };
  const restoreFetch = scriptFetch((url) => {
    if (url.includes("/api/flows/record-state")) return approvalFixture();
    return null;
  });
  t.after(restoreFetch);
  const { unmount } = await mountPayment(doc);
  t.after(unmount);
  assert.match(document.body.textContent ?? "", /RCPT-84/);
  assert.doesNotMatch(document.body.textContent ?? "", /salesInvoice:cf83a37e/);
});

test("delete confirmation text reaches the real drawer in every locale", async () => {
  const { LOCALES } = await import("../../../i18n/config.ts");
  for (const { code: locale } of LOCALES) {
    const localeMessages = locale === "en"
      ? messages
      : (await import(`../../../messages/${locale}/index.ts`)).default as typeof messages;
    const strings = localeMessages as unknown as {
      common: { labels: { actions: string }; actions: { delete: string } };
      payments: { drawer: { deleteConfirmTitle: string; deleteConfirmBody: string; deleteConfirmAction: string } };
    };
    const restoreFetch = scriptFetch((url) => url.includes("/api/flows/record-state") ? approvalFixture() : null);
    const { unmount } = await mountPayment(DRAFT_DOC(), [], undefined, null, [], locale, localeMessages);
    try {
      await click(buttonsNamed(strings.common.labels.actions)[0]!);
      await click(buttonsNamed(strings.common.actions.delete)[0]!);
      assert.deepEqual(globalThis.__payConfirmCalls, [{
        title: strings.payments.drawer.deleteConfirmTitle,
        message: strings.payments.drawer.deleteConfirmBody,
        confirmLabel: strings.payments.drawer.deleteConfirmAction,
        tone: "danger",
      }], `${locale} confirmation should resolve from the drawer catalog`);
    } finally {
      await unmount();
      restoreFetch();
    }
  }
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

test("changing the payment date hides prior-date FX evidence while new rates load", async (t) => {
  const doc = { ...DRAFT_DOC(), document_date: "2026-09-17" };
  const item = { lineId: "bill-fx", entryNumber: "BILL-FX", postingDate: "2026-09-01", dueDate: null, documentNumber: "BILL-FX", documentKind: "vendor_bill", referenceNumber: null, amount: "100.00", applied: "0.00", open: "100.00", currency: "EUR", transactionAmount: "100.00", transactionApplied: "0.00", transactionOpen: "100.00" };
  const restoreFetch = scriptFetch((url) => url.includes("/settlement-rates") ? Response.json({ rates: [{ id: "fx-old", toCurrency: "EUR", rate: "0.80", asOf: "2026-09-17", source: "daily" }] }) : null);
  t.after(restoreFetch);
  const { unmount } = await mountPayment(doc, [item], "edit", null, [{ openLineId: "bill-fx", sourceTransactionAmount: "125.00", targetTransactionAmount: "100.00", settlementRate: "0.80", settlementRateSource: "provider", settlementRateReference: "daily · 2026-09-17", settlementFxRateId: "fx-old" }]);
  t.after(unmount);
  const date = document.querySelector('input[type="date"]') as HTMLInputElement;
  const evidence = [...document.querySelectorAll("select")].find((select) => [...select.options].some((option) => option.textContent?.includes("2026-09-17")));
  assert.ok(evidence, "the initially fetched FX evidence renders");
  globalThis.fetch = (async () => new Promise<Response>(() => {})) as typeof fetch;
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set?.call(date, "2026-09-18");
    date.dispatchEvent(new window.Event("input", { bubbles: true }));
    date.dispatchEvent(new window.Event("change", { bubbles: true }));
    await tick();
  });
  assert.equal([...evidence.options].some((option) => option.textContent?.includes("2026-09-17")), false);
});
