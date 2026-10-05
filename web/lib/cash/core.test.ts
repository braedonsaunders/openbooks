import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { stubModules } from '../../testing/stub-modules.ts'
import { bootJsdomEnvironment } from '../../testing/jsdom-env.ts'

const navigation = { replacements: [] as string[] };
(globalThis as Record<string, unknown>).__cashHorizonNavigation = navigation;
stubModules({ navigation: { source: 'export const useRouter = () => ({ replace: (url) => globalThis.__cashHorizonNavigation.replacements.push(url) }); export const usePathname = () => "/analytics/cashflow"; export const useSearchParams = () => new URLSearchParams("sub=sub-1");' }, intl: false, authz: false, features: false });
// House render guard: classic JSX transforms and shared tsx caches need React
// on globalThis before the client control module is evaluated.
await bootJsdomEnvironment({ html: '<!doctype html><html><body></body></html>', url: 'http://localhost:4800/analytics/cashflow', matchMediaMatches: false });
// The horizon dropdown dispatches jsdom-realm events: keep jsdom's Event
// (Node 24 also ships a native global Event that this document will not
// dispatch as its own) until the shared preset offers an Event option.
globalThis.Event = window.Event;
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

test("formula TAX_RATE prices the enacted rate for the week, exactly", () => {
  // core.ts is server-only in production, so run the behavior check under
  // React's server condition (the same pattern used by other web tests).
  // The enacted-rate reader is the database boundary, so the test doubles
  // it at that seam — never the pure percent math under test.
  const source = `
    import assert from "node:assert/strict";
    import { resolveFormulaTaxRate } from "./web/lib/cash/core.ts";

    const calls = [];
    const reader = async (orgId, subsidiaryId, onDate) => {
      calls.push([orgId, subsidiaryId, onDate]);
      if (orgId === "org-bare") return null;
      return { ratePercent: "25.0000", jurisdictions: ["federal"] };
    };

    // A 25% enacted rate prices as the exact fraction 0.2500 — a float /100
    // would read 0.25000000000000006 territory and corrupt the formula.
    assert.equal(await resolveFormulaTaxRate("org-1", "2026-08-31", null, reader), "0.2500");
    assert.deepEqual(calls[0], ["org-1", null, "2026-08-31"]);
    // The category's subsidiary rides through for the entity stack.
    assert.equal(await resolveFormulaTaxRate("org-1", "2026-08-31", "sub-9", reader), "0.2500");
    assert.deepEqual(calls[1], ["org-1", "sub-9", "2026-08-31"]);

    // Nothing configured refuses by name with the remedy that exists.
    await assert.rejects(
      resolveFormulaTaxRate("org-bare", "2026-08-31", null, reader),
      /no enacted income tax rate.*Setup → Taxes → Income tax rates/,
    );
    console.log("cash TAX_RATE behavior passed: enacted 25% prices 0.2500 exactly; unconfigured refuses by name");
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

test("cash forecast aging places the 90th overdue day in 90+ and ages untermed items like the aging report", () => {
  const source = `
    import assert from "node:assert/strict";
    import { bucketOf, summariseSide } from "./web/lib/cash/core.ts";
    import { bucketOf as agingBucketOf } from "./web/lib/reports/aging.ts";

    assert.equal(bucketOf(89), "61-90");
    assert.equal(bucketOf(90), "90+");
    assert.equal(bucketOf(91), "90+");
    // An invoice with no due date posted 45 days ago is 31-60 on the cockpit,
    // exactly where the aging report (aging from posting date) puts it.
    const asOf = new Date("2026-06-30T00:00:00Z");
    const untermed = { id: "l1", entryId: "e1", docKind: "customer_invoice", docNumber: "INV-1", docId: "d1", partyId: "p1",
      partyName: "Acme", tranDate: new Date("2026-05-16T00:00:00Z"), dueDate: null, remaining: "100.0000" };
    const side = summariseSide([untermed], asOf, "0", 0);
    assert.equal(side.buckets.find((b) => b.label === "31-60").amount, "100.0000");
    assert.equal(agingBucketOf(45), "b2");
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
    assert.equal(MAX_CASH_HORIZON_WEEKS, 52);
    assert.equal(normalizeCashHorizonWeeks(13, 8), 13);
    assert.equal(normalizeCashHorizonWeeks(26, 8), 26);
    assert.equal(normalizeCashHorizonWeeks(52, 8), 52);
    assert.equal(normalizeCashHorizonWeeks("13", 8), 13);
    assert.equal(normalizeCashHorizonWeeks(12, 8), 12);
    assert.equal(normalizeCashHorizonWeeks(53, 8), 8);
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

test("monthly spreads use the week's actual calendar month, quarter flags the fiscal calendar", () => {
  // The forecast priced every month at 4.345 weeks and every quarter on the
  // calendar: January collected like February, and a July-start org's Q1 read
  // Q3. Run under React's server condition like the other core checks.
  const source = `
    import assert from "node:assert/strict";
    import { spreadMonthlyOverWeek, spreadWeeklyOverMonth, fiscalFormulaFlags } from "./web/lib/cash/core.ts";

    // 4345 a month spreads to 4345 * 7 / 31 in a January week and
    // 4345 * 7 / 28 in a February week — never 4345 in both, and never the
    // inflated monthly * days / 7 the helper computed before.
    assert.equal(spreadMonthlyOverWeek("4345.0000", "2026-01-04"), "981.1290");
    assert.equal(spreadMonthlyOverWeek("4345.0000", "2026-02-01"), "1086.2500");
    // The inverse direction places a week's average as a whole month's
    // worth: 1000 a week lands 4428.5714 in a 31-day monthly placement.
    assert.equal(spreadWeeklyOverMonth("1000.0000", "2026-01-04"), "4428.5714");
    assert.notEqual(
      spreadMonthlyOverWeek("4345.0000", "2026-01-04"),
      spreadMonthlyOverWeek("4345.0000", "2026-02-01"),
    );

    // A July-start org: the week of July 5 opens fiscal Q1, not calendar Q3.
    assert.deepEqual(fiscalFormulaFlags("2026-07-05", 7, 1, 0), { quarter: 1, isQStart: 1, isQEnd: 0, isYearEnd: 0 });
    // ... its fiscal year-end week straddles June into July, not December.
    assert.deepEqual(fiscalFormulaFlags("2026-06-28", 7, 0, 1), { quarter: 4, isQStart: 0, isQEnd: 1, isYearEnd: 1 });
    // A January-start org keeps calendar quarters: July opens Q3.
    assert.deepEqual(fiscalFormulaFlags("2026-07-05", 1, 1, 0), { quarter: 3, isQStart: 1, isQEnd: 0, isYearEnd: 0 });
    console.log("cash calendar behavior passed: actual month lengths spread months, fiscal start quarters years");
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
    window.close();
  }
});

test("week labels localize month names", () => {
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

test("declared category refusals map to an unavailable state, anything else rethrows", () => {
  // One refusing category must never take down the rest of the forecast:
  // the declared refusals become zeros that name their reason, while an
  // unknown failure maps to null so the caller rethrows it.
  const source = `
    import assert from "node:assert/strict";
    import { CategoryForecastRefusal, refusedCategories, toUnavailableCategory } from "./web/lib/cash/core.ts";
    import { MissingExchangeRateError } from "./web/lib/fx-presentation.ts";

    const cat = { id: "c1", name: "Card", direction: "outflow", method: "credit_card_cycle" };
    const refused = toUnavailableCategory(cat, 4, new CategoryForecastRefusal("c1", "Card"));
    assert.equal(refused.unavailable.code, "card-threshold-missing");
    assert.match(refused.unavailable.message, /category editor/);
    // The client renders the catalog message selected by code, so the
    // refusal must carry the message's parameters, not just English text.
    assert.deepEqual(refused.unavailable.params, { name: "Card" });
    assert.deepEqual(refused.weekly, ["0.0000", "0.0000", "0.0000", "0.0000"]);
    assert.equal(refused.total, "0.0000");
    assert.equal(refused.breakdown.length, 0);

    const blocked = toUnavailableCategory(cat, 4, new MissingExchangeRateError("USD", "CAD", "2026-09-01"));
    assert.equal(blocked.unavailable.code, "missing-exchange-rate");
    assert.match(blocked.unavailable.message, /no spot rate for USD→CAD/);
    assert.deepEqual(blocked.unavailable.params, { func: "USD", base: "CAD", date: "2026-09-01" });

    // The banner/tile reader lists every refusing category with the params
    // its catalog message needs — a dropped key renders a broken sentence.
    assert.deepEqual(refusedCategories([refused, blocked]).map((r) => [r.id, r.code, r.params]), [
      ["c1", "card-threshold-missing", { name: "Card" }],
      ["c1", "missing-exchange-rate", { func: "USD", base: "CAD", date: "2026-09-01" }],
    ]);

    assert.equal(toUnavailableCategory(cat, 4, new Error("boom")), null);
    assert.equal(toUnavailableCategory(cat, 4, "boom"), null);
    console.log("category refusal mapping passed: declared refusals name themselves, unknown failures rethrow");
  `;
  const result = spawnSync(
    process.execPath,
    ["--conditions=react-server", "--import", "tsx", "--input-type=module", "-e", source],
    { cwd: process.cwd(), env: process.env, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
