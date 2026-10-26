import assert from "node:assert/strict";
import test from "node:test";

const { stubModules } = await import("../../../../../../testing/stub-modules");
let search = "";
stubModules({
  navigation: {
    source:
      'export function useRouter(){return{replace(){},push(){},refresh(){}}} export function usePathname(){return"/reports/custom/run/x"} export function useSearchParams(){return new URLSearchParams(globalThis[Symbol.for("as-of-control-test")] ?? "")} export function notFound(){throw new Error("not found")} export function redirect(){throw new Error("redirect")}',
  },
  intl: true,
  authz: true,
  features: true,
  extra: { "server-only": "export {}" },
});
const setSearch = (value: string) => {
  search = value;
  (globalThis as Record<symbol, unknown>)[Symbol.for("as-of-control-test")] = search;
};

const React = await import("react");
Object.assign(globalThis, { React });
const { renderToString } = await import("react-dom/server");
const { NextIntlClientProvider } = await import("next-intl");
const { POINT_IN_TIME_DEFAULT_PERIOD_PRESET, POINT_IN_TIME_PERIOD_PRESETS, PERIOD_PRESETS } =
  await import("@openbooks/reports");
const { ReportFilterBar } = await import("../../../ReportFilterBar");
const { reportRunSpec } = await import("./view");
const messages = (await import("../../../../../../messages/en/index.ts")).default;

type Bar = {
  kind: string;
  controls: Record<string, unknown>;
  defaultPeriod?: unknown;
  periodPresets?: unknown;
  when?: unknown;
};

function filterBars(node: unknown, out: Bar[] = []): Bar[] {
  if (Array.isArray(node)) for (const item of node) filterBars(item, out);
  else if (node && typeof node === "object") {
    if ((node as { kind?: unknown }).kind === "filter-bar") out.push(node as Bar);
    for (const value of Object.values(node)) filterBars(value, out);
  }
  return out;
}

const data = {
  title: "Cap table as of a date",
  description: null,
  backHref: "/reports",
  backLabel: "Reports",
  hasPeriodField: false,
  hasAsOfField: true,
  asOfPeriodPresets: [...POINT_IN_TIME_PERIOD_PRESETS],
  noPeriodField: false,
  extraPeriods: undefined,
  canCreate: false,
  editHref: "",
  editLabel: "",
  definitionId: "d",
  historyHref: "",
  exportBaseHref: "",
  company: "Co",
  periodPhrase: "as of 2026-10-18",
  periodLabel: "Today",
  hasResult: false,
  hasError: true,
  result: null,
  drillTarget: null,
  error: null,
  hasPageInfo: false,
  pagerBasePath: "",
  totalRows: 0,
  currentPage: 1,
  perPage: 0,
};

test("a point-in-time report places the as-of filter bar: one date, point-in-time presets, today by default", () => {
  const bars = filterBars(reportRunSpec(data));
  const asOf = bars.filter((bar) => bar.controls.asOf === true);
  assert.equal(asOf.length, 1, "exactly one as-of filter bar");
  const [bar] = asOf;
  assert.equal(bar!.controls.period, true);
  assert.equal(bar!.defaultPeriod, POINT_IN_TIME_DEFAULT_PERIOD_PRESET);
  assert.equal(POINT_IN_TIME_DEFAULT_PERIOD_PRESET, "today");
  assert.match(JSON.stringify(bar!.periodPresets), /asOfPeriodPresets/);
  assert.match(JSON.stringify(bar!.when), /hasAsOfField/);
  // The period-window and no-period bars stay behind their own flags.
  assert.deepEqual(
    bars
      .filter((candidate) => candidate !== bar)
      .map((candidate) => JSON.stringify(candidate.when))
      .sort(),
    [
      JSON.stringify(bars.find((b) => /hasPeriodField/.test(JSON.stringify(b.when)))!.when),
      JSON.stringify(bars.find((b) => /noPeriodField/.test(JSON.stringify(b.when)))!.when),
    ].sort(),
  );
});

test("the point-in-time presets are the single-day presets and a custom date", () => {
  assert.deepEqual(
    [...POINT_IN_TIME_PERIOD_PRESETS],
    [...PERIOD_PRESETS.filter((preset) => preset.pointInTime).map((preset) => preset.id), "custom"],
  );
  assert.ok(POINT_IN_TIME_PERIOD_PRESETS.includes("today"));
  assert.ok(!POINT_IN_TIME_PERIOD_PRESETS.includes("this_fiscal_year"));
});

function bar(asOf = true): string {
  /* eslint-disable react/no-children-prop */
  return renderToString(
    React.createElement(NextIntlClientProvider, {
      locale: "en",
      messages,
      children: React.createElement(ReportFilterBar, {
        controls: { period: true, asOf },
        defaultPeriod: POINT_IN_TIME_DEFAULT_PERIOD_PRESET,
        periodPresets: POINT_IN_TIME_PERIOD_PRESETS,
      }),
    }),
  );
  /* eslint-enable react/no-children-prop */
}

test("the as-of control renders the point-in-time presets with today selected, and a custom selection is one date", () => {
  setSearch("");
  const html = bar();
  assert.match(html, />As of</i, "the control is labelled as of");
  assert.match(html, /<option value="today" selected="">/);
  assert.match(html, /<option value="yesterday"/);
  assert.doesNotMatch(html, /value="this_fiscal_year"/, "no period windows are offered");
  setSearch("period=custom&from=2026-09-15&to=2026-09-15");
  const custom = bar();
  assert.match(custom, /<option value="custom" selected="">/);
  assert.equal(
    (custom.match(/<input type="text"/g) ?? []).length,
    1,
    "a custom as-of is a single date, not a from/to window",
  );
  assert.equal(
    (bar(false).match(/<input type="text"/g) ?? []).length,
    2,
    "a period report keeps its from/to window",
  );
});
