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

// Excluding a stub closed the drawer even when the exclusion
// FAILED, stranding the typed adjustments with the stub that still holds
// them. The drawer closes only on a successful exclusion now. Mounts the
// real drawer under jsdom with an onAdjust that reports success or failure
// and asserts the close follows the outcome, not the click.
await bootJsdomEnvironment({
  url: "http://localhost:4800/payroll/runs/doc-1",
  matchMediaMatches: false,
});
const React = await import("react");
Object.assign(globalThis, { React });
const { createRoot } = await import("react-dom/client");
const { act } = await import("react");
const { NextIntlClientProvider } = await import("next-intl");
const messages = (await import("../../../../../messages/en")).default;
const { StubDrawer } = await import("./RunWizard");
const { RunWizard } = await import("./RunWizard");
const { MoneyProvider } = await import("../../../../../components/money-provider");

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

type StubDrawerProps = Parameters<typeof StubDrawer>[0];

const stub = {
  id: "stub-1",
  employee_party_id: "e1",
  employee_name: "Ada",
  country: "CA",
  lines: [],
  factors: {},
} as unknown as StubDrawerProps["stub"];

async function mount(t: TestContext, outcome: boolean, closed: { count: number }): Promise<void> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const rootHandle = createRoot(host);
  t.after(async () => {
    await act(async () => {
      rootHandle.unmount();
    });
    host.remove();
    for (const child of [...document.body.children]) child.remove();
  });
  await act(async () => {
    rootHandle.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <StubDrawer
          stub={stub}
          variance={null}
          change={null}
          onClose={() => {
            closed.count += 1;
          }}
          fmt={(v) => String(v ?? "")}
          adjustments={[]}
          components={[]}
          canAdjust
          busy={false}
          onAdjust={async () => outcome}
          buckets={[]}
          regionLabel=""
          traceEngines={{}}
          factorLabels={{}}
        />
      </NextIntlClientProvider>,
    );
    for (let i = 0; i < 8; i++) await tick();
  });
}

function excludeButton(): HTMLButtonElement {
  const button = [...document.querySelectorAll("button")].find((b) =>
    (b.textContent ?? "").includes("Exclude from this run"),
  ) as HTMLButtonElement | undefined;
  assert.ok(button, "the Exclude control must render");
  return button;
}

async function click(button: HTMLButtonElement): Promise<void> {
  await act(async () => {
    button.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    for (let i = 0; i < 10; i++) await tick();
  });
}

test("a refused exclusion keeps the drawer open", async (t) => {
  const closed = { count: 0 };
  await mount(t, false, closed);
  await click(excludeButton());
  assert.equal(closed.count, 0, "the drawer must stay open over a failed exclusion");
});

test("a successful exclusion closes the drawer", async (t) => {
  const closed = { count: 0 };
  await mount(t, true, closed);
  await click(excludeButton());
  assert.equal(closed.count, 1, "the drawer must close once the exclusion succeeds");
});

async function setFieldValue(
  element: HTMLInputElement | HTMLSelectElement,
  value: string,
): Promise<void> {
  await act(async () => {
    const proto =
      element instanceof HTMLSelectElement
        ? window.HTMLSelectElement.prototype
        : window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(element, value);
    element.dispatchEvent(
      new window.Event(element instanceof HTMLSelectElement ? "change" : "input", {
        bubbles: true,
      }),
    );
    for (let i = 0; i < 4; i++) await tick();
  });
}

function labelledInput(label: string): HTMLInputElement {
  const input = [...document.querySelectorAll("label")]
    .find((candidate) => (candidate.textContent ?? "").includes(label))
    ?.querySelector("input");
  assert.ok(input, `the "${label}" field must render`);
  return input as HTMLInputElement;
}

test("a bank cash split submits its explicit outside-bank amount and resets the form", async (t) => {
  const bodies: Record<string, unknown>[] = [];
  const host = document.createElement("div");
  document.body.appendChild(host);
  const rootHandle = createRoot(host);
  t.after(async () => {
    await act(async () => {
      rootHandle.unmount();
    });
    host.remove();
    for (const child of [...document.body.children]) child.remove();
  });
  const bankComponent = {
    id: "bank-component",
    code: "BANKPAY",
    name: "Bank payout",
    kind: "earning",
    bank_cash_component: true,
  } as unknown as StubDrawerProps["components"][number];
  await act(async () => {
    rootHandle.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <StubDrawer
          stub={stub}
          variance={null}
          change={null}
          onClose={() => {}}
          fmt={(v) => String(v ?? "")}
          adjustments={[]}
          components={[bankComponent]}
          canAdjust
          busy={false}
          onAdjust={async (body) => {
            bodies.push(body);
            return true;
          }}
          buckets={[]}
          regionLabel=""
          traceEngines={{}}
          factorLabels={{}}
        />
      </NextIntlClientProvider>,
    );
    for (let i = 0; i < 8; i++) await tick();
  });
  const picker = document.querySelector(
    'button[aria-label="Component"]',
  ) as HTMLButtonElement | null;
  assert.ok(picker, "the component picker must render");
  await click(picker);
  const option = [...document.querySelectorAll('[role="option"]')].find((candidate) =>
    (candidate.textContent ?? "").includes("Bank payout"),
  );
  assert.ok(option, "the bank payout component must be offered");
  await act(async () => {
    option.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
    for (let i = 0; i < 6; i++) await tick();
  });
  await setFieldValue(
    document.querySelector('input[aria-label="Amount"]') as HTMLInputElement,
    "1150.64",
  );
  await setFieldValue(labelledInput("Signed bank hours"), "8.00");
  await setFieldValue(labelledInput("Keyed hourly rate (optional)"), "143.83");
  await setFieldValue(labelledInput("Cash paid outside the bank (optional)"), "782.64");
  await setFieldValue(
    document.querySelector('input[aria-label="Source reference"]') as HTMLInputElement,
    "Payroll source document 7",
  );
  await setFieldValue(
    document.querySelector('input[aria-label="Reason / note (optional)"]') as HTMLInputElement,
    "Approved withdrawal with independently paid cash",
  );
  const add = [...document.querySelectorAll("button")].find(
    (b) => (b.textContent ?? "").trim() === "Add adjustment",
  ) as HTMLButtonElement | undefined;
  assert.ok(add, "the Add adjustment control must render");
  assert.equal(add.disabled, false, "a complete split input enables Add");
  await click(add);
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0]!.action, "bank-cash-input");
  assert.equal(bodies[0]!.outsideBankAmount, "782.64");
  assert.equal(bodies[0]!.amount, "1150.64");
  assert.equal(bodies[0]!.hours, "8.00");
  assert.equal(bodies[0]!.rate, "143.83");
  // A successful add resets the whole form: the component clears, which
  // unmounts the bank fields, and the shared amount field reads empty.
  assert.equal(
    [...document.querySelectorAll("label")].some((candidate) =>
      (candidate.textContent ?? "").includes("Cash paid outside the bank"),
    ),
    false,
    "a successful add resets the outside-bank amount with the form",
  );
  assert.equal(
    (document.querySelector('input[aria-label="Amount"]') as HTMLInputElement).value,
    "",
    "a successful add resets the amount",
  );
});

function wizardProps(stubs: unknown[]) {
  return {
    run: {
      document_id: "11111111-1111-4111-8111-111111111111",
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
      gross_total: "0",
      net_total: "0",
      employer_cost_total: "0",
      employee_count: 1,
    },
    stubs,
    roster: [],
    adjustments: [],
    adjustableComponents: [],
    previousNet: {},
    remittance: [],
    bankAccounts: [],
    registerReportId: null,
    registerBuckets: [],
    regionLabel: "ON",
    traceEngines: {},
    factorLabels: {},
    readiness: { items: [], blockers: 0, warnings: 0, included: 0 },
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
    changes: [],
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
  } as unknown as Parameters<typeof RunWizard>[0];
}

test("an open stub drawer follows its recalculated employee row and PDF link", async (t) => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const row = (id: string, net_pay: string) => ({
    ...stub,
    id,
    employee_party_id: "e1",
    gross: "100",
    net_pay,
    employer_cost: "110",
    province: "ON",
  });
  const render = (rows: unknown[]) => (
    <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
      <MoneyProvider currency="CAD">
        <RunWizard {...wizardProps(rows)} />
      </MoneyProvider>
    </NextIntlClientProvider>
  );
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  await act(async () => {
    root.render(render([row("old-id", "80")]));
    await tick();
  });
  const employee = [...host.querySelectorAll("tr")].find((tr) => tr.textContent?.includes("Ada"));
  assert.ok(employee);
  await act(async () => {
    employee.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await tick();
  });
  assert.ok(document.body.querySelector('a[href="/api/record-pdf/pay_stub/old-id"]'));
  await act(async () => {
    root.render(render([row("new-id", "90")]));
    await tick();
  });
  assert.ok(document.body.querySelector('a[href="/api/record-pdf/pay_stub/new-id"]'));
  assert.equal(document.body.querySelector('a[href="/api/record-pdf/pay_stub/old-id"]'), null);
});
