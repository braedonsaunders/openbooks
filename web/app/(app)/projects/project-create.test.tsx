import assert from "node:assert/strict";
import test from "node:test";
import { isUuid } from "@/lib/list-params";

declare global {
  var __projectCreateToasts: { kind: string; message: string }[] | undefined;
  var __projectCreateRouter: { pushes: string[]; replaces: string[]; refreshes: number } | undefined;
  var __projectCreateFetches: { url: string; init?: RequestInit }[] | undefined;
}

// Unsaved-create contract, Projects side: the New button and the
// ?project=new deep link open a URL-controlled drawer with ZERO writes;
// Cancel navigates away with zero writes; the drawer's explicit Save is
// exactly one idempotent POST with active defaulting true.

// jsdom first: the drawer reads browser globals at render.
const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", {
  url: "http://localhost:4800/projects",
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
    if (specifier.startsWith("@/")) {
      return next(new URL(`../../../${specifier.slice(2)}`, import.meta.url).href, context);
    }
    if (specifier === "next/navigation") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export function useRouter(){return {push(u){globalThis.__projectCreateRouter.pushes.push(String(u))},replace(u){globalThis.__projectCreateRouter.replaces.push(String(u))},refresh(){globalThis.__projectCreateRouter.refreshes+=1}}}export function usePathname(){return '/projects'}export function useSearchParams(){return new URLSearchParams()}",
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
        url: "data:text/javascript,export const toast={success(m){(globalThis.__projectCreateToasts??=[]).push({kind:'success',message:String(m)})},error(m){(globalThis.__projectCreateToasts??=[]).push({kind:'error',message:String(m)})},warning(m){(globalThis.__projectCreateToasts??=[]).push({kind:'warning',message:String(m)})}};export function Toaster(){return null}",
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
const { ProjectDrawer } = await import("./ProjectDrawer");
const { NewProjectButton } = await import("./NewProjectButton");
const { NewProjectRedirect } = await import("./NewProjectRedirect");

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

const NEW_PAYLOAD = {
  project: {
    id: "",
    code: null,
    name: "",
    is_active: true,
    custom: {},
    customer_id: null,
    foreman_id: null,
    manager_id: null,
    status: "active",
    customer_po_number: null,
    starts_on: null,
    ends_on: null,
    notes: null,
    subsidiary_id: null,
    subsidiary_include_children: true,
    project_type_id: null,
    invoicing_preference: null,
  },
  contractValue: null,
  customerName: null,
  foremanName: null,
  managerName: null,
  tasks: [],
  customFieldDefs: [],
};

const PERMISSIONS = { canRead: false, canCreate: false, canApprove: false, canInvoice: false };

function resetHarness() {
  globalThis.__projectCreateToasts = [];
  globalThis.__projectCreateRouter = { pushes: [], replaces: [], refreshes: 0 };
  globalThis.__projectCreateFetches = [];
  const prior = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    globalThis.__projectCreateFetches!.push({ url, init });
    return Response.json({ project: { id: "44444444-4444-4444-8444-444444444444" } }, { status: 201 });
  }) as typeof fetch;
  return () => {
    globalThis.fetch = prior;
  };
}

async function renderDrawer() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <MoneyProvider currency="USD">
          <ProjectDrawer
            payload={NEW_PAYLOAD as never}
            parties={[]}
            subsidiaries={[]}
            canManage
            canViewGl={false}
            cockpit={null}
            projectTypes={[]}
            schedulingEnabled={false}
            locale="en"
            createMode
            closeHref="/projects"
            applicationPermissions={PERMISSIONS}
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

async function click(button: HTMLButtonElement) {
  await act(async () => {
    button.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await tick();
  });
  await tick();
}

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set as
    | ((this: HTMLInputElement, value: string) => void)
    | undefined;
  setter?.call(input, value);
  input.dispatchEvent(new window.Event("input", { bubbles: true }));
}

/** The project-name input carries the name placeholder. */
function nameField(): HTMLInputElement | undefined {
  return [...document.querySelectorAll("input")].find((el) =>
    (el as HTMLInputElement).placeholder?.toLowerCase().includes("job name"),
  ) as HTMLInputElement | undefined;
}

test("opening the unsaved project drawer performs zero writes", async (t) => {
  const restoreFetch = resetHarness();
  t.after(restoreFetch);
  const { unmount } = await renderDrawer();
  t.after(unmount);
  assert.equal(
    globalThis.__projectCreateFetches!.length,
    0,
    "opening ?projectNew=1 must hit no endpoint — the draft flow's POST is gone",
  );
  const save = buttonsNamed("Save")[0];
  assert.ok(save, "the unsaved drawer opens editable with an explicit Save");
  assert.equal(save.disabled, true, "Save stays disabled until the project is named");
});

test("cancel navigates away with zero writes", async (t) => {
  const restoreFetch = resetHarness();
  t.after(restoreFetch);
  const { unmount } = await renderDrawer();
  t.after(unmount);
  const cancel = buttonsNamed("Cancel")[0];
  assert.ok(cancel, "edit mode must offer Cancel");
  await click(cancel);
  assert.deepEqual(globalThis.__projectCreateRouter!.pushes, ["/projects"]);
  assert.equal(
    globalThis.__projectCreateFetches!.length,
    0,
    "Cancel must write nothing — no draft exists to clean up",
  );
});

test("save posts once with a stable idempotency key, then opens the record", async (t) => {
  const restoreFetch = resetHarness();
  t.after(restoreFetch);
  const { unmount } = await renderDrawer();
  t.after(unmount);
  const field = nameField();
  assert.ok(field, "the project name input must render");
  await act(async () => {
    setInputValue(field!, "Harbourview Tower");
    await tick();
  });
  await tick();
  const save = buttonsNamed("Save")[0];
  assert.ok(save, "Save must render");
  assert.equal(save.disabled, false, "a named project is savable");
  await click(save);
  await tick();
  await tick();
  const posts = globalThis.__projectCreateFetches!.filter((f) => f.url === "/api/projects");
  assert.equal(posts.length, 1, "explicit Save is exactly one POST — never a draft plus an update");
  assert.equal(posts[0]!.init?.method, "POST");
  const key = (posts[0]!.init?.headers as Record<string, string>)["Idempotency-Key"];
  assert.ok(isUuid(key ?? ""), "the POST carries a UUID idempotency key");
  const body = JSON.parse(String(posts[0]!.init?.body)) as Record<string, unknown>;
  assert.equal(body.name, "Harbourview Tower");
  assert.equal(body.isActive, true, "creates default to active");
  assert.deepEqual(globalThis.__projectCreateRouter!.replaces, [
    "/projects?project=44444444-4444-4444-8444-444444444444",
  ]);
});

test("a refused create toasts and stays editable without navigating", async (t) => {
  const restoreFetch = resetHarness();
  t.after(restoreFetch);
  const prior = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    globalThis.__projectCreateFetches!.push({ url, init });
    return Response.json({ error: "Contract value must be a number" }, { status: 422 });
  }) as typeof fetch;
  const { unmount } = await renderDrawer();
  t.after(unmount);
  t.after(() => {
    globalThis.fetch = prior;
  });
  const field = nameField();
  assert.ok(field, "the project name input must render");
  await act(async () => {
    setInputValue(field!, "Harbourview Tower");
    await tick();
  });
  await tick();
  const save = buttonsNamed("Save")[0];
  assert.ok(save, "Save must render");
  await click(save);
  await tick();
  await tick();
  const toasts = globalThis.__projectCreateToasts ?? [];
  assert.ok(
    toasts.some((toast) => toast.kind === "error" && /Contract value must be a number/.test(toast.message)),
    "the refusal must surface the server's typed reason",
  );
  assert.ok(buttonsNamed("Save").length > 0, "a refused create stays editable");
  assert.deepEqual(globalThis.__projectCreateRouter!.replaces, [], "a refused create navigates nowhere");
});

test("the New button opens the unsaved drawer with zero writes", async (t) => {
  const restoreFetch = resetHarness();
  t.after(restoreFetch);
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  t.after(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
  });
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <NewProjectButton />
      </NextIntlClientProvider>,
    );
    await tick();
  });
  const button = buttonsNamed("New project")[0];
  assert.ok(button, "the New button must render");
  await click(button);
  assert.deepEqual(globalThis.__projectCreateRouter!.pushes, ["/projects?projectNew=1"]);
  assert.equal(globalThis.__projectCreateFetches!.length, 0, "the button writes nothing — no draft POST");
});

test("the ?project=new deep link swaps to the unsaved drawer with zero writes", async (t) => {
  const restoreFetch = resetHarness();
  t.after(restoreFetch);
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  t.after(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
  });
  await act(async () => {
    root.render(<NewProjectRedirect />);
    await tick();
  });
  await tick();
  assert.deepEqual(globalThis.__projectCreateRouter!.replaces, ["/projects?projectNew=1"]);
  assert.equal(globalThis.__projectCreateFetches!.length, 0, "the redirect writes nothing — no draft POST");
});
