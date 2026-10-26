import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { assertSavedReportPeriod, parseReportQuery } from "./report-filters.ts";

// E34: a stale period preset id (saved before the preset was removed from the
// catalog) must refuse by name — never silently become This Fiscal Year and
// widen (or move) the report window.
const stateKey = Symbol.for("openbooks.period-preset-refusal-test");
const hookState: {
  dbCalls: number;
  periodRows: {
    name: string;
    fiscal_year: number;
    period_number: number;
    starts_on: string;
    ends_on: string;
  }[];
} = { dbCalls: 0, periodRows: [] };
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = hookState;

const TODAY = "2026-09-24";

const mockSources = new Map<string, string>([
  [
    "mock:db",
    `const state = globalThis[Symbol.for('openbooks.period-preset-refusal-test')]
     export const db = { async execute(_query, mode) { const inMode = (result) => (mode === 'objects' ? result.rows : result); state.dbCalls += 1; return inMode({ rows: state.periodRows }) } }`,
  ],
  [
    "mock:org-scope",
    `export async function resolveOrgId(orgId) { if (orgId) return orgId; throw new Error('active organization is required') }`,
  ],
  ["mock:business-date", `export async function businessToday() { return '${TODAY}' }`],
  [
    "mock:fiscal",
    `export async function fiscalStartMonth() { return 1 }
     export async function defaultFiscalCalendarPeriods() { return null }`,
  ],
]);

const mockUrls = new Map<string, string>([
  ["@openbooks/engine/platform/db", "mock:db"],
  ["./org-scope", "mock:org-scope"],
  ["./fiscal", "mock:fiscal"],
  ["@openbooks/engine/platform/business-date/module", "mock:business-date"],
]);

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    const mocked = mockUrls.get(specifier);
    if (mocked) return { url: mocked, shortCircuit: true };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    const source = mockSources.get(url);
    if (source !== undefined) return { format: "module", source, shortCircuit: true };
    return nextLoad(url, context);
  },
});

const periodsUrl = "./periods.ts?period-preset-refusal-test";
const { resolvePeriod } = (await import(periodsUrl)) as typeof import("./periods.ts");
hooks.deregister();

const ORG = "org-1";

test("a stale preset id refuses by name instead of becoming This Fiscal Year", async () => {
  hookState.dbCalls = 0;
  await assert.rejects(
    resolvePeriod("fiscal_yesterdecade", { orgId: ORG, today: TODAY }),
    (error: unknown) => {
      const message = (error as Error).message;
      return message.includes("fiscal_yesterdecade") && message.includes("no longer exists");
    },
  );
  assert.equal(hookState.dbCalls, 0, "a stale preset must refuse before any database work");
});

test("an absent preset still resolves the default fiscal year", async () => {
  for (const preset of [null, undefined, ""]) {
    const resolved = await resolvePeriod(preset, { orgId: ORG, today: TODAY });
    assert.equal(resolved.presetId, "this_fiscal_year");
    assert.equal(resolved.from, "2026-01-01");
    assert.equal(resolved.to, "2026-12-31");
  }
});

test("a current preset still resolves", async () => {
  const resolved = await resolvePeriod("today", { orgId: ORG, today: TODAY });
  assert.equal(resolved.presetId, "today");
  assert.equal(resolved.from, TODAY);
  assert.equal(resolved.to, TODAY);
});

test("a business day before every configured accounting period refuses by name", async () => {
  hookState.periodRows = [
    {
      name: "FY 2027 period 1",
      fiscal_year: 2027,
      period_number: 1,
      starts_on: "2026-04-01",
      ends_on: "2026-04-30",
    },
  ];
  // The refusal names the first period by its fiscal position, not its stored name.
  await assert.rejects(
    resolvePeriod("this_period", { orgId: ORG, today: "2026-01-15" }),
    /2026-01-15.*precedes.*'P01 FY2027'/,
  );
  hookState.periodRows = [];
});

// A custom window is the only preset that carries its own bounds, so the
// filter bar, the saved view and the export must agree on exactly those bounds
// and must never widen to the fiscal year when they are missing.
const CUSTOM_TODAY = "2026-10-11";

test("a custom period resolves to exactly its saved bounds, excluding later days", async () => {
  const resolved = await resolvePeriod("custom", {
    orgId: ORG,
    today: CUSTOM_TODAY,
    customFrom: "2026-01-01",
    customTo: "2026-09-30",
  });
  assert.equal(resolved.presetId, "custom");
  assert.equal(resolved.from, "2026-01-01");
  assert.equal(resolved.to, "2026-09-30");
});

test("a custom period without valid bounds refuses by name before any database work", async () => {
  hookState.dbCalls = 0;
  const incomplete: Array<[string | undefined, string | undefined]> = [
    [undefined, "2026-09-30"],
    ["2026-01-01", undefined],
    ["2026-01-01", ""],
    ["2026-09-30", "2026-01-01"],
    ["2026-02-30", "2026-03-01"],
    ["01/01/2026", "2026-09-30"],
  ];
  for (const [customFrom, customTo] of incomplete) {
    await assert.rejects(
      resolvePeriod("custom", { orgId: ORG, today: CUSTOM_TODAY, customFrom, customTo }),
      (error: unknown) =>
        (error as { code?: unknown }).code === "incomplete-report-period" &&
        (error as { status?: unknown }).status === 422,
    );
  }
  assert.equal(
    hookState.dbCalls,
    0,
    "an incomplete custom window must refuse before any database work",
  );
});

test("a custom range round-trips from the filter bar through save, reopen and export", async () => {
  // The filter bar's applied URL state; SaveViewButton stores exactly this.
  const applied = { period: "custom", from: "2026-01-01", to: "2026-09-30", breakout: "none" };
  const stored = JSON.parse(JSON.stringify(applied)) as Record<string, string>;
  assert.doesNotThrow(() => assertSavedReportPeriod(stored));

  // Reopening a saved view navigates to the stored params; the page reads them.
  const reopened = new URLSearchParams(stored);
  const pageQuery = parseReportQuery(Object.fromEntries(reopened.entries()));
  const shown = await resolvePeriod(pageQuery.period, {
    orgId: ORG,
    today: CUSTOM_TODAY,
    customFrom: pageQuery.from,
    customTo: pageQuery.to,
  });

  // The export URL carries the same params the page exposes to its menu.
  const exportUrl = new URLSearchParams({
    format: "csv",
    ...Object.fromEntries(reopened.entries()),
  });
  const exportQuery = parseReportQuery(exportUrl);
  const exported = await resolvePeriod(exportQuery.period, {
    orgId: ORG,
    today: CUSTOM_TODAY,
    customFrom: exportUrl.get("from"),
    customTo: exportUrl.get("to"),
  });

  for (const period of [shown, exported]) {
    assert.equal(period.presetId, "custom");
    assert.equal(period.from, "2026-01-01");
    assert.equal(period.to, "2026-09-30");
  }
});

test("an incomplete custom saved view refuses at save and never reopens as the fiscal year", async () => {
  // A period=custom view saved before the range was applied carries no bounds.
  assert.throws(
    () => assertSavedReportPeriod({ period: "custom", from: "2026-01-01" }),
    (error: unknown) => (error as { code?: unknown }).code === "incomplete-report-period",
  );
  // Views saved without a custom period are unaffected.
  assert.doesNotThrow(() =>
    assertSavedReportPeriod({ period: "this_fiscal_year", breakout: "none" }),
  );

  const reopened = parseReportQuery(new URLSearchParams({ period: "custom", from: "2026-01-01" }));
  await assert.rejects(
    resolvePeriod(reopened.period, {
      orgId: ORG,
      today: CUSTOM_TODAY,
      customFrom: reopened.from,
      customTo: reopened.to,
    }),
    (error: unknown) => (error as { code?: unknown }).code === "incomplete-report-period",
  );
});
