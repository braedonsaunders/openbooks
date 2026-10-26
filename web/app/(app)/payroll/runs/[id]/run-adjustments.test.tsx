import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { bootJsdomEnvironment } from "../../../../../testing/jsdom-env";
import { stubModules } from "../../../../../testing/stub-modules";

stubModules({
  navigation: {
    source:
      "export function useRouter(){return {push(){},refresh(){},replace(){},back(){}}};" +
      'export function usePathname(){return "/payroll/runs/run-1"};' +
      "export function useSearchParams(){return new URLSearchParams()};" +
      "export function useParams(){return {}}",
  },
  intl: false,
  authz: false,
  features: false,
  extra: {
    "next/link":
      'export default function Link(p){return globalThis.React.createElement("a",{href:p.href},p.children)}',
    sonner: "export const toast={success(){},error(){},warning(){}}",
  },
});

// Adding a pay adjustment from the employee drawer: the component is chosen in
// the shared picker, the edit and its recalculation land, and the refreshed
// run shows the new row. Mounts the real wizard under jsdom with server answers
// shaped like the add-adjustment, calculate, and holiday-assertions routes.
// The shared picker dispatches its change through the global Event, so the
// test realm uses jsdom's own Event constructor.
await bootJsdomEnvironment({
  url: "http://localhost:4800/payroll/runs/doc-1",
  matchMediaMatches: true,
  event: "jsdom",
});
const React = await import("react");
Object.assign(globalThis, { React });
const { createRoot } = await import("react-dom/client");
const { act } = await import("react");
const { NextIntlClientProvider } = await import("next-intl");
const messages = (await import("../../../../../messages/en")).default;
const { RunWizard } = await import("./RunWizard");
const { MoneyProvider } = await import("../../../../../components/money-provider");

const RUN_ID = "11111111-1111-4111-8111-111111111111";
const EMPLOYEE_ID = "33333333-3333-4333-8333-333333333333";
const BONUS_ID = "44444444-4444-4444-8444-444444444444";
const TIPS_ID = "55555555-5555-4555-8555-555555555555";

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

type WizardProps = Parameters<typeof RunWizard>[0];

const components = [
  { id: BONUS_ID, code: "BONUS", name: "Bonus", kind: "earning" },
  { id: TIPS_ID, code: "TIPS_POOL", name: "Tips pool", kind: "earning" },
];

const regularPay = {
  stub_id: "stub-1",
  kind: "earning",
  description: "Regular pay",
  hours: null,
  rate: null,
  amount: "1000.0000",
  payment_kind: "cash",
  sequence: 1,
  component_code: "BASE",
  project_name: null,
  department_name: null,
};

function stubWith(lines: unknown[], netPay: string, gross: string) {
  return {
    id: "stub-1",
    employee_party_id: EMPLOYEE_ID,
    employee_name: "Ada",
    province: "ON",
    country: "CA",
    gross,
    net_pay: netPay,
    employer_cost: "1100.0000",
    factors: {},
    lines: [regularPay, ...lines],
  };
}

function adjustmentRow(id: string, componentId: string, componentName: string, amount: string) {
  return {
    id,
    employee_party_id: EMPLOYEE_ID,
    adjustment_type: "line",
    component_id: componentId,
    amount,
    hours: null,
    replace_component: false,
    note: null,
    employee_name: "Ada",
    component_name: componentName,
  };
}

function wizardProps(
  overrides: Partial<{ stubs: unknown[]; adjustments: unknown[]; changes: unknown[] }> = {},
): WizardProps {
  return {
    run: {
      document_id: RUN_ID,
      document_number: "PR-104",
      document_status: "draft",
      currency: "CAD",
      subsidiary_id: null,
      posted_entry_id: null,
      paid_at: null,
      paid_entry_id: null,
      schedule_name: "Biweekly",
      period_start: "2026-08-01",
      period_end: "2026-08-14",
      pay_date: "2026-08-20",
      tax_year: 2026,
      run_status: "calculated",
      run_type: "regular",
      pay_schedule_id: "22222222-2222-4222-8222-222222222222",
      gross_total: "1000.0000",
      net_total: "800.0000",
      employer_cost_total: "1100.0000",
      employee_count: 1,
    },
    stubs: overrides.stubs ?? [stubWith([], "800.0000", "1000.0000")],
    roster: [],
    adjustments: overrides.adjustments ?? [],
    adjustableComponents: components,
    previousNet: {},
    remittance: [],
    bankAccounts: [],
    registerReportId: null,
    registerBuckets: [],
    regionLabel: "Province",
    traceEngines: {},
    factorLabels: {},
    readiness: { items: [], blockers: 0, warnings: 0, included: 1 },
    staleness: { stale: false, reasons: [], calculatedAt: null },
    funding: {
      netPay: "0",
      rails: [],
      liabilities: "0",
      totalCost: "0",
      payDate: "2026-08-20",
      businessDaysToPayDate: 5,
      accounts: [],
    },
    changes: overrides.changes ?? [],
    separationSections: [],
    canRun: true,
    initialStep: "review",
    calculationErrors: [],
    refusalAcknowledgement: null,
    refusalsAcknowledged: false,
    approval: {
      policyExists: false,
      pending: false,
      submitted: false,
      released: false,
      outstandingGates: 0,
      documentStatus: "draft",
    },
    anomalyBlocks: 0,
    entityOptions: [],
    canAttributeEntity: false,
  } as unknown as WizardProps;
}

interface ServerOptions {
  /** A commission-status refusal from the statutory holiday calculation. */
  commissionRefusal: boolean;
}

/** Answers shaped like the add-adjustment, calculate and holiday-assertions routes. */
function installServer(t: TestContext, options: ServerOptions): string[] {
  const calls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
    calls.push(`${init?.method ?? "GET"} ${url} ${body.action ?? ""}`.trim());
    if (url === `/api/payroll/runs/${RUN_ID}` && body.action === "add-adjustment") {
      return Response.json({ ok: true });
    }
    if (url === `/api/payroll/runs/${RUN_ID}` && body.action === "calculate") {
      return Response.json({
        ok: true,
        employees: 1,
        errors: options.commissionRefusal
          ? [
              {
                employeePartyId: EMPLOYEE_ID,
                employee: "Ada",
                message:
                  "Ada: Canada Day needs an explicit commission-pay status for the statutory holiday calculation — record whether the employee is paid in whole or in part on commission",
                kind: "refusal",
              },
            ]
          : [],
        gross: "1250.0000",
        net: "1000.0000",
        employerCost: "1100.0000",
        refusalAcknowledgement: null,
        refusalsAcknowledged: !options.commissionRefusal,
      });
    }
    if (url === `/api/payroll/runs/${RUN_ID}/holiday-assertions`) {
      return Response.json({
        employees: [
          {
            employeePartyId: EMPLOYEE_ID,
            name: "Ada",
            paidOnCommission: null,
            occupationClass: null,
            occupationClasses: [],
            assertions: [],
            demanding: [
              {
                key: "canada-day",
                date: "2026-07-01",
                name: "Canada Day",
                needsCommissionStatus: true,
                needsAbsenceAssertion: false,
                needsEntitlementDayAssessment: false,
                needsOccupationClass: false,
              },
            ],
          },
        ],
        suggested: {},
      });
    }
    return Response.json({ error: `unexpected request ${url}` }, { status: 500 });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  return calls;
}

async function mount(t: TestContext, props: WizardProps) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
    for (const child of [...document.body.children]) child.remove();
  });
  const render = async (next: WizardProps) => {
    await act(async () => {
      root.render(
        <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
          <MoneyProvider currency="CAD">
            <RunWizard {...next} />
          </MoneyProvider>
        </NextIntlClientProvider>,
      );
      await tick();
    });
  };
  await render(props);
  return { host, render };
}

async function settle(rounds = 6): Promise<void> {
  await act(async () => {
    for (let i = 0; i < rounds; i++) await tick();
  });
}

async function clickElement(element: Element): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
    await tick();
  });
}

async function openEmployeeDrawer(host: HTMLElement): Promise<void> {
  const row = [...host.querySelectorAll("tr")].find((tr) => tr.textContent?.includes("Ada"));
  assert.ok(row, "the employee row must render");
  await clickElement(row);
  await settle(2);
}

function componentPicker(): HTMLButtonElement {
  const picker = document.querySelector(
    'button[aria-label="Component"]',
  ) as HTMLButtonElement | null;
  assert.ok(picker, "the Component picker must render in the adjustment form");
  return picker;
}

/** Open the picker and click the option by mouse, the way an operator chooses it. */
async function chooseComponentByMouse(name: string): Promise<void> {
  await clickElement(componentPicker());
  const option = [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')].find(
    (candidate) => candidate.textContent?.includes(name),
  );
  assert.ok(option, `the ${name} option must be offered by the picker`);
  await clickElement(option);
  await settle(2);
}

async function typeAmount(value: string): Promise<void> {
  const input = document.querySelector('input[aria-label="Amount"]') as HTMLInputElement | null;
  assert.ok(input, "the amount field must render");
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(
      input,
      value,
    );
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
    await tick();
  });
}

function drawerButton(label: string): HTMLButtonElement {
  const button = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => (candidate.textContent ?? "").trim() === label,
  );
  assert.ok(button, `the "${label}" control must render`);
  return button;
}

test("adding a bonus recalculates and shows the new row without throwing", async (t) => {
  const calls = installServer(t, { commissionRefusal: true });
  const { host, render } = await mount(t, wizardProps());
  await openEmployeeDrawer(host);

  await chooseComponentByMouse("Bonus");
  await typeAmount("250.00");
  await clickElement(drawerButton("Add adjustment"));
  await settle();

  assert.ok(
    calls.includes(`POST /api/payroll/runs/${RUN_ID} add-adjustment`),
    "the adjustment must be posted",
  );
  assert.ok(
    calls.includes(`POST /api/payroll/runs/${RUN_ID} calculate`),
    "the stubs must be recalculated",
  );
  // The commission refusal from the recalculation renders its answer controls.
  assert.match(document.body.textContent ?? "", /commission-pay status/);

  // router.refresh() delivers the recalculated run: the stub carries the bonus
  // line and the drawer lists the adjustment row.
  await render(
    wizardProps({
      stubs: [
        stubWith(
          [
            {
              ...regularPay,
              kind: "earning",
              description: "Bonus",
              amount: "250.0000",
              sequence: 2,
              component_code: "BONUS",
            },
          ],
          "1000.0000",
          "1250.0000",
        ),
      ],
      adjustments: [adjustmentRow("adj-1", BONUS_ID, "Bonus", "250.0000")],
      changes: [
        {
          employeePartyId: EMPLOYEE_ID,
          employeeName: "Ada",
          previousPayDate: "2026-08-06",
          netDelta: "200.0000",
          grossDelta: "250.0000",
          hoursDelta: "0",
          changes: [{ kind: "added", component: "Bonus", from: null, to: "250.0000" }],
        },
      ],
    }),
  );
  await settle();

  assert.ok(host.isConnected, "the wizard must stay mounted after the adjustment");
  const rows = [...document.querySelectorAll("li")].filter((li) =>
    li.textContent?.includes("Bonus"),
  );
  assert.ok(
    rows.some((li) => li.textContent?.includes("CA$250.00")),
    "the adjustment row must render with its amount",
  );
});

test("a tips pool adjustment on a non-cash line renders after the refresh", async (t) => {
  installServer(t, { commissionRefusal: false });
  const { host, render } = await mount(t, wizardProps());
  await openEmployeeDrawer(host);

  await chooseComponentByMouse("Tips pool");
  await typeAmount("40.1234");
  await clickElement(drawerButton("Add adjustment"));
  await settle();

  await render(
    wizardProps({
      stubs: [
        stubWith(
          [
            {
              ...regularPay,
              kind: "earning",
              description: "Tips pool",
              amount: "40.1234",
              payment_kind: "non_cash",
              sequence: 2,
              component_code: "TIPS_POOL",
            },
          ],
          "800.0000",
          "1040.1234",
        ),
      ],
      adjustments: [adjustmentRow("adj-2", TIPS_ID, "Tips pool", "40.1234")],
    }),
  );
  await settle();

  const rows = [...document.querySelectorAll("li")].filter((li) =>
    li.textContent?.includes("Tips pool"),
  );
  assert.ok(
    rows.some((li) => li.textContent?.includes("CA$40.12")),
    "the tips pool row must render with its amount",
  );
});

test("the Component picker selects an option on a mouse click", async (t) => {
  installServer(t, { commissionRefusal: false });
  const { host } = await mount(t, wizardProps());
  await openEmployeeDrawer(host);

  await chooseComponentByMouse("Tips pool");

  assert.match(
    componentPicker().textContent ?? "",
    /Tips pool/,
    "the mouse-selected component must show as the value",
  );
  assert.equal(
    drawerButton("Add adjustment").disabled,
    true,
    "Add stays disabled until an amount is entered for the chosen component",
  );
  await typeAmount("40.00");
  assert.equal(
    drawerButton("Add adjustment").disabled,
    false,
    "Add enables once component and amount are set",
  );
});
