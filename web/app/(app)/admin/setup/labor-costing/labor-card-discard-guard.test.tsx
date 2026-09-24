// F1-10: the labor rate-card drawer never closes silently on unsaved edits.
// The X button (via TransactionDrawer's beforeClose) and Cancel both ask
// first when the editor is dirty; a clean editor closes without prompting,
// and declining the confirm keeps the drawer open with the typed work
// intact.

import assert from "node:assert/strict";
import test from "node:test";

// jsdom first: the drawer reads browser globals at render.
const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", {
  url: "http://localhost:4800/admin/setup/labor-pricing?card=card-1",
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
  __laborDiscard: script,
  __laborDiscardRouter: { push() {}, replace() {}, refresh() {} },
});

const { registerHooks } = await import("node:module");
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "next/navigation") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export function useRouter(){return globalThis.__laborDiscardRouter}export function usePathname(){return '/admin/setup/labor-pricing'}export function useSearchParams(){return new URLSearchParams()}",
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
        url: "data:text/javascript,export async function confirmDialog(){const s=globalThis.__laborDiscard;s.confirmCalls++;return s.confirmResult}",
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
const messages = (await import("../../../../../messages/en")).default;
const { MoneyProvider } = await import("../../../../../components/money-provider");
const { LaborBillRateCards } = await import("./LaborBillRateCards");

const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

const CARD = {
  id: "card-1",
  rate_book_id: "book-1",
  code: "STD",
  name: "Standard rates",
  currency: "USD",
  effective_from: "2026-01-01",
  effective_to: null,
  status: "active",
  derivation_policy: "base",
  line_count: 0,
  assignment_count: 0,
  custom: {},
  scopes: [],
  adjustments: [],
  terms: [],
  lines: [],
};

async function mount() {
  script.confirmResult = true;
  script.confirmCalls = 0;
  const prior = globalThis.fetch;
  globalThis.fetch = (async () => Response.json({})) as typeof fetch;
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <MoneyProvider currency="USD">
          <LaborBillRateCards
            cards={[CARD]}
            selected={CARD as never}
            creating={false}
            total={1}
            page={1}
            perPage={25}
            currentParams={{}}
            timeFilter="all"
            dimensionFilter="all"
            items={[]}
            timeTypes={[]}
            options={{}}
            currencies={["USD"]}
            forms={[]}
            currentFormId={null}
            customFieldDefs={[]}
            canCustomize={false}
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

function buttonsNamed(name: string): HTMLButtonElement[] {
  return [...document.querySelectorAll("button")].filter(
    (b) => b.textContent?.trim() === name,
  ) as HTMLButtonElement[];
}

/** Open the editor and type into every plain text input to dirty the draft. */
async function editAndType() {
  const edit = buttonsNamed("Edit")[0];
  assert.ok(edit, "the card drawer must offer Edit");
  await act(async () => {
    edit.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await tick();
  });
  await tick(60);
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
  const button = [...document.querySelectorAll("button[aria-label]")].find((b) =>
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

test("X on a dirty rate card asks first and keeps the work when declined", async (t) => {
  const { cleanup } = await mount();
  t.after(cleanup);
  assert.ok(drawerOpen(), "the mounted drawer holds the page open");
  await editAndType();
  script.confirmResult = false;
  await clickX();
  assert.equal(script.confirmCalls, 1, "closing a dirty editor must ask");
  assert.ok(drawerOpen(), "declining must keep the drawer open with the typed work");
});

test("X on a dirty rate card closes when confirmed", async (t) => {
  const { cleanup } = await mount();
  t.after(cleanup);
  await editAndType();
  script.confirmResult = true;
  await clickX();
  assert.equal(script.confirmCalls, 1, "closing a dirty editor must ask");
  assert.ok(!drawerOpen(), "confirming must let the close proceed");
});

test("X on a clean rate card closes without asking", async (t) => {
  const { cleanup } = await mount();
  t.after(cleanup);
  script.confirmResult = false;
  await clickX();
  assert.equal(script.confirmCalls, 0, "a clean editor must not prompt");
  assert.ok(!drawerOpen(), "a clean editor must close straight through");
});
