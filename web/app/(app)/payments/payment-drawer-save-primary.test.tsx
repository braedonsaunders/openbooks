import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { bootJsdomEnvironment } from "../../../testing/jsdom-env";
import { stubModules } from "../../../testing/stub-modules";

declare global {
  var __payToasts: { kind: string; message: string }[] | undefined;
  var __payRouter: { push(url: string): void; refresh(): void } | undefined;
}

// receipt/payment Save lived inside the Actions menu, so routine
// operators could not discover persistence. Save is now a primary header
// button in edit mode, beside Cancel — no Actions menu at all.

// jsdom first: the drawer reads browser globals at render.
await bootJsdomEnvironment({ url: "http://localhost:4800/receipts", matchMediaMatches: false });

stubModules({
  navigation: {
    source:
      "export function useRouter(){return globalThis.__payRouter}" +
      "export function usePathname(){return '/receipts'}" +
      "export function useSearchParams(){return new URLSearchParams()}",
  },
  intl: false,
  authz: false,
  features: false,
  extra: {
    "next/link": "export default function Link(p){return p.children}",
    sonner:
      "export const toast={success(m){(globalThis.__payToasts??=[]).push({kind:'success',message:String(m)})},error(m){(globalThis.__payToasts??=[]).push({kind:'error',message:String(m)})},warning(m){(globalThis.__payToasts??=[]).push({kind:'warning',message:String(m)})},info(m){(globalThis.__payToasts??=[]).push({kind:'info',message:String(m)})}};export function Toaster(){return null}",
  },
});

// Confirm/prompt doubles stay suffix-wired: shared components import them
// through several relative spellings plus `@/`, which one exact key cannot name.
const { registerHooks: registerConfirmHooks } = await import("node:module");
registerConfirmHooks({
  resolve(specifier, context, next) {
    if (specifier.endsWith("/lib/confirm")) {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export async function confirmDialog(){return true}",
      };
    }
    if (specifier.endsWith("/lib/prompt")) {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export async function promptDialog(){return 'duplicate receipt'}",
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
const { PaymentDrawer } = await import("./PaymentDrawer");

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

function buttonsNamed(name: string): HTMLButtonElement[] {
  return [...document.querySelectorAll("button")].filter(
    (b) => b.textContent?.trim() === name,
  ) as HTMLButtonElement[];
}

const DRAFT_RECEIPT = () => ({
  id: randomUUID(),
  kind: "customer_payment",
  status: "draft",
  document_number: "RCPT-00049",
  currency: "USD",
  party_id: "33333333-3333-4333-8333-333333333333",
  party_name: "Meridian Dynamics",
  updated_at: "2026-09-17T12:00:00.000000Z",
  document_date: "2026-09-17",
  total: "1480.00",
});

test("edit mode offers Save as a primary button, not inside the Actions menu", async (t) => {
  const prior = globalThis.fetch;
  let saveRequest: { url: string; init?: RequestInit } | null = null;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    saveRequest = { url: String(input), init };
    return Response.json({ error: "This payment changed; reload before saving." }, { status: 409 });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = prior;
  });
  globalThis.__payToasts = [];
  globalThis.__payRouter = { push() {}, refresh() {} };
  const doc = DRAFT_RECEIPT();
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <MoneyProvider currency="USD">
          <PaymentDrawer
            payment={{ doc, bankAccountId: null, allocations: [], applied: [] }}
            initialOpenItems={[] as never}
            parties={[]}
            bankAccounts={[]}
            side="ar"
            basePath="/receipts"
            initialMode={"edit" as never}
          />
        </MoneyProvider>
      </NextIntlClientProvider>,
    );
    await tick();
  });
  await tick();
  await tick();
  t.after(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
  });
  assert.equal(buttonsNamed("Actions").length, 0, "edit mode must not hide persistence behind an Actions menu");
  const saves = buttonsNamed("Save");
  assert.equal(saves.length, 1, "edit mode must offer exactly one primary Save button");
  assert.ok(buttonsNamed("Cancel").length >= 1, "edit mode keeps Cancel beside Save");
  await act(async () => {
    saves[0]!.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await tick();
  });
  const request = saveRequest as { url: string; init?: RequestInit } | null;
  assert.ok(request, "saving an existing payment reaches its update endpoint");
  assert.equal(request.url, `/api/payments/${doc.id}`);
  assert.equal(request.init?.method, "PATCH");
  assert.equal(
    JSON.parse(String(request.init?.body)).expectedUpdatedAt,
    "2026-09-17T12:00:00.000000Z",
    "the write is fenced by the revision loaded into the drawer",
  );
  assert.match(document.querySelector('[role="alert"]')?.textContent ?? "", /payment changed; reload/i);
  assert.ok(
    (globalThis.__payToasts ?? []).some((toast) => toast.kind === "error" && /payment changed; reload/i.test(toast.message)),
    "the save refusal is announced as an error toast as well as a persistent alert",
  );
  assert.equal(saves[0]!.disabled, false, "the primary action is enabled after the refusal");
});

test("stored-value tenders replace allocations and retain drafts while unreadable amounts refuse precisely", async () => {
  const prior = globalThis.fetch;
  const writes: string[] = [];
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    if (init?.method && init.method !== 'GET') writes.push(String(input));
    return Response.json({ rows: [], credits: [], attachments: [] });
  }) as typeof fetch;
  globalThis.__payRouter = { push() {}, refresh() {} };
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => {
      root.render(<NextIntlClientProvider locale="en" messages={messages} timeZone="UTC"><MoneyProvider currency="USD"><PaymentDrawer
        payment={{ doc: DRAFT_RECEIPT(), bankAccountId: null, allocations: [], applied: [] }} initialOpenItems={[]} parties={[]} bankAccounts={[]} side="ar" basePath="/receipts" initialMode="edit"
        storedValue={{ customerCredits: [], tenders: [{ accountId: 'gift-a', codeLast4: '1234', amount: '1.23456' }] }}
      /></MoneyProvider></NextIntlClientProvider>);
      await tick();
    });
    await act(async () => { await tick(); await tick(); });
    const dialog = document.querySelector('[role="dialog"]')!;
    const code = dialog.querySelector<HTMLInputElement>('#sv-tender-code')!;
    assert.ok(code.closest('[hidden]'), 'tenders cannot stack below invoice allocations');
    async function panel(label: string) {
      const button = [...dialog.querySelectorAll<HTMLButtonElement>('button[aria-pressed]')].find(node => node.textContent?.trim() === label);
      assert.ok(button, `the native ${label} panel must remain reachable`);
      await act(async () => { button.click(); await tick(); });
    }
    await panel(messages.storedValue.payment.tenderLabel);
    assert.equal(code.closest('[hidden]'), null);
    assert.match(dialog.querySelector('[role="alert"]')?.textContent ?? '', /1234.*at most 4 decimal places.*5/s, 'excess precision cannot silently truncate into a valid total');
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(code, 'draft-gift-code');
      code.dispatchEvent(new window.Event('input', { bubbles: true }));
      await tick();
    });
    await panel(messages.common.auditTrail.tabs.details);
    await panel(messages.storedValue.payment.tenderLabel);
    assert.equal(document.querySelector('[role="dialog"]'), dialog);
    assert.equal(dialog.querySelector('#sv-tender-code'), code);
    assert.equal(code.value, 'draft-gift-code');
    const amount = dialog.querySelector<HTMLInputElement>('input[aria-label="' + messages.storedValue.labels.amount + '"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(amount, '12,34');
      amount.dispatchEvent(new window.Event('input', { bubbles: true }));
      await tick();
    });
    assert.match(dialog.querySelector('[role="alert"]')?.textContent ?? '', /12,34.*12\.34/s, 'a decimal comma must name its decimal remedy without changing the typed value');
    assert.equal(amount.value, '12,34');
    assert.deepEqual(writes, [], 'tab switching and invalid typed amounts cannot save or post');
  } finally { await act(async () => root.unmount()); host.remove(); globalThis.fetch = prior; }
});
