import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { bootJsdomEnvironment } from "../../../testing/jsdom-env";
import { stubModules } from "../../../testing/stub-modules";

declare global {
  var __settleRouter:
    { push(url: string): void; refresh(): void; replace(url: string): void } | undefined;
  var __settleToasts: { kind: string; message: string }[] | undefined;
}

// Posting right after Save must not fire on the pre-save revision: the
// drawer holds Post disabled while the save settles (the refreshed record
// has not arrived yet) with the reason visible, and a genuine stale
// revision still refuses loudly — pinned plus toast, never silently
// nothing.

// jsdom first: the drawer reads browser globals at render.
await bootJsdomEnvironment({ url: "http://localhost:4800/receipts", matchMediaMatches: false });

stubModules({
  navigation: {
    source:
      "export function useRouter(){return globalThis.__settleRouter}" +
      "export function usePathname(){return '/receipts'}" +
      "export function useSearchParams(){return new URLSearchParams()}",
  },
  intl: false,
  authz: false,
  features: false,
  extra: {
    "next/link": "export default function Link(p){return p.children}",
    sonner:
      "export const toast={success(m){(globalThis.__settleToasts??=[]).push({kind:'success',message:String(m)})},error(m){(globalThis.__settleToasts??=[]).push({kind:'error',message:String(m)})},warning(){},info(){}};export function Toaster(){return null}",
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

function draftDoc(updatedAt: string) {
  return {
    id: randomUUID(),
    kind: "customer_payment",
    status: "draft",
    document_number: "RCPT-00008",
    currency: "USD",
    party_id: "33333333-3333-4333-8333-333333333333",
    party_name: "Meridian Dynamics",
    updated_at: updatedAt,
    document_date: "2026-09-17",
    reference_number: "ACH-881",
    memo: null,
    total: "3500.00",
    entry_id: null,
    bank_account_number: null,
    bank_account_name: null,
  };
}

function buttonsNamed(name: string): HTMLButtonElement[] {
  return [...document.querySelectorAll("button")].filter(
    (b) => b.textContent?.trim() === name,
  ) as HTMLButtonElement[];
}

async function renderDrawer(doc: ReturnType<typeof draftDoc>, mode: "view" | "edit") {
  globalThis.__settleRouter = { push() {}, refresh() {}, replace() {} };
  globalThis.__settleToasts = [];
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const render = async (next: ReturnType<typeof draftDoc>) => {
    await act(async () => {
      root.render(
        <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
          <MoneyProvider currency="USD">
            <PaymentDrawer
              payment={{
                doc: next,
                bankAccountId: "bank-1",
                allocations: [ALLOCATION],
                applied: [],
              }}
              initialOpenItems={[OPEN_ITEM]}
              parties={[]}
              bankAccounts={[]}
              side="ar"
              basePath="/receipts"
              initialMode={mode as never}
            />
          </MoneyProvider>
        </NextIntlClientProvider>,
      );
      await tick();
    });
    await tick();
  };
  await render(doc);
  return {
    render,
    done: async () => {
      await act(async () => {
        root.unmount();
      });
      host.remove();
    },
  };
}

test("one Post click right after Save posts on the revision the save committed", async () => {
  const posts: { body: Record<string, unknown> }[] = [];
  const saves: { url: string; body: Record<string, unknown> }[] = [];
  const prior = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("/api/payments/") && init?.method === "PATCH") {
      saves.push({ url, body: JSON.parse(String(init.body)) });
      // The save commits revision 42; the drawer still shows 41 until refresh.
      return Response.json({ doc: { updated_at: "42" } });
    }
    if (url === "/api/payments/post-with-applications") {
      posts.push({ body: JSON.parse(String(init?.body)) });
      return Response.json({ ok: true });
    }
    return Response.json({ rates: [] });
  }) as typeof fetch;
  const { done } = await renderDrawer(draftDoc("41"), "edit");
  try {
    const save = buttonsNamed("Save");
    assert.equal(save.length, 1, "edit mode offers Save");
    await act(async () => {
      save[0]!.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
      await tick();
      await tick();
    });
    await tick();
    // The refreshed record has not arrived yet, but the save response named
    // the committed revision: Post is live and the single click is not lost.
    const post = buttonsNamed("Receive & post");
    assert.equal(post.length, 1, "view mode offers the primary Post after save");
    assert.equal(post[0]!.disabled, false, "a save that reported its revision leaves Post live");
    assert.ok(
      !(document.body.textContent ?? "").includes("Saving…"),
      "no settling reason shows once the save committed",
    );
    await act(async () => {
      post[0]!.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
      await tick();
      await tick();
    });
    assert.equal(saves.length, 1, "the save reached the update endpoint once");
    assert.equal(
      saves[0]!.body.expectedUpdatedAt,
      "41",
      "the save is fenced on the loaded revision",
    );
    assert.equal(posts.length, 1, "the single Post click posts exactly once");
    assert.equal(
      (posts.at(0)!.body as { expectedUpdatedAt?: string }).expectedUpdatedAt,
      "42",
      "post carries the committed revision, not the pre-save token",
    );
  } finally {
    globalThis.fetch = prior;
    await done();
  }
});

test("a save without a committed revision holds Post until the refreshed record arrives", async () => {
  const posts: { body: Record<string, unknown> }[] = [];
  const prior = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("/api/payments/") && init?.method === "PATCH") {
      return Response.json({});
    }
    if (url === "/api/payments/post-with-applications") {
      posts.push({ body: JSON.parse(String(init?.body)) });
      return Response.json({ ok: true });
    }
    return Response.json({ rates: [] });
  }) as typeof fetch;
  const loaded = draftDoc("41");
  const { render, done } = await renderDrawer(loaded, "edit");
  try {
    const save = buttonsNamed("Save");
    await act(async () => {
      save[0]!.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
      await tick();
      await tick();
    });
    await tick();
    // Without a token the drawer cannot prove which revision to post on, so
    // Post stays disabled with the reason visible.
    const settling = buttonsNamed("Receive & post");
    assert.equal(settling.length, 1, "view mode offers the primary Post after save");
    assert.equal(settling[0]!.disabled, true, "post waits for the refreshed record");
    assert.ok(
      (document.body.textContent ?? "").includes("Saving…"),
      "the drawer says the save is settling",
    );
    await act(async () => {
      settling[0]!.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
      await tick();
    });
    assert.equal(posts.length, 0, "a settling post posts nothing");
    // The refresh delivers revision 42: Post enables and carries it.
    await render({ ...loaded, updated_at: "42" });
    const fresh = buttonsNamed("Receive & post");
    assert.equal(fresh.length, 1);
    assert.equal(fresh[0]!.disabled, false, "post enables once the record arrives");
    await act(async () => {
      fresh[0]!.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
      await tick();
      await tick();
    });
    assert.equal(posts.length, 1, "post fires after settling");
    assert.equal(
      (posts.at(0)!.body as { expectedUpdatedAt?: string }).expectedUpdatedAt,
      "42",
      "post carries the refreshed revision, not the pre-save token",
    );
  } finally {
    globalThis.fetch = prior;
    await done();
  }
});

test("a Post refused right after Save pins the server reason and toasts it", async () => {
  const prior = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("/api/payments/") && init?.method === "PATCH") {
      return Response.json({ doc: { updated_at: "42" } });
    }
    if (url === "/api/payments/post-with-applications") {
      return Response.json(
        {
          error: "this payment changed after you opened it; reload and review the latest revision",
        },
        { status: 409 },
      );
    }
    return Response.json({ rates: [] });
  }) as typeof fetch;
  const { done } = await renderDrawer(draftDoc("41"), "edit");
  try {
    const save = buttonsNamed("Save");
    await act(async () => {
      save[0]!.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
      await tick();
      await tick();
    });
    await tick();
    const post = buttonsNamed("Receive & post");
    assert.equal(post.length, 1);
    await act(async () => {
      post[0]!.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
      await tick();
      await tick();
    });
    await tick();
    const errors = (globalThis.__settleToasts ?? []).filter((toast) => toast.kind === "error");
    assert.ok(errors.length >= 1, "the refused post toasts instead of going silent");
    assert.ok(
      (document.body.textContent ?? "").includes("changed after you opened it"),
      "the refusal pins inline beside the record",
    );
    assert.equal(
      buttonsNamed("Receive & post")[0]?.disabled,
      false,
      "Post is available again after the refusal",
    );
  } finally {
    globalThis.fetch = prior;
    await done();
  }
});

test("a stale-revision post refuses loudly with a toast and an inline pin", async () => {
  const prior = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, _init?: RequestInit) => {
    if (String(input) === "/api/payments/post-with-applications") {
      return Response.json(
        {
          error: "this payment changed after you opened it; reload and review the latest revision",
        },
        { status: 409 },
      );
    }
    return Response.json({ rates: [] });
  }) as typeof fetch;
  const { done } = await renderDrawer(draftDoc("41"), "view");
  try {
    const posts = buttonsNamed("Receive & post");
    assert.equal(posts.length, 1);
    assert.equal(posts.at(0)!.disabled, false, "no save is settling, so post is live");
    await act(async () => {
      posts.at(0)!.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
      await tick();
      await tick();
    });
    await tick();
    const errors = (globalThis.__settleToasts ?? []).filter((toast) => toast.kind === "error");
    assert.ok(errors.length >= 1, "the refusal toasts instead of going silent");
    assert.ok(
      (document.body.textContent ?? "").includes("changed after you opened it"),
      "the refusal pins inline beside the record",
    );
  } finally {
    globalThis.fetch = prior;
    await done();
  }
});
