// F1-2: the journal drawer offers Post, Delete, Void (and Edit/Save) only
// with gl.post. The server refuses every one of those mutations without
// the permission, so a drawer that offers them anyway only manufactures
// refusals. Mounts drive the real drawer: without canPost no mutation
// button exists even behind the Actions menu, and a ?mode=edit deep link
// lands read-only instead of an unsavable editor.

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

// jsdom first: the drawer reads browser globals at render.
const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", {
  url: "http://localhost:4800/journal",
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
  window.cancelAnimationFrame = ((_id: number) => setTimeout(() => {}, 0)) as unknown as typeof window.cancelAnimationFrame;
}

const { registerHooks } = await import("node:module");
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "next/navigation") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export function useRouter(){return globalThis.__journalRouter}export function usePathname(){return '/journal'}export function useSearchParams(){return new URLSearchParams()}",
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
        url: "data:text/javascript,export const toast={success(){},error(){},warning(){},info(){}};export function Toaster(){return null}",
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
        url: "data:text/javascript,export async function promptDialog(){return 'duplicate entry'}",
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
const { JournalDrawer } = await import("./JournalDrawer");

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));
const TOKEN = "2026-09-17T12:00:00.000000Z";

const BALANCED_LINES = [
  { account_id: "a1", amount: "100.00", description: "leg one", party_id: "", department_id: "", project_id: "", subsidiary_id: "", custom: {}, extra_dims: {} },
  { account_id: "a2", amount: "-100.00", description: "leg two", party_id: "", department_id: "", project_id: "", subsidiary_id: "", custom: {}, extra_dims: {} },
];

function docWith(status: string) {
  return {
    id: randomUUID(),
    kind: "journal",
    status,
    document_number: "JE-00012",
    currency: "USD",
    updated_at: TOKEN,
    document_date: "2026-09-17",
    memo: "accrual",
    total: "0.00",
  };
}

function scriptFetch() {
  const prior = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.includes("/api/flows/record-state")) {
      return Response.json({
        approvalState: { status: "none", pendingWith: [], myActions: null },
        history: [],
        failedRun: null,
        canRetry: false,
        neverSubmitted: true,
      });
    }
    return Response.json({});
  }) as typeof fetch;
  return () => {
    globalThis.fetch = prior;
  };
}

async function mount(doc: Record<string, unknown>, canPost: boolean, initialMode = "view") {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <MoneyProvider currency="USD">
          <JournalDrawer
            journal={{ doc, lines: BALANCED_LINES } as never}
            parties={[]}
            accounts={[]}
            departments={[]}
            projects={[]}
            subsidiaries={[]}
            headerDefs={[]}
            lineDefs={[]}
            initialMode={initialMode as never}
            canPost={canPost}
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

function buttonsNamed(name: string): HTMLButtonElement[] {
  return [...document.querySelectorAll("button")].filter(
    (b) => b.textContent?.trim() === name,
  ) as HTMLButtonElement[];
}

async function openActions() {
  const menu = buttonsNamed("Actions")[0];
  assert.ok(menu, "record actions must live behind the Actions menu");
  await act(async () => {
    menu.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await tick();
  });
  await tick();
}

test("a draft without gl.post offers no Edit, Post or Delete", async (t) => {
  (globalThis as Record<string, unknown>).__journalRouter = { push() {}, refresh() {} };
  const restoreFetch = scriptFetch();
  t.after(restoreFetch);
  const { unmount } = await mount(docWith("draft"), false);
  t.after(unmount);
  assert.equal(buttonsNamed("Edit").length, 0, "no Edit without gl.post");
  await openActions();
  assert.equal(buttonsNamed("Post").length, 0, "no Post without gl.post");
  assert.equal(buttonsNamed("Delete").length, 0, "no Delete without gl.post");
});

test("edit mode without gl.post offers no Save", async (t) => {
  (globalThis as Record<string, unknown>).__journalRouter = { push() {}, refresh() {} };
  const restoreFetch = scriptFetch();
  t.after(restoreFetch);
  // createMode is the only way to reach the editor without the permission,
  // and the loader never opens it without gl.post — mount it directly to
  // prove the Save button itself is gated, not just the way in.
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <MoneyProvider currency="USD">
          <JournalDrawer
            journal={{ doc: { ...docWith("draft"), id: "", document_number: null }, lines: BALANCED_LINES } as never}
            parties={[]}
            accounts={[]}
            departments={[]}
            projects={[]}
            subsidiaries={[]}
            headerDefs={[]}
            lineDefs={[]}
            createMode
            canPost={false}
          />
        </MoneyProvider>
      </NextIntlClientProvider>,
    );
    await tick();
  });
  await tick();
  t.after(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
  });
  await openActions();
  assert.equal(buttonsNamed("Save").length, 0, "no Save without gl.post, even in the editor");
});

test("a draft with gl.post keeps Edit, Post and Delete", async (t) => {
  (globalThis as Record<string, unknown>).__journalRouter = { push() {}, refresh() {} };
  const restoreFetch = scriptFetch();
  t.after(restoreFetch);
  const { unmount } = await mount(docWith("draft"), true);
  t.after(unmount);
  assert.equal(buttonsNamed("Edit").length, 1, "Edit stays with gl.post");
  await openActions();
  assert.ok(buttonsNamed("Post").length >= 1, "Post stays with gl.post");
  assert.ok(buttonsNamed("Delete").length >= 1, "Delete stays with gl.post");
});

test("an approved journal without gl.post offers no Void", async (t) => {
  (globalThis as Record<string, unknown>).__journalRouter = { push() {}, refresh() {} };
  const restoreFetch = scriptFetch();
  t.after(restoreFetch);
  const { unmount } = await mount(docWith("approved"), false);
  t.after(unmount);
  await openActions();
  assert.equal(buttonsNamed("Void").length, 0, "no Void without gl.post");
});

test("an approved journal with gl.post keeps Void", async (t) => {
  (globalThis as Record<string, unknown>).__journalRouter = { push() {}, refresh() {} };
  const restoreFetch = scriptFetch();
  t.after(restoreFetch);
  const { unmount } = await mount(docWith("approved"), true);
  t.after(unmount);
  await openActions();
  assert.ok(buttonsNamed("Void").length >= 1, "Void stays with gl.post");
});

test("a ?mode=edit deep link without gl.post lands read-only", async (t) => {
  (globalThis as Record<string, unknown>).__journalRouter = { push() {}, refresh() {} };
  const restoreFetch = scriptFetch();
  t.after(restoreFetch);
  const { unmount } = await mount(docWith("draft"), false, "edit");
  t.after(unmount);
  await openActions();
  assert.equal(buttonsNamed("Save").length, 0, "the deep link must not strand the reader in an unsavable editor");
  assert.equal(buttonsNamed("Edit").length, 0, "no Edit to re-enter the editor either");
});
