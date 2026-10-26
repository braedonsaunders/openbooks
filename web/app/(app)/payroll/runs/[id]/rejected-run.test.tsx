import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { bootJsdomEnvironment } from "../../../../../testing/jsdom-env";
import { stubModules } from "../../../../../testing/stub-modules";

stubModules({
  navigation: {
    source:
      "export function useRouter(){return {push(){},refresh(){},replace(){},back(){}}};" +
      'export function usePathname(){return "/payroll/runs/doc-1"};' +
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

// A run that an approver rejected is a draft again. The wizard must name the
// rejecter and their reason, badge the run as Rejected, and keep the operator's
// path forward open: submit for approval again from the GL step.
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
const { RunWizard } = await import("./RunWizard");
const { MoneyProvider } = await import("../../../../../components/money-provider");

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

type WizardProps = Parameters<typeof RunWizard>[0];

function runProps(overrides: Partial<WizardProps>): WizardProps {
  return {
    run: {
      document_id: "doc-1",
      document_number: "PR-1",
      document_status: "draft",
      document_revision: "1",
      currency: "CAD",
      subsidiary_id: null,
      posted_entry_id: null,
      paid_at: null,
      paid_entry_id: null,
      schedule_name: "Biweekly",
      period_start: "2025-10-11",
      period_end: "2025-10-24",
      pay_date: "2025-10-30",
      tax_year: 2025,
      run_status: "calculated",
      run_type: "regular",
      pay_schedule_id: "sched-1",
      gross_total: "1000.00",
      net_total: "700.00",
      employer_cost_total: "1100.00",
      employee_count: 1,
    },
    stubs: [],
    roster: [],
    adjustments: [],
    adjustableComponents: [],
    previousNet: {},
    remittance: [],
    bankAccounts: [],
    registerReportId: null,
    registerBuckets: [],
    regionLabel: "Province",
    traceEngines: {},
    factorLabels: {},
    readiness: { items: [], blockers: 0, warnings: 0, included: 1 },
    staleness: { stale: false, reasons: [], calculatedAt: "2025-10-25T00:00:00Z" },
    funding: {
      netPay: "700.00",
      rails: [],
      liabilities: "0",
      totalCost: "1100.00",
      payDate: "2025-10-30",
      businessDaysToPayDate: 3,
      accounts: [],
    },
    changes: [],
    separationSections: [],
    canRun: true,
    initialStep: "gl",
    calculationErrors: [],
    refusalAcknowledgement: null,
    refusalsAcknowledged: false,
    approval: {
      documentStatus: "draft",
      pending: false,
      outstandingGates: 0,
      policyExists: true,
      submitted: false,
      released: false,
    },
    rejection: null,
    anomalyBlocks: 0,
    entityOptions: [],
    canAttributeEntity: false,
    ...overrides,
  } as unknown as WizardProps;
}

const realFetch = globalThis.fetch;

async function mount(t: TestContext, props: WizardProps): Promise<void> {
  globalThis.fetch = (async (_url: unknown, init?: { body?: unknown }) => {
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
    if (body.action === "preview-gl") {
      return { ok: true, json: async () => ({ legs: [], debitTotal: "0" }) };
    }
    throw new Error(`unexpected fetch in rejected-run test: ${JSON.stringify(body)}`);
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = realFetch;
  });
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
        <MoneyProvider currency="CAD">
          <RunWizard {...props} />
        </MoneyProvider>
      </NextIntlClientProvider>,
    );
    for (let i = 0; i < 8; i++) await tick();
  });
}

function exactText(text: string): Element | undefined {
  return [...document.querySelectorAll("*")].find(
    (el) => el.children.length === 0 && (el.textContent ?? "").trim() === text,
  );
}

test("a rejected run names the rejecter and reason and stays open for resubmission", async (t) => {
  await mount(
    t,
    runProps({
      rejection: {
        rejectedBy: "Dana Approver",
        rejectedAt: "2025-10-27T15:30:00.000Z",
        reason: "Wrong pay period",
      },
    }),
  );
  const body = document.body.textContent ?? "";
  assert.ok(exactText("Rejected"), "the run header badges the run as Rejected");
  assert.match(
    body,
    /Rejected by Dana Approver on 2025-10-27/,
    "the banner names the rejecter and the date",
  );
  assert.match(body, /Reason: Wrong pay period/, "the banner carries the recorded reason");
  const submit = [...document.querySelectorAll("button")].find((b) =>
    (b.textContent ?? "").includes("Submit for approval"),
  );
  assert.ok(submit, "the GL step still offers resubmission for approval");
  assert.equal(submit.disabled, false, "resubmission is available to the operator");
});

test("a run that was never rejected shows no rejection notice", async (t) => {
  await mount(t, runProps({ initialStep: "period", rejection: null }));
  const body = document.body.textContent ?? "";
  assert.ok(exactText("Calculated"), "the header keeps the calculated stage badge");
  assert.doesNotMatch(body, /Rejected by/, "no rejection notice without a recorded rejection");
  assert.equal(exactText("Rejected"), undefined, "no Rejected badge without a rejection");
});
