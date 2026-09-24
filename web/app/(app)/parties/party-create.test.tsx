import assert from "node:assert/strict";
import test from "node:test";
import { isUuid } from "@/lib/list-params";

declare global {
  var __partyCreateToasts: { kind: string; message: string }[] | undefined;
  var __partyCreateRouter: { pushes: string[]; replaces: string[]; refreshes: number } | undefined;
  var __partyCreateFetches: { url: string; init?: RequestInit }[] | undefined;
}

// Unsaved-create contract, Parties side: the New button and the ?party=new
// deep link open a URL-controlled drawer with ZERO writes; Cancel navigates
// away with zero writes; the drawer's explicit Save is exactly one
// idempotent POST with active defaulting true.

// jsdom first: the drawer reads browser globals at render.
const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", {
  url: "http://localhost:4800/parties",
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
        url: "data:text/javascript,export function useRouter(){return {push(u){globalThis.__partyCreateRouter.pushes.push(String(u))},replace(u){globalThis.__partyCreateRouter.replaces.push(String(u))},refresh(){globalThis.__partyCreateRouter.refreshes+=1}}}export function usePathname(){return '/parties'}export function useSearchParams(){return new URLSearchParams()}",
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
        url: "data:text/javascript,export const toast={success(m){(globalThis.__partyCreateToasts??=[]).push({kind:'success',message:String(m)})},error(m){(globalThis.__partyCreateToasts??=[]).push({kind:'error',message:String(m)})},warning(m){(globalThis.__partyCreateToasts??=[]).push({kind:'warning',message:String(m)})}};export function Toaster(){return null}",
      };
    }
    if (specifier.endsWith("/lib/prompt")) {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export async function promptDialog(){return globalThis.__partyCreatePrompt ?? 'test reason'}",
      };
    }
    if (specifier.endsWith("/lib/confirm")) {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export async function confirmDialog(){return true}",
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
const { PartyDrawer } = await import("./PartyDrawer");
const { NewPartyButton } = await import("./NewPartyButton");
const { NewPartyRedirect } = await import("./NewPartyRedirect");

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

const NEW_PAYLOAD = {
  party: {
    id: "",
    display_name: "",
    legal_name: null,
    short_code: null,
    kind: "company",
    email: null,
    phone: null,
    website: null,
    subsidiary_id: null,
    is_active: true,
    updated_at: "",
    custom: {},
    invoicing_preference: null,
  },
  customer: null,
  vendor: null,
  employee: null,
  addresses: [],
  contacts: [],
  bankAccounts: [],
  transactionSummary: { count: 0, openCount: 0, lastDate: null, currencies: [] },
  additionalSubsidiaryIds: [],
};

function resetHarness() {
  globalThis.__partyCreateToasts = [];
  globalThis.__partyCreateRouter = { pushes: [], replaces: [], refreshes: 0 };
  globalThis.__partyCreateFetches = [];
  const prior = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    globalThis.__partyCreateFetches!.push({ url, init });
    return Response.json({ party: { id: "33333333-3333-4333-8333-333333333333" } }, { status: 201 });
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
          <PartyDrawer
            payload={NEW_PAYLOAD as never}
            paymentTerms={[]}
            departments={[]}
            trades={[]}
            fieldDefs={[]}
            subsidiaries={[]}
            canManage
            createMode
            closeHref="/parties"
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

/** The display-name input: the first free-text input in the identity section
 *  (kind is a select; email/phone carry their own types). */
function nameInput(): HTMLInputElement | undefined {
  return [...document.querySelectorAll("input")].find((el) => {
    const type = (el as HTMLInputElement).type;
    return type !== "checkbox" && type !== "email" && type !== "tel";
  }) as HTMLInputElement | undefined;
}

test("opening the unsaved party drawer performs zero writes", async (t) => {
  const restoreFetch = resetHarness();
  t.after(restoreFetch);
  const { unmount } = await renderDrawer();
  t.after(unmount);
  assert.equal(
    globalThis.__partyCreateFetches!.length,
    0,
    "opening ?partyNew=1 must hit no endpoint — the draft flow's POST is gone",
  );
  const save = buttonsNamed("Save")[0];
  assert.ok(save, "the unsaved drawer opens editable with an explicit Save");
  assert.equal(save.disabled, true, "Save stays disabled until the party is named");
});

test("cancel navigates away with zero writes", async (t) => {
  const restoreFetch = resetHarness();
  t.after(restoreFetch);
  const { unmount } = await renderDrawer();
  t.after(unmount);
  const cancel = buttonsNamed("Cancel")[0];
  assert.ok(cancel, "edit mode must offer Cancel");
  await click(cancel);
  assert.deepEqual(globalThis.__partyCreateRouter!.pushes, ["/parties"]);
  assert.equal(
    globalThis.__partyCreateFetches!.length,
    0,
    "Cancel must write nothing — no draft exists to clean up",
  );
});

test("save stays disabled until named, then posts once with a stable idempotency key", async (t) => {
  const restoreFetch = resetHarness();
  t.after(restoreFetch);
  const { unmount } = await renderDrawer();
  t.after(unmount);
  // Blank name: the ONLY save path refuses client-side, so no request fires.
  const field = nameInput();
  assert.ok(field, "the name input must render");
  await act(async () => {
    setInputValue(field!, "Acme Corp");
    await tick();
  });
  await tick();
  const save = buttonsNamed("Save")[0];
  assert.ok(save, "Save must render");
  assert.equal(save.disabled, false, "a named party is savable");
  await click(save);
  await tick();
  await tick();
  const posts = globalThis.__partyCreateFetches!.filter((f) => f.url === "/api/parties");
  assert.equal(posts.length, 1, "explicit Save is exactly one POST — never a draft plus an update");
  assert.equal(posts[0]!.init?.method, "POST");
  const key = (posts[0]!.init?.headers as Record<string, string>)["Idempotency-Key"];
  assert.ok(isUuid(key ?? ""), "the POST carries a UUID idempotency key");
  const body = JSON.parse(String(posts[0]!.init?.body)) as Record<string, unknown>;
  assert.equal(body.displayName, "Acme Corp");
  assert.equal(body.isActive, true, "creates default to active");
  assert.ok(!("expectedUpdatedAt" in body), "the PATCH concurrency token has no row to version on create");
  assert.deepEqual(globalThis.__partyCreateRouter!.replaces, [
    "/parties?party=33333333-3333-4333-8333-333333333333",
  ]);
});

test("a refused create pins its reason and stays editable without navigating", async (t) => {
  const restoreFetch = resetHarness();
  t.after(restoreFetch);
  const prior = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    globalThis.__partyCreateFetches!.push({ url, init });
    return Response.json({ error: "That short code is already used by another party" }, { status: 422 });
  }) as typeof fetch;
  const { unmount } = await renderDrawer();
  t.after(unmount);
  t.after(() => {
    globalThis.fetch = prior;
  });
  const field = nameInput();
  assert.ok(field, "the name input must render");
  await act(async () => {
    setInputValue(field!, "Acme Corp");
    await tick();
  });
  await tick();
  const save = buttonsNamed("Save")[0];
  assert.ok(save, "Save must render");
  await click(save);
  await tick();
  await tick();
  const alert = document.querySelector('[role="alert"]');
  assert.ok(alert, "the create refusal must pin as an alert, not vanish with the toast");
  assert.match(alert.textContent ?? "", /already used by another party/);
  assert.ok(buttonsNamed("Save").length > 0, "a refused create stays editable with values intact");
  assert.deepEqual(globalThis.__partyCreateRouter!.replaces, [], "a refused create navigates nowhere");
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
        <NewPartyButton basePath="/entities/customers" role="customer" label="New customer" />
      </NextIntlClientProvider>,
    );
    await tick();
  });
  const button = buttonsNamed("New customer")[0];
  assert.ok(button, "the New button must render");
  await click(button);
  assert.deepEqual(globalThis.__partyCreateRouter!.pushes, [
    "/entities/customers?partyNew=1&role=customer",
  ]);
  assert.equal(globalThis.__partyCreateFetches!.length, 0, "the button writes nothing — no draft POST");
});

test("the ?party=new deep link swaps to the unsaved drawer with zero writes", async (t) => {
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
        <NewPartyRedirect basePath="/entities/vendors" role="vendor" />
      </NextIntlClientProvider>,
    );
    await tick();
  });
  await tick();
  assert.deepEqual(globalThis.__partyCreateRouter!.replaces, ["/entities/vendors?partyNew=1&role=vendor"]);
  assert.equal(globalThis.__partyCreateFetches!.length, 0, "the redirect writes nothing — no draft POST");
});
