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

// Recalculating left the header strip (Gross / Net / Employer cost) on the
// pre-calculation figures until the operator left and came back: the strip
// read only the loader props, never the calculate response sitting in the
// same continuation. The strip now folds each recalculation's own totals in.
// Mounts the real wizard on a stale calculated run, answers calculate with
// fresh totals, and asserts the header moves without a revisit.
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

const props = {
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
  staleness: { stale: true, reasons: ["time"], calculatedAt: "2025-10-25T00:00:00Z" },
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
  initialStep: "period",
  calculationErrors: [],
  refusalAcknowledgement: null,
  refusalsAcknowledged: false,
  approval: {
    documentStatus: "draft",
    pending: false,
    outstandingGates: 0,
    policyExists: false,
    submitted: false,
    released: false,
  },
  anomalyBlocks: 0,
  entityOptions: [],
  canAttributeEntity: false,
} as unknown as WizardProps;

const realFetch = globalThis.fetch;

async function mount(t: TestContext): Promise<void> {
  globalThis.fetch = (async (url: unknown, init?: { body?: unknown }) => {
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
    if (body.action === "calculate") {
      return {
        ok: true,
        json: async () => ({
          ok: true,
          errors: [],
          employees: 1,
          gross: "2000.00",
          net: "1400.00",
          employerCost: "2200.00",
        }),
      };
    }
    throw new Error(`unexpected fetch in header test: ${String(url)}`);
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

function recalculateButton(): HTMLButtonElement {
  const button = [...document.querySelectorAll("button")].find((b) =>
    (b.textContent ?? "").includes("Recalculate"),
  ) as HTMLButtonElement | undefined;
  assert.ok(button, "the stale banner must offer Recalculate");
  return button;
}

async function click(button: HTMLButtonElement): Promise<void> {
  await act(async () => {
    button.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    for (let i = 0; i < 12; i++) await tick();
  });
}

test("the header strip refreshes from the recalculation result", async (t) => {
  await mount(t);
  assert.match(
    document.body.textContent ?? "",
    /1,000\.00/,
    "the strip starts on the loader totals",
  );
  await click(recalculateButton());
  assert.match(
    document.body.textContent ?? "",
    /2,000\.00/,
    "gross follows the calculate response, not the revisit",
  );
  assert.match(document.body.textContent ?? "", /1,400\.00/, "net follows the calculate response");
  assert.match(
    document.body.textContent ?? "",
    /2,200\.00/,
    "employer cost follows the calculate response",
  );
});
