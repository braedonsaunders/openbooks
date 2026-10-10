import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { bootJsdomEnvironment } from "../../../testing/jsdom-env";
import { stubModules } from "../../../testing/stub-modules";

declare global {
  var __payRouter: { push(url: string): void; refresh(): void } | undefined;
}

// A draft receipt whose prerequisites are not met hid its only path to
// Posted: the Actions menu held a disabled Post that rendered
// near-invisible, with no reason. Post is now a primary header action for
// drafts in view mode, carrying its first blocker as visible text; when an
// on_submit flow governs the kind it reads Submit for approval.

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
      "export const toast={success(){},error(){},warning(){},info(){}};export function Toaster(){return null}",
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

const OPEN_ITEM = {
  lineId: "line-inv-4",
  entryNumber: "JE-1",
  postingDate: "2026-09-01",
  dueDate: null,
  documentNumber: "INV-00004",
  documentKind: "customer_invoice",
  referenceNumber: null,
  amount: "3500.00",
  applied: "0.00",
  open: "3500.00",
  currency: "USD",
  transactionAmount: "3500.00",
  transactionApplied: "0.00",
  transactionOpen: "3500.00",
  accountId: "receivable-1",
} as never;

const ALLOCATION = {
  openLineId: "line-inv-4",
  sourceTransactionAmount: "3500.00",
  targetTransactionAmount: "3500.00",
  settlementRate: "1",
  settlementRateSource: "same_currency",
  settlementRateReference: "same transaction currency",
} as never;

function draftDoc(kind: "customer_payment" | "vendor_payment" = "customer_payment") {
  return {
    id: randomUUID(),
    kind,
    status: "draft",
    document_number: kind === "vendor_payment" ? "PAY-00004" : "RCPT-00008",
    currency: "USD",
    party_id: "33333333-3333-4333-8333-333333333333",
    party_name: "Meridian Dynamics",
    updated_at: "2026-09-17T12:00:00.000000Z",
    document_date: "2026-09-17",
    reference_number: "ACH-881",
    memo: null,
    total: "3500.00",
    entry_id: null,
    bank_account_number: null,
    bank_account_name: null,
  };
}

async function renderDrawer(options: {
  bankAccountId: string | null;
  allocations: never[];
  openItems: never[];
  governedByFlow?: boolean;
  side?: "ar" | "ap";
}) {
  const side = options.side ?? "ar";
  const prior = globalThis.fetch;
  globalThis.fetch = (async () =>
    Response.json({ rates: [] })) as typeof fetch;
  globalThis.__payRouter = { push() {}, refresh() {} };
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <MoneyProvider currency="USD">
          <PaymentDrawer
            payment={{
              doc: draftDoc(options.side === "ap" ? "vendor_payment" : "customer_payment"),
              bankAccountId: options.bankAccountId,
              allocations: options.allocations,
              applied: [],
              governedByFlow: options.governedByFlow,
            }}
            initialOpenItems={options.openItems}
            parties={[]}
            bankAccounts={[]}
            side={side}
            basePath={side === "ap" ? "/payments" : "/receipts"}
            initialMode={"view" as never}
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
    done: async () => {
      globalThis.fetch = prior;
      await act(async () => {
        root.unmount();
      });
      host.remove();
    },
  };
}

test("a complete draft shows an enabled primary Post action", async () => {
  const { done } = await renderDrawer({
    bankAccountId: "bank-1",
    allocations: [ALLOCATION],
    openItems: [OPEN_ITEM],
  });
  let postRequest: { url: string; init?: RequestInit } | null = null;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "POST") postRequest = { url: String(input), init };
    return Response.json({ rates: [] });
  }) as typeof fetch;
  try {
    const posts = buttonsNamed("Receive & post");
    assert.equal(posts.length, 1, "a complete draft must offer exactly one primary Post");
    assert.equal(posts[0]!.disabled, false, "no blocker means the primary Post is enabled");
    assert.ok(
      !(document.body.textContent ?? "").includes("Choose a deposit account"),
      "no blocker text may show when nothing blocks",
    );
    await act(async () => {
      posts[0]!.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
      await tick();
    });
    await tick();
    const request = postRequest as { url: string; init?: RequestInit } | null;
    assert.ok(request, "the primary Post must reach the post endpoint");
    assert.equal(request.url, "/api/payments/post-with-applications");
    assert.equal(request.init?.method, "POST");
    const body = JSON.parse(String(request.init?.body));
    assert.equal(body.allocations?.length, 1, "posting carries the valid allocations");
  } finally {
    await done();
  }
});

test("a draft without a deposit account names the blocker beside a disabled Post", async () => {
  const { done } = await renderDrawer({
    bankAccountId: null,
    allocations: [ALLOCATION],
    openItems: [OPEN_ITEM],
  });
  try {
    const posts = buttonsNamed("Receive & post");
    assert.equal(posts.length, 1, "Post stays visible even while blocked");
    assert.equal(posts[0]!.disabled, true, "a missing deposit account blocks posting");
    assert.ok(
      (document.body.textContent ?? "").includes("Choose a deposit account"),
      "the drawer must say the deposit account is missing",
    );
  } finally {
    await done();
  }
});

test("a draft with no applications names the blocker beside a disabled Post", async () => {
  const { done } = await renderDrawer({
    bankAccountId: "bank-1",
    allocations: [],
    openItems: [],
  });
  try {
    const posts = buttonsNamed("Receive & post");
    assert.equal(posts.length, 1, "Post stays visible even while blocked");
    assert.equal(posts[0]!.disabled, true, "no application blocks posting");
    assert.ok(
      (document.body.textContent ?? "").includes("Apply the receipt to at least one invoice"),
      "the drawer must say an application is missing",
    );
  } finally {
    await done();
  }
});

test("a flow-governed draft labels the primary action Submit for approval", async () => {
  const { done } = await renderDrawer({
    bankAccountId: "bank-1",
    allocations: [ALLOCATION],
    openItems: [OPEN_ITEM],
    governedByFlow: true,
  });
  try {
    const submits = buttonsNamed("Submit for approval");
    assert.equal(submits.length, 1, "a governed draft must offer Submit for approval");
    assert.equal(submits[0]!.disabled, false, "no blocker means the submit is enabled");
    assert.equal(buttonsNamed("Receive & post").length, 0, "the direct-post label must not show when governed");
  } finally {
    await done();
  }
});

test("a complete vendor draft shows an enabled primary Post action", async () => {
  const { done } = await renderDrawer({
    bankAccountId: "bank-1",
    allocations: [ALLOCATION],
    openItems: [OPEN_ITEM],
    side: "ap",
  });
  try {
    const posts = buttonsNamed("Pay & post");
    assert.equal(posts.length, 1, "a complete vendor draft must offer exactly one primary Post");
    assert.equal(posts[0]!.disabled, false, "no blocker means the primary Post is enabled");
  } finally {
    await done();
  }
});

test("a vendor draft without a paying account names the blocker beside a disabled Post", async () => {
  const { done } = await renderDrawer({
    bankAccountId: null,
    allocations: [ALLOCATION],
    openItems: [OPEN_ITEM],
    side: "ap",
  });
  try {
    const posts = buttonsNamed("Pay & post");
    assert.equal(posts.length, 1, "Post stays visible even while blocked");
    assert.equal(posts[0]!.disabled, true, "a missing paying account blocks posting");
    assert.ok(
      (document.body.textContent ?? "").includes("Choose a paying account"),
      "the drawer must say the paying account is missing",
    );
  } finally {
    await done();
  }
});

test("a vendor draft with no applications names the blocker beside a disabled Post", async () => {
  const { done } = await renderDrawer({
    bankAccountId: "bank-1",
    allocations: [],
    openItems: [],
    side: "ap",
  });
  try {
    const posts = buttonsNamed("Pay & post");
    assert.equal(posts.length, 1, "Post stays visible even while blocked");
    assert.equal(posts[0]!.disabled, true, "no application blocks posting");
    assert.ok(
      (document.body.textContent ?? "").includes("Apply the payment to at least one bill"),
      "the drawer must say a bill application is missing",
    );
  } finally {
    await done();
  }
});
