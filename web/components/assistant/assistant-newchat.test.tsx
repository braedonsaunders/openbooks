import assert from "node:assert/strict";
import test from "node:test";

// jsdom first: the workbench reads browser globals at render.
const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", {
  url: "http://localhost:4800/assistant",
});
const globals = globalThis as Record<string, unknown>;
const domWindow = dom.window as unknown as Record<string, unknown>;
for (const key of ["window", "document", "navigator", "Node", "Element", "HTMLElement", "Event", "self"]) {
  if (globals[key] === undefined) globals[key] = domWindow[key];
}
if (!window.HTMLElement.prototype.scrollIntoView) {
  window.HTMLElement.prototype.scrollIntoView = function () {};
}

declare global {
  var __newChatPushes: string[] | undefined;
}

const { registerHooks } = await import("node:module");
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "next/navigation") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export function useRouter(){return{push(u){globalThis.__newChatPushes.push(u)},refresh(){},replace(){},prefetch(){}}}export function usePathname(){return '/assistant'}export function useSearchParams(){return new URLSearchParams()}",
      };
    }
    if (specifier === "next/link") {
      // Render a real anchor (href/target/rel preserved) so link-behavior
      // tests can pin same-tab navigation; children-only mocks hide it.
      return {
        shortCircuit: true,
        url: "data:text/javascript,export default function Link(p){return globalThis.React.createElement('a',{href:p.href,target:p.target,rel:p.rel},p.children)}",
      };
    }
    if (specifier === "@/lib/confirm" || specifier.endsWith("/lib/confirm")) {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export async function confirmDialog(){return true}",
      };
    }
    return next(specifier, context);
  },
});

// Mount-only fetch stub: without it the mount effects retry against a dead
// endpoint with backoff and the file times out. These tests never send,
// delete, or poll runs, so empty payloads suffice.
globalThis.fetch = (async () =>
  new Response(JSON.stringify({ conversations: [], runs: [], messages: [] }), {
    headers: { "content-type": "application/json" },
  })) as typeof fetch;

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
const React = await import("react");
Object.assign(globalThis, { React });
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { NextIntlClientProvider } = await import("next-intl");
const messages = (await import("../../messages/en")).default;
const { AssistantApp } = await import("./assistant-app");

function newChatButton(host: HTMLElement): HTMLButtonElement {
  const buttons = [...host.querySelectorAll("button")];
  const found = buttons.find((b) => b.textContent?.includes("New chat"));
  assert.ok(found, "New chat button must render");
  return found as HTMLButtonElement;
}

async function mount(aiEnabled: boolean, canConfigureAi = false) {
  globalThis.__newChatPushes = [];
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    // The provider's overloads only accept children inside the props object.
    /* eslint-disable react/no-children-prop */
    root.render(
      React.createElement(NextIntlClientProvider, {
        locale: "en",
        messages,
        timeZone: "UTC",
        children: React.createElement(AssistantApp, {
          conversations: [],
          activeId: null,
          initialMessages: [],
          canWrite: true,
          aiEnabled,
          canConfigureAi,
        }),
      }),
    );
    /* eslint-enable react/no-children-prop */
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return {
    host,
    async unmount() {
      await act(async () => {
        root.unmount();
      });
      host.remove();
    },
  };
}

// F-t12-011 follow-up: with no AI provider configured, the sidebar
// "New chat" is a link to the page already showing — a dead click with no
// feedback. It must explain the setup state instead of silently no-op'ing.
test("F-t12-011: New chat explains setup instead of dead-clicking", async () => {
  const { host, unmount } = await mount(false);
  try {
    const button = newChatButton(host);
    await act(async () => {
      button.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.deepEqual(globalThis.__newChatPushes, [], "must not navigate");
    const alert = host.querySelector('[role="alert"]');
    assert.ok(
      alert?.textContent?.includes("isn't configured yet"),
      "must surface the not-configured guidance inline",
    );
  } finally {
    await unmount();
  }
});

// F-t13-004: the empty-state "AI providers" entry must take the admin to
// /admin/ai in the SAME tab. As target="_blank" the URL never changed and the
// link read as dead (new-tab opens are also popup-blocker bait in lockdown
// browsers). The New-chat half of that finding already holds — the F-t12-011
// test above pins the inline guidance, and the t13 screenshot shows it live.
test("F-t13-004: AI providers link navigates to setup in the same tab", async () => {
  const { host, unmount } = await mount(false, true);
  try {
    const link = host.querySelector('a[href="/admin/ai"]');
    assert.ok(link, "AI providers setup link must render for admins");
    assert.equal(
      link.getAttribute("target"),
      null,
      "setup link must not open a new tab",
    );
  } finally {
    await unmount();
  }
});

test("F-t12-011: New chat still links home when the assistant is configured", async () => {
  const { host, unmount } = await mount(true);
  try {
    // Configured New chat renders with no inline alert (navigation itself is covered by E2E).
    newChatButton(host);
    assert.equal(host.querySelector('[role="alert"]'), null, "no guidance alert when configured");
  } finally {
    await unmount();
  }
});
