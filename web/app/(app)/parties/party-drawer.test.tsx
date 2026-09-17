import assert from "node:assert/strict";
import test from "node:test";

declare global {
  var __partyToasts: { kind: string; message: string }[] | undefined;
  var __partyRouter: { push(url: string): void; refresh(): void } | undefined;
  var __partyPromptReason: string | null | undefined;
}

// PartyDrawer ran two behaviours in one file: save failures pinned, but
// activate/deactivate failures toasted without pinning. Both now run on the
// shared action path — the refusal pins as a record-level role="alert"
// until the next action AND toasts, and busy always releases.

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
    if (specifier === "next/navigation") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export function useRouter(){return globalThis.__partyRouter}export function usePathname(){return '/parties'}export function useSearchParams(){return new URLSearchParams()}",
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

const PARTY_ID = "22222222-2222-4222-8222-222222222222";

const PAYLOAD = {
  party: {
    id: PARTY_ID,
    display_name: "Acme Corp",
    legal_name: "Acme Corp Ltd",
    short_code: "ACME",
    kind: "company",
    email: null,
    phone: null,
    website: null,
    subsidiary_id: null,
    is_active: true,
    updated_at: "2026-09-17T12:00:00.000000Z",
    custom: null,
    invoicing_preference: null,
  },
  customer: null,
  vendor: {
    is_active: true,
    payment_method: null,
    eft_notification_email: null,
    payment_terms_id: null,
    currency: null,
    is_t4a: false,
    ap_account_id: null,
    default_expense_account_id: null,
    tax_code_id: null,
    is_on_hold: false,
    hold_reason: null,
  },
  employee: null,
  addresses: [],
  contacts: [],
  bankAccounts: [],
  transactionSummary: { count: 0, openCount: 0, lastDate: null, currencies: [] },
  additionalSubsidiaryIds: [],
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

async function renderDrawer(initialMode?: string) {
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
            payload={PAYLOAD as never}
            paymentTerms={[]}
            departments={[]}
            trades={[]}
            fieldDefs={[]}
            subsidiaries={[]}
            canManage
            recordType="vendor"
            initialMode={initialMode as never}
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

test("a refused deactivate pins the reason like a refused save does", async (t) => {
  const restoreFetch = scriptFetch((url, init) => {
    if (url === `/api/parties/${PARTY_ID}` && init?.method === "PATCH") {
      return Response.json({ error: "Party has open bills and cannot be deactivated" }, { status: 422 });
    }
    return null;
  });
  t.after(restoreFetch);
  const { unmount } = await renderDrawer();
  t.after(unmount);
  const menu = buttonsNamed("Actions")[0];
  assert.ok(menu, "record actions must live behind the Actions menu");
  await click(menu);
  const deactivate = buttonsNamed("Deactivate")[0];
  assert.ok(deactivate, "an active party must offer Deactivate");
  await click(deactivate);
  await tick();
  const alert = document.querySelector('[role="alert"]');
  assert.ok(alert, "the deactivate refusal must pin as an alert, not vanish with the toast");
  assert.match(
    alert.textContent ?? "",
    /Party has open bills/,
    "the alert must carry the server's typed reason",
  );
  const toasts = globalThis.__partyToasts ?? [];
  assert.ok(
    toasts.some((toast) => toast.kind === "error" && /open bills/.test(toast.message)),
    "the refusal must also toast as an error",
  );
  assert.ok(
    buttonsNamed("Deactivate").length > 0,
    "the party must stay active after a refused deactivate",
  );
});

test("a refused save still pins, toasts, and stays in edit mode", async (t) => {
  const restoreFetch = scriptFetch((url, init) => {
    if (url === `/api/parties/${PARTY_ID}` && init?.method === "PATCH") {
      return Response.json({ error: "Duplicate short code" }, { status: 422 });
    }
    return null;
  });
  t.after(restoreFetch);
  const { unmount } = await renderDrawer("edit");
  t.after(unmount);
  const save = buttonsNamed("Save")[0];
  assert.ok(save, "edit mode must offer Save");
  await click(save);
  await tick();
  const alert = document.querySelector('[role="alert"]');
  assert.ok(alert, "the save refusal must pin as an alert");
  assert.match(alert.textContent ?? "", /Duplicate short code/, "the alert must carry the server reason");
  assert.match(alert.textContent ?? "", /Save failed/, "the alert keeps the familiar save-failed heading");
  const toasts = globalThis.__partyToasts ?? [];
  assert.ok(
    toasts.some((toast) => toast.kind === "error" && /Duplicate short code/.test(toast.message)),
    "the save refusal must also toast",
  );
  assert.ok(buttonsNamed("Save").length > 0, "a refused save must stay in edit mode with values intact");
  assert.equal(save.disabled, false, "busy must release after the refusal");
});
