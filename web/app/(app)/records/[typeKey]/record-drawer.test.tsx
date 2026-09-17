import assert from "node:assert/strict";
import test from "node:test";

declare global {
  var __recordToasts: { kind: string; message: string }[] | undefined;
  var __recordRouter: { push(url: string): void; refresh(): void; pushes: string[]; refreshes: number } | undefined;
  var __recordGate: { ok: boolean; reason?: string; warnings?: string[] } | undefined;
  var __recordConfirm: boolean | undefined;
}

// The filed holdout (fleet8 finding u2-record-drawer-transient-save-failure):
// saveState had no 'error' member and every non-field failure — 409 revision
// conflict, 500, 403 — set 'dirty' plus a transient toast. Once the toast
// went, the form sat dirty with no reason on screen. Through useAppAction the
// non-field refusal pins as a record-level role="alert" until the next action
// or edit AND toasts; field failures stay inline; a 409 keeps the user's
// edits and the stale token so the next save still cannot overwrite unseen
// work.

// jsdom first: the drawer reads browser globals at render.
const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", {
  url: "http://localhost:4800/records/project",
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
        url: "data:text/javascript,export function useRouter(){return globalThis.__recordRouter}export function usePathname(){return '/records/project'}export function useSearchParams(){return new URLSearchParams()}",
      };
    }
    if (specifier === "sonner") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export const toast={success(m){(globalThis.__recordToasts??=[]).push({kind:'success',message:String(m)})},error(m){(globalThis.__recordToasts??=[]).push({kind:'error',message:String(m)})},warning(m){(globalThis.__recordToasts??=[]).push({kind:'warning',message:String(m)})}};export function Toaster(){return null}",
      };
    }
    if (specifier === "@/lib/confirm" || specifier.endsWith("/lib/confirm")) {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export async function confirmDialog(){return globalThis.__recordConfirm ?? true}",
      };
    }
    if (specifier === "@/lib/client-scripts" || specifier.endsWith("/lib/client-scripts")) {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export async function runClientScripts(){const g=globalThis.__recordGate;return g!==undefined?{ok:g.ok,reason:g.reason,warnings:g.warnings??[]}:{ok:true,warnings:[]}}",
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
const messages = (await import("../../../../messages/en")).default;
const { MoneyProvider } = await import("../../../../components/money-provider");
const { RecordDrawer } = await import("./RecordDrawer");

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

const SECTIONS = [
  {
    id: "s1",
    title: "Main",
    fields: [{ id: "name", type: "text", label: "Name" }],
  },
];

const RECORD = {
  id: "11111111-1111-4111-8111-111111111111",
  recordNumber: "PRJ-0007",
  data: { name: "Acme" },
  status: "draft",
  updatedAt: "2026-09-17T12:00:00.000000Z",
};

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

async function renderDrawer() {
  globalThis.__recordToasts = [];
  globalThis.__recordGate = undefined;
  globalThis.__recordConfirm = true;
  globalThis.__recordRouter = {
    push(url: string) {
      globalThis.__recordRouter!.pushes.push(url);
    },
    refresh() {
      globalThis.__recordRouter!.refreshes += 1;
    },
    pushes: [],
    refreshes: 0,
  };
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <MoneyProvider currency="USD">
          <RecordDrawer
            typeKey="project"
            typeName="Project"
            sections={SECTIONS as never}
            record={RECORD as never}
            canEdit
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

async function openEditorAndSave() {
  const edit = buttonsNamed("Edit")[0];
  assert.ok(edit, "a draft record must offer Edit");
  await click(edit);
  const save = buttonsNamed("Save")[0];
  assert.ok(save, "edit mode must offer Save");
  await click(save);
  await tick();
  return save;
}

test("a 409 conflict pins the reason and keeps the user's edits on the stale token", async (t) => {
  const restoreFetch = scriptFetch((url, init) => {
    if (url === "/api/records/project/11111111-1111-4111-8111-111111111111" && init?.method === "PATCH") {
      return Response.json(
        { error: "This record changed after you opened it; reload the record and reapply your changes", code: "revision_conflict" },
        { status: 409 },
      );
    }
    return null;
  });
  t.after(restoreFetch);
  const { unmount } = await renderDrawer();
  t.after(unmount);
  const save = await openEditorAndSave();
  const alert = document.querySelector('[role="alert"]');
  assert.ok(alert, "the 409 refusal must pin as an alert, not vanish with the toast");
  assert.match(
    alert.textContent ?? "",
    /This record changed after you opened it/,
    "the alert must carry the server's typed reason",
  );
  const toasts = globalThis.__recordToasts ?? [];
  assert.ok(
    toasts.some((toast) => toast.kind === "error" && /changed after you opened it/.test(toast.message)),
    "the refusal must also toast as an error",
  );
  const input = document.querySelector("input");
  assert.equal(input?.value, "Acme", "the conflict must keep the user's edits, not reset the form");
  assert.equal(save.disabled, false, "busy must release after the refusal so the user can retry");
  assert.equal(globalThis.__recordRouter!.refreshes, 0, "a refused save must not refresh away the pinned context");
});

test("a field validation failure still renders inline at the field", async (t) => {
  const restoreFetch = scriptFetch((url, init) => {
    if (url === "/api/records/project/11111111-1111-4111-8111-111111111111" && init?.method === "PATCH") {
      return Response.json(
        {
          error: "Fill every required field before activating",
          errors: [{ fieldId: "name", message: "Required" }],
          issues: [{ path: "name", message: "Required" }],
        },
        { status: 422 },
      );
    }
    return null;
  });
  t.after(restoreFetch);
  const { unmount } = await renderDrawer();
  t.after(unmount);
  await openEditorAndSave();
  assert.match(
    document.body.textContent ?? "",
    /Required/,
    "the field reason must render inline at the field",
  );
  assert.ok(
    document.querySelector('[role="alert"]'),
    "the 422 refusal must also pin as an alert with its issues",
  );
});

test("a failed status transition pins instead of toasting into the void", async (t) => {
  const restoreFetch = scriptFetch((url, init) => {
    if (url === "/api/records/project/11111111-1111-4111-8111-111111111111" && init?.method === "PATCH") {
      return Response.json({ error: "Database unavailable" }, { status: 500 });
    }
    return null;
  });
  t.after(restoreFetch);
  const { unmount } = await renderDrawer();
  t.after(unmount);
  const actions = buttonsNamed("Actions")[0];
  assert.ok(actions, "lifecycle actions must live behind the Actions menu");
  await click(actions);
  const activate = buttonsNamed("Activate")[0];
  assert.ok(activate, "a draft must offer Activate");
  await click(activate);
  await tick();
  const alert = document.querySelector('[role="alert"]');
  assert.ok(alert, "the transition refusal must pin as an alert");
  const toasts = globalThis.__recordToasts ?? [];
  assert.ok(
    toasts.some((toast) => toast.kind === "error"),
    "the transition refusal must also toast",
  );
});
