import assert from "node:assert/strict";
import test from "node:test";

// Activating is a drawer submit too: an operator-chosen subsidiary must ride
// along on the Activate PATCH, or the hire stays org-wide (NULL) and every
// later payroll-profile default falls through to the root entity's country.
// Deactivation stays status-only, and an untouched picker never re-scopes an
// org-wide party to the root default.

// jsdom first: the drawer reads browser globals at render.
const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", {
  url: "http://localhost:4800/entities/employees",
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
    if (specifier === "next/navigation") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export function useRouter(){return globalThis.__partyRouter}export function usePathname(){return '/entities/employees'}export function useSearchParams(){return new URLSearchParams()}",
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
        url: "data:text/javascript,export const toast={success(m){(globalThis.__partyToasts??=[]).push({kind:'success',message:String(m)})},error(m){(globalThis.__partyToasts??=[]).push({kind:'error',message:String(m)})},warning(m){(globalThis.__partyToasts??=[]).push({kind:'warning',message:String(m)})}};export function Toaster(){return null}",
      };
    }
    if (specifier.endsWith("/lib/prompt")) {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export async function promptDialog(){return globalThis.__partyPromptReason ?? 'test reason'}",
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

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

declare global {
  var __partyToasts: { kind: string; message: string }[] | undefined;
  var __partyRouter: { push(url: string): void; refresh(): void } | undefined;
  var __partyPromptReason: string | null | undefined;
}

const PARTY_ID = "33333333-3333-4333-8333-333333333333";
const ROOT_ID = "11111111-1111-4111-8111-111111111111";
const IE_ID = "44444444-4444-4444-8444-444444444444";

const SUBS = [
  { id: ROOT_ID, parentId: null, name: "Root Inc", isElimination: false, depth: 0 },
  { id: IE_ID, parentId: ROOT_ID, name: "Dublin Ltd", isElimination: false, depth: 1 },
];

function payloadFor(subsidiaryId: string | null) {
  return {
    party: {
      id: PARTY_ID,
      display_name: "New party",
      legal_name: null,
      short_code: null,
      kind: "company",
      email: null,
      phone: null,
      website: null,
      subsidiary_id: subsidiaryId,
      is_active: false,
      updated_at: "2026-09-17T12:00:00.000000Z",
      custom: null,
      invoicing_preference: null,
    },
    customer: null,
    vendor: null,
    employee: { is_active: true, employee_number: null, job_title: null, department_id: null, trade_id: null, worker_comp_group_id: null, hired_on: null },
    addresses: [],
    contacts: [],
    bankAccounts: [],
    transactionSummary: { count: 0, openCount: 0, lastDate: null, currencies: [] },
    additionalSubsidiaryIds: [],
  };
}

const bodies: Array<Record<string, unknown>> = [];
function scriptFetch() {
  const prior = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url === `/api/parties/${PARTY_ID}` && init?.method === "PATCH") {
      bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return Response.json({ party: { is_active: true } });
    }
    return Response.json({});
  }) as typeof fetch;
  return () => {
    globalThis.fetch = prior;
  };
}

async function renderDrawer(subsidiaryId: string | null) {
  bodies.length = 0;
  globalThis.__partyToasts = [];
  globalThis.__partyPromptReason = "test reason";
  globalThis.__partyRouter = { push() {}, refresh() {} };
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <MoneyProvider currency="USD">
          <PartyDrawer
            payload={payloadFor(subsidiaryId) as never}
            paymentTerms={[]}
            departments={[]}
            trades={[]}
            fieldDefs={[]}
            subsidiaries={SUBS as never}
            canManage
            role="employee"
            recordType="employee"
            initialMode={"edit" as never}
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

async function typeName() {
  const nameInput = document.querySelector("input") as HTMLInputElement | null;
  assert.ok(nameInput, "overview must render a name input");
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
    setter.call(nameInput, "Sean Murphy");
    nameInput.dispatchEvent(new window.Event("change", { bubbles: true }));
    await tick();
  });
  await tick();
}

async function chooseSubsidiary(id: string) {
  const subSelect = [...document.querySelectorAll("select")].find((s) =>
    [...s.options].some((o) => o.value === IE_ID),
  ) as HTMLSelectElement | undefined;
  assert.ok(subSelect, "a multi-subsidiary org must offer a primary-subsidiary picker");
  await act(async () => {
    subSelect.value = id;
    subSelect.dispatchEvent(new window.Event("change", { bubbles: true }));
    await tick();
  });
  await tick();
}

async function activate() {
  const menu = buttonsNamed("Actions")[0];
  assert.ok(menu, "drawer must offer an Actions menu");
  await click(menu);
  const button = buttonsNamed("Activate")[0];
  assert.ok(button && !button.disabled, "a named draft must offer an enabled Activate");
  await click(button);
  await tick();
}

test("activating after choosing a subsidiary carries the choice", async (t) => {
  const restoreFetch = scriptFetch();
  t.after(restoreFetch);
  const { unmount } = await renderDrawer(null);
  t.after(unmount);
  await typeName();
  await chooseSubsidiary(IE_ID);
  await activate();
  const activateBody = bodies.find((b) => b.isActive === true);
  assert.ok(activateBody, "activate must PATCH the party");
  assert.equal(
    activateBody.subsidiaryId,
    IE_ID,
    "the operator-chosen subsidiary must ride along on activate, or the hire stays org-wide",
  );
});

test("activating without touching the picker sends status only", async (t) => {
  const restoreFetch = scriptFetch();
  t.after(restoreFetch);
  const { unmount } = await renderDrawer(null);
  t.after(unmount);
  await typeName();
  await activate();
  const activateBody = bodies.find((b) => b.isActive === true);
  assert.ok(activateBody, "activate must PATCH the party");
  assert.ok(
    !("subsidiaryId" in activateBody),
    "an untouched picker must not silently re-scope an org-wide party to the root default",
  );
});

test("deactivating never carries the subsidiary form state", async (t) => {
  const restoreFetch = scriptFetch();
  t.after(restoreFetch);
  const { unmount } = await renderDrawer(IE_ID);
  t.after(unmount);
  const menu = buttonsNamed("Actions")[0];
  assert.ok(menu, "drawer must offer an Actions menu");
  await click(menu);
  // Draft payload is inactive so only Activate shows; render active instead.
  await unmount();
  bodies.length = 0;
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const activePayload = { ...payloadFor(IE_ID), party: { ...payloadFor(IE_ID).party, display_name: "Sean Murphy", is_active: true } };
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <MoneyProvider currency="USD">
          <PartyDrawer
            payload={activePayload as never}
            paymentTerms={[]}
            departments={[]}
            trades={[]}
            fieldDefs={[]}
            subsidiaries={SUBS as never}
            canManage
            role="employee"
            recordType="employee"
          />
        </MoneyProvider>
      </NextIntlClientProvider>,
    );
    await tick();
  });
  await tick();
  await tick();
  t.after(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
  });
  const menu2 = buttonsNamed("Actions")[0];
  assert.ok(menu2, "drawer must offer an Actions menu");
  await click(menu2);
  const deactivate = buttonsNamed("Deactivate")[0];
  assert.ok(deactivate, "an active party must offer Deactivate");
  await click(deactivate);
  await tick();
  const deactivateBody = bodies.find((b) => b.isActive === false);
  assert.ok(deactivateBody, "deactivate must PATCH the party");
  assert.ok(
    !("subsidiaryId" in deactivateBody),
    "deactivation is status-only and must not touch subsidiary assignment",
  );
});
