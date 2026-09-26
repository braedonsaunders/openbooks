import assert from "node:assert/strict";
import test from "node:test";

declare global {
  var __shareToasts: { kind: string; message: string }[] | undefined;
}

// Sharing-grant refusals must pin, not just toast: post/remove today
// toast documents.toasts.shareFailed and leave no on-screen reason once the
// toast dismisses. Through useAppAction the refusal pins as a record-level
// role="alert" until the next action AND toasts, and busy always releases.

// jsdom first: the panel reads browser globals at render.
const { bootJsdomEnvironment } = await import("../../../testing/jsdom-env");
await bootJsdomEnvironment({ url: "http://localhost:4800/documents/files", matchMediaMatches: false, resizeObserver: false });

const { registerHooks } = await import("node:module");
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "sonner") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export const toast={success(m){(globalThis.__shareToasts??=[]).push({kind:'success',message:String(m)})},error(m){(globalThis.__shareToasts??=[]).push({kind:'error',message:String(m)})},warning(m){(globalThis.__shareToasts??=[]).push({kind:'warning',message:String(m)})}};export function Toaster(){return null}",
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
const { SharePanel } = await import("./SharePanel");

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

const GRANTS_BASE = "/api/file-cabinet/folders/r1/grants";

function scriptFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response> | null) {
  const prior = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    return handler(url, init) ?? Response.json({});
  }) as typeof fetch;
  return () => {
    globalThis.fetch = prior;
  };
}

async function renderPanel() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <SharePanel resourceType="folder" resourceId="r1" />
      </NextIntlClientProvider>,
    );
    await tick();
  });
  await tick();
  await tick();
  return {
    host,
    unmount: async () => {
      await act(async () => {
        root.unmount();
      });
      host.remove();
    },
  };
}

function selects(): HTMLSelectElement[] {
  return [...document.querySelectorAll("select")] as HTMLSelectElement[];
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

async function choosePrincipal(value: string) {
  const picker = selects()[0];
  assert.ok(picker, "a principal picker must render once grants load");
  const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value")?.set;
  assert.ok(setter, "jsdom must expose the select value setter");
  await act(async () => {
    setter.call(picker, value);
    picker.dispatchEvent(new window.Event("change", { bubbles: true }));
    await tick();
  });
  await tick();
}

function loadedGrants(): void {
  assert.ok(
    selects().length > 0,
    "grants must finish loading before the action runs (empty list shows the pickers)",
  );
}

test("a refused grant pins as an alert and toasts, then releases busy", async (t) => {
  globalThis.__shareToasts = [];
  const restoreFetch = scriptFetch((url, init) => {
    if (url === GRANTS_BASE && (!init || !init.method || init.method === "GET")) {
      return Response.json({ grants: [] });
    }
    if (url === "/api/file-cabinet/principals") {
      return Response.json({ users: [{ id: "u1", name: "Ada" }], roles: [] });
    }
    if (url === GRANTS_BASE && init?.method === "POST") {
      return Response.json({ error: "Only managers may share this folder" }, { status: 403 });
    }
    return null;
  });
  t.after(restoreFetch);
  const { unmount } = await renderPanel();
  t.after(unmount);
  loadedGrants();
  await choosePrincipal("user:u1");
  const add = buttonsNamed("Add")[0];
  assert.ok(add, "an Add control must exist once a principal is chosen");
  await click(add);
  await tick();
  const alert = document.querySelector('[role="alert"]');
  assert.ok(alert, "the grant refusal must pin as an alert, not vanish with the toast");
  assert.match(
    alert.textContent ?? "",
    /Only managers may share this folder/,
    "the alert must carry the server's typed reason",
  );
  const toasts = globalThis.__shareToasts ?? [];
  assert.ok(
    toasts.some((toast) => toast.kind === "error" && /Only managers may share this folder/.test(toast.message)),
    "the refusal must also toast as an error",
  );
  assert.ok(
    toasts.every((toast) => toast.kind !== "success"),
    "a refused grant must never toast success",
  );
  assert.equal(add.disabled, false, "busy must release after the refusal so the user can retry");
});

test("a dead network on grant pins the localized fallback instead of wedging", async (t) => {
  globalThis.__shareToasts = [];
  const restoreFetch = scriptFetch((url, init) => {
    if (url === GRANTS_BASE && (!init || !init.method || init.method === "GET")) {
      return Response.json({ grants: [] });
    }
    if (url === "/api/file-cabinet/principals") {
      return Response.json({ users: [{ id: "u1", name: "Ada" }], roles: [] });
    }
    if (url === GRANTS_BASE && init?.method === "POST") {
      throw new TypeError("fetch failed");
    }
    return null;
  });
  t.after(restoreFetch);
  const { unmount } = await renderPanel();
  t.after(unmount);
  loadedGrants();
  await choosePrincipal("user:u1");
  const add = buttonsNamed("Add")[0];
  assert.ok(add, "an Add control must exist once a principal is chosen");
  await click(add);
  await tick();
  const alert = document.querySelector('[role="alert"]');
  assert.ok(alert, "a transport failure must still pin an alert (it cannot throw past the UI)");
  assert.match(
    alert.textContent ?? "",
    /Could not update sharing/,
    "with no server reason the alert falls back to localized copy",
  );
  assert.equal(add.disabled, false, "busy must release after a transport failure");
});
