import assert from "node:assert/strict";
import test from "node:test";
import { bootJsdomEnvironment } from "../../../testing/jsdom-env";
import { stubModules } from "../../../testing/stub-modules";

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
await bootJsdomEnvironment({ url: "http://localhost:4800/parties", matchMediaMatches: false });

stubModules({
  navigation: {
    source:
      "export function useRouter(){return globalThis.__partyRouter}" +
      "export function usePathname(){return '/parties'}" +
      "export function useSearchParams(){return new URLSearchParams()}",
  },
  intl: false,
  authz: false,
  features: false,
  extra: {
    "next/link": "export default function Link(p){return p.children}",
    sonner:
      "export const toast={success(m){(globalThis.__partyToasts??=[]).push({kind:'success',message:String(m)})},error(m){(globalThis.__partyToasts??=[]).push({kind:'error',message:String(m)})},warning(m){(globalThis.__partyToasts??=[]).push({kind:'warning',message:String(m)})}};export function Toaster(){return null}",
  },
});

// Confirm/prompt doubles stay suffix-wired: shared components import them
// through several relative spellings plus `@/`, which one exact key cannot name.
const { registerHooks: registerConfirmHooks } = await import("node:module");
registerConfirmHooks({
  resolve(specifier, context, next) {
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
const React = await import("react");
Object.assign(globalThis, { React });
const { createRoot } = await import("react-dom/client");
const { act } = await import("react");
const { NextIntlClientProvider } = await import("next-intl");
const messages = (await import("../../../messages/en")).default;
const { MoneyProvider } = await import("../../../components/money-provider");
const { BusinessDateProvider } = await import("../../../components/business-date-provider");
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
    const url = String(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
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
      return Response.json(
        { error: "Party has open bills and cannot be deactivated" },
        { status: 422 },
      );
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
  assert.match(
    alert.textContent ?? "",
    /Duplicate short code/,
    "the alert must carry the server reason",
  );
  assert.match(
    alert.textContent ?? "",
    /Save failed/,
    "the alert keeps the familiar save-failed heading",
  );
  const toasts = globalThis.__partyToasts ?? [];
  assert.ok(
    toasts.some((toast) => toast.kind === "error" && /Duplicate short code/.test(toast.message)),
    "the save refusal must also toast",
  );
  assert.ok(
    buttonsNamed("Save").length > 0,
    "a refused save must stay in edit mode with values intact",
  );
  assert.equal(save.disabled, false, "busy must release after the refusal");
});

// Direct-deposit capture at hire: the Employment tab's bank section offers
// Add bank account to HR/payroll operators through the native party bank
// path — without the master-data grant and without drawer edit mode —
// while pure readers still see no control.
const EMPLOYEE_PAYLOAD = {
  ...PAYLOAD,
  party: { ...PAYLOAD.party, kind: "person", display_name: "Hired Hannah" },
  vendor: null,
  employee: { is_active: true },
};

async function renderEmployeeDrawer(canManageEmployeeBanks: boolean) {
  globalThis.__partyToasts = [];
  globalThis.__partyRouter = { push() {}, refresh() {} };
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <MoneyProvider currency="USD">
          <BusinessDateProvider today="2026-10-01">
            <PartyDrawer
              payload={EMPLOYEE_PAYLOAD as never}
              paymentTerms={[]}
              departments={[]}
              trades={[]}
              fieldDefs={[]}
              subsidiaries={[]}
              canManage={false}
              canManageEmployeeBanks={canManageEmployeeBanks}
              recordType="employee"
              role="employee"
              initialTab="employment"
              hrm={{
                employmentIds: ["33333333-3333-4333-8333-333333333333"],
                canManageHrm: true,
                canReadExits: false,
                canRecordExit: false,
              }}
            />
          </BusinessDateProvider>
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

test("the Employment tab offers Add bank account to HR/payroll operators without edit mode", async (t) => {
  const restoreFetch = scriptFetch(() => null);
  t.after(restoreFetch);
  const { unmount } = await renderEmployeeDrawer(true);
  t.after(unmount);
  assert.ok(
    buttonsNamed("Add bank account")[0],
    "HR/payroll operators must get the native Add control where they hire",
  );
});

test("readers get no bank capture control on the Employment tab", async (t) => {
  const restoreFetch = scriptFetch(() => null);
  t.after(restoreFetch);
  const { unmount } = await renderEmployeeDrawer(false);
  t.after(unmount);
  assert.equal(buttonsNamed("Add bank account").length, 0, "no grant must mean no control");
});

// A 1099-reportable vendor read by an accountant: lifecycle and settlement
// entries the role cannot use stay out, while the readable entries — the
// statement and the 1099 settings on the Compliance tab — must be in the
// menu, never a button that opens an empty one.
const VENDOR_1099_PAYLOAD = {
  ...PAYLOAD,
  vendor: { ...PAYLOAD.vendor, is_t4a: true },
};

async function renderVendorAsAccountant() {
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
          <BusinessDateProvider today="2026-10-01">
            <PartyDrawer
              payload={VENDOR_1099_PAYLOAD as never}
              paymentTerms={[]}
              departments={[]}
              trades={[]}
              fieldDefs={[]}
              subsidiaries={[]}
              canManage={false}
              role="vendor"
              recordType="vendor"
              initialMode={"view" as never}
              complianceEnabled
              compliance={{ classId: null, classes: [] }}
            />
          </BusinessDateProvider>
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

function openMenuText(): string {
  return [...document.querySelectorAll("[data-ui-overlay]")]
    .map((el) => el.textContent ?? "")
    .join("\n");
}

test("a 1099 vendor offers its statement and compliance to a read-only accountant", async (t) => {
  const restoreFetch = scriptFetch(() => null);
  t.after(restoreFetch);
  const { unmount } = await renderVendorAsAccountant();
  t.after(unmount);
  const menu = buttonsNamed("Actions")[0];
  assert.ok(menu, "readable record actions must live behind the Actions menu");
  await click(menu);
  const entries = openMenuText();
  assert.match(entries, /View statement/, "the statement stays readable without the manage grant");
  assert.match(
    entries,
    /Compliance/,
    "the 1099 settings ride the same predicate as the Compliance tab",
  );
  const compliance = [...document.querySelectorAll("[data-ui-overlay] button")].find(
    (b) => b.textContent?.trim() === "Compliance",
  ) as HTMLButtonElement | undefined;
  assert.ok(compliance, "the compliance entry must be a real control");
  await click(compliance!);
  assert.match(
    document.body.textContent ?? "",
    /Subcontractor compliance/,
    "the entry lands on the Compliance tab without discarding the drawer",
  );
});

test("an unsaved record with no configured forms hides Actions instead of an empty menu", async (t) => {
  const restoreFetch = scriptFetch(() => null);
  t.after(restoreFetch);
  globalThis.__partyToasts = [];
  globalThis.__partyRouter = { push() {}, refresh() {} };
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <MoneyProvider currency="USD">
          <BusinessDateProvider today="2026-10-01">
            <PartyDrawer
              payload={PAYLOAD as never}
              paymentTerms={[]}
              departments={[]}
              trades={[]}
              fieldDefs={[]}
              subsidiaries={[]}
              canManage
              role="vendor"
              recordType="vendor"
              createMode
            />
          </BusinessDateProvider>
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
  assert.equal(buttonsNamed("Actions").length, 0, "no visible entry must mean no Actions button");
});
