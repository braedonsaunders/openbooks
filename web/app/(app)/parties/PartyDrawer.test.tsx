// The native party drawer retains edits and enforces each confidential panel grant.
import assert from "node:assert/strict";
import test from "node:test";
import { LOCALE_CODES as LOCALES } from "../../../i18n/config"
import { employeeBenefitAssignments } from "../../../lib/hrm/employee-benefits-types";
import { bootJsdomEnvironment } from "../../../testing/jsdom-env";
import { stubModules } from "../../../testing/stub-modules";

declare global {
  var __partyToasts: { kind: string; message: string }[] | undefined;
  var __partyRouter: { push(url: string): void; refresh(): void } | undefined;
  var __partyPromptReason: string | null | undefined;
}

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
    "next/link": "export default function Link(p){return globalThis.React.createElement('a',{href:p.href},p.children)}",
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
const enMessages = (await import("../../../messages/en")).default as Record<string, unknown>;
const { MoneyProvider } = await import("../../../components/money-provider");
const { BusinessDateProvider } = await import("../../../components/business-date-provider");
const { PartyDrawer, formatCreditLimit, rememberDrawerTab } = await import("./PartyDrawer");

function msg(tree: Record<string, unknown>, path: string): string {
  let node: unknown = tree;
  for (const part of path.split(".")) node = (node as Record<string, unknown>)[part];
  if (typeof node !== "string") throw new Error(`missing message ${path}`);
  return node;
}
const en = (path: string): string => msg(enMessages, path);

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

const PARTY_ID = "22222222-2222-4222-8222-222222222222";
const EMPLOYEE_ID = "55555555-5555-4555-8555-555555555555";

const VENDOR_PAYLOAD = {
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

const EMPLOYEE_ROW = {
  is_active: true,
  employee_number: null,
  job_title: null,
  department_id: null,
  trade_id: null,
  worker_comp_group_id: null,
  hired_on: null,
};

function employeePayload(kind: string, roles: { customer?: boolean; vendor?: boolean; employee?: boolean }) {
  return {
    party: { ...VENDOR_PAYLOAD.party, id: EMPLOYEE_ID, display_name: "Ava Employee", kind },
    customer: roles.customer ? { is_active: true } : null,
    vendor: roles.vendor ? { ...VENDOR_PAYLOAD.vendor } : null,
    employee: roles.employee === false ? null : { ...EMPLOYEE_ROW },
    addresses: [],
    contacts: [],
    bankAccounts: [],
    transactionSummary: { count: 0, openCount: 0, lastDate: null, currencies: [] },
    additionalSubsidiaryIds: [],
  };
}

const BALANCE_ROW = {
  planId: "plan-1",
  planName: "Vacation",
  planCode: "VAC",
  overLimit: false,
  nearLimit: false,
  unit: "hours",
  balance: "40",
  direction: "earn",
  maxBalance: null,
  limitScope: null,
};

const MOVEMENT_ROW = {
  id: "move-1",
  movement_date: "2026-08-01",
  plan_code: "VAC",
  plan_name: "Vacation",
  kind: "accrual",
  amount: "8",
  unit: "hours",
  run_number: null,
  note: null,
};

const BANK_ROW = {
  id: "bank-1",
  bank_name: "First Bank",
  routing: {},
  account_last_four: "1234",
  currency: "USD",
  retired_at: null,
  approval_status: "approved",
  approved_at: "2026-01-01",
  updated_at: "2026-01-01",
};

function routeFetch(routes: Record<string, () => Response>) {
  return (url: string) => Object.entries(routes).find(([prefix]) => url.startsWith(prefix))?.[1]() ?? null;
}

function stubFetch(handler: (url: string, init?: RequestInit) => Response | null) {
  const prior = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    return handler(url, init) ?? Response.json({});
  }) as typeof fetch;
  return () => {
    globalThis.fetch = prior;
  };
}

function employeeRoutes(): Record<string, () => Response> {
  return {
    "/api/admin/setup/labor-costing": () =>
      Response.json({ rates: [], currencies: ["USD"], defaultCurrency: "USD" }),
    "/api/payroll/profiles": () =>
      Response.json({
        profile: null,
        schedules: [
          { id: "sched-1", name: "Monthly" },
          { id: "sched-2", name: "Twice monthly" },
        ],
        filingAccounts: [],
        labourJurisdictions: {},
        countries: ["US"],
        packProfiles: {},
        storedCertificates: [],
        derivedProfileColumns: {},
        defaultCountry: "US",
      }),
    "/api/hrm/employee-benefits": () => Response.json({ employments: [{ value: "employment-1", label: "Employer" }], assignments: [], programs: [], enrollments: [], vacation: [], service: [], payroll: true, canManage: true, canReadBanks: true }),
    "/api/payroll/entitlements": () =>
      Response.json({ currency: "USD", balances: [BALANCE_ROW], movements: [MOVEMENT_ROW] }),
  };
}

async function renderDrawer(options: {
  payload?: Record<string, unknown>;
  role?: "customer" | "vendor" | "employee";
  recordType?: "customer" | "vendor" | "employee";
  /** Unified /parties directory scope: no role or record type is forced. */
  generic?: boolean;
  initialMode?: "view" | "edit";
  initialTab?: string;
  grants?: Record<string, unknown>;
  bankAccounts?: Record<string, unknown>[];
  messages?: Record<string, unknown>;
  locale?: string;
  fetchHandler?: (url: string, init?: RequestInit) => Response | null;
}) {
  const restoreFetch = stubFetch(options.fetchHandler ?? (() => null));
  globalThis.__partyToasts = [];
  globalThis.__partyPromptReason = "test reason";
  globalThis.__partyRouter = { push() {}, refresh() {} };
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const payload = {
    ...(options.payload ?? VENDOR_PAYLOAD),
    bankAccounts: options.bankAccounts ?? [],
  };
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale={options.locale ?? "en"} messages={options.messages ?? enMessages} timeZone="UTC">
        <MoneyProvider currency="USD">
          <BusinessDateProvider today="2026-09-17">
            <PartyDrawer
              payload={payload as never}
              paymentTerms={[]}
              departments={[]}
              trades={[]}
              fieldDefs={[]}
              subsidiaries={[]}
              canManage
              role={options.generic ? undefined : (options.role ?? "vendor")}
              recordType={options.generic ? undefined : (options.recordType ?? "vendor")}
              initialMode={(options.initialMode ?? "view") as never}
              initialTab={(options.initialTab ?? "overview") as never}
              {...(options.grants ?? {})}
            />
          </BusinessDateProvider>
        </MoneyProvider>
      </NextIntlClientProvider>,
    );
    await tick();
  });
  await tick();
  await tick();
  await tick();
  return {
    host,
    done: async () => {
      restoreFetch();
      await act(async () => {
        root.unmount();
      });
      host.remove();
    },
  };
}

function renderEmployeeDrawer(options: Parameters<typeof renderDrawer>[0] = {}) {
  return renderDrawer({ payload: employeePayload("employee", { employee: true }), role: "employee", recordType: "employee", fetchHandler: routeFetch(employeeRoutes()), ...options });
}

function renderPayrollDrawer(options: Parameters<typeof renderDrawer>[0] = {}) {
  return renderEmployeeDrawer({ initialTab: "payroll", grants: { canManageWages: true, canManagePayroll: true }, ...options });
}

function railTabs(scope: ParentNode = document, tree: Record<string, unknown> = enMessages): HTMLButtonElement[] {
  const rail = scope.querySelector(`nav[aria-label="${msg(tree, "common.auditTrail.ariaLabel")}"]`);
  assert.ok(rail, "the flyout must render its tab rail");
  return [...rail.querySelectorAll('button[aria-pressed]')] as HTMLButtonElement[];
}

function railTabNamed(name: string, scope: ParentNode = document, tree: Record<string, unknown> = enMessages): HTMLButtonElement | undefined {
  return railTabs(scope, tree).find((button) => button.textContent?.trim() === name);
}

async function clickTab(button: HTMLButtonElement) {
  await act(async () => {
    button.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await tick();
  });
  await tick();
  await tick();
}

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  setter.call(input, value);
  input.dispatchEvent(new window.Event("change", { bubbles: true }));
}

function setSelectValue(select: HTMLSelectElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value")!.set!;
  setter.call(select, value);
  select.dispatchEvent(new window.Event("change", { bubbles: true }));
}

function kindSelect(): HTMLSelectElement | undefined {
  return [...document.querySelectorAll("select")].find((select) =>
    [...select.options].some((option) => option.value === "customer"),
  ) as HTMLSelectElement | undefined;
}

test("credit-limit formatting preserves large decimals, rounds exact cents and permits an empty value", () => {
  for (const [value, expected] of [["9007199254740993.0000", "9007199254740993.00"], ["86.6150", "86.62"], [null, ""]] as const) assert.equal(formatCreditLimit(value), expected);
});

test("remembering a visited drawer tab keeps it without mutating the set", () => {
  const kept = rememberDrawerTab(new Set(["overview"]), "payroll");
  assert.ok(kept.has("overview"));
  assert.ok(kept.has("payroll"));
});

test("remembering an already kept tab returns the same set", () => {
  const kept = new Set(["overview", "payroll"] as const);
  assert.equal(rememberDrawerTab(kept, "payroll"), kept);
});

test("the kind control offers every stored kind", async (t) => {
  const { done } = await renderDrawer({ initialMode: "edit" });
  t.after(done);
  const select = kindSelect();
  assert.ok(select, "edit mode must offer a kind control");
  assert.deepEqual(
    [...select.options].map((option) => option.value),
    ["company", "person", "customer", "vendor", "employee"],
  );
});

test("read mode names the kind instead of offering the control", async (t) => {
  const payload = {
    ...VENDOR_PAYLOAD,
    party: { ...VENDOR_PAYLOAD.party, kind: "vendor" },
  };
  const { done } = await renderDrawer({ payload });
  t.after(done);
  assert.equal(kindSelect(), undefined, "read mode must not offer a kind control");
  assert.ok(
    document.body.textContent?.includes(en("parties.drawer.kindVendor")),
    "read mode must name the stored vendor kind",
  );
});

test("a failed photo removal keeps the photo and allows retry", async (t) => {
  let attempts = 0;
  const { done } = await renderDrawer({
    payload: { ...VENDOR_PAYLOAD, party: { ...VENDOR_PAYLOAD.party, photo_file_id: "photo-1" } },
    fetchHandler: (url, init) => {
      if (url.endsWith("/photo") && init?.method === "DELETE") {
        attempts += 1;
        if (attempts === 1) throw new TypeError("Network unavailable");
        return Response.json({ photoFileId: null });
      }
      return null;
    },
  });
  t.after(done);
  const remove = () => document.querySelector<HTMLButtonElement>(`button[aria-label="${en("parties.drawer.photo.remove")}"]`);
  assert.ok(remove());
  await act(async () => { remove()!.click(); await tick(); });
  assert.deepEqual(globalThis.__partyToasts, [{ kind: "error", message: en("parties.drawer.photo.removeFailed") }]);
  assert.ok(remove(), "a failed request must retain the current photo");
  assert.equal(remove()!.disabled, false, "the operator must be able to retry");
  await act(async () => { remove()!.click(); await tick(); });
  assert.equal(attempts, 2);
  assert.equal(remove(), null, "the successful retry must clear the photo through the drawer state");
});

test("the rail lists every panel once with overview first", async (t) => {
  const { done } = await renderDrawer({ initialTab: "overview" });
  t.after(done);
  const labels = railTabs().map((button) => button.textContent?.trim() ?? "");
  assert.ok(labels.length > 0, "the rail must list the drawer panels");
  assert.equal(labels[0], en("parties.drawer.tabs.overview"), "the leading slot reads Overview, not Details");
  assert.ok(!labels.includes("Details"), "the party must not nest a second Details strip");
  for (const key of ["attachments", "audit"] as const) {
    const label = en(`common.auditTrail.tabs.${key}`);
    assert.equal(
      labels.filter((text) => text === label).length,
      1,
      `the shell appends exactly one ${label} panel`,
    );
  }
});

function wagesSection(): HTMLElement {
  const heading = [...document.querySelectorAll("h3")].find(
    (element) => element.textContent?.trim() === en("parties.drawer.wages.title"),
  );
  assert.ok(heading, "the wages panel must render its heading");
  const section = heading.closest("section");
  assert.ok(section, "the wages panel must render as a section");
  return section as HTMLElement;
}

function payrollPanel(): HTMLElement {
  const strip = document.querySelector(`nav[aria-label="${en("parties.drawer.payrollTabs.ariaLabel")}"]`);
  assert.ok(strip, "the payroll tab must render its sub-tab strip");
  const panel = strip.closest("[hidden], .space-y-6");
  assert.ok(panel, "the payroll sub-tab strip must sit inside the payroll panel");
  return panel as HTMLElement;
}

test("a visited compensation tab stays mounted while another shows", async (t) => {
  const { done } = await renderEmployeeDrawer({
    initialTab: "compensation",
    grants: { canManageWages: true, canManagePayroll: true },
  });
  t.after(done);
  const rate = document.querySelector("#employee-wage-rate") as HTMLInputElement | null;
  assert.ok(rate, "the compensation tab must offer a rate input");
  await act(async () => {
    setInputValue(rate, "42.50");
    await tick();
  });
  await tick();

  const payroll = railTabNamed(en("parties.drawer.tabs.payroll"));
  assert.ok(payroll, "the payroll tab must ride the same rail");
  await clickTab(payroll);
  const wages = wagesSection();
  assert.ok(
    wages.closest("[hidden]") !== null,
    "the wages panel must hide instead of unmounting",
  );
  assert.equal(
    (document.querySelector("#employee-wage-rate") as HTMLInputElement | null)?.value,
    "42.50",
    "the unsaved rate must survive behind the hidden panel",
  );

  const compensationTab = railTabNamed(en("parties.drawer.tabs.compensation"));
  assert.ok(compensationTab, "the compensation tab must still ride the rail");
  await clickTab(compensationTab);
  assert.equal(
    wages.closest("[hidden]"),
    null,
    "returning must show the same mounted panel",
  );
  assert.equal(
    (document.querySelector("#employee-wage-rate") as HTMLInputElement | null)?.value,
    "42.50",
    "the unsaved rate must still be there",
  );
});

test("each confidential tab needs its own grant", async (t) => {
  const labels = {
    compensation: en("parties.drawer.tabs.compensation"),
    payroll: en("parties.drawer.tabs.payroll"),
    employment: en("parties.drawer.tabs.employment"),
  };
  let prior: (() => Promise<void>) | null = null;
  const names = async (grants: Record<string, unknown>): Promise<string[]> => {
    if (prior) {
      const unmount = prior;
      prior = null;
      await unmount();
    }
    const { done } = await renderEmployeeDrawer({
      grants,
    });
    prior = done;
    return railTabs().map((button) => button.textContent?.trim() ?? "");
  };

  const ungranted = await names({});
  assert.ok(!ungranted.includes(labels.compensation), "compensation stays hidden without a wage or compensation grant");
  assert.ok(!ungranted.includes(labels.payroll), "payroll stays hidden without the payroll grant");
  assert.ok(!ungranted.includes(labels.employment), "employment stays hidden without the HRM read surface");

  const waged = await names({ canManageWages: true });
  assert.ok(waged.includes(labels.compensation), "the setup grant opens compensation for wage rates");
  assert.ok(!waged.includes(labels.payroll), "the setup grant must not open payroll");

  const paid = await names({ canManageWages: true, canManagePayroll: true });
  assert.ok(paid.includes(labels.payroll), "the payroll grant opens payroll");

  const employed = await names({
    hrm: { employmentIds: ["emp-1"], canManageHrm: false, canReadExits: false, canRecordExit: false },
  });
  assert.ok(employed.includes(labels.employment), "the HRM read surface opens employment");
  assert.ok(!employed.includes(labels.compensation), "the HRM read surface must not open compensation");

  const compensated = await names({ canReadCompensation: true });
  assert.ok(compensated.includes(labels.compensation), "the compensation read grant opens compensation");
  assert.ok(!compensated.includes(labels.payroll), "the compensation read grant must not open payroll");
  if (prior) t.after(prior);
});

function equivalents(annual: string, hourly: string): Record<string, string> {
  return { hour: hourly, week: "0.00", biweekly: "0.00", semimonth: "0.00", month: "0.00", year: annual };
}

const TOTAL_COMPENSATION = {
  asOf: "2026-09-17",
  employmentId: "employment-1",
  employments: [{ id: "employment-1", employer: "Employer", status: "active" }],
  annualHours: "2080",
  annualHoursSource: "rate",
  payroll: { enabled: true, payBasis: "salary", schedule: { name: "Biweekly", frequency: "biweekly", periodsPerYear: 26 } },
  base: { rateId: "rate-1", rate: "6500.0000", basis: "month", currency: "USD", effectiveFrom: "2026-01-01", scope: "employee", equivalents: equivalents("78000.00", "37.50") },
  history: [],
  recurring: [
    { key: "benefit:1", source: "benefit", category: "retirement", name: "Pension match", program: "Group RRSP", paidBy: "employer", currency: "USD", annual: "3900.00", equivalents: equivalents("3900.00", "1.88"), refusal: null },
    { key: "benefit:2", source: "benefit", category: "health", name: "Dental premium", program: "Dental", paidBy: "employer", currency: "USD", annual: null, equivalents: null, refusal: "This contribution is priced per pay period — assign the employee a payroll pay schedule to project it for a year." },
    { key: "benefit:3", source: "benefit", category: "retirement", name: "Employee pension deduction", program: "Group RRSP", paidBy: "employee", currency: "USD", annual: "3900.00", equivalents: equivalents("3900.00", "1.88"), refusal: null },
  ],
  actualsWindow: { from: "2025-09-18", to: "2026-09-17" },
  statutory: [{ key: "cpp", name: "Pension plan (employer)", currency: "USD", amount: "4000.00" }],
  variable: [],
  variableHistory: [],
  awards: [],
  totals: {
    currency: "USD", base: "78000.00", variable: "0.00", benefits: "3900.00", statutory: "4000.00", total: "85900.00",
    equivalents: equivalents("85900.00", "41.30"),
    byCategory: [
      { category: "base", annual: "78000.00", equivalents: equivalents("78000.00", "37.50"), share: "90.8" },
      { category: "retirement", annual: "3900.00", equivalents: equivalents("3900.00", "1.88"), share: "4.5" },
      { category: "statutory", annual: "4000.00", equivalents: equivalents("4000.00", "1.92"), share: "4.7" },
    ],
  },
};

test("total compensation restates the employer total and names what it cannot price", async (t) => {
  const { done } = await renderEmployeeDrawer({
    initialTab: "compensation",
    grants: { canReadCompensation: true },
    fetchHandler: routeFetch({ "/api/hrm/employee-compensation": () => Response.json(TOTAL_COMPENSATION) }),
  });
  t.after(done);
  const text = () => document.body.textContent ?? "";
  assert.ok(text().includes("$85,900.00"), "the annual employer total leads the view");
  assert.ok(text().includes("Pension match"), "an employer-paid contribution is listed");
  assert.ok(
    text().includes("assign the employee a payroll pay schedule"),
    "a term payroll cannot price shows its refusal and remedy instead of a zero",
  );
  assert.ok(text().includes(en("parties.drawer.compensation.employeePaid.title")), "employee-paid contributions sit apart from the employer total");

  const hourly = [...document.querySelectorAll('button[role="radio"]')].find(
    (button) => button.textContent?.trim() === en("parties.drawer.compensation.basis.short.hour"),
  ) as HTMLButtonElement | undefined;
  assert.ok(hourly, "the view offers an hourly basis");
  await act(async () => {
    hourly.click();
    await tick();
  });
  assert.ok(text().includes("$41.30"), "switching the basis restates the total per hour");
});

const CUSTOMER_PAYLOAD = {
  ...VENDOR_PAYLOAD,
  customer: { is_active: true },
  vendor: null,
};

const AUTOPAY_GRANTS = { autopay: { canManageMethods: true, canManageAutopay: true } };

const METHOD_ROW = {
  id: "method-1",
  provider: "stripe",
  providerCustomerId: "cus_123",
  providerMethodId: "pm_123",
  brand: "Visa",
  last4: "4242",
  expMonth: 12,
  expYear: 2028,
  mandateReference: null,
  isDefault: true,
  status: "active",
};

const CUSTOMER_ENROLLMENT_ROW = {
  id: "enrollment-1",
  subscriptionId: null,
  subscriptionName: null,
  status: "active",
  chargeOnIssue: false,
};

function autopayRoutes(): Record<string, () => Response> {
  return {
    "/api/autopay/methods": () => Response.json({ methods: [METHOD_ROW] }),
    "/api/autopay/enrollments": () => Response.json({ enrollments: [CUSTOMER_ENROLLMENT_ROW] }),
  };
}

function renderCustomerDrawer(options: Parameters<typeof renderDrawer>[0] = {}) {
  return renderDrawer({
    payload: CUSTOMER_PAYLOAD,
    role: "customer",
    recordType: "customer",
    fetchHandler: routeFetch(autopayRoutes()),
    ...options,
  });
}

async function waitForText(text: string, rounds = 20): Promise<boolean> {
  for (let round = 0; round < rounds; round += 1) {
    if (document.body.textContent?.includes(text)) return true;
    await tick();
  }
  return document.body.textContent?.includes(text) ?? false;
}

test("the customer rail gains a payment-methods tab only with the autopay read surface", async (t) => {
  const label = en("parties.drawer.tabs.paymentMethods");
  let prior: (() => Promise<void>) | null = null;
  const names = async (options: Parameters<typeof renderDrawer>[0]): Promise<string[]> => {
    if (prior) {
      const unmount = prior;
      prior = null;
      await unmount();
    }
    const { done } = await renderCustomerDrawer(options);
    prior = done;
    return railTabs().map((button) => button.textContent?.trim() ?? "");
  };

  const ungranted = await names({});
  assert.ok(!ungranted.includes(label), "the methods tab stays hidden without the autopay read surface");

  const granted = await names({ grants: AUTOPAY_GRANTS });
  assert.ok(granted.includes(label), "the read surface opens the methods tab");
  const tab = railTabNamed(label);
  assert.ok(tab, "the methods tab must ride the customer rail");
  await clickTab(tab);
  assert.ok(await waitForText(en("parties.drawer.autopay.description")), "clicking the rail must open the methods panel");

  const vendor = await names({
    payload: VENDOR_PAYLOAD,
    role: "vendor",
    recordType: "vendor",
    grants: AUTOPAY_GRANTS,
  });
  assert.ok(!vendor.includes(label), "the methods tab never rides a vendor drawer");
  if (prior) t.after(prior);
});

test("the payment-methods tab lists stored methods with the default badge", async (t) => {
  const { done } = await renderCustomerDrawer({ grants: AUTOPAY_GRANTS, initialTab: "paymentMethods" });
  t.after(done);
  assert.ok(await waitForText("Visa •••• 4242"), "the stored method must read brand plus last four");
  const body = document.body.textContent ?? "";
  assert.ok(body.includes("Visa •••• 4242"), "the stored method must read brand plus last four");
  assert.ok(body.includes(en("parties.drawer.autopay.defaultBadge")), "the default method wears its badge");
  assert.ok(
    !body.includes(en("parties.drawer.autopay.setDefault")),
    "the default method offers no make-default action",
  );
});

test("removing a method asks first and detaches on confirm", async (t) => {
  const seen: Array<{ url: string; method: string }> = [];
  const { done } = await renderCustomerDrawer({
    grants: AUTOPAY_GRANTS,
    initialTab: "paymentMethods",
    fetchHandler: (url: string, init?: RequestInit) => {
      seen.push({ url, method: init?.method ?? "GET" });
      return routeFetch(autopayRoutes())(url);
    },
  });
  t.after(done);
  assert.ok(await waitForText("Visa •••• 4242"), "the stored method must render before removal");
  const remove = [...document.querySelectorAll("button")].find(
    (button) => button.textContent?.trim() === en("parties.drawer.autopay.remove"),
  ) as HTMLButtonElement | undefined;
  assert.ok(remove, "a stored method must offer removal");
  await act(async () => {
    remove.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await tick();
  });
  await tick();
  await tick();
  assert.ok(
    seen.some((request) => request.url === "/api/autopay/methods/method-1" && request.method === "DELETE"),
    "confirming removal must detach the method",
  );
});

test("payroll read mode shows values with no editors", async (t) => {
  const { done } = await renderPayrollDrawer({ bankAccounts: [BANK_ROW] });
  t.after(done);
  const panel = payrollPanel();
  assert.equal(
    panel.querySelectorAll("input, select, textarea").length,
    0,
    "read mode must render payroll values with no editors",
  );
  assert.ok(!panel.textContent?.includes(en("parties.drawer.addBankAccount")), "read mode must not offer a bank add");
  assert.ok(
    panel.textContent?.includes(en("common.approvalFlow.historyTitle")),
    "history reads, so it stays in read mode",
  );
});

test("payroll edit mode restores every editor", async (t) => {
  const { done } = await renderPayrollDrawer({ initialMode: "edit" });
  t.after(done);
  const panel = payrollPanel();
  assert.ok(panel.querySelector("#pp-schedule"), "edit mode must offer the pay-schedule editor");
  assert.ok(!panel.textContent?.includes(en("payroll.entitlements.title")), "Benefits owns entitlement balances");
  assert.ok(
    panel.textContent?.includes(en("parties.drawer.addBankAccount")),
    "edit mode must offer the bank add",
  );
});

test("payroll sub-tabs keep every section mounted", async (t) => {
  const { done } = await renderPayrollDrawer({ initialMode: "edit" });
  t.after(done);
  const strip = document.querySelector(`nav[aria-label="${en("parties.drawer.payrollTabs.ariaLabel")}"]`);
  assert.ok(strip, "the payroll tab must render its sub-tab strip");
  const subTab = (label: string): HTMLButtonElement => {
    const button = [...strip.querySelectorAll('button[aria-pressed]')].find(
      (candidate) => candidate.textContent?.trim() === label,
    ) as HTMLButtonElement | undefined;
    assert.ok(button, `the payroll strip must offer ${label}`);
    return button;
  };
  const editorWrap = (document.querySelector("#pp-schedule") as HTMLElement).parentElement as HTMLElement;
  const editorHidden = () =>
    (editorWrap.closest("div[hidden]") as HTMLElement | null) !== null;

  await clickTab(subTab("Bank accounts"));
  assert.ok(editorHidden(), "the profile editor must hide behind the accounts tab");
  assert.ok(document.body.textContent?.includes(en("parties.drawer.addBankAccount")), "bank accounts remain in Payroll");

  await clickTab(subTab("General"));
  assert.equal(editorHidden(), false, "returning must show the same mounted editor");
  assert.ok(document.querySelector("#pp-schedule"), "the editor must still be mounted");
});

test("general and tax share one profile editor", async (t) => {
  const { done } = await renderPayrollDrawer({ initialMode: "edit", grants: { canManagePayroll: true } });
  t.after(done);
  const nativeSchedule = (): HTMLSelectElement => {
    const matches = [...document.querySelectorAll("select")].filter((candidate) =>
      [...(candidate as HTMLSelectElement).options].some((option) => option.value === "sched-2"),
    ) as HTMLSelectElement[];
    assert.equal(matches.length, 1, "both halves must share a single profile editor");
    const found = matches[0];
    assert.ok(found, "the schedule editor must render its native select");
    return found;
  };
  const schedule = nativeSchedule();
  await act(async () => {
    setSelectValue(schedule, "sched-2");
    await tick();
  });
  await tick();
  assert.equal(nativeSchedule().value, "sched-2", "the schedule change must land");
  const strip = document.querySelector(`nav[aria-label="${en("parties.drawer.payrollTabs.ariaLabel")}"]`);
  assert.ok(strip, "the payroll tab must render its sub-tab strip");
  const tax = [...strip.querySelectorAll('button[aria-pressed]')].find(
    (candidate) => candidate.textContent?.trim() === "Tax and withholding",
  ) as HTMLButtonElement;
  assert.ok(tax, "the payroll strip must offer the tax half");
  await clickTab(tax);
  const general = [...strip.querySelectorAll('button[aria-pressed]')].find(
    (candidate) => candidate.textContent?.trim() === "General",
  ) as HTMLButtonElement;
  assert.ok(general, "the payroll strip must offer the general half");
  await clickTab(general);
  assert.equal(
    nativeSchedule().value,
    "sched-2",
    "the chosen schedule must survive the half switch",
  );
});

test("a vendor kind without a vendor row hides compliance and reads as company", async (t) => {
  const grants = {
    complianceEnabled: true,
    compliance: { classId: null, classes: [] },
  };
  const rowless = await renderDrawer({
    payload: employeePayload("vendor", { employee: false }),
    role: "vendor",
    recordType: "vendor",
    grants,
  });
  const rowlessLabels = railTabs().map((button) => button.textContent?.trim() ?? "");
  assert.ok(
    !rowlessLabels.includes(en("parties.drawer.tabs.compliance")),
    "no vendor row must mean no compliance tab, even with ?role=vendor",
  );
  assert.ok(
    document.body.textContent?.includes(en("parties.drawer.kindCompany")),
    "the kind label must fall back to Company without a backing role",
  );
  await rowless.done();

  const rowed = await renderDrawer({
    payload: { ...employeePayload("vendor", { employee: false }), vendor: { ...VENDOR_PAYLOAD.vendor } },
    role: "vendor",
    recordType: "vendor",
    grants,
  });
  t.after(rowed.done);
  const rowedLabels = railTabs().map((button) => button.textContent?.trim() ?? "");
  assert.ok(
    rowedLabels.includes(en("parties.drawer.tabs.compliance")),
    "the vendor row must open the compliance tab",
  );
});

for (const locale of LOCALES) {
  test(`the drawer renders translated text with no key paths in ${locale}`, async (t) => {
    const messages = (await import(`../../../messages/${locale}/index.ts`)).default as Record<string, unknown>;
    const { done } = await renderDrawer({ messages, locale });
    t.after(done);
    const text = document.body.textContent ?? "";
    assert.ok(
      !text.includes("parties.drawer"),
      `${locale} must not leak the drawer namespace into rendered text`,
    );
    for (const button of railTabs(document, messages)) {
      const label = button.textContent?.trim() ?? "";
      assert.ok(label.length > 0, `${locale} must translate every rail label`);
      assert.ok(!label.includes("."), `${locale} rail label must be text, not a key path: ${label}`);
    }
  });
}

test("relationship edits survive a tab round-trip", async (t) => {
  const profile = {
    lifecycle_stage: "lead",
    status_id: "s1",
    owner_user_id: null,
    territory_id: null,
    lead_source_id: null,
    industry: null,
    category: null,
    annual_revenue: null,
    employee_count: null,
    qualification_score: null,
    next_action_at: null,
    updated_at: "2026-09-17T12:00:00.000000Z",
  };
  const options = {
    statuses: [{ id: "s1", name: "New", lifecycle_stage: "lead", is_default: true }],
    owners: [],
    territories: [],
    sources: [],
  };
  const { done } = await renderDrawer({
    role: "customer",
    recordType: "customer",
    initialMode: "edit",
    grants: { canReadCrmAccounts: true, canManageCrmAccounts: true },
    fetchHandler: (url) =>
      url === `/api/crm/accounts/${PARTY_ID}`
        ? Response.json({ account: { profile, opportunities: [] }, options })
        : null,
  });
  t.after(done);
  const relationship = railTabNamed(en("parties.drawer.tabs.relationship"));
  assert.ok(relationship, "the relationship tab must render");
  await clickTab(relationship);
  const panel = [...document.querySelectorAll("section")].find((section) =>
    section.textContent?.includes("Relationship profile"),
  );
  assert.ok(panel, "the relationship panel must render");
  const industry = [...panel.querySelectorAll("input")].find(
    (input) => (input as HTMLInputElement).type === "text",
  ) as HTMLInputElement | undefined;
  assert.ok(industry && panel.querySelector(`label[for="${industry.id}"][id="${industry.getAttribute("aria-labelledby")}"]`), "the shared party renderer associates the visible label with the input");
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(industry!, "Software");
    industry!.dispatchEvent(new window.Event("input", { bubbles: true }));
    await tick();
  });
  await tick();
  const overview = railTabNamed(en("parties.drawer.tabs.overview"));
  assert.ok(overview, "the overview tab must render");
  await clickTab(overview);
  await clickTab(railTabNamed(en("parties.drawer.tabs.relationship"))!);
  const revived = [...document.querySelectorAll("section")]
    .find((section) => section.textContent?.includes("Relationship profile"))
    ?.querySelectorAll("input");
  const revivedIndustry = [...(revived ?? [])].find(
    (input) => (input as HTMLInputElement).type === "text",
  ) as HTMLInputElement | undefined;
  assert.equal(revivedIndustry?.value, "Software", "the typed industry must survive the tab round-trip");
});

test("bank-account approval history names the empty state in the host drawer", async (t) => {
  const emptyApprovalState = {
    approvalState: { status: "approved", pendingWith: [], myActions: null },
    history: [],
  };
  const { done } = await renderDrawer({
    bankAccounts: [BANK_ROW],
    fetchHandler: (url) =>
      url.startsWith("/api/flows/record-state") ? Response.json(emptyApprovalState) : null,
  });
  t.after(done);

  const accounting = railTabNamed(en("parties.drawer.bankAccountsHeading"));
  assert.ok(accounting, "the bank-account panel must be reachable in the party drawer");
  await clickTab(accounting);
  const history = [...document.querySelectorAll("button")].find(
    (button) => button.textContent?.trim() === en("common.approvalFlow.historyTitle"),
  );
  assert.ok(history, "the bank-account row must expose its approval history");
  await clickTab(history);

  assert.ok(
    document.body.textContent?.includes(en("common.approvalFlow.historyEmpty")),
    "the host drawer must show the localized empty approval state for a bank account with no history",
  );
});

test("an open bank account draft survives a tab round-trip", async (t) => {
  const { done } = await renderDrawer({});
  t.after(done);
  const accounting =
    railTabNamed(en("parties.drawer.tabs.accounting")) ??
    railTabNamed(en("parties.drawer.bankAccountsHeading"));
  assert.ok(accounting, "the accounting tab must render");
  await clickTab(accounting);
  const add = [...document.querySelectorAll("button")].find(
    (button) => button.textContent?.trim() === en("parties.drawer.addBankAccount"),
  ) as HTMLButtonElement | undefined;
  assert.ok(add, "the add bank account action must render");
  await clickTab(add);
  const bankName = [...document.querySelectorAll("input")].find(
    (input) =>
      (input as HTMLInputElement).type === "text" &&
      (input as HTMLInputElement).value === "",
  ) as HTMLInputElement | undefined;
  assert.ok(bankName, "the draft bank name input must render");
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(bankName!, "First National");
    bankName!.dispatchEvent(new window.Event("input", { bubbles: true }));
    await tick();
  });
  await tick();
  await clickTab(railTabNamed(en("parties.drawer.tabs.overview"))!);
  await clickTab(
    railTabNamed(en("parties.drawer.tabs.accounting")) ??
      railTabNamed(en("parties.drawer.bankAccountsHeading"))!,
  );
  const revived = [...document.querySelectorAll("input")].find(
    (input) => (input as HTMLInputElement).value === "First National",
  ) as HTMLInputElement | undefined;
  assert.ok(revived, "the half-typed bank draft must survive the tab round-trip");
});

test("compliance class selection survives a tab round-trip", async (t) => {
  const { done } = await renderDrawer({
    initialMode: "edit",
    grants: {
      complianceEnabled: true,
      compliance: {
        classId: null,
        classes: [{ id: "c1", code: "C1", name: "Class one" }],
      },
      canManageCompliance: true,
    },
  });
  t.after(done);
  const compliance = railTabNamed(en("parties.drawer.tabs.compliance"));
  assert.ok(compliance, "the compliance tab must render");
  await clickTab(compliance);
  const panel = [...document.querySelectorAll("section")].find((section) =>
    section.textContent?.includes(en("parties.drawer.compliance.heading")),
  );
  assert.ok(panel, "the compliance panel must render");
  const select = panel.querySelector("select") as HTMLSelectElement | null;
  assert.ok(select, "the class select must render");
  setSelectValue(select!, "c1");
  await tick();
  await tick();
  await clickTab(railTabNamed(en("parties.drawer.tabs.overview"))!);
  await clickTab(railTabNamed(en("parties.drawer.tabs.compliance"))!);
  const revived = [...document.querySelectorAll("section")]
    .find((section) => section.textContent?.includes(en("parties.drawer.compliance.heading")))
    ?.querySelector("select") as HTMLSelectElement | null;
  assert.equal(revived?.value, "c1", "the chosen class must survive the tab round-trip");
});

const ORPHAN_PAYLOAD = {
  ...VENDOR_PAYLOAD,
  party: { ...VENDOR_PAYLOAD.party, display_name: "Acme Industrial Supply", kind: "company" },
  customer: null,
  vendor: null,
  employee: null,
};

async function saveWithKind(kind: "customer" | "vendor" | "employee"): Promise<Record<string, unknown>> {
  const bodies: Record<string, unknown>[] = [];
  const { done } = await renderDrawer({
    generic: true,
    payload: ORPHAN_PAYLOAD,
    initialMode: "edit",
    fetchHandler: (url, init) => {
      if (url.includes("/api/parties/") && init?.method === "PATCH") {
        bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return Response.json({ party: { is_active: true } });
      }
      return null;
    },
  });
  try {
    const select = kindSelect();
    assert.ok(select, "edit mode must offer a kind control");
    await act(async () => {
      setSelectValue(select, kind);
      await tick();
    });
    await tick();
    const save = [...document.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === en("common.actions.save"),
    ) as HTMLButtonElement | undefined;
    assert.ok(save, "edit mode must offer a save control");
    await act(async () => {
      save.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
      await tick();
    });
    await tick();
    await tick();
    assert.equal(bodies.length, 1, "one PATCH must carry the repair");
    return bodies[0]!;
  } finally {
    await done();
  }
}

for (const kind of ["vendor", "customer", "employee"] as const) {
  test(`choosing kind ${kind} in the generic edit drawer enables the ${kind} role in the save`, async () => {
    const body = await saveWithKind(kind);
    assert.equal(body.kind, kind);
    assert.equal(
      ((body.roles as Record<string, { enabled: boolean }>)[kind] ?? {}).enabled,
      true,
      `the kind choice must carry roles.${kind}.enabled so the audited save backs the claim`,
    );
  });
}

test("employee Benefits owns program assignments, credited service and entitlement balances with its own grant", async t => {
  const ui = await renderEmployeeDrawer({ initialTab: "benefits", grants: { canReadBenefits: true }, fetchHandler: routeFetch(employeeRoutes()) }); t.after(ui.done);
  assert.ok(document.body.textContent?.includes(en("hrm.employeeBenefits.programs")));
  assert.ok(document.body.textContent?.includes(en("hrm.benefitPolicies.service")));
  const balances = [...document.querySelectorAll('button')].find(node => node.textContent?.trim() === en("hrm.benefitPolicies.balances")); assert.ok(balances); await clickTab(balances);
  assert.ok(document.body.textContent?.includes("40")); assert.ok(document.body.textContent?.includes(en("payroll.entitlements.title")));
});


test("employee Benefits presents native program and assignment destinations for every relationship", async t => {
  const assignments = employeeBenefitAssignments([{ id: 'rrsp', name: 'Retirement savings', type: 'retirement' }, { id: 'vac', name: 'Vacation', type: 'time_off' }, { id: 'recognition', name: 'Recognition', type: 'reward' }],
    ['enrollment', 'vacation_terms', 'membership'].map((nativeKind, index) => ({ id: `assignment-${index}`, nativeKind: nativeKind as 'enrollment' | 'vacation_terms' | 'membership', programId: ['rrsp', 'vac', 'recognition'][index]!, employmentId: 'employment', employeePartyId: EMPLOYEE_ID, employeeName: 'Nadia', status: 'active', effectiveFrom: '2026-01-01', effectiveTo: null })), { type: value => value, status: () => 'Active' });
  const routes = employeeRoutes(); routes['/api/hrm/employee-benefits'] = () => Response.json({ assignments, programs: [], employments: [], enrollments: [], vacation: [], service: [], payroll: false, canManage: false, canReadBanks: false });
  const ui = await renderEmployeeDrawer({ initialTab: 'benefits', grants: { canReadBenefits: true }, fetchHandler: routeFetch(routes) }); t.after(ui.done);
  const navigation: string[] = []; globalThis.__partyRouter!.push = href => navigation.push(href);
  const rows = [...document.querySelectorAll('tbody tr')]; assert.equal(rows.length, 3);
  assert.deepEqual(new Set([...document.querySelectorAll('a[href^="/hrm/benefits?view=programs&program="]')].map(link => link.getAttribute('href'))), new Set(assignments.map(row => row.programHref)));
  for (const name of ['Retirement savings', 'Recognition', 'Vacation']) assert.ok(document.body.textContent?.includes(name));
  const programsRail = [...document.querySelectorAll('nav')].find(nav => nav.querySelector('button')?.textContent === en('hrm.employeeBenefits.programs'));
  assert.equal(programsRail?.querySelectorAll('button[aria-pressed]').length, 1, 'only Programs is available without Payroll and bank permissions');
  for (const [name, expected] of [['Retirement savings', '/parties?benefitPolicyKind=coverage&benefitPolicyRow=assignment-0'], ['Recognition', '/hrm/benefits?view=programs&program=recognition&transactionTab=participants']]) {
    await act(async () => rows.find(row => row.textContent?.includes(name!))!.dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
    assert.equal(navigation.at(-1), expected);
  }
});

const BILLING_GRANTS = { consolidatedBilling: { canManage: true } };

function billingRoutes(): Record<string, () => Response> {
  return {
    "/api/billing-relationships": () =>
      Response.json({
        summary: {
          billToPartyId: "child-1",
          billToName: "Child Co",
          payerPartyId: "child-1",
          payerName: "Child Co",
          consolidationGroupId: null,
          groupCode: null,
          groupName: null,
          groupCadence: null,
        },
        relationships: [],
        children: [],
        groups: [],
        parties: [],
        canManage: true,
      }),
  };
}

function renderBillingDrawer(options: Parameters<typeof renderDrawer>[0] = {}) {
  return renderDrawer({
    payload: CUSTOMER_PAYLOAD,
    role: "customer",
    recordType: "customer",
    fetchHandler: routeFetch(billingRoutes()),
    ...options,
  });
}

test("the customer rail gains a billing tab only with the consolidated-billing read surface", async (t) => {
  const label = en("parties.drawer.tabs.billing");
  let prior: (() => Promise<void>) | null = null;
  const names = async (options: Parameters<typeof renderDrawer>[0]): Promise<string[]> => {
    if (prior) {
      const unmount = prior;
      prior = null;
      await unmount();
    }
    const { done } = await renderBillingDrawer(options);
    prior = done;
    return railTabs().map((button) => button.textContent?.trim() ?? "");
  };

  const ungranted = await names({});
  assert.ok(!ungranted.includes(label), "the billing tab stays hidden without the consolidated-billing read surface");

  const granted = await names({ grants: BILLING_GRANTS });
  assert.ok(granted.includes(label), "the read surface opens the billing tab");
  const tab = railTabNamed(label);
  assert.ok(tab, "the billing tab must ride the customer rail");
  await clickTab(tab);
  assert.ok(
    await waitForText(en("parties.billingRelationships.standalone")),
    "clicking the rail must open the billing panel with its everyday summary",
  );

  const vendor = await names({
    payload: VENDOR_PAYLOAD,
    role: "vendor",
    recordType: "vendor",
    grants: BILLING_GRANTS,
  });
  assert.ok(!vendor.includes(label), "the billing tab never rides a vendor drawer");
  if (prior) t.after(prior);
});

const MANDATE_GRANTS = { debitMandates: { partyId: PARTY_ID } };

const MANDATE_ROW = {
  id: "mandate-1",
  mandateReference: "MND-0001",
  scheme: "sepa_core",
  status: "pending",
  partyBankAccountId: "bank-1",
  bankAccountLabel: "First Bank · ••••1234",
  signedOn: "2026-09-01",
  validFrom: null,
  expiresOn: null,
};

function mandateFetch(seen: Array<{ url: string; method: string; body: Record<string, unknown> | null }>, mandates: Record<string, unknown>[]) {
  return (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    seen.push({ url, method, body: typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : null });
    if (url === `/api/parties/${PARTY_ID}/debit-mandates`) {
      return Response.json({ mandates, bankAccounts: [{ id: "bank-1", label: "First Bank · ••••1234" }] });
    }
    if (url.startsWith("/api/admin/payment-operations/mandates")) {
      return Response.json(method === "POST" ? { id: "mandate-2" } : { ok: true }, { status: method === "POST" ? 201 : 200 });
    }
    return null;
  };
}

/** The shared Select proxies a hidden native select beside its labelled trigger. */
function nativeSelect(id: string): HTMLSelectElement {
  const select = document.getElementById(id)?.closest("span")?.querySelector("select");
  assert.ok(select, `the ${id} select must render`);
  return select as HTMLSelectElement;
}

async function clickButton(name: string) {
  const button = [...document.querySelectorAll("button")].find((element) => element.textContent?.trim() === name) as HTMLButtonElement | undefined;
  assert.ok(button, `the ${name} button must render`);
  await act(async () => {
    button.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await tick();
  });
  await tick();
  await tick();
}

test("the debit-mandates tab rides only a granted customer record and a stale deep link falls back to overview", async (t) => {
  const label = en("parties.drawer.tabs.debitMandates");
  let prior: (() => Promise<void>) | null = null;
  const render = async (options: Parameters<typeof renderDrawer>[0]) => {
    if (prior) {
      const unmount = prior;
      prior = null;
      await unmount();
    }
    const { done } = await renderCustomerDrawer({ fetchHandler: mandateFetch([], []), ...options });
    prior = done;
    return railTabs();
  };
  const pressed = (tabs: HTMLButtonElement[]) => tabs.find((button) => button.getAttribute("aria-pressed") === "true")?.textContent?.trim();

  const ungranted = await render({ initialTab: "debitMandates" });
  assert.ok(!ungranted.map((button) => button.textContent?.trim()).includes(label), "the tab stays hidden without the mandate grant");
  assert.equal(pressed(ungranted), en("parties.drawer.tabs.overview"), "a stale deep link lands on overview");

  const roleless = await render({ initialTab: "debitMandates", payload: VENDOR_PAYLOAD, generic: true, grants: MANDATE_GRANTS });
  assert.ok(!roleless.map((button) => button.textContent?.trim()).includes(label), "a party without the customer role never shows mandates");
  assert.equal(pressed(roleless), en("parties.drawer.tabs.overview"), "the deep link falls back when the customer role is missing");

  const granted = await render({ initialTab: "debitMandates", grants: MANDATE_GRANTS });
  assert.equal(pressed(granted), label, "the granted customer deep link opens the mandates tab");
  assert.ok(await waitForText(en("parties.drawer.debitMandates.empty")), "the tab body is the mandates panel");
  if (prior) t.after(prior);
});

test("a new mandate is issued to the drawer's party and an edit sends only the mutable fields", async (t) => {
  const seen: Array<{ url: string; method: string; body: Record<string, unknown> | null }> = [];
  const { done } = await renderCustomerDrawer({
    initialTab: "debitMandates",
    grants: MANDATE_GRANTS,
    fetchHandler: mandateFetch(seen, [MANDATE_ROW]),
  });
  t.after(done);
  assert.ok(await waitForText("MND-0001"), "the party's mandate must list by reference");

  await clickButton(en("parties.drawer.debitMandates.new"));
  const bank = nativeSelect("debit-mandate-bank-account");
  const reference = document.getElementById("debit-mandate-reference") as HTMLInputElement;
  assert.ok(bank && reference, "the new-mandate drawer offers the bank account and reference");
  await act(async () => {
    setSelectValue(bank, "bank-1");
    setInputValue(reference, "  MND-0002 ");
    await tick();
  });
  await clickButton(en("common.actions.save"));
  const created = seen.find((request) => request.method === "POST");
  assert.deepEqual(created?.body, {
    partyId: PARTY_ID,
    partyBankAccountId: "bank-1",
    scheme: "nacha",
    mandateReference: "MND-0002",
    status: "pending",
  }, "the create carries the drawer's party and the scheme the form displays");

  const row = [...document.querySelectorAll("tr")].find((element) => element.textContent?.includes("MND-0001"));
  const edit = [...(row?.querySelectorAll("button") ?? [])].find((button) => button.textContent?.trim() === en("common.actions.edit"));
  assert.ok(edit, "each mandate row offers an edit");
  await act(async () => {
    edit.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await tick();
  });
  await tick();
  assert.ok((document.getElementById("debit-mandate-reference") as HTMLInputElement).disabled, "the reference is fixed after create");
  await act(async () => {
    setSelectValue(nativeSelect("debit-mandate-status"), "active");
    await tick();
  });
  await clickButton(en("common.actions.save"));
  const updated = seen.find((request) => request.method === "PATCH");
  assert.equal(updated?.url, "/api/admin/payment-operations/mandates/mandate-1");
  assert.deepEqual(updated?.body, { status: "active", signedOn: "2026-09-01", validFrom: "", expiresOn: "" },
    "an edit never resends the party, bank account, scheme or reference the route refuses");
});

test("the unified drawer shows roles on the overview tab", async (t) => {
  const { done } = await renderDrawer({ generic: true, initialTab: "overview", initialMode: "view" });
  t.after(done);
  const overview = railTabNamed(en("parties.drawer.tabs.overview"));
  assert.ok(overview, "the overview tab must render");
  await clickTab(overview);
  const headings = [...document.querySelectorAll("h3")].map((h) => h.textContent?.trim());
  assert.ok(
    headings.includes(en("common.labels.vendor")),
    "the vendor role details must render on overview beside identity",
  );
});

test("the unified drawer offers role checkboxes on overview in edit mode", async (t) => {
  const { done } = await renderDrawer({ generic: true, initialTab: "overview", initialMode: "edit" });
  t.after(done);
  const overview = railTabNamed(en("parties.drawer.tabs.overview"));
  assert.ok(overview, "the overview tab must render");
  await clickTab(overview);
  const section = [...document.querySelectorAll("section")].find((element) =>
    element.textContent?.includes(en("parties.drawer.rolesHeading")),
  );
  assert.ok(section, "the roles section must render on overview in edit mode");
  const boxes = section?.querySelectorAll('input[type="checkbox"]') ?? [];
  assert.ok(boxes.length >= 3, "customer, vendor, and employee each offer an enable checkbox");
});

test("the relationship tab reads as values until Edit, and the drawer's single Save persists it", async (t) => {
  const profile = {
    lifecycle_stage: "lead", status_id: "s1", owner_user_id: null, territory_id: null, lead_source_id: null,
    industry: null, category: null, annual_revenue: null, employee_count: null, qualification_score: null,
    next_action_at: null, updated_at: "2026-09-17T12:00:00.000000Z",
  };
  const options = { statuses: [{ id: "s1", name: "New", lifecycle_stage: "lead", is_default: true }], owners: [], territories: [], sources: [] };
  const seen: Array<{ url: string; method: string; body: Record<string, unknown> | null }> = [];
  const { done } = await renderDrawer({
    role: "customer",
    recordType: "customer",
    payload: CUSTOMER_PAYLOAD,
    grants: { canReadCrmAccounts: true, canManageCrmAccounts: true },
    fetchHandler: (url, init) => {
      const method = init?.method ?? "GET";
      seen.push({ url, method, body: typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : null });
      if (url === `/api/crm/accounts/${PARTY_ID}`) {
        return method === "PATCH" ? Response.json({ ok: true }) : Response.json({ account: { profile, opportunities: [] }, options });
      }
      if (url === `/api/parties/${PARTY_ID}` && method === "PATCH") return Response.json({ party: { is_active: true } });
      return null;
    },
  });
  t.after(done);
  await clickTab(railTabNamed(en("parties.drawer.tabs.relationship"))!);
  const panel = () => [...document.querySelectorAll("section")].find((section) => section.textContent?.includes("Relationship profile"));
  assert.ok(await waitForText("Relationship profile"), "the relationship panel must render");
  assert.equal(panel()!.querySelectorAll("input, select").length, 0, "view mode renders the relationship as values");
  const saveButtons = () => [...document.querySelectorAll("button")].filter((button) => button.textContent?.trim() === en("common.actions.save"));
  assert.equal(saveButtons().length, 0, "view mode offers no Save anywhere — the section has none of its own");

  await clickButton(en("common.actions.edit"));
  const industry = [...panel()!.querySelectorAll("input")].find((input) => (input as HTMLInputElement).type === "text") as HTMLInputElement | undefined;
  assert.ok(industry, "edit mode opens the relationship fields");
  assert.equal(saveButtons().length, 1, "edit mode has exactly one Save: the record's");
  await act(async () => {
    setInputValue(industry, "Software");
    await tick();
  });
  await clickButton(en("common.actions.save"));
  await tick();
  const relationshipPatch = seen.find((request) => request.url === `/api/crm/accounts/${PARTY_ID}` && request.method === "PATCH");
  assert.equal(relationshipPatch?.body?.industry, "Software", "the record Save persists the relationship edits");
  assert.ok(seen.some((request) => request.url === `/api/parties/${PARTY_ID}` && request.method === "PATCH"), "the party itself saves in the same Save");
  assert.equal(panel()!.querySelectorAll("input, select").length, 0, "a successful Save returns the relationship to view mode");
});

