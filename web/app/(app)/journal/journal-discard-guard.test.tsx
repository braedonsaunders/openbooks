// F1-10: the journal drawer never closes silently on unsaved edits. The X
// button (via TransactionDrawer's beforeClose) and Cancel both ask first
// when the editor is dirty; a clean editor closes without prompting, and
// declining the confirm keeps the drawer open with the typed work intact.

import assert from "node:assert/strict";
import test from "node:test";

// jsdom first: the drawer reads browser globals at render.
const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", {
  // The drawer URL differs from the close href (as in production), so the
  // close navigation has somewhere to go.
  url: "http://localhost:4800/journal?entryNew=1&mode=edit",
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

const script = { confirmResult: true, confirmCalls: 0 };
Object.assign(globalThis, {
  __journalDiscard: script,
  __journalDiscardRouter: {
    push() {},
    replace() {},
    refresh() {},
  },
});

const { registerHooks } = await import("node:module");
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "next/navigation") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export function useRouter(){return globalThis.__journalDiscardRouter}export function usePathname(){return '/journal'}export function useSearchParams(){return new URLSearchParams()}",
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
        url: "data:text/javascript,export async function confirmDialog(){const s=globalThis.__journalDiscard;s.confirmCalls++;return s.confirmResult}",
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

const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

const BALANCED_LINES = [
  { account_id: "a1", amount: "100.00", description: "leg one", party_id: "", department_id: "", project_id: "", subsidiary_id: "", custom: {}, extra_dims: {} },
  { account_id: "a2", amount: "-100.00", description: "leg two", party_id: "", department_id: "", project_id: "", subsidiary_id: "", custom: {}, extra_dims: {} },
];

async function mount() {
  script.confirmResult = true;
  script.confirmCalls = 0;
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
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <MoneyProvider currency="USD">
          <JournalDrawer
            journal={{
              doc: {
                id: "",
                kind: "journal",
                status: "draft",
                document_number: null,
                currency: "USD",
                updated_at: "",
                document_date: "2026-09-17",
                memo: "",
                total: "0.00",
              },
              lines: BALANCED_LINES,
            } as never}
            parties={[]}
            accounts={[]}
            departments={[]}
            projects={[]}
            subsidiaries={[]}
            headerDefs={[]}
            lineDefs={[]}
            createMode
            canPost
            closeHref="/journal"
          />
        </MoneyProvider>
      </NextIntlClientProvider>,
    );
    await tick();
  });
  await tick(60);
  return {
    cleanup: async () => {
      globalThis.fetch = prior;
      await act(async () => {
        root.unmount();
      });
      host.remove();
      for (const node of [...document.body.children]) node.remove();
    },
  };
}

/** Type into every plain text input so at least the tracked fields dirty the form. */
async function typeIntoForm() {
  await act(async () => {
    const inputs = [...document.querySelectorAll("input")] as HTMLInputElement[];
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
    for (const input of inputs) {
      if (input.disabled || input.readOnly || input.type === "hidden" || input.type === "checkbox") continue;
      setter?.call(input, `${input.value}x`);
      input.dispatchEvent(new window.Event("input", { bubbles: true }));
    }
    await tick();
  });
  await tick(60);
}

function closeButton(): HTMLButtonElement {
  const button = [...document.querySelectorAll('button[aria-label]')].find((b) =>
    /close/i.test(b.getAttribute("aria-label") ?? ""),
  ) as HTMLButtonElement | undefined;
  assert.ok(button, "the drawer must offer a labelled close button");
  return button;
}

async function clickX() {
  await act(async () => {
    closeButton().dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await tick(120);
  });
  await tick(120);
}

/**
 * Whether the drawer shell still holds the page open. The shell locks body
 * scroll while open and releases it the moment close() proceeds past the
 * guard — a synchronous, animation-independent signal, unlike the deferred
 * close navigation (which waits for the exit animation that never
 * completes under jsdom).
 */
function drawerOpen(): boolean {
  return document.body.style.overflow === "hidden";
}

test("X on a dirty journal asks first and keeps the work when declined", async (t) => {
  const { cleanup } = await mount();
  t.after(cleanup);
  assert.ok(drawerOpen(), "the mounted drawer holds the page open");
  await typeIntoForm();
  script.confirmResult = false;
  await clickX();
  assert.equal(script.confirmCalls, 1, "closing a dirty editor must ask");
  assert.ok(drawerOpen(), "declining must keep the drawer open with the typed work");
  assert.ok(closeButton(), "the close button must still be there");
});

test("X on a dirty journal closes when confirmed", async (t) => {
  const { cleanup } = await mount();
  t.after(cleanup);
  await typeIntoForm();
  script.confirmResult = true;
  await clickX();
  assert.equal(script.confirmCalls, 1, "closing a dirty editor must ask");
  assert.ok(!drawerOpen(), "confirming must let the close proceed");
});

test("X on a clean journal closes without asking", async (t) => {
  const { cleanup } = await mount();
  t.after(cleanup);
  script.confirmResult = false;
  await clickX();
  assert.equal(script.confirmCalls, 0, "a clean editor must not prompt");
  assert.ok(!drawerOpen(), "a clean editor must close straight through");
});
