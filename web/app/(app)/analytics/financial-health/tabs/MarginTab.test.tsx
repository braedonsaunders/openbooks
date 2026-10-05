import assert from "node:assert/strict";
import test from "node:test";

// The margin bridge splits gross-margin movement into volume and rate
// effects in exact decimals from the engine's ratios — never revenue || 1.
// It reconciles prior to current exactly, or names its residual; without
// prior revenue it refuses with its reason instead of dividing by a
// stand-in. Drives the real tab in jsdom (charts stubbed).

const { bootJsdomEnvironment } = await import("../../../../../testing/jsdom-env");
await bootJsdomEnvironment({ url: "http://localhost:4800/analytics/financial-health", matchMediaMatches: false, scrollIntoView: false, resizeObserver: false });

const { registerHooks } = await import("node:module");
const { stubModules } = await import("../../../../../testing/stub-modules");
stubModules({ navigation: "export function useRouter(){return globalThis.__mgRouter}export function usePathname(){return '/analytics/financial-health'}export function useSearchParams(){return new URLSearchParams()}" });
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.endsWith("/_ui/charts")) {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export function Waterfall(){return null}export function TrendChart(){return null}export function Donut(){return null}",
      };
    }
    return next(specifier, context);
  },
});

declare global {
  var __mgRouter: { push(url: string): void; refresh(): void } | undefined;
}

const React = await import("react");
Object.assign(globalThis, { React });
const { createRoot } = await import("react-dom/client");
const { act } = await import("react");
const { NextIntlClientProvider } = await import("next-intl");
const messages = (await import("../../../../../messages/en")).default;
const { MoneyProvider } = await import("../../../../../components/money-provider");
const { MarginTab, buildMarginBridge } = await import("./MarginTab");

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

function marginData(priorRevenue: string, priorGP: string): Record<string, unknown> {
  return {
    figures: {
      revenue: "1000000.0000",
      cogs: "600000.0000",
      grossProfit: "400000.0000",
      opex: "250000.0000",
      operatingIncome: "150000.0000",
      otherExpense: "10000.0000",
      netIncome: "140000.0000",
    },
    ratios: {
      profitability: [],
      liquidity: [],
      solvency: [],
      efficiency: [],
      operating: [],
    },
    pnlSummary: [
      { key: "revenue", label: "Revenue", current: "1000000.0000", prior: priorRevenue, change: "200000.0000", changePct: "0.2500", strong: true },
      { key: "grossProfit", label: "Gross Profit", current: "400000.0000", prior: priorGP, change: "80000.0000", changePct: "0.2500", strong: true },
    ],
    marginFlow: [
      { key: "revenue", label: "Revenue", amount: "1000000.0000", pctOfRevenue: "1.0000", kind: "start" },
      { key: "netIncome", label: "Net Income", amount: "140000.0000", pctOfRevenue: "0.1400", kind: "total" },
    ],
    monthly: [],
  };
}

function withRatios(data: Record<string, unknown>): Record<string, unknown> {
  return {
    ...data,
    ratios: {
      profitability: [],
      liquidity: [],
      solvency: [],
      efficiency: [],
      operating: [
        { id: "gross_margin", value: "0.4000", format: "pct" },
        { id: "operating_margin", value: "0.1500", format: "pct" },
        { id: "net_margin", value: "0.1400", format: "pct" },
        { id: "cogs_ratio", value: "0.6000", format: "pct" },
      ],
    },
  };
}

async function mount(data: Record<string, unknown>) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <MoneyProvider currency="USD">
          <MarginTab data={data as never} />
        </MoneyProvider>
      </NextIntlClientProvider>,
    );
    await tick();
  });
  await tick();
  return {
    host,
    unmount: async () => {
      await act(async () => {
        root.unmount();
      });
      host.remove();
    },
  };
}

test("the bridge reconciles in exact decimals, or names its residual", () => {
  // Prior 800k at 40% GM, current 1M at 40%: volume 80k, rate 0, no residual.
  const exact = buildMarginBridge(
    { revenue: "1000000.0000", grossProfit: "400000.0000" },
    { revenue: "800000.0000", grossProfit: "320000.0000" },
    "0.4000",
  );
  assert.equal(exact?.priorGm, "0.4000");
  assert.equal(exact?.volumeEffect, "80000.0000");
  assert.equal(exact?.rateEffect, "0.0000");
  assert.equal(exact?.residual, "0.0000");
  // Sub-unit rounding dust does not vanish: it is reported by name.
  const dusty = buildMarginBridge(
    { revenue: "100000.0000", grossProfit: "33333.3334" },
    { revenue: "100000.0000", grossProfit: "33333.3333" },
    "0.3333",
  );
  assert.equal(dusty?.residual, "0.0001");
  // No prior revenue, no prior margin, no current margin: no bridge.
  assert.equal(buildMarginBridge({ revenue: "1000000.0000", grossProfit: "400000.0000" }, { revenue: "0.0000", grossProfit: "0.0000" }, "0.4000"), null);
  assert.equal(buildMarginBridge({ revenue: "1000000.0000", grossProfit: "400000.0000" }, null, "0.4000"), null);
  assert.equal(buildMarginBridge({ revenue: "1000000.0000", grossProfit: "400000.0000" }, { revenue: "800000.0000", grossProfit: "320000.0000" }, null), null);
});

test("KPIs read the engine ratios and the bridge carries exact margins", async () => {
  globalThis.__mgRouter = { push() {}, refresh() {} };
  const { host, unmount } = await mount(withRatios(marginData("800000.0000", "320000.0000")));
  try {
    const text = host.textContent ?? "";
    assert.match(text, /40%/, "gross margin reads the engine ratio, never revenue || 1");
    assert.match(text, /15%/, "operating margin reads the engine ratio");
    assert.match(text, /60%/, "the COGS ratio reads the engine ratio");
    assert.match(text, /\(40% → 40%\)/, "the bridge hint carries the exact prior and current margins");
    assert.doesNotMatch(text, /split volume and rate effects/, "an exact bridge shows no refusal");
  } finally {
    await unmount();
  }
});

test("no prior revenue refuses the bridge instead of dividing by a stand-in", async () => {
  globalThis.__mgRouter = { push() {}, refresh() {} };
  const { host, unmount } = await mount(withRatios(marginData("0.0000", "0.0000")));
  try {
    const text = host.textContent ?? "";
    assert.match(text, /split volume and rate effects/, "the refusal names what is missing");
    assert.doesNotMatch(text, /Volume Effect/, "no bridge fabricates effects without a prior margin");
  } finally {
    await unmount();
  }
});
