import assert from "node:assert/strict";
import test from "node:test";
import {
  CONTROL_ACCOUNT_ROLES,
  CONTROL_ACCOUNT_TYPE_POLICY,
} from "@openbooks/engine/records/control-accounts";

declare global {
  var __settingsRouter: { push(url: string): void; refresh(): void } | undefined;
  var __settingsToasts: { kind: string; message: string }[] | undefined;
}

// jsdom first: the form reads browser globals at render.
const { bootJsdomEnvironment } = await import("../../../../testing/jsdom-env");
await bootJsdomEnvironment({
  url: "http://localhost:4800/admin/settings",
  matchMediaMatches: false,
  scrollIntoView: false,
  resizeObserver: false,
});

const { registerHooks } = await import("node:module");
const { stubModules } = await import("../../../../testing/stub-modules");
stubModules({
  navigation:
    'export function useRouter(){return globalThis.__settingsRouter}export function usePathname(){return "/admin/settings"}export function useSearchParams(){return new URLSearchParams()}',
});
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "next/link") {
      return {
        shortCircuit: true,
        url: `data:text/javascript,export default function Link(p){return globalThis.React.createElement('a',{href:p.href},p.children)}`,
      };
    }
    if (specifier === "sonner") {
      return {
        shortCircuit: true,
        url: `data:text/javascript,export const toast=Object.assign((m)=>{(globalThis.__settingsToasts??=[]).push({kind:'info',message:String(m)})},{success(m){(globalThis.__settingsToasts??=[]).push({kind:'success',message:String(m)})},error(m){(globalThis.__settingsToasts??=[]).push({kind:'error',message:String(m)})}});export function Toaster(){return null}`,
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
const messages = (await import("../../../../messages/en")).default;
const settingsCopy = (
  await import("../../../../messages/en/admin.json", { with: { type: "json" } })
).default.settings as unknown as Record<string, Record<string, string>>;
const { SaasMetricsNormalization } = await import("./SaasMetricsNormalization");
const normalizationCopy = (
  await import("../../../../messages/en/admin.json", { with: { type: "json" } })
).default.settings.saasMetrics.normalization as unknown as Record<string, string> & {
  states: Record<string, string>;
};
const { SettingsForm } = await import("./SettingsForm");
const contractCreationCopy = (
  await import("../../../../messages/en/admin.json", { with: { type: "json" } })
).default.settings.revenue.contractCreation as unknown & {
  label: string;
  firstBilling: string;
  booking: string;
};

type FormProps = Parameters<typeof SettingsForm>[0];

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

const INITIAL: FormProps["initial"] = {
  name: "Acme",
  legalName: "",
  country: "CA",
  baseCurrency: "USD",
  timeZone: "UTC",
  fiscalYearStartMonth: 1,
  reportingFramework: "us_gaap",
  defaultLocale: "en" as never,
  reportPdfStyle: "formal",
  fairValueRangePolicy: "off",
  contractCreation: "first_billing",
  controlAccounts: {
    ar: "a1",
    ap: "a2",
    bank: "a3",
    taxCollected: "a4",
    taxPaid: "a5",
    employeePayable: "a6",
    fxUnrealizedGainLoss: "a7",
    fxRealizedGainLoss: "a8",
  },
};

const PROPS: Omit<FormProps, "initial"> = {
  controlAccountRoles: CONTROL_ACCOUNT_ROLES,
  controlAccountPolicy: CONTROL_ACCOUNT_TYPE_POLICY,
  accounts: [],
  currencies: [
    { code: "USD", name: "US Dollar" },
    { code: "CAD", name: "Canadian Dollar" },
  ],
  timeZones: ["UTC", "America/Toronto"],
};

interface SeenRequest {
  url: string;
  method: string;
  body: unknown;
}

async function mountForm(
  initial: FormProps["initial"] = INITIAL,
  extraProps: Partial<Omit<FormProps, "initial">> = {},
  respond?: () => Response,
) {
  globalThis.__settingsRouter = { push() {}, refresh() {} };
  globalThis.__settingsToasts = [];
  const seen: SeenRequest[] = [];
  const prior = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push({
      url: String(
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      ),
      method: (init?.method ?? "GET").toUpperCase(),
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    return respond ? respond() : Response.json({ changed: true });
  }) as typeof fetch;
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <SettingsForm initial={initial} {...PROPS} {...extraProps} />
      </NextIntlClientProvider>,
    );
    await tick();
  });
  await tick();
  return {
    seen,
    async unmount() {
      await act(async () => {
        root.unmount();
      });
      host.remove();
      globalThis.fetch = prior;
    },
  };
}

function saveButton(): HTMLButtonElement {
  const button = [...document.querySelectorAll("button")].find(
    (b) => (b.textContent ?? "").trim() === String(settingsCopy.saveSettings),
  ) as HTMLButtonElement | undefined;
  assert.ok(button, "the form must offer Save");
  return button;
}

// clearing Display name and saving gave zero feedback — Save
// stays enabled, the input carries no invalid state, and the empty value is
// silently rejected server-side. The field itself must carry the required
// error where the tester can still read it.
test("a blank display name pins an inline required error on the field", async () => {
  const { seen, unmount } = await mountForm();
  try {
    const name = document.getElementById("name") as HTMLInputElement | null;
    assert.ok(name, "expected the display-name input");
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )!.set!;
    await act(async () => {
      setter.call(name, "   ");
      name.dispatchEvent(new window.Event("input", { bubbles: true }));
      await tick();
    });
    await tick();
    await act(async () => {
      saveButton().click();
      await tick();
    });
    await tick();
    assert.equal(seen.length, 0, "a blank name must never reach the API");
    assert.equal(name.getAttribute("aria-invalid"), "true", "the input exposes its invalid state");
    const alert = document.getElementById("name-error");
    assert.equal(
      alert?.getAttribute("role"),
      "alert",
      "the error persists as an alert, not only a toast",
    );
    assert.equal(alert?.textContent, String(settingsCopy.validation?.nameRequired));
  } finally {
    await unmount();
  }
});

test("each control-account field states the account types its role accepts", async () => {
  const { unmount } = await mountForm(INITIAL, {
    accounts: [
      { id: "eq1", label: "3200 · Translation reserve", type: "equity" },
      { id: "ca1", label: "1250 · Clearing", type: "asset_current_other" },
    ],
  });
  try {
    const expected = document.getElementById("ctrl-translationAdjustment-expected");
    assert.equal(expected?.textContent, "Accepts: Equity");
    const labor = document.getElementById("ctrl-laborClearing-expected");
    assert.equal(labor?.textContent, "Accepts: Other Current Assets or Other Current Liabilities");
  } finally {
    await unmount();
  }
});

test("a stored mapping of the wrong type is flagged for correction, not shown blank", async () => {
  const { unmount } = await mountForm(
    { ...INITIAL, controlAccounts: { ...INITIAL.controlAccounts, translationAdjustment: "ca1" } },
    { accounts: [{ id: "ca1", label: "1250 · Clearing", type: "asset_current_other" }] },
  );
  try {
    const note = document.getElementById("ctrl-translationAdjustment-expected");
    assert.equal(
      note?.textContent,
      "The selected account's type isn't accepted for Translation adjustment. Choose Equity.",
    );
  } finally {
    await unmount();
  }
});

test("a control-account refusal is restated with the field label, never the storage key", async () => {
  const { unmount } = await mountForm(INITIAL, {}, () =>
    Response.json(
      {
        error:
          "Translation adjustment control account must be Equity; the selected account is Other current asset",
        code: "control-account-invalid",
        role: "translationAdjustment",
        reason: "type",
        accountType: "asset_current_other",
        allowedTypes: ["equity"],
      },
      { status: 400 },
    ),
  );
  try {
    await act(async () => {
      saveButton().click();
      await tick();
    });
    await tick();
    const errors = (globalThis.__settingsToasts ?? []).filter((toast) => toast.kind === "error");
    assert.deepEqual(
      errors.map((toast) => toast.message),
      ["Translation adjustment must be Equity; the selected account is Other Current Assets."],
    );
    assert.ok(!errors[0]!.message.includes("translationAdjustment"));
  } finally {
    await unmount();
  }
});

test("legal identity offers the country's tax numbers, checks them before saving, and sends canonical values", async () => {
  const { seen, unmount } = await mountForm();
  try {
    const bn = document.getElementById("company-tax-id-ca_bn") as HTMLInputElement | null;
    assert.ok(bn, "a Canadian company records its Business Number");
    assert.ok(document.getElementById("company-tax-id-ca_gst_hst"), "and its GST/HST number");
    assert.equal(
      document.getElementById("company-tax-id-us_ein"),
      null,
      "a US EIN is not offered to a Canadian company",
    );
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )!.set!;
    const type = async (input: HTMLInputElement, value: string) => {
      await act(async () => {
        setter.call(input, value);
        input.dispatchEvent(new window.Event("input", { bubbles: true }));
        await tick();
      });
    };
    await type(bn, "123456789");
    await act(async () => {
      saveButton().click();
      await tick();
    });
    assert.equal(seen.length, 0, "a number failing its check digit never reaches the API");
    assert.equal(bn.getAttribute("aria-invalid"), "true");
    assert.match(
      document.getElementById("company-tax-id-ca_bn-error")?.textContent ?? "",
      /enter it like 123456782/,
    );

    await type(bn, "123 456 782");
    const street = document.getElementById("company-address-line1") as HTMLInputElement;
    const city = document.getElementById("company-address-city") as HTMLInputElement;
    await type(street, "400 King St W");
    await type(city, "Toronto");
    // The legal-form picker's id names its visible trigger; its backing native
    // select fires the genuine change event the form handles.
    const form = document
      .getElementById("company-legal-form")
      ?.closest("span")
      ?.querySelector("select");
    assert.ok(form, "the legal form picker has its backing native select");
    const selectValue = Object.getOwnPropertyDescriptor(
      window.HTMLSelectElement.prototype,
      "value",
    )!.set!;
    await act(async () => {
      selectValue.call(form, "sole_proprietorship");
      form.dispatchEvent(new window.Event("change", { bubbles: true }));
      await tick();
    });
    await act(async () => {
      saveButton().click();
      await tick();
    });
    await tick();
    assert.equal(seen.length, 1);
    const body = seen.at(0)!.body as Record<string, unknown>;
    assert.deepEqual(body.taxIds, {
      ca_bn: "123456782",
      ca_gst_hst: null,
      ca_qst: null,
      tax_id: null,
      registration: null,
    });
    assert.deepEqual(body.address, {
      line1: "400 King St W",
      line2: "",
      city: "Toronto",
      region: "",
      postalCode: "",
      country: "CA",
    });
    assert.equal(body.legalForm, "sole_proprietorship");
    assert.equal(body.taxClassification, "individual", "a structure with one treatment selects it");
  } finally {
    await unmount();
  }
});

test("approval configuration links to the sole Flow policy surface", async () => {
  const { unmount } = await mountForm();
  try {
    assert.equal(document.getElementById("requireVendorBillApproval"), null);
    assert.equal(document.getElementById("requireStockCountReview"), null);
    const link = [...document.querySelectorAll("a")].find(
      (item) => item.getAttribute("href") === "/admin/flows",
    );
    assert.ok(link);
    assert.equal(link.textContent, String(settingsCopy.approvals?.manageFlows));
    assert.ok(
      (document.body.textContent ?? "").includes(String(settingsCopy.approvals?.description)),
    );
  } finally {
    await unmount();
  }
});

// TZ1: the org business time zone is settable on Company Settings — it offers
// the canonical zone list and saves the chosen zone.
test("the organization card exposes the business time zone picker", async () => {
  const { seen, unmount } = await mountForm();
  try {
    const trigger = document.querySelector(
      `button[aria-label="${String(settingsCopy.organization?.timeZone)}"]`,
    ) as HTMLButtonElement | null;
    assert.ok(trigger, "expected the business time-zone picker");
    await act(async () => {
      trigger.click();
      await tick();
    });
    await tick();
    const options = [...document.querySelectorAll('[role="option"]')].map(
      (el) => el.textContent ?? "",
    );
    assert.ok(
      options.some((text) => text.includes("UTC")),
      "the picker offers UTC",
    );
    assert.ok(
      options.some((text) => text.includes("America/Toronto")),
      "the picker offers the canonical zones",
    );
    const toronto = [...document.querySelectorAll('[role="option"]')].find((el) =>
      (el.textContent ?? "").includes("America/Toronto"),
    ) as HTMLButtonElement | undefined;
    assert.ok(toronto, "expected an America/Toronto option");
    await act(async () => {
      toronto.click();
      await tick();
    });
    await tick();
    await act(async () => {
      saveButton().click();
      await tick();
      await tick();
    });
    await tick();
    assert.equal(seen.length, 1, "the save must PUT once");
    assert.equal(
      (seen.at(0)!.body as Record<string, unknown>).timeZone,
      "America/Toronto",
      "the chosen zone travels with the save",
    );
  } finally {
    await unmount();
  }
});

// Contract creation belongs to scoped revenue contracts: the choice renders
// only while the switch is on, travels with the save, and stays out of the
// payload while off so the stored choice survives the toggle.
test("contract creation travels only while scoped contracts are on", async () => {
  const gated = await mountForm(INITIAL, { revenueRecognition: true, revenueContracts: true });
  try {
    const trigger = [...document.querySelectorAll("button")].find((button) =>
      (button.textContent ?? "").includes(String(contractCreationCopy.firstBilling)),
    ) as HTMLButtonElement | undefined;
    assert.ok(trigger, "expected the contract-creation picker while scoped contracts are on");
    await act(async () => {
      trigger.click();
      await tick();
    });
    await tick();
    const booking = [...document.querySelectorAll('[role="option"]')].find((el) =>
      (el.textContent ?? "").includes(String(contractCreationCopy.booking)),
    ) as HTMLButtonElement | undefined;
    assert.ok(booking, "expected a booking option");
    // Drive the picker's backing native select (its documented contract:
    // the genuine change event fires from the native control), which is the
    // seam this form owns — the picker's own suite covers option clicks.
    const native = [...document.querySelectorAll("select")].find((candidate) =>
      [...candidate.options].some((option) => option.value === "booking"),
    );
    assert.ok(native, "expected the backing native select");
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLSelectElement.prototype,
      "value",
    )!.set!;
    await act(async () => {
      setter.call(native, "booking");
      native.dispatchEvent(new window.Event("change", { bubbles: true }));
      await tick();
    });
    await tick();
    await act(async () => {
      saveButton().click();
      await tick();
      await tick();
    });
    await tick();
    assert.equal(gated.seen.length, 1, "the save must PUT once");
    assert.equal(
      (gated.seen.at(0)!.body as Record<string, unknown>).contractCreation,
      "booking",
      "the booking choice travels with the save",
    );
  } finally {
    await gated.unmount();
  }

  const ungated = await mountForm(INITIAL, { revenueRecognition: true });
  try {
    assert.equal(
      document.getElementById("contractCreation"),
      null,
      "no contract-creation control while scoped contracts are off",
    );
    await act(async () => {
      saveButton().click();
      await tick();
      await tick();
    });
    await tick();
    assert.equal(ungated.seen.length, 1, "the save must PUT once");
    assert.ok(
      !("contractCreation" in ((ungated.seen.at(0)!.body as Record<string, unknown>) ?? {})),
      "the stored choice is left alone while the switch is off",
    );
  } finally {
    await ungated.unmount();
  }
});

// Normalization operator workflow: composed inside the existing SaaS Metrics
// card, reading only the authenticated API. Fetch is the one doubled
// boundary; translations, schemas, and the res.ok-first refusal handling
// stay real.

type WorkflowSeen = { url: string; method: string; body: unknown };

async function mountWorkflow(respond: (seen: WorkflowSeen) => Response | Promise<Response>) {
  const seen: WorkflowSeen[] = [];
  const prior = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const record: WorkflowSeen = {
      url: String(
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      ),
      method: (init?.method ?? "GET").toUpperCase(),
      body: init?.body ? JSON.parse(String(init.body)) : null,
    };
    if (record.url.startsWith("/api/flows/record-state")) {
      const id = new URL(record.url, "http://test.local").searchParams.get("subjectId");
      return Response.json({
        approvalState: {
          status: "pending",
          pendingWith: [],
          myActions: { gateId: `gate-${id}`, signatureRequired: false },
        },
        history: [],
        failedRun: null,
        canRetry: false,
      });
    }
    seen.push(record);
    return respond(record);
  }) as typeof fetch;
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <SaasMetricsNormalization />
      </NextIntlClientProvider>,
    );
    await tick();
  });
  await tick();
  return {
    seen,
    async unmount() {
      await act(async () => {
        root.unmount();
      });
      host.remove();
      globalThis.fetch = prior;
    },
  };
}

function setWorkflowInput(id: string, value: string) {
  const field = document.getElementById(id) as HTMLInputElement | null;
  assert.ok(field, `expected input #${id}`);
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  setter.call(field, value);
  field.dispatchEvent(new window.Event("input", { bubbles: true }));
}

function clickWorkflowButton(label: string): HTMLButtonElement {
  const button = [...document.querySelectorAll("button")].find(
    (b) => (b.textContent ?? "").trim() === label,
  ) as HTMLButtonElement | undefined;
  assert.ok(button, `expected a "${label}" button`);
  return button;
}

const FAILED_MONTH = [
  {
    month: "2026-07-01",
    state: "failed",
    counts: { monthly: 1, facts: 1, cohorts: 1 },
    denominationVersion: null,
    reportingCurrency: null,
    request: { id: "request-1", status: "failed" },
    failure:
      "Month 2026-07-01 changed under its correction; the proven row counts no longer match.",
    remedy:
      "Retry the request in Company Setup → SaaS Metrics; every metric write was rolled back.",
  },
];

test("normalization evidence renders accessible month rows with only pending approval actions", async () => {
  const ready = {
    month: "2026-06-01",
    state: "ready",
    counts: { monthly: 4, facts: 12, cohorts: 2 },
    denominationVersion: "v3",
    reportingCurrency: "CAD",
    request: null,
    failure: null,
    remedy: null,
  };
  const pending = {
    month: "2026-08-01",
    state: "pending",
    counts: { monthly: 3, facts: 8, cohorts: 1 },
    denominationVersion: null,
    reportingCurrency: null,
    request: { id: "request-august", status: "pending" },
    failure: null,
    remedy: null,
  };
  const { seen, unmount } = await mountWorkflow((record) =>
    record.method === "POST"
      ? Response.json(
          {
            error: "Request request-august needs a different approver.",
            remedy:
              "Have another authorized approver review August in Company Setup → SaaS Metrics.",
          },
          { status: 409 },
        )
      : Response.json([ready, FAILED_MONTH[0], pending]),
  );
  try {
    const table = document.querySelector("table");
    assert.ok(table, "the month evidence uses a semantic table");
    const headings = [...table.querySelectorAll("thead th")].map((cell) =>
      cell.textContent?.trim(),
    );
    assert.deepEqual(headings, [
      normalizationCopy.monthColumn,
      normalizationCopy.statusColumn,
      normalizationCopy.countsColumn,
      normalizationCopy.approveSubmit,
    ]);
    const rows = [...table.querySelectorAll("tbody tr")] as HTMLTableRowElement[];
    assert.equal(rows.length, 3);
    assert.deepEqual(
      rows.map((row) => row.cells[0]?.textContent),
      ["2026-06-01", "2026-07-01", "2026-08-01"],
    );
    assert.match(rows[0]!.cells[1]!.textContent ?? "", /v3.*CAD/);
    assert.match(rows[0]!.cells[2]!.textContent ?? "", /4 \/ 12 \/ 2/);
    assert.match(rows[1]!.cells[1]!.textContent ?? "", /the proven row counts no longer match/);
    assert.match(rows[1]!.cells[1]!.textContent ?? "", /Company Setup → SaaS Metrics/);
    assert.match(rows[2]!.cells[1]!.textContent ?? "", /request-august/);
    const action = rows[2]!.querySelector("button");
    assert.ok(action, "only the pending month offers approval");
    assert.equal(rows[0]!.querySelector("button"), null);
    assert.equal(rows[1]!.querySelector("button"), null);
    action.focus();
    assert.equal(document.activeElement, action, "the approval remains a native focusable button");
    await act(async () => {
      action.click();
      await tick();
    });
    assert.ok(
      seen.some((entry) => entry.method === "POST" && entry.url === "/api/flows/gates/decide"),
    );
    assert.match(document.body.textContent ?? "", /another authorized approver review August/);
  } finally {
    await unmount();
  }
});

test("normalization empty state keeps the correction form available", async () => {
  const { unmount } = await mountWorkflow(() => Response.json([]));
  try {
    assert.equal(document.querySelector("table"), null);
    assert.ok(document.body.textContent?.includes(String(normalizationCopy.empty)));
    assert.ok(document.getElementById("normalization-month"));
    assert.ok(document.getElementById("normalization-reason"));
    assert.ok(clickWorkflowButton(String(normalizationCopy.requestSubmit)));
  } finally {
    await unmount();
  }
});

test("a failed month reads with its exact failure and remedy, never a bare state", async () => {
  const { unmount } = await mountWorkflow(() => Response.json(FAILED_MONTH));
  try {
    assert.ok(
      document.body.textContent?.includes(String(normalizationCopy.states.failed)),
      "the failed state must render",
    );
    assert.ok(
      document.body.textContent?.includes("the proven row counts no longer match"),
      "the recorded failure text must read verbatim",
    );
    assert.ok(
      document.body.textContent?.includes("Company Setup → SaaS Metrics"),
      "the recorded remedy must name the Setup surface",
    );
  } finally {
    await unmount();
  }
});

test("a non-JSON error renders the load fallback, never a parse error", async () => {
  const { unmount } = await mountWorkflow(
    () => new Response("Internal Server Error", { status: 500 }),
  );
  try {
    assert.ok(
      document.body.textContent?.includes(String(normalizationCopy.loadFailed)),
      "the load fallback must render when the body cannot be parsed",
    );
    assert.ok(
      !document.body.textContent?.includes("Unexpected token"),
      "a JSON parse error must never reach the operator",
    );
  } finally {
    await unmount();
  }
});

test("submitting a request posts one month, a reason, and a uuid key, then reloads", async () => {
  const uuid = "00000000-0000-4000-8000-000000000003";
  const cryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  Object.defineProperty(globalThis, "crypto", {
    value: { randomUUID: () => uuid },
    configurable: true,
  });
  let gets = 0;
  const { seen, unmount } = await mountWorkflow((record) => {
    if (record.method === "POST") {
      return Response.json(
        { request: { id: "request-1", status: "pending" }, created: true },
        { status: 201 },
      );
    }
    gets += 1;
    return Response.json(
      gets > 1
        ? [
            {
              month: "2026-07-01",
              state: "pending",
              counts: { monthly: 1, facts: 1, cohorts: 1 },
              denominationVersion: null,
              reportingCurrency: null,
              request: { id: "request-1", status: "pending" },
              failure: null,
              remedy: null,
            },
          ]
        : [],
    );
  });
  try {
    await act(async () => {
      setWorkflowInput("normalization-month", "2026-07-01");
      await tick();
    });
    await act(async () => {
      setWorkflowInput("normalization-reason", "Correct the July legacy denomination.");
      await tick();
    });
    await act(async () => {
      clickWorkflowButton(String(normalizationCopy.requestSubmit)).click();
      await tick();
      await tick();
    });
    await tick();
    const post = seen.find((entry) => entry.method === "POST");
    assert.deepEqual(
      post?.body,
      {
        month: "2026-07-01",
        reason: "Correct the July legacy denomination.",
        idempotencyKey: uuid,
      },
      "the request posts exactly one month, the reason, and the uuid key",
    );
    assert.ok(
      document.body.textContent?.includes(String(normalizationCopy.states.pending)),
      "the reloaded list must show the pending month",
    );
  } finally {
    if (cryptoDescriptor) Object.defineProperty(globalThis, "crypto", cryptoDescriptor);
    await unmount();
  }
});

test("a pending month decides its configured Flow gate and surfaces a refusal remedy", async () => {
  const pending = [
    {
      month: "2026-07-01",
      state: "pending",
      counts: { monthly: 1, facts: 1, cohorts: 1 },
      denominationVersion: null,
      reportingCurrency: null,
      request: { id: "request-1", status: "pending" },
      failure: null,
      remedy: null,
    },
  ];
  const { seen, unmount } = await mountWorkflow((record) => {
    if (record.method === "POST") {
      return Response.json(
        {
          error: "Request request-1 cannot be approved by its requester.",
          code: "saas_normalization_self_approval",
          remedy:
            "Have a different authorized approver approve the request in Company Setup → SaaS Metrics.",
        },
        { status: 409 },
      );
    }
    return Response.json(pending);
  });
  try {
    await act(async () => {
      clickWorkflowButton("Approve").click();
      await tick();
      await tick();
    });
    await tick();
    assert.ok(
      seen.some(
        (entry) =>
          entry.method === "POST" &&
          entry.url === "/api/flows/gates/decide" &&
          (entry.body as { gateId?: string })?.gateId === "gate-request-1",
      ),
      "the decision addresses the native Flow gate",
    );
    assert.ok(
      document.body.textContent?.includes("different authorized approver"),
      "the self-approval remedy must read verbatim after res.ok fails",
    );
  } finally {
    await unmount();
  }
});

test("the SaaS Metrics card hosts the workflow only while the feature is on", async () => {
  const mountSettings = async (saasMetricsEnabled: boolean) => {
    const prior = globalThis.fetch;
    globalThis.fetch = (async () => Response.json([])) as typeof fetch;
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(
        <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
          <SettingsForm initial={INITIAL} {...PROPS} saasMetricsEnabled={saasMetricsEnabled} />
        </NextIntlClientProvider>,
      );
      await tick();
    });
    await tick();
    return {
      async unmount() {
        await act(async () => {
          root.unmount();
        });
        host.remove();
        globalThis.fetch = prior;
      },
    };
  };
  const off = await mountSettings(false);
  try {
    assert.ok(
      !document.body.textContent?.includes(String(normalizationCopy.title)),
      "no workflow surface may render while the feature is off",
    );
  } finally {
    await off.unmount();
  }
  const on = await mountSettings(true);
  try {
    assert.ok(
      document.body.textContent?.includes(String(normalizationCopy.title)),
      "the existing card hosts the workflow while the feature is on",
    );
  } finally {
    await on.unmount();
  }
});

test("a non-JSON request error renders the request fallback, never a parse error", async () => {
  const { unmount } = await mountWorkflow((record) => {
    if (record.method === "POST") return new Response("Internal Server Error", { status: 500 });
    return Response.json([]);
  });
  try {
    await act(async () => {
      setWorkflowInput("normalization-month", "2026-07-01");
      await tick();
    });
    await act(async () => {
      setWorkflowInput("normalization-reason", "Correct the July legacy denomination.");
      await tick();
    });
    await act(async () => {
      clickWorkflowButton(String(normalizationCopy.requestSubmit)).click();
      await tick();
      await tick();
    });
    await tick();
    assert.ok(
      document.body.textContent?.includes(String(normalizationCopy.requestFailed)),
      "the request fallback must render when the error body cannot be parsed",
    );
    assert.ok(
      !document.body.textContent?.includes("Unexpected token"),
      "a JSON parse error must never reach the operator",
    );
  } finally {
    await unmount();
  }
});

test("a non-JSON approval error renders the approval fallback", async () => {
  const pending = [
    {
      month: "2026-07-01",
      state: "pending",
      counts: { monthly: 1, facts: 1, cohorts: 1 },
      denominationVersion: null,
      reportingCurrency: null,
      request: { id: "request-1", status: "pending" },
      failure: null,
      remedy: null,
    },
  ];
  const { unmount } = await mountWorkflow((record) => {
    if (record.method === "POST") return new Response("Internal Server Error", { status: 500 });
    return Response.json(pending);
  });
  try {
    await act(async () => {
      clickWorkflowButton("Approve").click();
      await tick();
      await tick();
    });
    await tick();
    assert.ok(
      document.body.textContent?.includes(String(messages.common.approvalFlow.decisionFailed)),
      "the approval fallback must render when the error body cannot be parsed",
    );
  } finally {
    await unmount();
  }
});

test("a rejected load renders the load fallback instead of rejecting", async () => {
  const { unmount } = await mountWorkflow(() => {
    throw new Error("connection lost");
  });
  try {
    assert.ok(
      document.body.textContent?.includes(String(normalizationCopy.loadFailed)),
      "a fetch rejection must surface the load fallback",
    );
  } finally {
    await unmount();
  }
});

test("an unchanged retry reuses its key while a changed body rotates", async () => {
  let sequence = 0;
  const nextKey = () => `00000000-0000-4000-8000-${String((sequence += 1)).padStart(12, "0")}`;
  const cryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  Object.defineProperty(globalThis, "crypto", {
    value: { randomUUID: nextKey },
    configurable: true,
  });
  const { seen, unmount } = await mountWorkflow((record) => {
    if (record.method === "POST") return new Response("Internal Server Error", { status: 500 });
    return Response.json([]);
  });
  try {
    await act(async () => {
      setWorkflowInput("normalization-month", "2026-07-01");
      await tick();
    });
    await act(async () => {
      setWorkflowInput("normalization-reason", "Correct the July legacy denomination.");
      await tick();
    });
    const submit = async () => {
      await act(async () => {
        clickWorkflowButton(String(normalizationCopy.requestSubmit)).click();
        await tick();
        await tick();
      });
      await tick();
    };
    await submit();
    await submit();
    const posts = seen.filter((entry) => entry.method === "POST");
    assert.equal(posts.length, 2, "both retries must post");
    assert.equal(
      (posts[0]!.body as Record<string, unknown>).idempotencyKey,
      (posts[1]!.body as Record<string, unknown>).idempotencyKey,
      "an unchanged retry after a lost response must reuse the same key",
    );
    await act(async () => {
      setWorkflowInput("normalization-reason", "Correct the July legacy denomination twice.");
      await tick();
    });
    await submit();
    const rotated = seen.filter((entry) => entry.method === "POST");
    assert.equal(rotated.length, 3, "the changed draft must post again");
    assert.notEqual(
      (rotated[2]!.body as Record<string, unknown>).idempotencyKey,
      (rotated[0]!.body as Record<string, unknown>).idempotencyKey,
      "a changed body must rotate to a fresh key",
    );
  } finally {
    if (cryptoDescriptor) Object.defineProperty(globalThis, "crypto", cryptoDescriptor);
    await unmount();
  }
});

test("a conclusive success consumes its draft key", async () => {
  let sequence = 100;
  const nextKey = () => `00000000-0000-4000-8000-${String((sequence += 1)).padStart(12, "0")}`;
  const cryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  Object.defineProperty(globalThis, "crypto", {
    value: { randomUUID: nextKey },
    configurable: true,
  });
  const { seen, unmount } = await mountWorkflow((record) => {
    if (record.method === "POST") {
      return Response.json(
        { request: { id: "request-1", status: "pending" }, created: true },
        { status: 201 },
      );
    }
    return Response.json([]);
  });
  const fillSameDraft = async () => {
    await act(async () => {
      setWorkflowInput("normalization-month", "2026-07-01");
      await tick();
    });
    await act(async () => {
      setWorkflowInput("normalization-reason", "Correct the July legacy denomination.");
      await tick();
    });
    await act(async () => {
      clickWorkflowButton(String(normalizationCopy.requestSubmit)).click();
      await tick();
      await tick();
    });
    await tick();
  };
  try {
    await fillSameDraft();
    await fillSameDraft();
    const posts = seen.filter((entry) => entry.method === "POST");
    assert.equal(posts.length, 2, "both submissions must post");
    assert.notEqual(
      (posts[0]!.body as Record<string, unknown>).idempotencyKey,
      (posts[1]!.body as Record<string, unknown>).idempotencyKey,
      "a conclusive success must rotate the draft key even for the same body",
    );
  } finally {
    if (cryptoDescriptor) Object.defineProperty(globalThis, "crypto", cryptoDescriptor);
    await unmount();
  }
});

test("a ready month renders its recorded denomination and currency", async () => {
  const { unmount } = await mountWorkflow(() =>
    Response.json([
      {
        month: "2026-07-01",
        state: "ready",
        counts: { monthly: 1, facts: 1, cohorts: 1 },
        denominationVersion: "v1",
        reportingCurrency: "CAD",
        request: { id: "request-1", status: "succeeded" },
        failure: null,
        remedy: null,
      },
    ]),
  );
  try {
    assert.ok(
      document.body.textContent?.includes(String(normalizationCopy.resultDenomination)),
      "the recorded denomination label must render",
    );
    assert.ok(document.body.textContent?.includes("v1"), "the recorded denomination must render");
    assert.ok(
      document.body.textContent?.includes(String(normalizationCopy.resultCurrency)),
      "the recorded currency label must render",
    );
    assert.ok(document.body.textContent?.includes("CAD"), "the recorded currency must render");
  } finally {
    await unmount();
  }
});

// Till-drop destinations: the bank and clearing accounts a cashier's
// "Deposit cash to bank" may move till cash into. A stored destination
// arrives checked, toggling updates the set, and the save carries the ids
// the deposit endpoint fences against — receivables never offer.
test("till-drop bank accounts check on and travel with the save", async () => {
  const bankA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const bankB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const { seen, unmount } = await mountForm(
    {
      ...INITIAL,
      cashSales: {
        walkInCustomerId: "",
        defaultCashAccountId: "",
        defaultCardAccountId: "",
        defaultBankAccountId: "",
        depositAccountIds: [bankA],
      },
    },
    {
      cashSalesEnabled: true,
      accounts: [
        { id: bankA, label: "1100 · Operating", type: "asset_bank" },
        { id: bankB, label: "1110 · Savings", type: "asset_bank" },
        {
          id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
          label: "1120 · Clearing",
          type: "asset_current_other",
        },
        {
          id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
          label: "1200 · Receivables",
          type: "asset_receivable",
        },
      ],
    },
  );
  try {
    const box = (label: string): HTMLInputElement => {
      const span = [...document.querySelectorAll("span")].find(
        (node) => node.textContent === label,
      );
      assert.ok(span, `expected a ${label} option`);
      const input = span
        .closest("label")
        ?.querySelector('input[type="checkbox"]') as HTMLInputElement | null;
      assert.ok(input, `expected a checkbox for ${label}`);
      return input;
    };
    assert.equal(box("1100 · Operating").checked, true, "a stored destination arrives checked");
    assert.equal(box("1110 · Savings").checked, false, "an unstored bank arrives unchecked");
    assert.ok(box("1120 · Clearing"), "clearing accounts are valid drop destinations too");
    assert.equal(
      [...document.querySelectorAll("span")].some(
        (node) => node.textContent === "1200 · Receivables",
      ),
      false,
      "receivables never offer drops",
    );
    await act(async () => {
      box("1110 · Savings").click();
      await tick();
    });
    await act(async () => {
      saveButton().click();
      await tick();
    });
    await tick();
    const put = seen.find(
      (request) => request.url === "/api/admin/settings" && request.method === "PUT",
    );
    assert.ok(put, "saving must PUT the settings");
    assert.deepEqual(
      (put.body as { cashSales?: { depositAccountIds?: unknown } }).cashSales?.depositAccountIds,
      [bankA, bankB],
      "the checked destinations must travel with the save",
    );
  } finally {
    await unmount();
  }
});
