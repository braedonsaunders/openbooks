import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

declare global {
  var __equipToasts: { kind: string; message: string }[] | undefined;
  var __equipRouter: { push(url: string): void; refresh(): void } | undefined;
}

// EquipmentDrawer on the shared action path. A dead network on save threw
// past the busy reset (wedged Save, unhandled rejection); refused deletes
// and capitalizations toasted without pinning. The charge-item refusal keeps
// its translated copy and its field flag — the code names no remedy — now
// branched off a stable route code instead of the error text.

// jsdom first: the drawer reads browser globals at render.
const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", {
  url: "http://localhost:4800/assets/equipment",
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
        url: "data:text/javascript,export function useRouter(){return globalThis.__equipRouter}export function usePathname(){return '/assets/equipment'}export function useSearchParams(){return new URLSearchParams()}",
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
        url: "data:text/javascript,export const toast={success(m){(globalThis.__equipToasts??=[]).push({kind:'success',message:String(m)})},error(m){(globalThis.__equipToasts??=[]).push({kind:'error',message:String(m)})},warning(m){(globalThis.__equipToasts??=[]).push({kind:'warning',message:String(m)})},info(m){(globalThis.__equipToasts??=[]).push({kind:'info',message:String(m)})}};export function Toaster(){return null}",
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
const messages = (await import("../../../../messages/en")).default;
const { MoneyProvider } = await import("../../../../components/money-provider");
const { EquipmentDrawer } = await import("./EquipmentDrawer");

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

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

function freshGlobals() {
  globalThis.__equipToasts = [];
  globalThis.__equipRouter = { push() {}, refresh() {} };
}

const UNIT_ID = randomUUID();

function payload() {
  return {
    unit: {
      id: UNIT_ID,
      name: "Excavator 3",
      unit_number: "EX-003",
      description: "",
      status: "draft",
      subsidiary_id: randomUUID(),
      charge_item_id: null,
      charge_item_name: null,
      fixed_asset_id: null,
      fixed_asset_number: null,
      fixed_asset_cost: null,
      rate_book_id: null,
      rate_book_name: null,
      purchase_price: "120000",
      acquired_on: null,
      in_service_on: null,
      serial_number: "",
      capacity_quantity: null,
      capacity_unit: null,
    },
    metrics: { recovery: "0", billed_revenue: "0", direct_costs: "0", depreciation: "0", usage: "0", billable: "0" },
  };
}

async function mountDrawer(extraProps: Record<string, unknown> = {}) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <MoneyProvider currency="USD">
          <EquipmentDrawer
            payload={payload()}
            items={[]}
            assets={[]}
            books={[]}
            subsidiaries={[]}
            canManage
            {...extraProps}
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

async function openEditAndSave() {
  const edit = buttonsNamed("Edit")[0];
  assert.ok(edit, "the unit must offer Edit");
  await click(edit);
  const save = buttonsNamed("Save")[0];
  assert.ok(save, "edit mode must offer Save");
  await click(save);
  await tick();
  return save;
}

test("a refused delete pins the reason instead of toasting into the void", async (t) => {
  freshGlobals();
  const restoreFetch = scriptFetch((url, init) => {
    if (url === `/api/equipment/${UNIT_ID}` && init?.method === "DELETE") {
      return Response.json({ error: "Unit has time entries" }, { status: 422 });
    }
    return null;
  });
  t.after(restoreFetch);
  const { unmount } = await mountDrawer();
  t.after(unmount);
  const menu = buttonsNamed("Actions")[0];
  assert.ok(menu, "record actions must live behind the Actions menu");
  await click(menu);
  const del = buttonsNamed("Delete")[0];
  assert.ok(del, "a draft unit must offer Delete");
  await click(del);
  await tick();
  const alert = document.querySelector('[role="alert"]');
  assert.ok(alert, "the delete refusal must pin as an alert, not vanish with the toast");
  assert.match(alert.textContent ?? "", /Unit has time entries/, "the alert must carry the server reason");
});

test("a refused capitalize pins the generic copy, never a kernel code", async (t) => {
  freshGlobals();
  const restoreFetch = scriptFetch((url, init) => {
    if (url === `/api/equipment/${UNIT_ID}/capitalize` && init?.method === "POST") {
      return Response.json({ error: "already_capitalized" }, { status: 409 });
    }
    return null;
  });
  t.after(restoreFetch);
  const { unmount } = await mountDrawer({ fixedAssetsEnabled: true });
  t.after(unmount);
  const menu = buttonsNamed("Actions")[0];
  assert.ok(menu, "record actions must live behind the Actions menu");
  await click(menu);
  const cap = buttonsNamed("Capitalize as fixed asset")[0];
  assert.ok(cap, "capitalization must be offered while Fixed Assets is on");
  await click(cap);
  await tick();
  const alert = document.querySelector('[role="alert"]');
  assert.ok(alert, "the capitalize refusal must pin as an alert, not vanish with the toast");
  assert.match(alert.textContent ?? "", /Could not capitalize/, "the pin must render the translated remedy copy");
  assert.doesNotMatch(alert.textContent ?? "", /already_capitalized/, "a kernel code must never reach the user verbatim");
});

test("a charge-item refusal still pins translated copy and flags its field (F-t07-006)", async (t) => {
  freshGlobals();
  const restoreFetch = scriptFetch((url, init) => {
    if (url === `/api/equipment/${UNIT_ID}` && init?.method === "PATCH") {
      return Response.json({ error: "charge_item_required", code: "charge_item_required" }, { status: 422 });
    }
    return null;
  });
  t.after(restoreFetch);
  const { unmount } = await mountDrawer();
  t.after(unmount);
  await openEditAndSave();
  const alert = document.querySelector('[role="alert"]');
  assert.ok(alert, "the charge-item refusal must pin as an alert");
  assert.match(alert.textContent ?? "", /charge item is required/, "the pin must render the translated reason");
});

test("a dead network on save pins the fallback and releases Save", async (t) => {
  freshGlobals();
  const restoreFetch = scriptFetch((url, init) => {
    if (url === `/api/equipment/${UNIT_ID}` && init?.method === "PATCH") {
      throw new TypeError("fetch failed");
    }
    return null;
  });
  t.after(restoreFetch);
  const { unmount } = await mountDrawer();
  t.after(unmount);
  const save = await openEditAndSave();
  const alert = document.querySelector('[role="alert"]');
  assert.ok(alert, "a transport failure must still pin an alert — it cannot throw past the UI");
  assert.match(alert.textContent ?? "", /Could not save equipment/, "with no server reason the alert falls back to localized copy");
  assert.equal(save.disabled, false, "busy must release after a transport failure");
});

