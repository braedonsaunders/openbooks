import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

declare global {
  var __drawerRouter: { push(url: string): void; refresh(): void } | undefined;
  var __drawerToasts: { kind: string; message: string }[] | undefined;
  var __confirmCalls: unknown[] | undefined;
  var __confirmVerdict: boolean | undefined;
}

// F-t02-003: a dirty document drawer must not close silently, and Save must be
// a visible header action in edit mode — not buried in the Actions menu.

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
        url: "data:text/javascript,export const toast={success(m){(globalThis.__drawerToasts??=[]).push({kind:'success',message:String(m)})},error(m){(globalThis.__drawerToasts??=[]).push({kind:'error',message:String(m)})}};export function Toaster(){return null}",
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
// passes: the drawer's dirty tracking compares payload identity, and an
// omitted segments prop defaults to a fresh [] on every render, which reads
// as an edit the moment edit mode re-renders.
const SEGMENTS: never[] = [];

function scriptFetch(handler: (url: string) => Response | null) {
  const prior = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    return handler(url) ?? Response.json({});
  }) as typeof fetch;
  return () => {
    globalThis.fetch = prior;
  };
}

async function mountDraftInvoice() {
  globalThis.__drawerRouter = { push() {}, refresh() {} };
  globalThis.__drawerToasts = [];
  globalThis.__confirmCalls = [];
  globalThis.__confirmVerdict = true;
  // Mount-time panel fetches must resolve, not reject: a rejection escaping a
  // settling handler flips dirty state and poisons the clean-editor case.
  const restoreFetch = scriptFetch(() => null);
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
            layout={{ header: { groups: [{ fields: [{ key: "memo", visible: true }] }] }, lines: { columns: [] }, actions: [] } as never}
          />
        </MoneyProvider>
      </NextIntlClientProvider>,
    );
    await tick();
  });
  await tick();
  await tick();
  return { host, root, restoreFetch };
}

function buttonsNamed(name: string): HTMLButtonElement[] {
  return [...document.querySelectorAll("button")].filter(
    (b) => b.textContent?.trim() === name,
  ) as HTMLButtonElement[];
}

function memoInput(): HTMLInputElement {
  const labels = [...document.querySelectorAll("label")].filter(
    (l) => l.textContent?.trim() === "Memo",
  );
  assert.equal(labels.length, 1, "the memo field must render in edit mode");
  const label = labels[0]!;
  const following = [...document.querySelectorAll("input")].filter(
    (input) => (label.compareDocumentPosition(input) & window.Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
  );
  assert.ok(following.length > 0, "the memo field must be an input in edit mode");
  return following[0] as HTMLInputElement;
}

async function typeMemo(value: string) {
  const input = memoInput();
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
    setter.call(input, value);
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
    await tick();
  });
  await tick();
}

async function enterEdit() {
  const edit = buttonsNamed("Edit")[0];
  assert.ok(edit, "an Edit action must render in view mode");
  await click(edit);
  assert.equal(buttonsNamed("Save").length, 1, "edit mode must offer a header Save");
}

async function click(button: HTMLButtonElement) {
  await act(async () => {
    button.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await tick();
  });
  await tick();
}

test("edit mode offers Save as a header action without opening the Actions menu", async (t) => {
  const { host, root, restoreFetch } = await mountDraftInvoice();
  await enterEdit();
  t.after(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
    restoreFetch();
  });
  assert.equal(buttonsNamed("Save").length, 1, "exactly one header Save must render in edit mode");
  assert.equal(buttonsNamed("Cancel").length, 1, "Cancel stays beside Save in edit mode");
  const actions = [...document.querySelectorAll("button")].find((b) => b.textContent?.includes("Actions"));
  assert.ok(actions, "the Actions menu still renders");
  await click(actions as HTMLButtonElement);
  assert.equal(buttonsNamed("Save").length, 1, "Save must not duplicate inside the Actions menu");
});

test("cancelling a dirty editor asks first; declining keeps the edits", async (t) => {
  const { host, root, restoreFetch } = await mountDraftInvoice();
  await enterEdit();
  t.after(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
    restoreFetch();
  });
  await typeMemo("do not lose me");
  assert.match(document.body.textContent ?? "", /Unsaved changes/, "the footer must flag dirty state");
  globalThis.__confirmVerdict = false;
  await click(buttonsNamed("Cancel")[0]!);
  assert.equal(globalThis.__confirmCalls?.length, 1, "Cancel on a dirty editor must ask");
  const call = globalThis.__confirmCalls?.[0] as { confirmLabel?: string };
  assert.equal(call.confirmLabel, "Discard changes", "the confirm offers an explicit discard choice");
  assert.equal(buttonsNamed("Save").length, 1, "declining the discard must stay in edit mode");
  assert.equal(memoInput().value, "do not lose me", "declining the discard must keep the typed edits");
});

test("cancelling a clean editor does not prompt", async (t) => {
  const { host, root, restoreFetch } = await mountDraftInvoice();
  await enterEdit();
  t.after(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
    restoreFetch();
  });
  await click(buttonsNamed("Cancel")[0]!);
  assert.equal(globalThis.__confirmCalls?.length ?? 0, 0, "a clean cancel must not prompt");
  assert.equal(buttonsNamed("Edit").length, 1, "a clean cancel returns to view mode");
});

test("closing a dirty drawer via X asks first and keeps the drawer on decline", async (t) => {
  const { host, root, restoreFetch } = await mountDraftInvoice();
  await enterEdit();
  t.after(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
    restoreFetch();
  });
  await typeMemo("do not lose me either");
  const close = [...document.querySelectorAll("button[aria-label]")].find(
    (b) => b.getAttribute("aria-label") === "Close",
  ) as HTMLButtonElement | undefined;
  assert.ok(close, "the drawer chrome must render a labelled close button");
  globalThis.__confirmVerdict = false;
  await click(close!);
  assert.equal(globalThis.__confirmCalls?.length, 1, "X on a dirty drawer must ask");
  assert.equal(buttonsNamed("Save").length, 1, "declining the discard must leave the drawer open");
});
