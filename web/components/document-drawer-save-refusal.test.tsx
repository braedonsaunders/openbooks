import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

declare global {
  var __drawerRouter: { push(url: string): void; refresh(): void } | undefined;
  var __drawerToasts: { kind: string; message: string }[] | undefined;
  var __confirmCalls: unknown[] | undefined;
  var __confirmVerdict: boolean | undefined;
}

// Document saves on the shared action path (F-t03-002 lives here: a bill
// save 422 once toasted and moved on). A refused save pins the typed reason
// as a record-level alert until the next action AND toasts; a dead network
// used to throw past the busy reset (wedged Save, unhandled rejection) and
// now pins the localized fallback the same way, always releasing busy.
// (The Post-refusal pin, F-t03-004, is covered by
// document-drawer-post-refusal.test.tsx and must keep passing unchanged.)

// jsdom first: the drawer reads browser globals at render.
const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", {
  url: "http://localhost:4800/ar/invoices",
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

const { registerHooks } = await import("node:module");
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "next/navigation") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export function useRouter(){return globalThis.__drawerRouter}export function usePathname(){return '/ar/invoices'}export function useSearchParams(){return new URLSearchParams()}",
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
        url: "data:text/javascript,export const toast={success(m){(globalThis.__drawerToasts??=[]).push({kind:'success',message:String(m)})},error(m){(globalThis.__drawerToasts??=[]).push({kind:'error',message:String(m)})},warning(m){(globalThis.__drawerToasts??=[]).push({kind:'warning',message:String(m)})}};export function Toaster(){return null}",
      };
    }
    if (specifier === "@/lib/confirm" || specifier.endsWith("/lib/confirm")) {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export async function confirmDialog(opts){(globalThis.__confirmCalls??=[]).push(opts);return globalThis.__confirmVerdict ?? true}",
      };
    }
    if (specifier === "@/lib/prompt" || specifier.endsWith("/lib/prompt")) {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export async function promptDialog(){return null}",
      };
    }
    if (specifier.endsWith("/lib/client-scripts")) {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export async function runClientScripts(){return {ok:true,warnings:[]}}",
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
const messages = (await import("../messages/en")).default;
const { MoneyProvider } = await import("./money-provider");
const { DocumentDrawer } = await import("./document-drawer");
const { DOC_KINDS } = await import("../lib/document-kinds");

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

// Stable across renders, like the server-loaded picker arrays production
// passes (see document-drawer-dirty.test.tsx).
const SEGMENTS: never[] = [];

function scriptFetch(handler: (url: string, init?: RequestInit) => void | Response | null) {
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

async function mountDraftInvoice() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const doc = {
    id: randomUUID(),
    kind: "customer_invoice",
    status: "draft",
    document_number: "INV-00057",
    currency: "USD",
    updated_at: "2026-09-17T12:00:00.000000Z",
    document_date: "2026-09-17",
    subtotal: "100.00",
    tax_total: "0.00",
    total: "100.00",
  };
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <MoneyProvider currency="USD">
          <DocumentDrawer
            payload={{ doc, lines: [] }}
            config={DOC_KINDS["customer_invoice"]!}
            basePath="/ar/invoices"
            parties={[]}
            accounts={[]}
            taxCodes={[]}
            taxGroups={[]}
            cards={[]}
            bankAccounts={[]}
            departments={[]}
            projects={[]}
            locations={[]}
            classes={[]}
            items={[]}
            subsidiaries={[]}
            headerDefs={[]}
            lineDefs={[]}
            segments={SEGMENTS}
            canCreate
            canPost
            layout={{ header: { groups: [] }, lines: { columns: [] }, actions: [] } as never}
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

async function enterEditAndSave() {
  const edit = buttonsNamed("Edit")[0];
  assert.ok(edit, "a draft invoice must offer Edit");
  await click(edit);
  const save = buttonsNamed("Save")[0];
  assert.ok(save, "edit mode must offer Save");
  await click(save);
  await tick();
  return save;
}

function freshGlobals() {
  globalThis.__drawerRouter = { push() {}, refresh() {} };
  globalThis.__drawerToasts = [];
  globalThis.__confirmCalls = [];
  globalThis.__confirmVerdict = true;
}

// OM-09: the invoice as Sara left it — one booked line and her added line
// (OPS-W01 x2 @100, account empty, amount derived to 200.0000).
async function mountInvoiceWithAccountlessLine() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const doc = {
    id: randomUUID(),
    kind: "customer_invoice",
    status: "draft",
    document_number: "INV-00002",
    currency: "USD",
    updated_at: "2026-09-17T12:00:00.000000Z",
    document_date: "2026-09-17",
    subtotal: "1480.00",
    tax_total: "0.00",
    total: "1480.00",
  };
  const lines = [
    { id: randomUUID(), account_id: "income-acct", item_id: null, description: "booked", quantity: "1", unit_price: "1480", amount: "1480.0000" },
    { id: "", account_id: "", item_id: "OPS-W01", description: "field work", quantity: "2", unit_price: "100", amount: "200.0000" },
  ];
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <MoneyProvider currency="USD">
          <DocumentDrawer
            payload={{ doc, lines }}
            config={DOC_KINDS["customer_invoice"]!}
            basePath="/ar/invoices"
            parties={[]}
            accounts={[]}
            taxCodes={[]}
            taxGroups={[]}
            cards={[]}
            bankAccounts={[]}
            departments={[]}
            projects={[]}
            locations={[]}
            classes={[]}
            items={[]}
            subsidiaries={[]}
            headerDefs={[]}
            lineDefs={[]}
            segments={SEGMENTS}
            canCreate
            canPost
            layout={{ header: { groups: [] }, lines: { columns: [] }, actions: [] } as never}
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

test("a refused save pins the typed reason, not only a toast (F-t03-002)", async (t) => {
  freshGlobals();
  const restoreFetch = scriptFetch((url, init) => {
    if (url.startsWith("/api/documents/") && init?.method && init.method !== "GET") {
      return Response.json({ error: "AR is closed for this period and accounting book" }, { status: 422 });
    }
    return null;
  });
  t.after(restoreFetch);
  const { unmount } = await mountDraftInvoice();
  t.after(unmount);
  const save = await enterEditAndSave();
  const alert = document.querySelector('[role="alert"]');
  assert.ok(alert, "the save refusal must pin as an alert, not only toast");
  assert.match(alert.textContent ?? "", /AR is closed for this period/, "the alert must carry the typed reason");
  const toasts = globalThis.__drawerToasts ?? [];
  assert.ok(
    toasts.some((toast) => toast.kind === "error" && /AR is closed/.test(toast.message)),
    "the save refusal must also toast",
  );
  assert.equal(save.disabled, false, "busy must release after the refusal");
});

test("a dead network on save pins the fallback and releases Save", async (t) => {
  freshGlobals();
  const restoreFetch = scriptFetch((url, init) => {
    if (url.startsWith("/api/documents/") && init?.method && init.method !== "GET") {
      throw new TypeError("fetch failed");
    }
    return null;
  });
  t.after(restoreFetch);
  const { unmount } = await mountDraftInvoice();
  t.after(unmount);
  const save = await enterEditAndSave();
  const alert = document.querySelector('[role="alert"]');
  assert.ok(alert, "a transport failure must still pin an alert — it cannot throw past the UI");
  assert.match(alert.textContent ?? "", /Action failed/, "with no server reason the alert falls back to localized copy");
  const toasts = globalThis.__drawerToasts ?? [];
  assert.ok(
    toasts.some((toast) => toast.kind === "error"),
    "the transport failure must toast as an error",
  );
  assert.equal(save.disabled, false, "busy must release after a transport failure so the user can retry");
});

test("OM-09: saving with a contentful account-less line refuses by line name and keeps the row", async (t) => {
  freshGlobals();
  const writes: string[] = [];
  const restoreFetch = scriptFetch((url, init) => {
    if (url.startsWith("/api/documents/") && init?.method && init.method !== "GET") {
      writes.push(`${init.method} ${url}`);
    }
    return null;
  });
  t.after(restoreFetch);
  const { unmount } = await mountInvoiceWithAccountlessLine();
  t.after(unmount);
  const edit = buttonsNamed("Edit")[0];
  assert.ok(edit, "a draft invoice must offer Edit");
  await click(edit);
  // The footer prices the account-less $200 line instead of hiding it: the
  // operator reviews 1,680, not the booked 1,480.
  const digits = (document.body.textContent ?? "").replace(/[^0-9]/g, " ");
  assert.match(digits, /1\s*680/, "the footer must include the account-less line's amount");
  const save = buttonsNamed("Save")[0];
  assert.ok(save, "edit mode must offer Save");
  await click(save);
  await tick();
  assert.deepEqual(writes, [], "no document write may fire while a contentful line has no account");
  const alert = document.querySelector('[role="alert"]');
  assert.ok(alert, "the missing account must pin as an alert, not only toast");
  assert.match(alert.textContent ?? "", /Line 2: choose an account/, "the refusal must name the grid line and the remedy");
  const toasts = globalThis.__drawerToasts ?? [];
  assert.ok(
    toasts.some((toast) => toast.kind === "error" && /Line 2/.test(toast.message)),
    "the missing account must also toast with the line named",
  );
  // The entered row stays in state: the footer still shows 1,680, so the
  // $200 line is neither booked nor lost.
  const after = (document.body.textContent ?? "").replace(/[^0-9]/g, " ");
  assert.match(after, /1\s*680/, "the refused row must stay in the drawer with its amount priced");
  assert.equal(save.disabled, false, "busy must release after the refusal");
});
