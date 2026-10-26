import assert from "node:assert/strict";
import test from "node:test";

const { stubModules } = await import("../../../../testing/stub-modules");
stubModules({
  navigation: `export function usePathname(){return '/reports/project-profitability'}export function useSearchParams(){return new URLSearchParams()}export function useRouter(){return {}}`,
  intl: false,
  authz: false,
  features: false,
});

const React = await import("react");
// Classic-JSX fallback: the shared tsx cache can serve a classic transform,
// which resolves bare React from the global scope, not the module scope.
Object.assign(globalThis, { React });
const { renderToString } = await import("react-dom/server");
const { NextIntlClientProvider } = await import("next-intl");
const { MoneyProvider } = await import("../../../../components/money-provider");
const { ProjectProfitabilityTable } = await import("./ProjectProfitabilityTable");
const { marginRatioToPercent } = await import("../../../../lib/statement-format");

type RowValues = {
  revenue: string;
  cogs: string;
  grossProfit: string;
  expenses: string;
  net: string;
  margin: string | null;
  hours: number;
};

function tableHtml(values: RowValues | null, emptyHint = "Hint"): string {
  return renderToString(
    <NextIntlClientProvider locale="en" messages={{}} timeZone="UTC">
      <MoneyProvider currency="USD">
        <ProjectProfitabilityTable
          company="Acme"
          title="Project profitability"
          periodPhrase="FY 2026"
          columns={[]}
          emptyLabel="No project postings"
          emptyHint={emptyHint}
          currency="USD"
          groups={
            values
              ? [
                  {
                    key: "g1",
                    name: "Bridge job",
                    expandLabel: "Expand",
                    collapseLabel: "Collapse",
                    values,
                    drillScope: null,
                    projects: [],
                  },
                ]
              : []
          }
          totalLabel="Total"
          totals={
            values ?? {
              revenue: "0.0000",
              cogs: "0.0000",
              grossProfit: "0.0000",
              expenses: "0.0000",
              net: "0.0000",
              margin: null,
              hours: 0,
            }
          }
          totalScope={null}
          drillBase={null}
        />
      </MoneyProvider>
    </NextIntlClientProvider>,
  );
}

// decimalRatio returns 0.2500 for a 25% margin — the table must scale it
// exactly once to percent, like the CSV/XLSX/PDF export does through the
// same helper. Scaling twice (or never) shows 0.0% (or 0.3%) instead.
test("a 25% margin ratio displays as 25.0%, scaled exactly once", () => {
  const html = tableHtml({
    revenue: "1000.0000",
    cogs: "600.0000",
    grossProfit: "400.0000",
    expenses: "150.0000",
    net: "250.0000",
    margin: "0.2500",
    hours: 10,
  });
  assert.ok(html.includes("Bridge job"), "the group row must render");
  assert.ok(html.includes("25.0%"), "a 0.2500 margin ratio must display as 25.0%");
  assert.ok(!html.includes("0.0%"), "a twice-scaled ratio would collapse to 0.0%");
});

// Both the table and the export scale margins through marginRatioToPercent,
// so display and export cannot diverge: the shared helper scales exactly
// once, with no rounding on the way.
test("margin ratios scale to percent units exactly once through the shared helper", () => {
  assert.equal(marginRatioToPercent("0.2500"), "25.0000");
  assert.equal(marginRatioToPercent("-0.1250"), "-12.5000");
  assert.equal(marginRatioToPercent("0.0000"), "0.0000");
});

// an empty project report must explain its zero — what would have to
// be posted, or to widen the period — naming the selected period.
test("the empty report explains its zero with the period and the remedy", () => {
  const hint = "Nothing was posted to projects in FY 2026 — post a bill or widen the period.";
  const html = tableHtml(null, hint);
  assert.ok(html.includes("No project postings"), "the empty label must render");
  assert.ok(html.includes(hint), "the zero-state explanation must render under the empty label");
});

test("rows drill through targets built from the shared base and their own scope", async () => {
  const { profitDrillTargets } = await import("./drills");
  const base = {
    from: "2026-01-01",
    to: "2026-12-31",
    dims: { segments: {}, includeNullSubsidiary: false, departmentId: undefined },
    basis: "accrual",
    activeProjects: true,
  };
  const project = profitDrillTargets(base, "Bridge job", { projectId: "p1" });
  assert.deepEqual(project.revenue, {
    kind: "ledger",
    label: "Bridge job",
    accountTypes: ["income", "income_other"],
    from: "2026-01-01",
    to: "2026-12-31",
    mode: "flow",
    dims: { segments: {}, includeNullSubsidiary: false, projectId: "p1" },
    activeProjectsOnly: false,
    profitSigned: false,
    basis: "accrual",
  });
  assert.equal(project.margin, project.net, "margin drills to the net ledger");
  const customer = profitDrillTargets(base, "Acme", { customerId: "c1", search: "bridge" });
  assert.deepEqual(customer.hours, {
    kind: "time",
    label: "Acme",
    from: "2026-01-01",
    to: "2026-12-31",
    projectCustomerId: "c1",
    projectSearch: "bridge",
    activeProjectsOnly: true,
  });
});
