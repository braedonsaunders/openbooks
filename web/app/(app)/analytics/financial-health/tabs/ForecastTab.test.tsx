import assert from "node:assert/strict";
import test from "node:test";

// The financial-health Forecast tab must attach an explicit, user-readable
// caveat wherever a nonnegative metric's projection leaves its domain —
// chart, detail table, and projected growth — naming the model and why, so a
// reader cannot mistake the historical gauge for an endorsement of the
// projection. Drives the real tab in jsdom on a declining revenue series
// (the chart itself is stubbed: ECharts needs no canvas for this).

const { bootJsdomEnvironment } = await import("../../../../../testing/jsdom-env");
await bootJsdomEnvironment({ url: "http://localhost:4800/analytics/financial-health", matchMediaMatches: false, scrollIntoView: false, resizeObserver: false });

const { registerHooks } = await import("node:module");
const { stubModules } = await import("../../../../../testing/stub-modules");
stubModules({ navigation: "export function useRouter(){return globalThis.__fcRouter}export function usePathname(){return '/analytics/financial-health'}export function useSearchParams(){return new URLSearchParams()}" });
registerHooks({
  resolve(specifier, context, next) {

    if (specifier.endsWith("/_ui/charts")) {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export function ForecastChart(){return null}",
      };
    }
    return next(specifier, context);
  },
});

declare global {
  var __fcRouter: { push(url: string): void; refresh(): void } | undefined;
}

const React = await import("react");
Object.assign(globalThis, { React });
const { createRoot } = await import("react-dom/client");
const { act } = await import("react");
const { NextIntlClientProvider } = await import("next-intl");
const messages = (await import("../../../../../messages/en")).default;
const { MoneyProvider } = await import("../../../../../components/money-provider");
const { ForecastTab } = await import("./ForecastTab");

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

// Six months of revenue falling ~0.7M a month: default ETS carries the
// decline through zero inside the 6-month horizon.
function forecastParams(): Record<string, unknown> {
  return {
    periodsPerYear: 12,
    defaultMethod: 'ets',
    methods: ['ets', 'ets_damped', 'linear', 'seasonal', 'moving_avg', 'arima'],
    defaultHorizon: 6,
    defaultConfidence: 90,
    defaultSeasonality: 'auto',
    seasonalities: ['auto', 'none', 'monthly', 'quarterly'],
    horizons: [3, 6, 12, 24],
    confidences: [80, 90, 95, 99],
    adjustments: [
      { code: 'neg10', value: -0.1 },
      { code: 'neg05', value: -0.05 },
      { code: 'zero', value: 0 },
      { code: 'pos05', value: 0.05 },
      { code: 'pos10', value: 0.1 },
    ],
    defaultAdjustment: 'zero',
    model: { alpha: 0.3, beta: 0.1, gamma: 0.2, dampedPhi: 0.9, ma1: 0.3, minCorrelation: 0.3, minPeriods: 24 },
  };
}

function decliningData(): Record<string, unknown> {
  const revenues = [4_000_000, 3_300_000, 2_600_000, 1_900_000, 1_200_000, 500_000];
  return {
    forecast: forecastParams(),
    monthly: revenues.map((revenue, i) => ({
      month: `2026-0${i + 1}`,
      label: `M${i + 1}`,
      revenue: String(revenue),
      cogs: '0',
      grossProfit: String(revenue),
      grossMarginPct: 100,
      opex: '0',
      operatingIncome: String(revenue),
      operatingMarginPct: 100,
      netIncome: String(revenue),
    })),
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
          <ForecastTab data={data as never} />
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

test("an out-of-domain revenue projection carries the caveat on chart, table, and growth", async () => {
  globalThis.__fcRouter = { push() {}, refresh() {} };
  const { host, unmount } = await mount(decliningData());
  try {
    const text = host.textContent ?? "";
    // Chart banner: names the model and why, with the first breach month.
    assert.match(text, /Projection leaves the metric's range/);
    assert.match(text, /ETS/);
    assert.match(text, /carries the recent decline forward/);
    // Detail table: breached months are marked, with the footnote.
    assert.match(text, /⚠/);
    assert.match(text, /outside the range this metric can take/);
    // Projected growth is not a plain number: it carries the star and note.
    assert.match(text, /% \*/);
    assert.match(text, /outside.*range.*see the caveat above/);
  } finally {
    await unmount();
  }
});

test("an unknown confidence level refuses with the valid levels", async () => {
  globalThis.__fcRouter = { push() {}, refresh() {} };
  const data = decliningData();
  (data.forecast as { defaultConfidence: number }).defaultConfidence = 97;
  const { host, unmount } = await mount(data);
  try {
    const text = host.textContent ?? "";
    // Names the offending level and the levels that would work — never a
    // band printed under a false name.
    assert.match(text, /Unknown Confidence/);
    assert.match(text, /97/);
    assert.match(text, /80%, 90%, 95%, 99%/);
    assert.doesNotMatch(text, /Projected Growth/);
  } finally {
    await unmount();
  }
});

test("a confidence the model cannot band renders the refusal, not the empty state", async () => {
  globalThis.__fcRouter = { push() {}, refresh() {} };
  const data = decliningData();
  // The offered list names 97, so the invalid-input branch passes and the
  // model itself throws: the tab must render that refusal by name instead
  // of falling through to "not enough history".
  (data.forecast as { confidences: number[] }).confidences = [97];
  (data.forecast as { defaultConfidence: number }).defaultConfidence = 97;
  const { host, unmount } = await mount(data);
  try {
    const text = host.textContent ?? "";
    assert.match(text, /Unknown Confidence/);
    assert.match(text, /97/);
    assert.doesNotMatch(text, /Not enough history/);
    assert.doesNotMatch(text, /Projected Growth/);
  } finally {
    await unmount();
  }
});

test("a non-monthly calendar without future periods refuses by name", async () => {
  globalThis.__fcRouter = { push() {}, refresh() {} };
  const data = decliningData();
  (data.forecast as { futurePeriodNames: string[] }).futurePeriodNames = [];
  const { host, unmount } = await mount(data);
  try {
    const text = host.textContent ?? "";
    // Names the missing declaration and where to fix it — never
    // month-stepped buckets the calendar cannot reconcile.
    assert.match(text, /no future periods/);
    assert.match(text, /Declare periods/);
    assert.doesNotMatch(text, /Projected Growth/);
  } finally {
    await unmount();
  }
});

test("short future periods keep Settings with only fitting horizons", async () => {
  globalThis.__fcRouter = { push() {}, refresh() {} };
  const data = decliningData();
  // Four declared names against the default 6-period horizon: the chart
  // refuses by name, but Settings stay so the operator can pick 3 instead
  // of only declaring more periods.
  (data.forecast as { futurePeriodNames: string[] }).futurePeriodNames =
    ["Q3 FY26", "Q4 FY26", "Q1 FY27", "Q2 FY27"];
  const { host, unmount } = await mount(data);
  try {
    const text = host.textContent ?? "";
    assert.match(text, /only 4 future periods/);
    assert.match(text, /at most 4 periods in Forecast Settings/);
    assert.match(text, /Forecast Settings/);
    assert.match(text, /Declare periods/);
    assert.doesNotMatch(text, /Projected Growth/);
    // The second native select is the horizon: only covered horizons stay.
    const horizon = host.querySelectorAll("select")[1];
    assert.deepEqual([...(horizon?.querySelectorAll("option") ?? [])].map((o) => o.value), ["3"]);
  } finally {
    await unmount();
  }
});

test("declared future period names label the buckets", async () => {
  globalThis.__fcRouter = { push() {}, refresh() {} };
  const data = decliningData();
  (data.forecast as { futurePeriodNames: string[] }).futurePeriodNames =
    ["Q3 FY26", "Q4 FY26", "Q1 FY27", "Q2 FY27", "Q3 FY27", "Q4 FY27"];
  const { host, unmount } = await mount(data);
  try {
    const text = host.textContent ?? "";
    assert.match(text, /Q3 FY26/);
    assert.match(text, /Q4 FY26/);
  } finally {
    await unmount();
  }
});

test("quiet trailing periods keep the end-anchored bucket names", async () => {
  globalThis.__fcRouter = { push() {}, refresh() {} };
  // Activity stops after March but the window ends in June: bucket 1 is
  // July, not the April the last active month would step to.
  const data = decliningData();
  (data.monthly as { revenue: string; grossProfit: string; operatingIncome: string; netIncome: string }[]).forEach((m, i) => {
    const revenue = i < 3 ? '1000000' : '0';
    m.revenue = revenue;
    m.grossProfit = revenue;
    m.operatingIncome = revenue;
    m.netIncome = revenue;
  });
  const { host, unmount } = await mount(data);
  try {
    const firstCell = host.querySelector("tbody tr td");
    assert.equal(firstCell?.textContent, "Jul '26");
  } finally {
    await unmount();
  }
});

test("a window with fewer than 3 active periods refuses instead of modelling", async () => {
  globalThis.__fcRouter = { push() {}, refresh() {} };
  // Two active months of six: smoothing zeros is not a forecast.
  const data = decliningData();
  (data.monthly as { revenue: string; grossProfit: string; operatingIncome: string; netIncome: string }[]).forEach((m, i) => {
    const revenue = i < 2 ? '1000000' : '0';
    m.revenue = revenue;
    m.grossProfit = revenue;
    m.operatingIncome = revenue;
    m.netIncome = revenue;
  });
  const { host, unmount } = await mount(data);
  try {
    const text = host.textContent ?? "";
    assert.match(text, /Not enough history/);
    assert.doesNotMatch(text, /Projected Growth/);
  } finally {
    await unmount();
  }
});

test("an in-domain projection shows no caveat", async () => {
  globalThis.__fcRouter = { push() {}, refresh() {} };
  const data = decliningData();
  (data.monthly as { revenue: string }[]).forEach((m) => {
    m.revenue = '1000000';
  });
  const { host, unmount } = await mount(data);
  try {
    const text = host.textContent ?? "";
    assert.doesNotMatch(text, /Projection leaves the metric's range/);
    assert.doesNotMatch(text, /⚠/);
    assert.doesNotMatch(text, /% \*/);
  } finally {
    await unmount();
  }
});
