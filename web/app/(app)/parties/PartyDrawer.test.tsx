// The party flyout's tab, grant, and edit-gate contracts, proved by rendering
// the real PartyDrawer — not by matching its source text. The pure drawer
// helpers (credit-limit formatting, visited-tab memory) are unit-tested
// directly; everything else below drives the component the way an operator
// does: opening tabs, switching modes, and reading what renders.
//
// Defects covered: F-t08-003 (visited compensation tabs unmounted, discarding
// edits), F-t05-002 (kind control vocabulary vs stored kinds), F-t02-015
// (drawer-namespace keys leaking untranslated), HR-1/2 (payroll edit gate),
// HR-9 (confidential tabs need their own grants), OM-16 (role tabs need the
// role row, kind falls back without one).
import assert from "node:assert/strict";
import test from "node:test";

declare global {
  var __partyToasts: { kind: string; message: string }[] | undefined;
  var __partyRouter: { push(url: string): void; refresh(): void } | undefined;
  var __partyPromptReason: string | null | undefined;
}

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
    "/api/payroll/entitlements": () =>
      Response.json({ currency: "USD", balances: [BALANCE_ROW], movements: [MOVEMENT_ROW] }),
  };
}

async function renderDrawer(options: {
  payload?: Record<string, unknown>;
  role?: "customer" | "vendor" | "employee";
  recordType?: "customer" | "vendor" | "employee";
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
              role={options.role ?? "vendor"}
              recordType={options.recordType ?? "vendor"}
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

function railTabs(scope: ParentNode = document, tree: Record<string, unknown> = enMessages): HTMLButtonElement[] {
  const rail = scope.querySelector(`nav[aria-label="${msg(tree, "common.auditTrail.ariaLabel")}"]`);
  assert.ok(rail, "the flyout must render its tab rail");
  return [...rail.querySelectorAll('button[role="tab"]')] as HTMLButtonElement[];
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

test("credit-limit display preserves large persisted numeric values exactly", () => {
  assert.equal(formatCreditLimit("9007199254740993.0000"), "9007199254740993.00");
});

test("credit-limit display rounds fractional cents with exact decimal arithmetic", () => {
  assert.equal(formatCreditLimit("86.6150"), "86.62");
  assert.equal(formatCreditLimit(null), "");
});

// F-t08-003: switching employee drawer tabs unmounted the payroll/wage
// panels, silently discarding unsaved profile edits. Visited compensation
// tabs must stay mounted (hidden) so their local edits survive a switch.
test("remembering a visited drawer tab keeps it without mutating the set", () => {
  const kept = rememberDrawerTab(new Set(["overview"]), "payroll");
  assert.ok(kept.has("overview"));
  assert.ok(kept.has("payroll"));
});

test("remembering an already kept tab returns the same set", () => {
  const kept = new Set(["overview", "payroll"] as const);
  assert.equal(rememberDrawerTab(kept, "payroll"), kept);
});

// F-t05-002: the Kind control offered only company|person while parties store
// customer/vendor/employee kinds, so the control misread the record and the
// PATCH it echoed back 422'd. The control must offer the stored vocabulary.
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

// The rail is the shared flyout shell's, driven as a CONTROLLED tab, so the
// party owns one strip instead of nesting its own under the shell's
// Details / Attachments / Audit trail. Every switch still lands on showTab.
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
  return strip.parentElement as HTMLElement;
}

// F-t08-003 behaviourally: a typed-but-unsaved wage survives a round trip to
// the payroll tab and back, because the visited panel stays mounted hidden.
test("a visited compensation tab stays mounted while another shows", async (t) => {
  const routes = employeeRoutes();
  const { done } = await renderDrawer({
    payload: employeePayload("employee", { employee: true }),
    role: "employee",
    recordType: "employee",
    initialTab: "wages",
    grants: { canManageWages: true, canManagePayroll: true },
    fetchHandler: routeFetch(routes),
  });
  t.after(done);
  const rate = document.querySelector("#employee-wage-rate") as HTMLInputElement | null;
  assert.ok(rate, "the wages tab must offer a rate input");
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
    (wages.parentElement as HTMLElement | null)?.hasAttribute("hidden"),
    "the wages panel must hide instead of unmounting",
  );
  assert.equal(
    (document.querySelector("#employee-wage-rate") as HTMLInputElement | null)?.value,
    "42.50",
    "the unsaved rate must survive behind the hidden panel",
  );

  const wagesTab = railTabNamed(en("parties.drawer.tabs.wages"));
  assert.ok(wagesTab, "the wages tab must still ride the rail");
  await clickTab(wagesTab);
  assert.equal(
    (wages.parentElement as HTMLElement | null)?.hasAttribute("hidden"),
    false,
    "returning must show the same mounted panel",
  );
  assert.equal(
    (document.querySelector("#employee-wage-rate") as HTMLInputElement | null)?.value,
    "42.50",
    "the unsaved rate must still be there",
  );
});

// HR-9 self-service: a manager opening a report's drawer sees the Employment
// tab through the structural team fallback, while payroll, wages, and
// compliance stay hidden unless their own grants hold — the team read selects
// no pay data, so there is nothing to leak.
test("each confidential tab needs its own grant", async (t) => {
  const routes = employeeRoutes();
  const handler = routeFetch(routes);
  const labels = {
    wages: en("parties.drawer.tabs.wages"),
    payroll: en("parties.drawer.tabs.payroll"),
    employment: en("parties.drawer.tabs.employment"),
  };
  // One drawer mounted at a time: each matrix row unmounts its predecessor
  // before the next renders, so document-scoped rail reads stay exact.
  let prior: (() => Promise<void>) | null = null;
  const names = async (grants: Record<string, unknown>): Promise<string[]> => {
    if (prior) {
      const unmount = prior;
      prior = null;
      await unmount();
    }
    const { done } = await renderDrawer({
      payload: employeePayload("employee", { employee: true }),
      role: "employee",
      recordType: "employee",
      grants,
      fetchHandler: handler,
    });
    prior = done;
    return railTabs().map((button) => button.textContent?.trim() ?? "");
  };

  const ungranted = await names({});
  assert.ok(!ungranted.includes(labels.wages), "wages stay hidden without the setup grant");
  assert.ok(!ungranted.includes(labels.payroll), "payroll stays hidden without the payroll grant");
  assert.ok(!ungranted.includes(labels.employment), "employment stays hidden without the HRM read surface");

  const waged = await names({ canManageWages: true });
  assert.ok(waged.includes(labels.wages), "the setup grant opens wages");
  assert.ok(!waged.includes(labels.payroll), "the setup grant must not open payroll");

  const paid = await names({ canManageWages: true, canManagePayroll: true });
  assert.ok(paid.includes(labels.payroll), "the payroll grant opens payroll");

  const employed = await names({
    hrm: { employmentIds: ["emp-1"], canManageHrm: false, canReadExits: false, canRecordExit: false },
  });
  assert.ok(employed.includes(labels.employment), "the HRM read surface opens employment");
  assert.ok(!employed.includes(labels.wages), "the HRM read surface must not open wages");
  if (prior) t.after(prior);
});

// HR-1 defect 2: the Payroll tab honours the drawer edit mode exactly like
// Overview (editable = mode === 'edit' && canManage). Read mode renders
// values; only edit mode renders the editors.
test("payroll read mode shows values with no editors", async (t) => {
  const routes = employeeRoutes();
  const { done } = await renderDrawer({
    payload: employeePayload("employee", { employee: true }),
    role: "employee",
    recordType: "employee",
    initialTab: "payroll",
    grants: { canManageWages: true, canManagePayroll: true },
    bankAccounts: [BANK_ROW],
    fetchHandler: routeFetch(routes),
  });
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
  const routes = employeeRoutes();
  const { done } = await renderDrawer({
    payload: employeePayload("employee", { employee: true }),
    role: "employee",
    recordType: "employee",
    initialMode: "edit",
    initialTab: "payroll",
    grants: { canManageWages: true, canManagePayroll: true },
    fetchHandler: routeFetch(routes),
  });
  t.after(done);
  const panel = payrollPanel();
  assert.ok(panel.querySelector("#pp-schedule"), "edit mode must offer the pay-schedule editor");
  const search = [...panel.querySelectorAll('input[placeholder="Search"]')];
  assert.ok(search.length > 0, "edit mode must offer the movement search");
  assert.ok(
    panel.textContent?.includes(en("parties.drawer.addBankAccount")),
    "edit mode must offer the bank add",
  );
});

// The Payroll tab splits into sub-tabs on the shared drawer strip — the same
// primitive as the rail, not a second tab style — with every section staying
// mounted (hidden) so unsaved edits survive sub-tab switches.
test("payroll sub-tabs keep every section mounted", async (t) => {
  const routes = employeeRoutes();
  const { done } = await renderDrawer({
    payload: employeePayload("employee", { employee: true }),
    role: "employee",
    recordType: "employee",
    initialMode: "edit",
    initialTab: "payroll",
    grants: { canManageWages: true, canManagePayroll: true },
    fetchHandler: routeFetch(routes),
  });
  t.after(done);
  const strip = document.querySelector(`nav[aria-label="${en("parties.drawer.payrollTabs.ariaLabel")}"]`);
  assert.ok(strip, "the payroll tab must render its sub-tab strip");
  const subTab = (label: string): HTMLButtonElement => {
    const button = [...strip.querySelectorAll('button[role="tab"]')].find(
      (candidate) => candidate.textContent?.trim() === label,
    ) as HTMLButtonElement | undefined;
    assert.ok(button, `the payroll strip must offer ${label}`);
    return button;
  };
  const editorWrap = (document.querySelector("#pp-schedule") as HTMLElement).parentElement as HTMLElement;
  const editorHidden = () =>
    (editorWrap.closest("div[hidden]") as HTMLElement | null) !== null;

  await clickTab(subTab("Pay banks"));
  assert.ok(editorHidden(), "the profile editor must hide behind the banks half");
  assert.ok(
    document.body.textContent?.includes(en("payroll.entitlements.title")),
    "the banks half must show the entitlement balances",
  );

  await clickTab(subTab("General"));
  assert.equal(editorHidden(), false, "returning must show the same mounted editor");
  assert.ok(document.querySelector("#pp-schedule"), "the editor must still be mounted");
});

// One editor instance serves General and Tax: the single ProfileEditor stays
// mounted and switches its half by prop, so typed values survive the switch.
test("general and tax share one profile editor", async (t) => {
  const routes = employeeRoutes();
  const { done } = await renderDrawer({
    payload: employeePayload("employee", { employee: true }),
    role: "employee",
    recordType: "employee",
    initialMode: "edit",
    initialTab: "payroll",
    grants: { canManagePayroll: true },
    fetchHandler: routeFetch(routes),
  });
  t.after(done);
  // The house Select shows a trigger button and keeps the genuine native
  // select underneath: the native control is the editor's state source.
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
  const tax = [...strip.querySelectorAll('button[role="tab"]')].find(
    (candidate) => candidate.textContent?.trim() === "Tax and withholding",
  ) as HTMLButtonElement;
  assert.ok(tax, "the payroll strip must offer the tax half");
  await clickTab(tax);
  const general = [...strip.querySelectorAll('button[role="tab"]')].find(
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

// OM-16: a party showing "Kind: Vendor" with no vendor_roles row left the
// Compliance tab unreachable while a ?role=vendor URL faked it (and wages,
// payroll, employment the same way) into existence. Every role tab needs its
// role ROW — never the role filter or the kind column — and the Kind label
// falls back to Company when no active role backs a role-kind.
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

// F-t02-015: the blank-name guard and the statement link rendered raw
// `parties.drawer.drawer.*` keys in every locale, because the drawer called
// t('drawer.nameRequired') / t('drawer.viewStatement') under the
// parties.drawer namespace instead of the bare keys that exist in all 7
// catalogs. Every locale must render translated text — never a key path.
const LOCALES = ["en", "de", "es", "fr", "ja", "pt-BR", "zh"] as const;

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
