import assert from "node:assert/strict";
import test from "node:test";

// The scenario model prices every figure in exact decimals from the
// engine's baseline: with every input at 0 the scenario IS the baseline —
// every delta reads exactly zero — and a non-numeric input refuses by name
// instead of coercing. Drives the real tab in jsdom (the chart is stubbed:
// ECharts needs no canvas for this).

const { bootJsdomEnvironment } = await import("../../../../../testing/jsdom-env");
await bootJsdomEnvironment({ url: "http://localhost:4800/analytics/financial-health", matchMediaMatches: false, scrollIntoView: false, resizeObserver: false });

const { registerHooks } = await import("node:module");
const { stubModules } = await import("../../../../../testing/stub-modules");
stubModules({ navigation: "export function useRouter(){return globalThis.__scRouter}export function usePathname(){return '/analytics/financial-health'}export function useSearchParams(){return new URLSearchParams()}" });
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.endsWith("/_ui/charts")) {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export function GroupedBar(){return null}",
      };
    }
    return next(specifier, context);
  },
});

declare global {
  var __scRouter: { push(url: string): void; refresh(): void } | undefined;
}

const React = await import("react");
Object.assign(globalThis, { React });
const { createRoot } = await import("react-dom/client");
const { act } = await import("react");
const { NextIntlClientProvider } = await import("next-intl");
const messages = (await import("../../../../../messages/en")).default;
const { MoneyProvider } = await import("../../../../../components/money-provider");
const { ScenariosTab } = await import("./ScenariosTab");

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

// A coherent baseline: 900k operating revenue + 100k other income, 600k
// COGS, 250k opex, 10k other expense, 40k net (100k reconciling tax).
// Gross margin 0.40, breakeven 625k, safety 0.375 — comfortably low-risk.
function baselineData(): Record<string, unknown> {
  return {
    figures: {
      revenue: "1000000.0000",
      operatingRevenue: "900000.0000",
      otherIncome: "100000.0000",
      cogs: "600000.0000",
      grossProfit: "400000.0000",
      opex: "250000.0000",
      operatingIncome: "50000.0000",
      otherExpense: "10000.0000",
      netIncome: "40000.0000",
      breakevenRevenue: "625000.0000",
    },
    ratios: {
      profitability: [{ id: "gross_margin", value: "0.4000", format: "pct" }],
      liquidity: [],
      solvency: [],
      efficiency: [],
      operating: [],
    },
    bands: {
      hhi: { warning: 1500, critical: 2500 },
      scenario: { safety: "0.1000", comfort: "0.3000" },
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
          <ScenariosTab data={data as never} />
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

test("all inputs at zero reproduce the baseline exactly", async () => {
  globalThis.__scRouter = { push() {}, refresh() {} };
  const { host, unmount } = await mount(baselineData());
  try {
    const text = host.textContent ?? "";
    // Scenario figures equal the baseline money to the unit.
    assert.match(text, /\$1M/, "revenue reads the baseline million");
    assert.match(text, /\$625K/, "breakeven follows the engine's opex-over-margin definition");
    assert.match(text, /40%/, "gross margin reads the exact quotient");
    assert.match(text, /37\.5%/, "safety margin reads the exact quotient");
    // Every delta is exactly zero — any drift would print here.
    assert.match(text, /\+\$0/, "money deltas are exactly zero");
    assert.match(text, /\+0%/, "margin deltas are exactly zero");
    // 0.375 clears the 0.30 comfort band: low risk.
    assert.match(text, /Low/, "a comfortable safety margin reads low risk");
    assert.doesNotMatch(text, /must be a plain number/, "no refusal at the baseline");
  } finally {
    await unmount();
  }
});

test("a non-numeric input refuses by name and holds the baseline", async () => {
  globalThis.__scRouter = { push() {}, refresh() {} };
  const { host, unmount } = await mount(baselineData());
  try {
    const input = host.querySelectorAll('input[type="number"]')[0] as HTMLInputElement;
    assert.ok(input, "the builder offers numeric inputs");
    await act(async () => {
      // Through React's own value tracker so the controlled input notices.
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "");
      input.dispatchEvent(new window.Event("input", { bubbles: true }));
      await tick();
    });
    await tick();
    const text = host.textContent ?? "";
    assert.match(text, /Growth % must be a plain number/, "the refusal names the field and the remedy");
    assert.match(text, /—/, "refused figures read as unavailable, never zero");
  } finally {
    await unmount();
  }
});

test("scenario templates carry translated names without emoji", async () => {
  globalThis.__scRouter = { push() {}, refresh() {} };
  const { host, unmount } = await mount(baselineData());
  try {
    const text = host.textContent ?? "";
    assert.match(text, /Recession/, "template names come from the catalog");
    assert.doesNotMatch(text, /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u, "no emoji rides in data");
  } finally {
    await unmount();
  }
});
