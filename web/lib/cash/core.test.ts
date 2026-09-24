import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { spawnSync } from "node:child_process";
import test from "node:test";

const navigation = { replacements: [] as string[] };
(globalThis as Record<string, unknown>).__cashHorizonNavigation = navigation;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "next/navigation") {
      const code = `
        export const useRouter = () => ({ replace: (url) => globalThis.__cashHorizonNavigation.replacements.push(url) });
        export const usePathname = () => "/analytics/cashflow";
        export const useSearchParams = () => new URLSearchParams("sub=sub-1");
      `;
      return { shortCircuit: true, format: "module", url: `data:text/javascript,${encodeURIComponent(code)}` };
    }
    return nextResolve(specifier, context);
  },
});

// House render guard: classic JSX transforms and shared tsx caches need React
// on globalThis before the client control module is evaluated.
const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost:4800/analytics/cashflow" });
const browser = dom.window as unknown as Record<string, unknown>;
for (const key of ["window", "document", "navigator", "Node", "Element", "HTMLElement", "HTMLSelectElement", "Event", "self"]) {
  if ((globalThis as Record<string, unknown>)[key] === undefined) {
    (globalThis as Record<string, unknown>)[key] = browser[key];
  }
}
;(globalThis as Record<string, unknown>).Event = browser.Event
if (!(dom.window as unknown as { matchMedia?: unknown }).matchMedia) {
  (dom.window as unknown as { matchMedia: (query: string) => MediaQueryList }).matchMedia = (query) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() { return true; },
  } as unknown as MediaQueryList);
}
;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
const React = await import("react");
Object.assign(globalThis, { React });
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { NextIntlClientProvider } = await import("next-intl");
const { HorizonControl } = await import("../../app/(app)/analytics/cashflow/HorizonControl.tsx");
const horizonMessages = {
  analytics: { cashflow: { horizon: { label: "Horizon", aria: "Forecast horizon", weeks: "{count} weeks" } } },
  common: { labels: { none: "None" }, actions: { close: "Close", select: "Select" } },
  ui: { select: { placeholder: "Select", searchPlaceholder: "Search", noMatches: "No matches", searching: "Searching" } },
};

test("formula TAX_RATE resolves each org default and fails closed", () => {
  // core.ts is server-only in production, so run the behavior check under
  // React's server condition (the same pattern used by other web tests).
  const source = `
    import assert from "node:assert/strict";
    import { resolveFormulaTaxRate } from "./web/lib/cash/core.ts";

    const fixtures = new Map([
      ["org-gst", { defaultRatePercent: "5", updatedAt: "2026-08-01" }],
      ["org-bc", { defaultRatePercent: "12", updatedAt: "2026-08-01" }],
      ["org-malformed", { defaultRatePercent: "not-a-rate", updatedAt: "2026-08-01" }],
      ["org-negative", { defaultRatePercent: "-1", updatedAt: "2026-08-01" }],
      ["org-revision", { defaultRatePercent: "9", updatedAt: "2026-08-01" }],
    ]);
    const queries = [];
    const runner = {
      async execute(query) {
        const chunks = Array.isArray(query.queryChunks) ? query.queryChunks : [];
        const params = chunks.filter((chunk) => typeof chunk === "string");
        const [orgId, asOfIso] = params;
        const queryText = chunks.map((chunk) => {
          if (typeof chunk === "string") return chunk;
          return Array.isArray(chunk?.value) ? chunk.value.join("") : "";
        }).join("");
        assert.match(queryText, /from tax_rate_provider_configs/);
        assert.match(queryText, /org_id =/);
        assert.match(queryText, /provider = 'manual'/);
        assert.match(queryText, /is_enabled/);
        assert.match(queryText, /updated_at </);
        queries.push(queryText);

        const fixture = fixtures.get(orgId);
        if (!fixture || asOfIso < fixture.updatedAt) return { rows: [] };
        return { rows: [{ defaultRatePercent: fixture.defaultRatePercent }] };
      },
    };

    const gstRate = await resolveFormulaTaxRate("org-gst", "2026-08-31", runner);
    const bcRate = await resolveFormulaTaxRate("org-bc", "2026-08-31", runner);
    assert.equal(gstRate, 0.05);
    assert.equal(bcRate, 0.12);
    assert.notEqual(gstRate, 0);
    assert.notEqual(bcRate, 0.13);
    assert.match(queries[0], /org_id = org-gst/);
    assert.match(queries[1], /org_id = org-bc/);

    await assert.rejects(
      resolveFormulaTaxRate("org-missing", "2026-08-31", runner),
      /requires an enabled manual tax-rate provider with settings\\.defaultRatePercent/,
    );
    await assert.rejects(
      resolveFormulaTaxRate("org-malformed", "2026-08-31", runner),
      /has an invalid settings\\.defaultRatePercent/,
    );
    await assert.rejects(
      resolveFormulaTaxRate("org-negative", "2026-08-31", runner),
      /has an invalid settings\\.defaultRatePercent/,
    );

    // A revision made after the forecast date is not usable historically;
    // the engine must fail closed instead of applying a stale or default rate.
    assert.equal(await resolveFormulaTaxRate("org-revision", "2026-08-01", runner), 0.09);
    await assert.rejects(
      resolveFormulaTaxRate("org-revision", "2026-07-31", runner),
      /requires an enabled manual tax-rate provider with settings\\.defaultRatePercent/,
    );
    console.log("cash TAX_RATE behavior passed: org-gst=5%, org-bc=12%; missing, malformed, negative, and pre-revision bindings fail closed");
  `;
  const result = spawnSync(
    process.execPath,
    ["--conditions=react-server", "--import", "tsx", "--input-type=module", "-e", source],
    { cwd: process.cwd(), env: process.env, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("a malformed forecast formula refuses by name instead of forecasting zero", () => {
  // The formula_expression strategy used to answer 0 for every week a
  // malformed tenant formula threw — a forecast that reads "no cash
  // expected", indistinguishable from correctly nil, which is exactly the
  // silent-zero class. Run under React's server condition like the other
  // core behavior checks; the money formatter is stubbed at the module edge
  // (display-only), while the formula evaluator under test is the real one.
  const source = `
    import assert from "node:assert/strict";
    import { registerHooks } from "node:module";
    registerHooks({
      resolve(specifier, context, nextResolve) {
        if (specifier === "../money-server") return { url: "data:text/javascript,export async function getMoneyFormatter() { return { money: String, moneyCompact: String } }", shortCircuit: true };
        return nextResolve(specifier, context);
      },
    });
    const { categoryWeekly } = await import("./web/lib/cash/core.ts");
    const weeks = ["2026-09-07"];
    const context = { arWeekly: {}, apWeekly: {}, cashStart: "0" };
    try {
      await categoryWeekly("org-1", { id: "cat-broken", name: "Broken", method: "formula_expression", formula: "{AR_IN} + not-a-token(", amount: "0", enabled: true }, "2026-09-01", weeks, context);
      assert.fail("a malformed formula must refuse, never forecast");
    } catch (e) {
      assert.match(String(e), /cash forecast formula .* failed for the week of 2026-09-07/);
    }
    console.log("malformed formula refusal passed");
  `;
  const result = spawnSync(
    process.execPath,
    ["--conditions=react-server", "--import", "tsx", "--input-type=module", "-e", source],
    { cwd: process.cwd(), env: process.env, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("cash forecast aging places the 90th overdue day in 90+", () => {
  const source = `
    import assert from "node:assert/strict";
    import { bucketOf } from "./web/lib/cash/core.ts";

    assert.equal(bucketOf(89), "61-90");
    assert.equal(bucketOf(90), "90+");
    assert.equal(bucketOf(91), "90+");
    console.log("cash aging boundary passed: day 89 is 61-90; day 90 begins 90+");
  `;
  const result = spawnSync(
    process.execPath,
    ["--conditions=react-server", "--import", "tsx", "--input-type=module", "-e", source],
    { cwd: process.cwd(), env: process.env, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("horizon normalizer accepts the cap range and fails closed to the fallback", () => {
  // core.ts is server-only in production, so run the behavior check under
  // React's server condition (the same pattern used by other web tests).
  const source = `
    import assert from "node:assert/strict";
    import { CASH_HORIZON_PRESETS, MAX_CASH_HORIZON_WEEKS, normalizeCashHorizonWeeks } from "./web/lib/cash/core.ts";

    assert.deepEqual([...CASH_HORIZON_PRESETS], [4, 8, 13, 26]);
    assert.equal(MAX_CASH_HORIZON_WEEKS, 26);
    assert.equal(normalizeCashHorizonWeeks(13, 8), 13);
    assert.equal(normalizeCashHorizonWeeks(26, 8), 26);
    assert.equal(normalizeCashHorizonWeeks("13", 8), 13);
    assert.equal(normalizeCashHorizonWeeks(12, 8), 12);
    assert.equal(normalizeCashHorizonWeeks(27, 8), 8);
    assert.equal(normalizeCashHorizonWeeks(0, 8), 8);
    assert.equal(normalizeCashHorizonWeeks("soon", 4), 4);
    assert.equal(normalizeCashHorizonWeeks(undefined, 4), 4);
    console.log("cash horizon behavior passed: presets inside the cap, out-of-range and garbage fall back");
  `;
  const result = spawnSync(
    process.execPath,
    ["--conditions=react-server", "--import", "tsx", "--input-type=module", "-e", source],
    { cwd: process.cwd(), env: process.env, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("cashflow horizon control offers shared presets and preserves other query filters", async () => {
  document.body.innerHTML = "";
  navigation.replacements.length = 0;
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  try {
    await act(async () => {
      const providerProps = {
        locale: "en",
        messages: horizonMessages,
        timeZone: "UTC",
        children: React.createElement(HorizonControl, { value: 8 }),
      };
      root.render(React.createElement(NextIntlClientProvider, providerProps));
    });
    const trigger = document.querySelector<HTMLButtonElement>('button[aria-label="Forecast horizon"]');
    assert.ok(trigger, "cashflow exposes its forecast horizon selector");
    assert.deepEqual([...document.querySelectorAll('[role="option"]')].map((option) => option.textContent), []);
    await act(async () => {
      trigger.click();
    });
    assert.deepEqual([...document.querySelectorAll('[role="option"]')].map((option) => option.textContent), [
      "4 weeks", "8 weeks", "13 weeks", "26 weeks",
    ]);
    const thirteenWeeks = [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')]
      .find((option) => option.textContent === "13 weeks");
    assert.ok(thirteenWeeks, "the supported 13-week standard horizon is selectable");
    await act(async () => thirteenWeeks.click());
    assert.deepEqual(navigation.replacements, ["/analytics/cashflow?sub=sub-1&horizon=13"]);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    dom.window.close();
  }
});

test("week labels localize month names (F-t04-010)", () => {
  // core.ts is server-only in production, so run the behavior check under
  // React's server condition (the same pattern used by other web tests).
  const source = `
    import assert from "node:assert/strict";
    import { weekLabel } from "./web/lib/cash/core.ts";

    const d = new Date("2026-09-07T00:00:00Z");
    assert.equal(weekLabel(d), "Sep 7");
    assert.equal(weekLabel(d, "en-US"), "Sep 7");
    assert.match(weekLabel(d, "fr"), /sept/i);
    assert.match(weekLabel(d, "es"), /sept/i);
    console.log("cash weekLabel locale behavior passed");
  `;
  const result = spawnSync(
    process.execPath,
    ["--conditions=react-server", "--import", "tsx", "--input-type=module", "-e", source],
    { cwd: process.cwd(), env: process.env, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
