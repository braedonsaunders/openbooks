import assert from "node:assert/strict";
import test from "node:test";

// LAYOUT2 sweep: the saved-view default picker fires one PUT per pick. A
// refused save must surface the named failure (never an unhandled rejection
// or a JSON parse error) and release the busy state so the operator can
// retry.

declare global {
  var __viewToasts: { kind: string; message: string }[] | undefined;
}

const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", {
  url: "http://localhost:4800/customers",
});
const globals = globalThis as Record<string, unknown>;
const domWindow = dom.window as unknown as Record<string, unknown>;
for (const key of ["window", "document", "navigator", "Node", "Element", "HTMLElement", "Event", "self"]) {
  if (globals[key] === undefined) globals[key] = domWindow[key];
}
if (!window.HTMLElement.prototype.scrollIntoView) {
  window.HTMLElement.prototype.scrollIntoView = function () {};
}
if (typeof window.matchMedia !== "function") {
  window.matchMedia = (() => ({
    matches: false,
    media: "",
    addEventListener() {},
    removeEventListener() {},
  })) as typeof window.matchMedia;
}

const { registerHooks } = await import("node:module");
const { pathToFileURL } = await import("node:url");
// @openbooks/* symlinks resolve to the MAIN checkout (stale); pin the real
// worktree copy so the test runs the code under test.
const worktreeUi = pathToFileURL(
  (await import("node:path")).join(process.cwd(), "packages", "ui", "src", "index.ts"),
).href;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "@openbooks/ui") {
      return { shortCircuit: true, url: worktreeUi };
    }
    if (specifier === "next/navigation") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export function useRouter(){return{push(){},refresh(){},replace(){}}}export function usePathname(){return '/customers'}export function useSearchParams(){return new URLSearchParams()}",
      };
    }
    if (specifier === "next/link") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export default function Link(p){const{children,...rest}=p;return globalThis.React.createElement('a',rest,children)}",
      };
    }
    if (specifier === "sonner") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export const toast={success(m){(globalThis.__viewToasts??=[]).push({kind:'success',message:String(m)})},error(m){(globalThis.__viewToasts??=[]).push({kind:'error',message:String(m)})}};export function Toaster(){return null}",
      };
    }
    return next(specifier, context);
  },
});

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
const React = await import("react");
Object.assign(globalThis, { React });
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { NextIntlClientProvider } = await import("next-intl");
const messages = (await import("../messages/en")).default;
const messagesFr = (await import("../messages/fr")).default;
const { ViewsMenu } = await import("./views-menu");

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));
const FAILED = (messages as { customization: { views: { setDefaultFailed: string } } }).customization.views
  .setDefaultFailed;
const SET_DEFAULT = (messages as { customization: { views: { setDefault: string } } }).customization.views
  .setDefault;

function provider(children: React.ReactElement, locale = "en", catalog = messages) {
  /* eslint-disable react/no-children-prop */
  return React.createElement(NextIntlClientProvider, {
    locale,
    messages: catalog,
    timeZone: "UTC",
    children,
  });
  /* eslint-enable react/no-children-prop */
}

async function mountMenu(options: {
  locale?: string
  catalog?: typeof messages
  available?: Array<{ id: string; name: string; recordType: string; scope: "org" | "user"; ownerId: string | null; isDefault: boolean; isActive: boolean }>
  currentName?: string
} = {}): Promise<{ root: { unmount: () => void } }> {
  document.body.innerHTML = "";
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      provider(
        React.createElement(ViewsMenu, {
          available: options.available ?? [
            { id: "v1", name: "V One", recordType: "customer", scope: "user", ownerId: null, isDefault: false, isActive: true },
          ],
          currentId: "v1",
          currentName: options.currentName ?? "V One",
          recordType: "customer",
          basePath: "/customers",
          currentParams: {},
          canManage: false,
        }),
        options.locale ?? "en",
        options.catalog ?? messages,
      ),
    );
    await tick();
  });
  await act(async () => {
    const trigger = [...document.querySelectorAll("button")].find(
      (b) => b.getAttribute("aria-haspopup") === "menu",
    );
    assert.ok(trigger, "the view-picker trigger must render");
    (trigger as HTMLButtonElement).dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await tick();
    await tick();
  });
  return { root };
}

test("an unrenamed seeded view stays translated in the French dropdown", async () => {
  const { root } = await mountMenu({
    locale: "fr",
    catalog: messagesFr,
    currentName: "Vue par défaut",
    available: [
      { id: "v1", name: "Default view", recordType: "customer", scope: "user", ownerId: null, isDefault: false, isActive: true },
    ],
  });
  const defaultView = [...document.querySelectorAll('[role="menuitem"]')].find((item) => item.textContent?.includes("Vue par défaut"));
  assert.ok(defaultView, 'the seeded "Default view" row must use its French label after opening the menu');
  assert.doesNotMatch(defaultView.textContent ?? "", /Default view/);
  await act(async () => {
    root.unmount();
  });
});

async function clickSetDefault(): Promise<void> {
  const action = [...document.querySelectorAll('button[role="menuitem"]')].find(
    (b) => b.textContent?.trim() === SET_DEFAULT,
  ) as HTMLButtonElement | undefined;
  assert.ok(action, "the set-default action must render");
  await act(async () => {
    action.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await tick();
    await tick();
  });
  await tick();
}

function errorToasts(): string[] {
  return (globalThis.__viewToasts ?? []).filter((t) => t.kind === "error").map((t) => t.message);
}

test("a rejected default-view save toasts the named failure and releases busy", async () => {
  globalThis.__viewToasts = [];
  const priorFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new TypeError("fetch failed");
  }) as typeof fetch;
  try {
    const { root } = await mountMenu();
    await clickSetDefault();

    assert.deepEqual(errorToasts(), [FAILED]);

    // Busy released: the action is clickable again for a retry.
    const action = [...document.querySelectorAll('button[role="menuitem"]')].find(
      (b) => b.textContent?.trim() === SET_DEFAULT,
    ) as HTMLButtonElement;
    assert.equal(action.disabled, false, "busy must reset after a network failure");
    await act(async () => {
      root.unmount();
    });
  } finally {
    globalThis.fetch = priorFetch;
  }
});

test("a non-JSON 500 toasts the fallback instead of a parse error", async () => {
  globalThis.__viewToasts = [];
  const priorFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response("<html>proxy page</html>", {
      status: 500,
      headers: { "content-type": "text/html" },
    })) as typeof fetch;
  try {
    const { root } = await mountMenu();
    await clickSetDefault();

    const errors = errorToasts();
    assert.equal(errors.length, 1);
    assert.match(errors[0]!, /Could not save the default view/);
    assert.match(errors[0]!, /status 500/);
    assert.doesNotMatch(errors[0]!, /json/i, "no SyntaxError may stand in for the refusal");
    await act(async () => {
      root.unmount();
    });
  } finally {
    globalThis.fetch = priorFetch;
  }
});
