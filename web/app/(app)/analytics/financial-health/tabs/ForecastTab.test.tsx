import assert from "node:assert/strict";
import test from "node:test";

// The financial-health Forecast tab must attach an explicit, user-readable
// caveat wherever a nonnegative metric's projection leaves its domain —
// chart, detail table, and projected growth — naming the model and why, so a
// reader cannot mistake the historical gauge for an endorsement of the
// projection. Drives the real tab in jsdom on a declining revenue series
// (the chart itself is stubbed: ECharts needs no canvas for this).

const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", {
  url: "http://localhost:4800/analytics/financial-health",
});
const globals = globalThis as Record<string, unknown>;
const domWindow = dom.window as unknown as Record<string, unknown>;
for (const key of ["window", "document", "navigator", "Node", "Element", "HTMLElement", "Event", "self"]) {
  if (globals[key] === undefined) globals[key] = domWindow[key];
}
if (typeof window.matchMedia !== "function") {
  window.matchMedia = (() => ({
    matches: false,
    media: "",
    addEventListener() {},
    removeEventListener() {},
  })) as typeof window.matchMedia;
}

const { registerHooks } = await import("node:module");
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "next/navigation") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export function useRouter(){return globalThis.__fcRouter}export function usePathname(){return '/analytics/financial-health'}export function useSearchParams(){return new URLSearchParams()}",
      };
    }
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

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
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
function decliningData(): Record<string, unknown> {
  const revenues = [4_000_000, 3_300_000, 2_600_000, 1_900_000, 1_200_000, 500_000];
  return {
    monthly: revenues.map((revenue, i) => ({
      month: `2026-0${i + 1}`,
      label: `M${i + 1}`,
      revenue,
      cogs: 0,
      grossProfit: revenue,
      grossMarginPct: 100,
      opex: 0,
      operatingIncome: revenue,
      operatingMarginPct: 100,
      netIncome: revenue,
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

test("an in-domain projection shows no caveat", async () => {
  globalThis.__fcRouter = { push() {}, refresh() {} };
  const data = decliningData();
  (data.monthly as { revenue: number }[]).forEach((m) => {
    m.revenue = 1_000_000;
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
