// The party drawer never closes silently on unsaved edits. The X
// button (via TransactionDrawer's beforeClose) and Cancel both ask first
// when the editor is dirty; a clean editor closes without prompting, and
// declining the confirm keeps the drawer open with the typed work intact.

import assert from "node:assert/strict";
import test from "node:test";
import { bootJsdomEnvironment } from "../../../testing/jsdom-env";
import { stubModules } from "../../../testing/stub-modules";

// jsdom first: the drawer reads browser globals at render.
await bootJsdomEnvironment({ url: "http://localhost:4800/entities/vendors?party=22222222-2222-4222-8222-222222222222&mode=edit", matchMediaMatches: false });

const script = { confirmResult: true, confirmCalls: 0 };
Object.assign(globalThis, {
  __partyDiscard: script,
  __partyDiscardRouter: { push() {}, replace() {}, refresh() {} },
  __partyToasts: [],
  __partyPromptReason: "test reason",
});

stubModules({
  navigation: {
    source:
      "export function useRouter(){return globalThis.__partyDiscardRouter}" +
      "export function usePathname(){return '/entities/vendors'}" +
      "export function useSearchParams(){return new URLSearchParams()}",
  },
  intl: false,
  authz: false,
  features: false,
  extra: {
    "next/link": "export default function Link(p){return p.children}",
    sonner:
      "export const toast={success(){},error(){},warning(){},info(){}};export function Toaster(){return null}",
  },
});

// Confirm/prompt doubles stay suffix-wired: shared components import them
// through several relative spellings plus `@/`, which one exact key cannot name.
const { registerHooks: registerConfirmHooks } = await import("node:module");
registerConfirmHooks({
  resolve(specifier, context, next) {
    if (specifier.endsWith("/lib/confirm")) {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export async function confirmDialog(){const s=globalThis.__partyDiscard;s.confirmCalls++;return s.confirmResult}",
      };
    }
    if (specifier.endsWith("/lib/prompt")) {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export async function promptDialog(){return globalThis.__partyPromptReason}",
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
const { MoneyProvider } = await import("../../../components/money-provider");
const { PartyDrawer } = await import("./PartyDrawer");

const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));
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

async function mount() {
  script.confirmResult = true;
  script.confirmCalls = 0;
  const prior = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url === `/api/parties/${PARTY_ID}` && init?.method === "PATCH") {
      return Response.json({ ok: true });
    }
    return Response.json({});
  }) as typeof fetch;
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
            initialMode={"edit" as never}
            closeHref="/entities/vendors"
          />
        </MoneyProvider>
      </NextIntlClientProvider>,
    );
    await tick();
  });
  await tick(60);
  return {
    cleanup: async () => {
      globalThis.fetch = prior;
      await act(async () => {
        root.unmount();
      });
      host.remove();
      for (const node of [...document.body.children]) node.remove();
    },
  };
}

/** Type into every plain text input so at least the tracked fields dirty the form. */
async function typeIntoForm() {
  await act(async () => {
    const inputs = [...document.querySelectorAll("input")] as HTMLInputElement[];
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
    for (const input of inputs) {
      if (input.disabled || input.readOnly || input.type === "hidden" || input.type === "checkbox") continue;
      setter?.call(input, `${input.value}x`);
      input.dispatchEvent(new window.Event("input", { bubbles: true }));
    }
    await tick();
  });
  await tick(60);
}

function closeButton(): HTMLButtonElement {
  const button = [...document.querySelectorAll("button[aria-label]")].find((b) =>
    /close/i.test(b.getAttribute("aria-label") ?? ""),
  ) as HTMLButtonElement | undefined;
  assert.ok(button, "the drawer must offer a labelled close button");
  return button;
}

async function clickX() {
  await act(async () => {
    closeButton().dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await tick(120);
  });
  await tick(120);
}

/**
 * Whether the drawer shell still holds the page open. The shell locks body
 * scroll while open and releases it the moment close proceeds past the
 * guard — a synchronous, animation-independent signal, unlike the deferred
 * close navigation (which waits for the exit animation that never
 * completes under jsdom).
 */
function drawerOpen(): boolean {
  return document.body.style.overflow === "hidden";
}

test("X on a dirty party asks first and keeps the work when declined", async (t) => {
  const { cleanup } = await mount();
  t.after(cleanup);
  assert.ok(drawerOpen(), "the mounted drawer holds the page open");
  await typeIntoForm();
  script.confirmResult = false;
  await clickX();
  assert.equal(script.confirmCalls, 1, "closing a dirty editor must ask");
  assert.ok(drawerOpen(), "declining must keep the drawer open with the typed work");
});

test("X on a dirty party closes when confirmed", async (t) => {
  const { cleanup } = await mount();
  t.after(cleanup);
  await typeIntoForm();
  script.confirmResult = true;
  await clickX();
  assert.equal(script.confirmCalls, 1, "closing a dirty editor must ask");
  assert.ok(!drawerOpen(), "confirming must let the close proceed");
});

test("X on a clean party closes without asking", async (t) => {
  const { cleanup } = await mount();
  t.after(cleanup);
  script.confirmResult = false;
  await clickX();
  assert.equal(script.confirmCalls, 0, "a clean editor must not prompt");
  assert.ok(!drawerOpen(), "a clean editor must close straight through");
});
