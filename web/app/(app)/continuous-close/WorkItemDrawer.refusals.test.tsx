import assert from "node:assert/strict";
import test from "node:test";

declare global {
  var __workItemToasts: { kind: string; message: string }[] | undefined;
  var __workItemRefreshed: boolean | undefined;
}

// F4-3: dismiss/resolve/assign/note/rate refusals (invalid_transition,
// reason_required, conflict, forbidden — all named by the items route) were
// thrown away into generic feedback.actionFailed toasts. Like the sibling
// GateActions, the drawer must pin the named refusal beside the finding until
// the next action AND toast it, without refreshing the un-applied state away.

// jsdom first: the drawer reads browser globals at render.
const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", {
  url: "http://localhost:4800/close",
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
        url: "data:text/javascript,export function useRouter(){return{push(){},refresh(){globalThis.__workItemRefreshed=true},replace(){}}}export function usePathname(){return '/close'}export function useSearchParams(){return new URLSearchParams()}",
      };
    }
    if (specifier === "next/link") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export default function Link(){return null}",
      };
    }
    if (specifier === "sonner") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export const toast={success(m){(globalThis.__workItemToasts??=[]).push({kind:'success',message:String(m)})},error(m){(globalThis.__workItemToasts??=[]).push({kind:'error',message:String(m)})}};export function Toaster(){return null}",
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
const { MoneyProvider } = await import("../../../components/money-provider");
const { WorkItemDrawer } = await import("./WorkItemDrawer");
type WorkItem = Parameters<typeof WorkItemDrawer>[0]["item"];

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

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

async function click(el: Element) {
  await act(async () => {
    el.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await tick();
  });
  await tick();
}

const ITEM: WorkItem = {
  id: "11111111-2222-4333-8444-555555555555",
  agentKey: "reconciliation",
  findingType: "unmatched_bank_activity",
  severity: "warning",
  status: "open",
  confidence: "0.5",
  materiality: "100.00",
  summary: {},
  firstDetectedAt: "2026-09-01T00:00:00.000Z",
  lastDetectedAt: "2026-09-02T00:00:00.000Z",
  dismissalReason: null,
  evidence: [],
  feedback: null,
};

async function renderDrawer(withNotes = false) {
  document.body.innerHTML = "";
  globalThis.__workItemRefreshed = false;
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <MoneyProvider currency="USD">
          <WorkItemDrawer
            item={{ ...ITEM }}
            closeHref="/close"
            canWrite={true}
            notes={withNotes ? [] : undefined}
          />
        </MoneyProvider>
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

test("a refused resolve pins the translated reason and does not refresh", async (t) => {
  globalThis.__workItemToasts = [];
  const restoreFetch = scriptFetch((url, init) => {
    if (url === `/api/continuous-close/items/${ITEM.id}` && init?.method === "PATCH") {
      return Response.json({ error: "invalid_transition" }, { status: 409 });
    }
    return null;
  });
  t.after(restoreFetch);
  const { unmount } = await renderDrawer();
  t.after(unmount);

  const resolve = [...document.querySelectorAll("button")].find(
    (b) => b.textContent?.trim() === "Resolve",
  );
  assert.ok(resolve, "the Resolve action must render for an open finding");
  await click(resolve);
  await tick();
  await tick();

  const alert = document.querySelector('[role="alert"]');
  assert.ok(alert, "the refusal must pin as an alert beside the finding");
  assert.match(
    alert.textContent ?? "",
    /isn't available for this finding anymore/,
    "the pinned refusal must carry the translated invalid_transition reason",
  );
  const toasts = globalThis.__workItemToasts ?? [];
  assert.ok(
    toasts.some((toast) => toast.kind === "error" && /isn't available for this finding anymore/.test(toast.message)),
    `the refusal must also toast, saw ${JSON.stringify(toasts)}`,
  );
  assert.ok(
    toasts.every((toast) => toast.kind !== "success"),
    "a refused transition must never toast success",
  );
  assert.equal(globalThis.__workItemRefreshed, false, "the un-applied finding must not refresh away its refusal");
});

test("a forbidden note pins the translated reason", async (t) => {
  globalThis.__workItemToasts = [];
  const restoreFetch = scriptFetch((url, init) => {
    if (url === `/api/continuous-close/items/${ITEM.id}` && init?.method === "PATCH") {
      return Response.json({ error: "forbidden" }, { status: 403 });
    }
    return null;
  });
  t.after(restoreFetch);
  const { unmount } = await renderDrawer(true);
  t.after(unmount);

  const box = document.querySelector("textarea");
  assert.ok(box, "the note composer must render when notes are provided");
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
  assert.ok(setter, "jsdom must expose the textarea value setter");
  await act(async () => {
    setter.call(box, "checking this tomorrow");
    box.dispatchEvent(new window.Event("input", { bubbles: true }));
    await tick();
  });
  await tick();
  const add = [...document.querySelectorAll("button")].find(
    (b) => b.textContent?.trim() === "Add note",
  );
  assert.ok(add, "the Add note action must render once a note is typed");
  await click(add);
  await tick();
  await tick();

  const alert = document.querySelector('[role="alert"]');
  assert.ok(alert, "the refusal must pin as an alert beside the finding");
  assert.match(
    alert.textContent ?? "",
    /don't have permission/,
    "the pinned refusal must carry the translated forbidden reason",
  );
});
