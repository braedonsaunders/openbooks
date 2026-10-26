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

// An APPROVED run whose inputs changed after approval must offer a governed
// recalculation (withdraw the approval, recalculate, resubmit) instead of the
// draft-only Calculate control, and the header must name the approval state.
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
const { ConfirmRoot } = await import("../../../../../lib/confirm");

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

type WizardProps = Parameters<typeof RunWizard>[0];

const approvedProps = {
  run: {
    document_id: "doc-1",
    document_number: "PAY-00002",
    document_status: "approved",
    document_revision: "7",
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
  staleness: { stale: true, reasons: ["settings"], calculatedAt: "2025-10-25T00:00:00Z" },
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
  canWithdrawApproval: true,
  initialStep: "review",
  calculationErrors: [],
  refusalAcknowledgement: null,
  refusalsAcknowledged: true,
  approval: {
    documentStatus: "approved",
    pending: false,
    outstandingGates: 0,
    policyExists: true,
    submitted: true,
    released: true,
  },
  rejection: null,
  anomalyBlocks: 0,
  entityOptions: [],
  canAttributeEntity: false,
} as unknown as WizardProps;

const realFetch = globalThis.fetch;

type Recorded = { action: string };

async function mount(t: TestContext, props: WizardProps, recorded: Recorded[]): Promise<void> {
  globalThis.fetch = (async (url: unknown, init?: { body?: unknown }) => {
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
    recorded.push({ action: String(body.action ?? "") });
    if (body.action === "recalculate-approved") {
      return {
        ok: true,
        json: async () => ({
          ok: true,
          errors: [],
          employees: 1,
          gross: "2000.00",
          net: "1400.00",
          employerCost: "2200.00",
          reasons: ["settings"],
          resubmitted: true,
          gated: true,
        }),
      };
    }
    throw new Error(`unexpected fetch in stale approved run test: ${String(url)} ${body.action}`);
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
          <ConfirmRoot />
        </MoneyProvider>
      </NextIntlClientProvider>,
    );
    for (let i = 0; i < 8; i++) await tick();
  });
}

function buttonsLabelled(label: string): HTMLButtonElement[] {
  return [...document.querySelectorAll("button")].filter(
    (b) => (b.textContent ?? "").trim() === label,
  ) as HTMLButtonElement[];
}

async function click(button: HTMLButtonElement): Promise<void> {
  await act(async () => {
    button.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    for (let i = 0; i < 12; i++) await tick();
  });
}

test("an approved run whose inputs changed names its approval state and offers a governed recalculation", async (t) => {
  const recorded: Recorded[] = [];
  await mount(t, approvedProps, recorded);
  const text = document.body.textContent ?? "";
  assert.match(text, /Approved · needs recalculation/, "the header names the approved state");
  assert.match(text, /Approved, but inputs changed since approval \(payroll settings\)/);
  assert.equal(
    buttonsLabelled("Calculate").length + buttonsLabelled("Recalculate").length,
    0,
    "the draft-only Calculate control is not offered on an approved run",
  );
  assert.equal(
    buttonsLabelled("Recalculate and resubmit").length,
    1,
    "the approved run offers Recalculate and resubmit",
  );
  assert.deepEqual(recorded, [], "nothing is sent before the operator confirms");
});

test("recalculating an approved run asks for confirmation that the approval will be withdrawn", async (t) => {
  const recorded: Recorded[] = [];
  await mount(t, approvedProps, recorded);
  await click(buttonsLabelled("Recalculate and resubmit")[0]!);
  const dialog = document.querySelector('[role="dialog"]');
  assert.ok(dialog, "the confirmation dialog opens");
  assert.match(dialog.textContent ?? "", /Withdraw approval and recalculate\?/);
  assert.match(dialog.textContent ?? "", /withdraws this run's approval/);
  assert.deepEqual(recorded, [], "nothing is sent until the operator confirms the withdrawal");
});

test("confirming the recalculation sends the governed action and resubmits the run", async (t) => {
  const recorded: Recorded[] = [];
  await mount(t, approvedProps, recorded);
  await click(buttonsLabelled("Recalculate and resubmit")[0]!);
  const dialog = document.querySelector('[role="dialog"]');
  assert.ok(dialog, "the confirmation dialog opens");
  const confirm = [...dialog.querySelectorAll("button")].find(
    (b) => (b.textContent ?? "").trim() === "Recalculate and resubmit",
  ) as HTMLButtonElement | undefined;
  assert.ok(confirm, "the dialog confirms with the same action label");
  await click(confirm);
  assert.deepEqual(recorded, [{ action: "recalculate-approved" }]);
});

test("an approved run offers no recalculation to a user without the approval-withdrawal permission", async (t) => {
  const recorded: Recorded[] = [];
  await mount(t, { ...approvedProps, canWithdrawApproval: false } as WizardProps, recorded);
  assert.equal(buttonsLabelled("Recalculate and resubmit").length, 0);
  assert.match(document.body.textContent ?? "", /Approved, but inputs changed since approval/);
});

test("a run awaiting approval names the approval decision and offers no recalculation", async (t) => {
  const recorded: Recorded[] = [];
  await mount(
    t,
    {
      ...approvedProps,
      run: { ...approvedProps.run, document_status: "pending_approval" },
      approval: {
        ...approvedProps.approval,
        documentStatus: "pending_approval",
        pending: true,
        released: false,
      },
    } as WizardProps,
    recorded,
  );
  const text = document.body.textContent ?? "";
  assert.match(text, /Awaiting approval/);
  assert.match(text, /its approver must decide that request before it can be recalculated/);
  assert.equal(buttonsLabelled("Recalculate and resubmit").length, 0);
  assert.equal(buttonsLabelled("Recalculate").length, 0);
});
