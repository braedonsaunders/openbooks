import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

declare global {
  var __journalToasts: { kind: string; message: string }[] | undefined;
  var __journalRouter: { push(url: string): void; refresh(): void } | undefined;
  var __journalGets: number | undefined;
}

// JournalDrawer on the shared action path. Save failures toasted without
// pinning; a stale-revision void toasted translated copy without pinning.
// Both now pin as a record-level alert until the next action AND toast, with
// busy always releasing. The stale-revision recovery (reload the canonical
// revision, say so in translated copy — F-t06-021) is preserved inside the
// task: the server sentence leaks the revision-token mechanism, and the
// reload already happened, so the message must describe what happened.

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
  window.cancelAnimationFrame = ((id: number) => clearTimeout(id)) as unknown as typeof window.cancelAnimationFrame;
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
        url: "data:text/javascript,export const toast={success(m){(globalThis.__journalToasts??=[]).push({kind:'success',message:String(m)})},error(m){(globalThis.__journalToasts??=[]).push({kind:'error',message:String(m)})},warning(m){(globalThis.__journalToasts??=[]).push({kind:'warning',message:String(m)})},info(m){(globalThis.__journalToasts??=[]).push({kind:'info',message:String(m)})}};export function Toaster(){return null}",
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

function freshGlobals() {
  globalThis.__journalToasts = [];
  globalThis.__journalRouter = { push() {}, refresh() {} };
  globalThis.__journalGets = 0;
}

function snapshotBody(id: string) {
  return {
    doc: { id, updated_at: TOKEN, document_date: "2026-09-17", memo: "", reference_number: "" },
    lines: BALANCED_LINES,
  };
}

async function mountJournal(doc: Record<string, unknown>, initialMode?: string) {
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
  kind: "journal",
  status: "draft",
  document_number: "JE-00012",
  currency: "USD",
  updated_at: TOKEN,
  document_date: "2026-09-17",
  memo: "accrual",
  total: "0.00",
});

// Balanced legs so Save/Post enable: the drawer disables both on invalid
// amounts, and a disabled button cannot prove the refusal path.
const BALANCED_LINES = [
  { account_id: "a1", amount: "100.00", description: "leg one", party_id: "", department_id: "", project_id: "", subsidiary_id: "", custom: {}, extra_dims: {} },
  { account_id: "a2", amount: "-100.00", description: "leg two", party_id: "", department_id: "", project_id: "", subsidiary_id: "", custom: {}, extra_dims: {} },
];

test("a refused save pins the reason instead of toasting into the void", async (t) => {
  freshGlobals();
  const doc = DRAFT_DOC();
  const restoreFetch = scriptFetch((url, init) => {
    if (url === `/api/journals/${doc.id}` && (!init?.method || init.method === "GET")) {
      globalThis.__journalGets = (globalThis.__journalGets ?? 0) + 1;
      return Response.json(snapshotBody(String(doc.id)));
    }
    if (url === `/api/journals/${doc.id}` && init?.method === "PATCH") {
      return Response.json({ error: "Out of balance by 0.01" }, { status: 422 });
    }
    if (url.includes("/api/flows/record-state")) {
      return Response.json({
        approvalState: { status: "none", pendingWith: [], myActions: null },
        history: [],
        failedRun: null,
        canRetry: false,
        neverSubmitted: true,
      });
    }
    return null;
  });
  t.after(restoreFetch);
  const { unmount } = await mountJournal(doc, "edit");
  t.after(unmount);
  const menu = buttonsNamed("Actions")[0];
  assert.ok(menu, "record actions must live behind the Actions menu");
  await click(menu);
  const save = buttonsNamed("Save")[0];
  assert.ok(save, "edit mode must offer Save");
  await click(save);
  await tick();
  const alert = document.querySelector('[role="alert"]');
  assert.ok(alert, "the save refusal must pin as an alert, not vanish with the toast");
  assert.match(alert.textContent ?? "", /Out of balance/, "the alert must carry the server reason");
  const toasts = globalThis.__journalToasts ?? [];
  assert.ok(
    toasts.some((toast) => toast.kind === "error" && /Out of balance/.test(toast.message)),
    "the save refusal must also toast",
  );
  assert.equal(save.disabled, false, "busy must release after the refusal");
});

test("a stale-revision void reloads and pins translated copy (F-t06-021)", async (t) => {
  freshGlobals();
  const doc = { ...DRAFT_DOC(), status: "posted" };
  const restoreFetch = scriptFetch((url, init) => {
    if (url === `/api/journals/${doc.id}` && (!init?.method || init.method === "GET")) {
      globalThis.__journalGets = (globalThis.__journalGets ?? 0) + 1;
      return Response.json(snapshotBody(String(doc.id)));
    }
    if (url === `/api/documents/${doc.id}/void` && init?.method === "POST") {
      return Response.json(
        { error: "Reload the document and supply its exact revision before voiding", code: "stale-revision" },
        { status: 409 },
      );
    }
    if (url.includes("/api/flows/record-state")) {
      return Response.json({
        approvalState: { status: "none", pendingWith: [], myActions: null },
        history: [],
        failedRun: null,
        canRetry: false,
        neverSubmitted: true,
      });
    }
    return null;
  });
  t.after(restoreFetch);
  const { unmount } = await mountJournal(doc);
  t.after(unmount);
  const menu = buttonsNamed("Actions")[0];
  assert.ok(menu, "record actions must live behind the Actions menu");
  await click(menu);
  const voidButton = buttonsNamed("Void")[0];
  assert.ok(voidButton, "a posted journal must offer Void");
  await click(voidButton);
  await tick();
  assert.ok(
    (globalThis.__journalGets ?? 0) >= 2,
    "the stale revision must reload the canonical snapshot behind the refusal",
  );
  const alert = document.querySelector('[role="alert"]');
  assert.ok(alert, "the stale-revision refusal must pin as an alert");
  assert.match(
    alert.textContent ?? "",
    /changed after you opened it/,
    "the pin must render the translated recovery copy, not the revision-token mechanism",
  );
  const toasts = globalThis.__journalToasts ?? [];
  assert.equal(
    toasts.filter((toast) => toast.kind === "error").length,
    1,
    "the recovery must toast exactly once — no server-text duplicate beside the translated copy",
  );
});

test("a refused post still pins the server reason (F-t06-006 preservation)", async (t) => {
  freshGlobals();
  const doc = DRAFT_DOC();
  const restoreFetch = scriptFetch((url, init) => {
    if (url === `/api/journals/${doc.id}` && (!init?.method || init.method === "GET")) {
      return Response.json(snapshotBody(String(doc.id)));
    }
    if (url === "/api/journals/actions" && init?.method === "POST") {
      return Response.json({ error: "No open period covers September" }, { status: 422 });
    }
    if (url.includes("/api/flows/record-state")) {
      return Response.json({
        approvalState: { status: "none", pendingWith: [], myActions: null },
        history: [],
        failedRun: null,
        canRetry: false,
        neverSubmitted: true,
      });
    }
    return null;
  });
  t.after(restoreFetch);
  const { unmount } = await mountJournal(doc);
  t.after(unmount);
  const menu = buttonsNamed("Actions")[0];
  assert.ok(menu, "record actions must live behind the Actions menu");
  await click(menu);
  const post = buttonsNamed("Post")[0];
  assert.ok(post, "a draft journal must offer Post");
  await click(post);
  await tick();
  const alert = document.querySelector('[role="alert"]');
  assert.ok(alert, "the post refusal must pin as an alert");
  assert.match(alert.textContent ?? "", /No open period/, "the alert must carry the server reason");
});
