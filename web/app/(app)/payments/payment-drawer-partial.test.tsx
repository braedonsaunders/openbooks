import assert from "node:assert/strict";
import test from "node:test";
import { bootJsdomEnvironment } from "../../../testing/jsdom-env";
import { stubModules } from "../../../testing/stub-modules";

declare global {
  var __payToasts: { kind: string; message: string }[] | undefined;
  var __payRouter:
    { push(url: string): void; replace(url: string): void; refresh(): void } | undefined;
}

// A same-currency partial apply must stay valid: editing the Apply cell to
// less than the open balance keeps the row (source and target move
// together at 1:1) instead of dropping it with the invalid-allocation note.

await bootJsdomEnvironment({ url: "http://localhost:4800/payments", matchMediaMatches: false });

stubModules({
  navigation: {
    source:
      "export function useRouter(){return globalThis.__payRouter}" +
      "export function usePathname(){return '/payments'}" +
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
        url: "data:text/javascript,export async function promptDialog(){return 'duplicate payment'}",
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

const VENDOR_ID = "33333333-3333-4333-8333-333333333333";
const BANK_ID = "44444444-4444-4444-8444-444444444444";
const BILL_LINE = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";

const BILL_ITEM = {
  lineId: BILL_LINE,
  entryNumber: "AP-1",
  postingDate: "2026-09-01",
  dueDate: "2026-10-01",
  documentNumber: "BILL-101",
  documentKind: "vendor_bill",
  referenceNumber: null,
  amount: "8814.00",
  applied: "0.00",
  open: "8814.00",
  currency: "CAD",
  transactionAmount: "8814.00",
  transactionApplied: "0.00",
  transactionOpen: "8814.00",
  accountId: "ap-account",
};

const DRAFT_DOC = {
  id: "",
  kind: "vendor_payment",
  status: "draft",
  document_number: null,
  currency: "CAD",
  party_id: VENDOR_ID,
  party_name: "Acme Supplies",
  updated_at: "",
  document_date: "2026-10-01",
  total: "0",
  reference_number: null,
  memo: null,
  entry_id: null,
  bank_account_number: null,
  bank_account_name: null,
};

async function mountNewPayment(posts: unknown[]) {
  const prior = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/payments" && init?.method === "POST") {
      posts.push(JSON.parse(init.body as string));
      return Response.json({ doc: { id: "pay-1" } });
    }
    return Response.json({});
  }) as typeof fetch;
  globalThis.__payToasts = [];
  globalThis.__payRouter = { push() {}, replace() {}, refresh() {} };
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <MoneyProvider currency="CAD">
          <PaymentDrawer
            payment={{ doc: DRAFT_DOC, bankAccountId: BANK_ID, allocations: [], applied: [] }}
            initialOpenItems={[BILL_ITEM] as never}
            parties={[{ value: VENDOR_ID, label: "Acme Supplies" }] as never}
            bankAccounts={[{ value: BANK_ID, label: "Operating" }] as never}
            side="ap"
            basePath="/payments"
            closeHref="/payments"
            createMode
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
      globalThis.fetch = prior;
      await act(async () => {
        root.unmount();
      });
      host.remove();
    },
  };
}

function applyCheckbox(): HTMLInputElement {
  const box = [...document.querySelectorAll('input[type="checkbox"]')].find((el) =>
    el.getAttribute("aria-label")?.includes("BILL-101"),
  ) as HTMLInputElement | undefined;
  assert.ok(box, "the open bill offers an apply checkbox");
  return box!;
}

function applyInput(): HTMLInputElement {
  const inputs = [...document.querySelectorAll('input[inputmode="decimal"]')] as HTMLInputElement[];
  assert.equal(inputs.length, 1, "a same-currency line edits one apply amount");
  return inputs[0]!;
}

async function click(el: HTMLElement) {
  await act(async () => {
    el.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await tick();
  });
  await tick();
}

async function typeAmount(input: HTMLInputElement, text: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    input.focus();
    setter.call(input, "");
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
    for (const ch of text) {
      setter.call(input, input.value + ch);
      input.dispatchEvent(new window.Event("input", { bubbles: true }));
      await tick();
    }
    input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
    input.blur();
    await tick();
  });
  await tick();
}

function saves(): HTMLButtonElement[] {
  return [...document.querySelectorAll("button")].filter(
    (b) => b.textContent?.trim() === "Save",
  ) as HTMLButtonElement[];
}

test("a same-currency partial apply stays valid and posts the partial amount", async (t) => {
  const posts: unknown[] = [];
  const { unmount } = await mountNewPayment(posts);
  t.after(unmount);
  await click(applyCheckbox());
  assert.match(
    document.body.textContent ?? "",
    /Applying 1 item/,
    "checking the bill applies it in full",
  );
  await typeAmount(applyInput(), "3500");
  assert.doesNotMatch(
    document.body.textContent ?? "",
    /cross-foot/,
    "a partial same-currency apply is not an invalid allocation",
  );
  assert.match(
    document.body.textContent ?? "",
    /Applying 1 item/,
    "the partial apply still counts",
  );
  assert.match(document.body.textContent ?? "", /3,500/, "the footer totals the partial amount");
  await click(saves()[0]!);
  assert.equal(posts.length, 1, "one explicit save posts once");
  const body = posts[0] as { allocations: Record<string, unknown>[] };
  assert.equal(body.allocations.length, 1, "the partial apply posts one allocation");
  assert.deepEqual(
    [body.allocations[0]!.sourceTransactionAmount, body.allocations[0]!.targetTransactionAmount],
    ["3500.0000", "3500.0000"],
    "source and target move together at 1:1",
  );
  assert.equal(body.allocations[0]!.settlementRate, "1", "same-currency evidence stays intact");
});

test("applying more than the open balance stays refused", async (t) => {
  const posts: unknown[] = [];
  const { unmount } = await mountNewPayment(posts);
  t.after(unmount);
  await click(applyCheckbox());
  await typeAmount(applyInput(), "9000");
  assert.match(
    document.body.textContent ?? "",
    /cross-foot/,
    "an over-apply still refuses with the allocation note",
  );
  assert.match(
    document.body.textContent ?? "",
    /Applying 0 items/,
    "the over-apply drops out of the total",
  );
  assert.equal(posts.length, 0, "nothing posts on its own");
});
