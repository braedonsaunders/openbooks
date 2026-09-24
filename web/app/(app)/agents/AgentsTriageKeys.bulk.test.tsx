import assert from "node:assert/strict";
import test from "node:test";

declare global {
  var __triageToasts: { kind: string; message: string }[] | undefined;
  var __triagePushed: string[] | undefined;
  var __triageFetches: { url: string; method: string }[] | undefined;
}

// F4-4: bulk-resolving N findings broke on the first refusal — the loop
// stopped, the selection was cleared, one generic actionFailed toast fired
// and the list refreshed, so applied rows, refused rows and unattempted rows
// were indistinguishable. Every selected row must now be attempted, refused
// rows stay selected with their named reasons pinned, and the toast accounts
// applied vs refused.

// jsdom first: the island reads browser globals at render.
const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", {
  url: "http://localhost:4800/agents",
});
const globals = globalThis as Record<string, unknown>;
const domWindow = dom.window as unknown as Record<string, unknown>;
for (const key of ["window", "document", "navigator", "Node", "Element", "HTMLElement", "Event", "self", "CSS"]) {
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
const { pathToFileURL } = await import("node:url");
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
        url: "data:text/javascript,export function useRouter(){return{push(h){(globalThis.__triagePushed??=[]).push(String(h))},refresh(){},replace(){}}}export function usePathname(){return '/agents'}export function useSearchParams(){return new URLSearchParams()}",
      };
    }
    if (specifier === "sonner") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export const toast={success(m){(globalThis.__triageToasts??=[]).push({kind:'success',message:String(m)})},error(m){(globalThis.__triageToasts??=[]).push({kind:'error',message:String(m)})}};export function Toaster(){return null}",
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
const messages = (await import("../../../messages/en")).default;
const { AgentsTriageKeys } = await import("./AgentsTriageKeys");

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

function scriptFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response> | null) {
  const prior = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = init?.method ?? "GET";
    (globalThis.__triageFetches ??= []).push({ url, method });
    return handler(url, init) ?? Response.json({});
  }) as typeof fetch;
  return () => {
    globalThis.fetch = prior;
  };
}

async function click(el: Element) {
  await act(async () => {
    el.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await tick();
  });
  await tick();
}

async function press(key: string) {
  // Dispatch on the body (a real Element): the island skips keys from inside
  // inputs via target.closest, which window itself does not implement.
  await act(async () => {
    document.body.dispatchEvent(new window.KeyboardEvent("keydown", { key, bubbles: true }));
    await tick();
  });
  await tick();
}

const ROWS = [
  { id: "r1", href: "/agents?finding=r1", hasProposal: false, status: "open" },
  { id: "r2", href: "/agents?finding=r2", hasProposal: false, status: "open" },
  { id: "r3", href: "/agents?finding=r3", hasProposal: false, status: "open" },
];

async function renderKeys() {
  document.body.innerHTML = "";
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <AgentsTriageKeys rows={ROWS} canWrite={true} orgId="triage-test-org" locale="en" />
      </NextIntlClientProvider>,
    );
    await tick();
  });
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

test("a refused middle row does not stop the bulk and stays accounted", async (t) => {
  globalThis.__triageToasts = [];
  globalThis.__triageFetches = [];
  const restoreFetch = scriptFetch((url, init) => {
    if (url === "/api/continuous-close/items/r1" && init?.method === "PATCH") {
      return Response.json({ ok: true });
    }
    if (url === "/api/continuous-close/items/r2" && init?.method === "PATCH") {
      return Response.json({ error: "invalid_transition" }, { status: 409 });
    }
    if (url === "/api/continuous-close/items/r3" && init?.method === "PATCH") {
      return Response.json({ ok: true });
    }
    return null;
  });
  t.after(restoreFetch);
  const { unmount } = await renderKeys();
  t.after(unmount);

  // Select all three rows: x selects, j moves the cursor.
  await press("x");
  await press("j");
  await press("x");
  await press("j");
  await press("x");
  assert.match(document.body.textContent ?? "", /3 selected/, "all three rows must be selected");

  const resolve = [...document.querySelectorAll("button")].find(
    (b) => b.textContent?.trim() === "Resolve",
  );
  assert.ok(resolve, "the bulk Resolve button must render once rows are selected");
  await click(resolve);
  await tick();
  await tick();

  const attempted = (globalThis.__triageFetches ?? []).filter(
    (f) => f.url.startsWith("/api/continuous-close/items/") && f.method === "PATCH",
  );
  assert.equal(attempted.length, 3, `every selected row must be attempted, saw ${JSON.stringify(attempted)}`);

  const toasts = globalThis.__triageToasts ?? [];
  const errors = toasts.filter((toast) => toast.kind === "error");
  assert.equal(errors.length, 1, `exactly one error toast must fire, saw ${JSON.stringify(toasts)}`);
  assert.match(errors[0]?.message ?? "", /Applied 2/, "the toast must name the applied count");
  assert.match(errors[0]?.message ?? "", /1 refused/, "the toast must name the refused count");

  const alert = document.querySelector('[role="alert"]');
  assert.ok(alert, "the refused row must pin as an alert with its reason");
  assert.match(
    alert.textContent ?? "",
    /isn't available for this finding anymore/,
    "the pinned refusal must carry the translated invalid_transition reason",
  );
  assert.match(document.body.textContent ?? "", /1 selected/, "exactly the refused row must stay selected");
});
