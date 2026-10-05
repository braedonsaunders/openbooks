import assert from "node:assert/strict";
import test from "node:test";

// Smoke coverage for the translated tabs: each mounts against its catalog
// namespace with a minimal payload, proving the tab reads its data shape
// and its keys (a mistyped key or a missing field fails here, not in front
// of an operator). Charts are stubbed; panels and cards run for real.

const { bootJsdomEnvironment } = await import("../../../../../testing/jsdom-env");
await bootJsdomEnvironment({ url: "http://localhost:4800/analytics/financial-health", matchMediaMatches: false, scrollIntoView: false, resizeObserver: false });

const { registerHooks } = await import("node:module");
const { stubModules } = await import("../../../../../testing/stub-modules");
stubModules({ navigation: "export function useRouter(){return globalThis.__smRouter}export function usePathname(){return '/analytics/financial-health'}export function useSearchParams(){return new URLSearchParams()}" });
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.endsWith("/_ui/charts")) {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export function GroupedBar(){return null}export function TrendChart(){return null}export function DivergingBar(){return null}export function Donut(){return null}export function Waterfall(){return null}export function ForecastChart(){return null}",
      };
    }
    return next(specifier, context);
  },
});

declare global {
  var __smRouter: { push(url: string): void; refresh(): void } | undefined;
}

const React = await import("react");
Object.assign(globalThis, { React });
const { createRoot } = await import("react-dom/client");
const { act } = await import("react");
const { NextIntlClientProvider } = await import("next-intl");
const messages = (await import("../../../../../messages/en")).default;
const { MoneyProvider } = await import("../../../../../components/money-provider");
const { OverviewTab } = await import("./OverviewTab");
const { SegmentsTab } = await import("./SegmentsTab");
const { DriversTab } = await import("./DriversTab");
const { ItemsTab } = await import("./ItemsTab");

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

async function mount(node: React.ReactElement) {
  globalThis.__smRouter = { push() {}, refresh() {} };
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <MoneyProvider currency="USD">{node}</MoneyProvider>
      </NextIntlClientProvider>,
    );
    await tick();
  });
  await tick();
  const text = host.textContent ?? "";
  await act(async () => {
    root.unmount();
  });
  host.remove();
  return text;
}

const figures = {
  revenue: "1000000.0000",
  operatingRevenue: "900000.0000",
  otherIncome: "100000.0000",
  cogs: "600000.0000",
  grossProfit: "400000.0000",
  opex: "250000.0000",
  operatingIncome: "150000.0000",
  otherExpense: "10000.0000",
  netIncome: "140000.0000",
  breakevenRevenue: "625000.0000",
};
const ratios = {
  profitability: [],
  liquidity: [],
  solvency: [],
  efficiency: [],
  operating: [
    { id: "gross_margin", value: "0.4000", format: "pct" },
    { id: "operating_margin", value: "0.1500", format: "pct" },
  ],
};
const bands = {
  hhi: { warning: 1500, critical: 2500 },
  scenario: { safety: "0.1000", comfort: "0.3000" },
};

test("overview renders its translated chrome and exact margins", async () => {
  const text = await mount(
    <OverviewTab data={{
      figures, ratios, bands,
      monthly: [{ month: "2026-01", label: "Jan", revenue: "1000000.0000", cogs: "600000.0000", grossProfit: "400000.0000", grossMarginPct: 0.4, opex: "250000.0000", operatingIncome: "150000.0000", operatingMarginPct: 0.15, netIncome: "140000.0000" }],
      pnlSummary: [{ key: "revenue", label: "Revenue", current: "1000000.0000", prior: "900000.0000", change: "100000.0000", changePct: "0.1111", favorable: true, strong: true }],
      marginFlow: [{ key: "revenue", label: "Revenue", amount: "1000000.0000", pctOfRevenue: "1.0000", kind: "start" }],
      segments: { department: [], class: [], location: [] },
      drivers: { revenue: [], cost: [] },
      items: { rows: [], gainers: [], decliners: [], totalCurrent: "0.0000", totalChange: "0.0000" },
      insights: [],
      budget: { scenario: null, rows: [], totals: { budget: "0.0000", actual: "0.0000", variance: "0.0000" }, tolerance: { onTrack: 10, watch: 25 } },
    } as never} />,
  );
  assert.match(text, /Revenue Trend/);
  assert.match(text, /Performance Trend/);
  assert.match(text, /40%/);
});

test("segments read configured HHI bands and translate every band", async () => {
  const seg = (id: string, revenue: string) => ({
    id, name: id, revenue, cogs: "0.0000", grossProfit: revenue, grossMarginPct: 0.5,
    opex: "0.0000", operatingIncome: revenue, operatingMarginPct: 0.5, priorRevenue: "0.0000", yoyPct: null, health: "good" as const, sharePct: 0.2,
  });
  const text = await mount(
    <SegmentsTab data={{
      figures, ratios, bands,
      monthly: [], pnlSummary: [], marginFlow: [],
      segments: { department: ["a", "b", "c", "d", "e"].map((id) => seg(id, "200000.0000")), class: [], location: [] },
      drivers: { revenue: [], cost: [] },
      items: { rows: [], gainers: [], decliners: [], totalCurrent: "0.0000", totalChange: "0.0000" },
      insights: [],
      budget: { scenario: null, rows: [], totals: { budget: "0.0000", actual: "0.0000", variance: "0.0000" }, tolerance: { onTrack: 10, watch: 25 } },
    } as never} />,
  );
  // Five equal shares price HHI 2000: inside the configured 1500/2500 band.
  assert.match(text, /Segment Performance/);
  assert.match(text, /HHI 2000/);
  assert.match(text, /Moderate/);
  assert.match(text, /By Department/);
});

test("drivers render both tables in the reader's language", async () => {
  const row = (name: string) => ({ id: `a-${name}`, name, current: "100000.0000", change: "10000.0000", changePct: 0.1, contribution: 0.5 });
  const text = await mount(
    <DriversTab onDrill={() => {}} data={{
      figures, ratios, bands,
      monthly: [], pnlSummary: [], marginFlow: [],
      segments: { department: [], class: [], location: [] },
      drivers: { revenue: [row("Services")], cost: [row("Salaries")] },
      items: { rows: [], gainers: [], decliners: [], totalCurrent: "0.0000", totalChange: "0.0000" },
      insights: [],
      budget: { scenario: null, rows: [], totals: { budget: "0.0000", actual: "0.0000", variance: "0.0000" }, tolerance: { onTrack: 10, watch: 25 } },
    } as never} />,
  );
  assert.match(text, /Revenue Drivers/);
  assert.match(text, /Cost Drivers/);
  assert.match(text, /Services/);
});

test("items render the detail table in the reader's language", async () => {
  const row = (id: string) => ({ id, name: id, current: "50000.0000", change: "5000.0000", changePct: 0.1, contribution: 0.25 });
  const text = await mount(
    <ItemsTab onDrill={() => {}} data={{
      figures, ratios, bands,
      monthly: [], pnlSummary: [], marginFlow: [],
      segments: { department: [], class: [], location: [] },
      drivers: { revenue: [], cost: [] },
      items: { rows: [row("Sales")], gainers: [row("Sales")], decliners: [], totalCurrent: "50000.0000", totalChange: "5000.0000" },
      insights: [],
      budget: { scenario: null, rows: [], totals: { budget: "0.0000", actual: "0.0000", variance: "0.0000" }, tolerance: { onTrack: 10, watch: 25 } },
    } as never} />,
  );
  assert.match(text, /Account Detail/);
  assert.match(text, /Largest Gainer/);
});

test("clicking a driver row drills into its account", async () => {
  // The drill prop the dashboard shell passes must reach the ledger account:
  // a row click carries the row's account id and name, never a bare label.
  globalThis.__smRouter = { push() {}, refresh() {} };
  const seen: Array<{ id: string; name: string }> = [];
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  try {
    await act(async () => {
      root.render(
        <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
          <MoneyProvider currency="USD">
            <DriversTab onDrill={(id, name) => seen.push({ id, name })} data={{
              figures, ratios, bands,
              monthly: [], pnlSummary: [], marginFlow: [],
              segments: { department: [], class: [], location: [] },
              drivers: {
                revenue: [{ id: "a-services", name: "Services", current: "100000.0000", change: "10000.0000", changePct: 0.1, contribution: 0.5 }],
                cost: [],
              },
              items: { rows: [], gainers: [], decliners: [], totalCurrent: "0.0000", totalChange: "0.0000" },
              insights: [],
              budget: { scenario: null, rows: [], totals: { budget: "0.0000", actual: "0.0000", variance: "0.0000" }, tolerance: { onTrack: 10, watch: 25 } },
            } as never} />
          </MoneyProvider>
        </NextIntlClientProvider>,
      );
      await tick();
    });
    await tick();
    const row = [...host.querySelectorAll("tbody tr")].find((tr) => tr.textContent?.includes("Services"));
    assert.ok(row, "the driver row renders");
    await act(async () => {
      row.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
      await tick();
    });
    assert.deepEqual(seen, [{ id: "a-services", name: "Services" }]);
  } finally {
    await act(async () => {
      root.unmount();
    });
    host.remove();
  }
});
