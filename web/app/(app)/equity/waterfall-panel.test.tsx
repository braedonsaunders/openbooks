import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { bootJsdomEnvironment, setJsdomInput } from "../../../testing/jsdom-env";
import { stubModules } from "../../../testing/stub-modules";
import type { WaterfallResult, WaterfallScenario } from "@openbooks/engine/equity";

await bootJsdomEnvironment({ url: "http://localhost/equity", matchMediaMatches: false });
Object.assign(globalThis, { React });
window.requestAnimationFrame = (callback) => window.setTimeout(() => callback(0), 0);
window.cancelAnimationFrame = (id) => window.clearTimeout(id);
stubModules({
  navigation: {
    source:
      'export function usePathname(){return window.location.pathname} export function useSearchParams(){return new URLSearchParams(window.location.search)} export function useRouter(){return {push(){},replace(){},refresh(){},prefetch(){}}} export function notFound(){throw new Error("not found")} export function redirect(){throw new Error("redirect")}',
  },
  // Charts draw on a canvas the test DOM does not have: the stub records the
  // option each chart hands to the renderer so the drawing contract is asserted.
  extra: {
    "@openbooks/analytics/viz":
      "export function InsightChart(props){(globalThis.__chartOptions ??= []).push(props.option);return null}",
  },
});
const { createRoot } = await import("react-dom/client");
const { NextIntlClientProvider } = await import("next-intl");
const { default: messages } = await import("../../../messages/en");
const { MoneyProvider } = await import("../../../components/money-provider");
const { EquityWaterfallPanel } = await import("./WaterfallPanel");
const { TrendChart, Waterfall } = await import("../analytics/_ui/charts");

type ChartOption = {
  xAxis: { type: string; data?: string[]; axisLabel: { formatter?: (value: number) => string } };
  yAxis: { axisLabel: { formatter?: (value: number) => string } };
  series: {
    type: string;
    name?: string;
    smooth?: boolean;
    showSymbol?: boolean;
    data: unknown[];
    lineStyle?: { color?: string };
    label?: { formatter: (param: { dataIndex: number }) => string };
  }[];
  tooltip: { formatter: (params: unknown[]) => string };
};
const charts = globalThis as unknown as { __chartOptions?: ChartOption[] };
const takeCharts = () => {
  const drawn = charts.__chartOptions ?? [];
  charts.__chartOptions = [];
  return drawn;
};

async function mount(node: React.ReactNode, url = "/equity") {
  window.history.replaceState({}, "", url);
  takeCharts();
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <MoneyProvider currency="USD">{node}</MoneyProvider>
      </NextIntlClientProvider>,
    ),
  );
  return {
    host,
    close: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

const text = (element: Element | null) => (element?.textContent ?? "").replace(/\s+/g, " ").trim();
const cells = (row: Element) =>
  [...row.querySelectorAll("td")]
    .map((cell) => text(cell))
    .filter(Boolean)
    .join(" ");
/** Past the scenario's input debounce, with the answer applied. */
const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 360));
  });

const SUB = "a0000000-0000-4000-8000-000000000001";
const SA = "c0000000-0000-4000-8000-0000000000a1";
const COMMON = "c0000000-0000-4000-8000-000000000001";
const HOLDER = "b0000000-0000-4000-8000-000000000001";
const OTHER = "b0000000-0000-4000-8000-000000000002";
const context = {
  subsidiaryId: SUB,
  currency: "USD",
  asOf: "2026-12-15",
  canManage: true,
  actorId: "u0000000-0000-4000-8000-000000000001",
  pending: [],
  params: { sub: SUB, view: "waterfall" } as Record<string, string>,
  list: { page: 1, query: "", sort: "default", dir: "asc" as const },
};
const asOfControl = {
  defaultPeriod: "today",
  periodPresets: ["today", "yesterday", "tomorrow", "custom"],
};

type ClassRow = WaterfallResult["classes"][number];
const seriesA = (values: Partial<ClassRow>): ClassRow => ({
  shareClassId: SA,
  code: "SERIESA",
  kind: "preferred",
  seniority: 2,
  participationMode: "none",
  converted: false,
  preference: "0.0000",
  participation: "0.0000",
  total: "0.0000",
  perShare: "0.0000000000",
  preferenceEntitlement: "14000000.0000",
  participationCap: null,
  alternativeTotal: "0.0000",
  ...values,
});
const common = (values: Partial<ClassRow>): ClassRow => ({
  shareClassId: COMMON,
  code: "CS",
  kind: "common",
  seniority: 0,
  participationMode: "none",
  converted: false,
  preference: "0.0000",
  participation: "0.0000",
  total: "0.0000",
  perShare: "0.0000000000",
  preferenceEntitlement: "0.0000",
  participationCap: null,
  alternativeTotal: null,
  ...values,
});
function resultAt(exitValue: string, a: Partial<ClassRow>, cs: Partial<ClassRow>): WaterfallResult {
  const classes = [seriesA(a), common(cs)];
  return {
    exitValue,
    pricePerCommonShare: "3.5172186210",
    classes,
    payouts: classes.map((row, index) => ({
      securityId: `s${index}`,
      holderPartyId: index === 0 ? HOLDER : OTHER,
      kind: "share" as const,
      shareClassId: row.shareClassId,
      amount: row.total,
    })),
    holders: [
      {
        holderPartyId: HOLDER,
        amount: classes[0]!.total,
        percent: exitValue === "0.0000" ? "0.0000" : "22.8600",
      },
      {
        holderPartyId: OTHER,
        amount: classes[1]!.total,
        percent: exitValue === "0.0000" ? "0.0000" : "77.1400",
      },
    ],
    safes: [],
    unallocated: "0.0000",
  };
}

/**
 * A 67,316,585.60 exit: Series A (1x non-participating, 14,000,000 preference)
 * participates as converted. The engine rounds the class's parts half up and
 * its total by largest remainder, so the raw parts sit one cent off the total.
 */
const current = resultAt(
  "67316585.6000",
  {
    participationMode: "full",
    preference: "14000000.0000",
    participation: "1387831.4600",
    total: "15387831.4700",
    perShare: "3.5172186210",
  },
  { participation: "51928754.1300", total: "51928754.1300", perShare: "3.5172186210" },
);
/** The curve's exit values are where the payouts bend, so they are unevenly spaced. */
const curve = [
  { exitValue: "0.0000", result: resultAt("0.0000", {}, {}) },
  {
    exitValue: "14000000.0000",
    result: resultAt("14000000.0000", { preference: "14000000.0000", total: "14000000.0000" }, {}),
  },
  { exitValue: "67316585.6000", result: current },
  {
    exitValue: "134633171.2000",
    result: resultAt(
      "134633171.2000",
      {
        participationMode: "full",
        preference: "14000000.0000",
        participation: "16775662.9300",
        total: "30775662.9300",
      },
      { participation: "103857508.2700", total: "103857508.2700" },
    ),
  },
];
const scenarioOf = (
  result: WaterfallResult,
  extra: Partial<WaterfallScenario> = {},
): WaterfallScenario => ({
  entity: { id: SUB, name: "Northstar Cloud", currency: "USD" } as WaterfallScenario["entity"],
  grossExitValue: result.exitValue,
  transactionFees: "0.0000",
  result,
  curve: [],
  parties: { [HOLDER]: "Series A Fund", [OTHER]: "Founder One" },
  classes: { [SA]: "SERIESA", [COMMON]: "CS" },
  ...extra,
});
const presets = [
  { multiple: "0.5", value: "33658292.8000" },
  { multiple: "1", value: "67316585.6000" },
  { multiple: "2", value: "134633171.2000" },
  { multiple: "5", value: "336582928.0000" },
];
type PanelView = NonNullable<React.ComponentProps<typeof EquityWaterfallPanel>["view"]>;
function viewOf(
  scenario: WaterfallScenario | null,
  inputs: Partial<PanelView["inputs"]> & { payoutsBy?: "class" | "holder" } = {},
): PanelView {
  return {
    context,
    asOfControl,
    anchor: { roundName: "Series A", closedOn: "2025-09-30", postMoney: "67316585.6000" },
    presets,
    classOrder: [COMMON, SA],
    inputs: {
      exitValue: "67316585.6000",
      transactionFees: "",
      unvestedAwards: "participate",
      changeOfControl: true,
      terminated: false,
      ...inputs,
    },
    scenario,
    refusal: null,
  } as PanelView;
}

test("the proceeds chart plots every exit value at its true position with straight segments", async () => {
  const screen = await mount(
    <EquityWaterfallPanel view={viewOf(scenarioOf(current, { curve }))} />,
    `/equity?view=waterfall&sub=${SUB}`,
  );
  try {
    const line = takeCharts().find((option) =>
      option.series.every((series) => series.type === "line"),
    );
    assert.ok(line, "the proceeds chart is drawn");
    assert.equal(
      line.xAxis.type,
      "value",
      "exit values sit on a value axis, not evenly spaced categories",
    );
    assert.ok(
      line.series.every((series) => series.smooth === false && series.showSymbol === true),
      "segments are straight and every computed point is marked",
    );
    const seriesA = line.series[0]!.data as [number, number][];
    assert.deepEqual(
      seriesA,
      [
        [0, 0],
        [14000000, 14000000],
        [67316585.6, 15387831.47],
        [134633171.2, 30775662.93],
      ],
      "Series A reaches its preference exactly at the exit that covers it",
    );
    assert.equal(
      line.xAxis.axisLabel.formatter?.(20000000),
      "$20M",
      "the exit axis reads as compact money",
    );
    const tip = line.tooltip.formatter([
      {
        dataIndex: 1,
        seriesIndex: 0,
        seriesName: "SERIESA",
        marker: "",
        value: [14000000, 14000000],
        axisValue: 14000000,
      },
    ]);
    assert.equal(tip, "$14M<br/> SERIESA: $14M");
    // Each class line wears the colour its donut slice and cascade bars wear.
    const { equityClassColor } = await import("../../../lib/equity-colors");
    assert.equal(
      line.series.find((series) => series.name === "SERIESA")?.lineStyle?.color,
      equityClassColor(SA, [COMMON, SA]),
    );
    assert.equal(
      line.series.find((series) => series.name === "CS")?.lineStyle?.color,
      equityClassColor(COMMON, [COMMON, SA]),
    );
  } finally {
    await screen.close();
  }
});

test("the shared trend chart keeps its evenly spaced, smoothed rendering for every other caller", async () => {
  const screen = await mount(
    <TrendChart labels={["Jan", "Feb", "Mar"]} series={[{ name: "Spend", data: [1, null, 3] }]} />,
  );
  try {
    const [option] = takeCharts();
    assert.equal(option!.xAxis.type, "category");
    assert.deepEqual(option!.xAxis.data, ["Jan", "Feb", "Mar"]);
    assert.equal(option!.series[0]!.smooth, true);
    assert.equal(option!.series[0]!.showSymbol, false);
    assert.deepEqual(option!.series[0]!.data, [1, null, 3]);
    assert.equal(
      option!.tooltip.formatter([
        {
          dataIndex: 0,
          seriesIndex: 0,
          seriesName: "Spend",
          marker: "",
          value: 1,
          axisValue: "Jan",
        },
        {
          dataIndex: 1,
          seriesIndex: 0,
          seriesName: "Spend",
          marker: "",
          value: null,
          axisValue: "Jan",
        },
      ]),
      "Jan<br/> Spend: $1",
    );
  } finally {
    await screen.close();
  }
});

test("the cascade axis keeps negative values signed while its bars read by size, and lands exactly on zero", async () => {
  const screen = await mount(
    <Waterfall
      magnitudeLabels
      steps={[
        { label: "Exit", amount: "0.3000", kind: "start" },
        { label: "Series A", amount: "-0.1000", kind: "deduct" },
        { label: "Common", amount: "-0.2000", kind: "deduct" },
      ]}
    />,
  );
  try {
    const [option] = takeCharts();
    assert.equal(
      option!.yAxis.axisLabel.formatter?.(-10000000),
      "-$10M",
      "a negative axis tick keeps its sign",
    );
    assert.equal(option!.yAxis.axisLabel.formatter?.(10000000), "$10M");
    assert.equal(
      option!.series[1]!.label!.formatter({ dataIndex: 1 }),
      "$0.1",
      "a deduction is labelled by its size",
    );
    const bases = (option!.series[0]!.data as { value: number }[]).map((point) => point.value);
    assert.deepEqual(bases, [0, 0.2, 0], "exact steps leave no floating-point dust below zero");
  } finally {
    await screen.close();
  }
  const signed = await mount(
    <Waterfall
      steps={[
        { label: "Revenue", amount: 100, kind: "start" },
        { label: "Costs", amount: -150, kind: "deduct" },
        { label: "Net", amount: -50, kind: "total" },
      ]}
    />,
  );
  try {
    const [option] = takeCharts();
    assert.equal(
      option!.series[1]!.label!.formatter({ dataIndex: 2 }),
      "-$50",
      "without magnitude labels a bridge keeps its signs",
    );
    assert.deepEqual(
      (option!.series[0]!.data as { value: number }[]).map((point) => point.value),
      [0, -50, 0],
    );
  } finally {
    await signed.close();
  }
});

test("the payouts view opens from the URL and writes every change back to it", async () => {
  const screen = await mount(
    <EquityWaterfallPanel view={viewOf(scenarioOf(current), { payoutsBy: "holder" })} />,
    `/equity?view=waterfall&sub=${SUB}&payouts=holder`,
  );
  try {
    const select = () =>
      [...screen.host.querySelectorAll("label")]
        .find((label) => text(label.querySelector("span")) === "Payouts")!
        .querySelector("select")!;
    assert.equal(select().value, "holder");
    assert.deepEqual([...screen.host.querySelectorAll("tbody tr")].map(cells), [
      "Series A Fund $15,387,831.47 22.86%",
      "Founder One $51,928,754.13 77.14%",
    ]);
    await act(async () => {
      select().value = "class";
      select().dispatchEvent(new window.Event("change", { bubbles: true }));
    });
    assert.equal(
      new URL(window.location.href).searchParams.get("payouts"),
      null,
      "by class is the default and leaves the URL clean",
    );
    assert.equal(
      new URL(window.location.href).searchParams.get("sub"),
      SUB,
      "the rest of the URL is kept",
    );
    assert.ok(cells(screen.host.querySelector("tbody tr")!).startsWith("SERIESA"));
    await act(async () => {
      select().value = "holder";
      select().dispatchEvent(new window.Event("change", { bubbles: true }));
    });
    assert.equal(
      new URL(window.location.href).searchParams.get("payouts"),
      "holder",
      "a reload reopens by holder",
    );
  } finally {
    await screen.close();
  }
});

test("each payout row shows parts that add up to its total, with prices and amounts on one line", async () => {
  const screen = await mount(
    <EquityWaterfallPanel view={viewOf(scenarioOf(current))} />,
    `/equity?view=waterfall&sub=${SUB}`,
  );
  try {
    const rows = [...screen.host.querySelectorAll("tbody tr")].map(cells);
    assert.equal(
      rows[0],
      "SERIESA Takes preference $14,000,000.00 $1,387,831.47 $15,387,831.47 $3.5172 22.86%",
      "the participation is the total less the preference paid",
    );
    assert.equal(rows[1], "CS — — $51,928,754.13 $51,928,754.13 $3.5172 77.14%");
    assert.equal(rows[2], "Total $67,316,585.60 100.00%");
    const numeric = [...screen.host.querySelectorAll("tbody tr:first-child td")].slice(2);
    assert.ok(
      numeric.every((cell) => cell.className.includes("whitespace-nowrap")),
      "numbers never wrap in narrow columns",
    );
    assert.ok(
      text(screen.host).includes(
        "Takes its $14,000,000.00 preference and shares the rest as converted: $15,387,831.47 in all.",
      ),
    );
    assert.ok(
      text(screen.host).includes("$3.5172"),
      "the per-share price reads through the money formatter, not as raw ten-place text",
    );
    assert.ok(!text(screen.host).includes("3.5172186210"));
  } finally {
    await screen.close();
  }
});

test("a zero exit gives no class a share of the proceeds", async () => {
  const zero = resultAt("0.0000", {}, {});
  const screen = await mount(
    <EquityWaterfallPanel view={viewOf(scenarioOf(zero), { exitValue: "0" })} />,
    `/equity?view=waterfall&sub=${SUB}&exit=0`,
  );
  try {
    const rows = [...screen.host.querySelectorAll("tbody tr")].map(cells);
    assert.equal(rows.at(-1), "Total $0.00 —", "the share-of-exit total is undefined, not 100%");
    assert.ok(rows.slice(0, -1).every((row) => row.endsWith("—")));
    assert.equal(
      text(screen.host).match(/No proceeds to share/g)?.length,
      2,
      "both share tiles say there is nothing to share",
    );
    assert.ok(
      text(screen.host).includes(
        "Receives nothing: the proceeds do not reach its $14,000,000.00 preference; converting would pay $0.00.",
      ),
    );
  } finally {
    await screen.close();
  }
});

test("a preference the proceeds cover only in part is described by the amount paid", async () => {
  const partial = resultAt(
    "10000000.0000",
    { preference: "10000000.0000", total: "10000000.0000", perShare: "2.5000000000" },
    {},
  );
  const screen = await mount(
    <EquityWaterfallPanel view={viewOf(scenarioOf(partial), { exitValue: "10000000" })} />,
    `/equity?view=waterfall&sub=${SUB}&exit=10000000`,
  );
  try {
    const body = text(screen.host);
    assert.ok(
      body.includes(
        "Takes $10,000,000.00 of its $14,000,000.00 preference, which the proceeds cover only in part; converting would pay $0.00.",
      ),
    );
    assert.ok(
      !body.includes("Takes its $14,000,000.00 preference"),
      "the full preference is never claimed when it is not paid",
    );
  } finally {
    await screen.close();
  }
});

test("a refused recompute replaces the stale results until the inputs compute again", async () => {
  const requests: unknown[] = [];
  const answers: Response[] = [
    new Response(
      JSON.stringify({
        error: "The transaction fees exceed the exit value.",
        code: "equity_waterfall_invalid",
        remedy: "Enter fees no greater than the exit value.",
        field: "transactionFees",
      }),
      { status: 422, headers: { "Content-Type": "application/json" } },
    ),
    new Response(
      JSON.stringify(
        scenarioOf(current, { grossExitValue: "67316585.6000", transactionFees: "0.0000" }),
      ),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ),
  ];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body)));
    return answers.shift()!;
  }) as typeof fetch;
  const screen = await mount(
    <EquityWaterfallPanel view={viewOf(scenarioOf(current))} />,
    `/equity?view=waterfall&sub=${SUB}`,
  );
  try {
    const fees = screen.host.querySelectorAll<HTMLInputElement>("input[inputmode=decimal]")[1]!;
    await act(async () => setJsdomInput(fees, "90000000"));
    assert.equal(
      new URL(window.location.href).searchParams.get("fees"),
      "90000000",
      "the URL reflects the inputs at once",
    );
    await settle();
    assert.deepEqual(
      requests.map((body) => (body as { transactionFees: string }).transactionFees),
      ["90000000"],
    );
    const body = text(screen.host);
    assert.ok(
      body.includes("The transaction fees exceed the exit value.") &&
        body.includes("Enter fees no greater than the exit value."),
      "the named refusal and its remedy are shown",
    );
    for (const stale of [
      "Proceeds to holders",
      "Payment cascade",
      "Conversion decisions",
      "$15,387,831.47",
    ])
      assert.ok(!body.includes(stale), `${stale} is not left on screen`);
    assert.equal(screen.host.querySelectorAll("tbody tr").length, 0);
    await act(async () => setJsdomInput(fees, ""));
    await settle();
    assert.ok(
      text(screen.host).includes("Payment cascade"),
      "valid inputs compute and show results again",
    );
    assert.equal(new URL(window.location.href).searchParams.get("fees"), null);
  } finally {
    globalThis.fetch = realFetch;
    await screen.close();
  }
});

test("an exit value tabbed into and retyped, or pasted grouped, replaces the old one and computes on the exact amount", async () => {
  const requests: { exitValue: string }[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body)) as { exitValue: string });
    return new Response(JSON.stringify(scenarioOf(current)), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  const screen = await mount(
    <EquityWaterfallPanel view={viewOf(scenarioOf(current), { exitValue: "74424261.56" })} />,
    `/equity?view=waterfall&sub=${SUB}&exit=74424261.56`,
  );
  try {
    const exit = screen.host.querySelector<HTMLInputElement>("input[inputmode=decimal]")!;
    assert.equal(exit.value, "74,424,261.56");
    await act(async () => {
      exit.focus();
    });
    assert.deepEqual(
      [exit.selectionStart, exit.selectionEnd],
      [0, exit.value.length],
      "focus selects the amount",
    );
    await act(async () => setJsdomInput(exit, "5000000"));
    assert.equal(
      new URL(window.location.href).searchParams.get("exit"),
      "5000000",
      "the typed amount replaced the old one",
    );
    await settle();
    await act(async () => setJsdomInput(exit, "20,000,000.50"));
    assert.equal(
      new URL(window.location.href).searchParams.get("exit"),
      "20000000.5",
      "a grouped paste reads as the amount it shows",
    );
    await settle();
    assert.deepEqual(
      requests.map((body) => body.exitValue),
      ["5000000", "20000000.5"],
    );
    assert.ok(!text(screen.host).includes("is not an amount"));
    await act(async () => {
      exit.blur();
    });
    assert.equal(exit.value, "20,000,000.50");
  } finally {
    globalThis.fetch = realFetch;
    await screen.close();
  }
});

test("input the waterfall cannot compute replaces the results with what to correct", async () => {
  const screen = await mount(
    <EquityWaterfallPanel view={viewOf(scenarioOf(current))} />,
    `/equity?view=waterfall&sub=${SUB}`,
  );
  try {
    const exit = screen.host.querySelector<HTMLInputElement>("input[inputmode=decimal]")!;
    await act(async () => setJsdomInput(exit, "25,00,000"));
    const body = text(screen.host);
    assert.ok(body.includes("Exit value is not an amount: “25,00,000”."), body);
    assert.ok(
      body.includes("Enter digits, with “.” before any decimals, such as 1,234,567.89."),
      "the remedy is written the way the field displays amounts",
    );
    assert.ok(
      !/without separators|thousands separator/.test(body),
      "nothing asks to omit the grouping the field itself shows",
    );
    assert.ok(!body.includes("Payment cascade"));
    assert.equal(exit.getAttribute("aria-invalid"), "true");
    await act(async () => setJsdomInput(exit, "-5"));
    assert.ok(
      text(screen.host).includes("The exit value cannot be negative.") &&
        text(screen.host).includes("Enter the exit value as an amount, such as 25,000,000."),
    );
    await act(async () => setJsdomInput(exit, ""));
    assert.ok(text(screen.host).includes("Enter an exit value"), "a blank exit asks for one");
  } finally {
    await screen.close();
  }
});

test("exit presets show a localized amount in the input and write a clean decimal to the URL", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(scenarioOf(current)), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })) as typeof fetch;
  const screen = await mount(
    <EquityWaterfallPanel view={viewOf(scenarioOf(current))} />,
    `/equity?view=waterfall&sub=${SUB}`,
  );
  try {
    const exit = screen.host.querySelector<HTMLInputElement>("input[inputmode=decimal]")!;
    assert.equal(
      exit.value,
      "67,316,585.60",
      "the opening exit reads as a localized amount, without ledger zeros",
    );
    const chips = [...screen.host.querySelectorAll<HTMLButtonElement>("button[aria-pressed]")];
    assert.deepEqual(
      chips.map((chip) => chip.getAttribute("aria-pressed")),
      ["false", "true", "false", "false"],
    );
    await act(async () => {
      chips[0]!.click();
    });
    assert.equal(exit.value, "33,658,292.80");
    assert.equal(new URL(window.location.href).searchParams.get("exit"), "33658292.8");
    await act(async () => {
      chips[3]!.click();
    });
    assert.equal(exit.value, "336,582,928.00");
    assert.equal(new URL(window.location.href).searchParams.get("exit"), "336582928");
    await act(async () => {
      exit.focus();
    });
    assert.equal(exit.value, "336582928", "editing shows the clean decimal");
    await act(async () => {
      exit.blur();
    });
    assert.equal(chips[3]!.getAttribute("aria-pressed"), "true");
    await settle();
  } finally {
    globalThis.fetch = realFetch;
    await screen.close();
  }
});
