import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { bootJsdomEnvironment } from "../../../testing/jsdom-env";
import { stubModules } from "../../../testing/stub-modules";
import type { CapTable, PendingRequest } from "@openbooks/engine/equity";

await bootJsdomEnvironment({ url: "http://localhost/equity", matchMediaMatches: false });
Object.assign(globalThis, { React });
window.requestAnimationFrame = (callback) => window.setTimeout(() => callback(0), 0);
window.cancelAnimationFrame = (id) => window.clearTimeout(id);
stubModules({
  navigation: {
    source:
      'export function usePathname(){return window.location.pathname} export function useSearchParams(){return new URLSearchParams(window.location.search)} export function useRouter(){return {push(){},replace(){},refresh(){},prefetch(){}}} export function notFound(){throw new Error("not found")} export function redirect(){throw new Error("redirect")}',
  },
  // Charts draw on a canvas the test DOM does not have; their data is asserted through the shared builders.
  extra: { "@openbooks/analytics/viz": "export function InsightChart(){return null}" },
});
const { createRoot } = await import("react-dom/client");
const { NextIntlClientProvider } = await import("next-intl");
const { default: messages } = await import("../../../messages/en");
const { MoneyProvider } = await import("../../../components/money-provider");
const { LOCAL_NAVIGATION } = await import("@openbooks/engine/navigation");
const { ViewTabsProvider, PageViewTabs } =
  await import("../../../components/module-home/view-tabs");
const { EquityOwnership, EquityActivityList } = await import("./OverviewSections");
const { AttentionList } = await import("../purchasing/sections");
const { EquityCapTablePanel } = await import("./CapTablePanel");
const { capTableExportData } = await import("../../../lib/equity-cap-table-export");
const { EquityRunsPanel } = await import("./RunsPanel");
const { EquityWaterfallPanel } = await import("./WaterfallPanel");
const { EquitySecuritiesPanel } = await import("./SecuritiesPanel");
const { EquityClassesPanel, EquityPlansPanel, EquityStakeholdersPanel } =
  await import("./StructurePanels");
const { EquityRoundsPanel } = await import("./RoundsPanel");
const { PendingActions } = await import("./shared");

async function mount(node: React.ReactNode, url = "/equity") {
  window.history.replaceState({}, "", url);
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
const SUB = "a0000000-0000-4000-8000-000000000001";
const ACTOR = "u0000000-0000-4000-8000-000000000001";
const context = (
  overrides: {
    canManage?: boolean;
    pending?: PendingRequest[];
    list?: { page: number; query: string; sort: string; dir: "asc" | "desc" };
  } = {},
) => ({
  subsidiaryId: SUB,
  currency: "USD",
  asOf: "2026-12-15",
  canManage: true,
  actorId: ACTOR,
  pending: [] as PendingRequest[],
  params: { sub: SUB, view: "compensation" } as Record<string, string>,
  list: { page: 1, query: "", sort: "default", dir: "asc" as const },
  ...overrides,
});
const asOfControl = {
  defaultPeriod: "today",
  periodPresets: ["today", "yesterday", "tomorrow", "custom"],
};

test("the workspace strip shows the overview and five working views, with share classes, plans and stakeholders in More", async () => {
  const equity = LOCAL_NAVIGATION.find((set) => set.id === "equity")!;
  const labels = (messages as unknown as { equity: { tabs: Record<string, string> } }).equity.tabs;
  const group = equity.tabs.map((tab) => ({
    href: tab.href,
    label: labels[tab.key.replace("tabs.", "")]!,
    secondary: tab.secondary,
    carry: ["sub", "book", ...(tab.carry ?? [])],
  }));
  const screen = await mount(
    <ViewTabsProvider managed groups={[group]}>
      <PageViewTabs />
    </ViewTabsProvider>,
    "/equity?view=plans&sub=" + SUB,
  );
  try {
    const strip = screen.host.querySelector("[data-subtabs]")!;
    const pills = [...strip.querySelectorAll(":scope > a")].map((link) => text(link));
    assert.deepEqual(pills, [
      "Overview",
      "Cap table",
      "Securities",
      "Rounds",
      "Waterfall",
      "Stock comp",
    ]);
    const more = strip.querySelector<HTMLButtonElement>("button[aria-haspopup=menu]")!;
    assert.equal(
      text(more),
      "More: Plans",
      "the active overflow destination names the More control",
    );
    await act(async () => {
      more.click();
    });
    const entries = [...document.querySelectorAll("[role=menu] [role=menuitem]")];
    assert.deepEqual(
      entries.map((entry) => text(entry)),
      ["Share classes", "Plans", "Stakeholders"],
    );
    assert.ok(
      entries.every((entry) => entry.getAttribute("href")?.includes(`sub=${SUB}`)),
      "the legal entity travels between views",
    );
  } finally {
    await screen.close();
  }
});

test("the ownership hero and activity render populated and empty compositions", async () => {
  const populated = await mount(
    <>
      <EquityOwnership
        empty="No shares"
        slices={[
          {
            key: "class:cs",
            label: "CS · Common",
            shares: "12000000",
            percent: "56.9200",
            color: "#008300",
          },
          {
            key: "option",
            label: "Options",
            shares: "1500000",
            percent: "7.1150",
            color: "#2a78d6",
          },
          {
            key: "pool",
            label: "Available pool",
            shares: "800000",
            percent: "3.7944",
            color: "#cbd5e1",
          },
        ]}
      />
      <EquityActivityList
        empty="No activity"
        items={[
          {
            key: "event:1",
            date: "Oct 1, 2026",
            text: "Exercise · OPT-0007 · Maya Chen · 12,000 shares",
            href: "/equity?view=securities&security=x",
          },
        ]}
      />
      <AttentionList
        allClear="Nothing needs attention."
        items={[
          {
            tone: "warning",
            text: "Stock compensation is not posted through Sep 30, 2026",
            href: "/equity?view=compensation",
          },
        ]}
      />
    </>,
  );
  try {
    const legend = [...populated.host.querySelectorAll("li")].slice(0, 3).map((row) =>
      [...row.querySelectorAll("span")]
        .map((span) => text(span))
        .filter(Boolean)
        .join(" "),
    );
    assert.deepEqual(legend, [
      "CS · Common 12,000,000 56.9%",
      "Options 1,500,000 7.1%",
      "Available pool 800,000 3.8%",
    ]);
    assert.equal(
      populated.host
        .querySelector('a[href="/equity?view=securities&security=x"]')
        ?.textContent?.includes("OPT-0007"),
      true,
    );
    assert.ok(
      text(populated.host).includes("Stock compensation is not posted through Sep 30, 2026"),
    );
  } finally {
    await populated.close();
  }
  const empty = await mount(
    <>
      <EquityOwnership empty="No shares or awards are outstanding on this date." slices={[]} />
      <EquityActivityList empty="No equity activity recorded yet." items={[]} />
      <AttentionList allClear="Nothing needs attention." items={[]} />
    </>,
  );
  try {
    assert.equal(empty.host.querySelectorAll("li").length, 0);
    assert.ok(text(empty.host).includes("No shares or awards are outstanding on this date."));
    assert.ok(text(empty.host).includes("No equity activity recorded yet."));
    assert.ok(text(empty.host).includes("Nothing needs attention."));
  } finally {
    await empty.close();
  }
});

const COMMON = "c0000000-0000-4000-8000-000000000001";
const HOLDER = "b0000000-0000-4000-8000-000000000001";
const EMPLOYEE = "b0000000-0000-4000-8000-000000000002";
const capTable: CapTable = {
  asOf: "2026-12-15",
  classes: [
    {
      shareClassId: COMMON,
      code: "CS",
      name: "Common",
      kind: "common" as const,
      seniority: 0,
      authorized: "10000000",
      outstanding: "4000000",
      asConvertedOutstanding: "4000000",
      awardsOutstanding: "48000",
      poolAvailable: "952000",
      fullyDiluted: "5000000",
      conversionRatio: "1.0000000000",
      parValue: "0.0001000000",
      originalIssuePrice: null,
      conversionPrice: null,
      outstandingPercent: "100.0000",
      fullyDilutedPercent: "100.0000",
    },
  ],
  holders: [
    {
      holderPartyId: HOLDER,
      sharesByClass: { [COMMON]: "4000000" },
      asConvertedOutstanding: "4000000",
      options: "0",
      rsus: "0",
      warrants: "0",
      vestedAwards: "0",
      fullyDiluted: "4000000",
      outstandingPercent: "100.0000",
      fullyDilutedPercent: "80.0000",
    },
    {
      holderPartyId: EMPLOYEE,
      sharesByClass: {},
      asConvertedOutstanding: "0",
      options: "48000",
      rsus: "0",
      warrants: "0",
      vestedAwards: "12000",
      fullyDiluted: "48000",
      outstandingPercent: "0.0000",
      fullyDilutedPercent: "0.9600",
    },
  ],
  unallocatedPool: { fullyDiluted: "952000", fullyDilutedPercent: "19.0400" },
  plans: [],
  holdings: [
    {
      securityId: "s1",
      securityNumber: "CS-0001",
      kind: "share" as const,
      holderPartyId: HOLDER,
      shareClassId: COMMON,
      planId: null,
      status: "outstanding" as const,
      outstanding: "4000000",
      vested: "4000000",
      unvested: "0",
      asConverted: "4000000",
      exercisePrice: null,
    },
    {
      securityId: "o1",
      securityNumber: "OPT-0001",
      kind: "option" as const,
      holderPartyId: EMPLOYEE,
      shareClassId: COMMON,
      planId: null,
      status: "outstanding" as const,
      outstanding: "48000",
      vested: "12000",
      unvested: "36000",
      asConverted: "48000",
      exercisePrice: "0.5000000000",
    },
  ],
  convertibles: [],
  totals: {
    outstanding: "4000000",
    asConvertedOutstanding: "4000000",
    awardsOutstanding: "48000",
    poolAvailable: "952000",
    fullyDiluted: "5000000",
  },
};

test("the cap table filters its view and instrument with toolbar drop-downs beside the native as-of control", async () => {
  const view = {
    context: {
      ...context(),
      params: { sub: SUB, view: "captable", by: "holder", instrument: "option" },
    },
    asOfControl,
    dimension: "holder" as const,
    instrument: "option" as const,
    query: "",
    table: capTable,
    parties: { [HOLDER]: "Founder One", [EMPLOYEE]: "Employee One" },
    hasAccountPolicy: true,
    accountsSetupHref: "/admin/setup/equity-account-policies",
    reportHref: "/reports/custom/run/r1",
    asOfReportHref: "/reports/custom/run/r2",
  };
  const screen = await mount(
    <EquityCapTablePanel view={view} />,
    `/equity?view=captable&sub=${SUB}&by=holder&instrument=option`,
  );
  try {
    const selects = [...screen.host.querySelectorAll("label")].map((label) => [
      text(label.querySelector("span")),
      label.querySelector("select")?.value,
    ]);
    assert.deepEqual(
      selects.filter(([name]) => name === "View" || name === "Instrument"),
      [
        ["View", "holder"],
        ["Instrument", "option"],
      ],
    );
    assert.ok(
      text(screen.host).includes("As of"),
      "the native as-of control sits on the table toolbar",
    );
    assert.equal(
      screen.host.querySelector('nav[aria-label="Cap table view"]'),
      null,
      "no sub-tabs above the table",
    );
    const headers = [...screen.host.querySelectorAll("th")].map((cell) => text(cell));
    assert.deepEqual(headers, ["Holder", "Options outstanding", "Vested", "Unvested"]);
    const rows = [...screen.host.querySelectorAll("tbody tr")].map(cells);
    assert.deepEqual(
      rows,
      ["Employee One 48,000 12,000 36,000", "Total 48,000 12,000 36,000"],
      "only option holders are listed, with an aligned totals row",
    );
  } finally {
    await screen.close();
  }
});

test("the cap table by holder truncates a long holder name with the full name on hover, and its figure headers wrap between words", async () => {
  const longName = "Meridian Growth Partners Opportunity Fund II";
  const view = {
    context: { ...context(), params: { sub: SUB, view: "captable", by: "holder" } },
    asOfControl,
    dimension: "holder" as const,
    instrument: "all" as const,
    query: "",
    table: capTable,
    parties: { [HOLDER]: longName, [EMPLOYEE]: "Employee One" },
    hasAccountPolicy: true,
    accountsSetupHref: "/admin/setup/equity-account-policies",
    reportHref: null,
    asOfReportHref: null,
  };
  const screen = await mount(
    <EquityCapTablePanel view={view as never} />,
    `/equity?view=captable&sub=${SUB}&by=holder`,
  );
  try {
    const holder = [...screen.host.querySelectorAll("tbody a")].find(
      (link) => text(link) === longName,
    )!;
    assert.equal(holder.getAttribute("title"), longName, "the full name is on hover");
    assert.ok(
      holder.className.includes("truncate") && holder.className.includes("max-w-40"),
      holder.className,
    );
    assert.ok(
      holder.closest("td")!.className.includes("whitespace-nowrap"),
      "a name never wraps onto several lines",
    );
    const figureHeaders = [...screen.host.querySelectorAll("thead th")].slice(1);
    assert.ok(
      figureHeaders.length > 0 &&
        figureHeaders.every((th) => !th.className.includes("whitespace-nowrap")),
      "figure headers may wrap, so the columns fit",
    );
    assert.ok(
      [...screen.host.querySelectorAll("tbody td")]
        .slice(1)
        .every((td) => td.className.includes("px-3")),
      "figures keep the compact gutter",
    );
  } finally {
    await screen.close();
  }
});

test("the cap table export holds exactly the rows, columns and totals on screen for every filter", async () => {
  const parties = { [HOLDER]: "Founder One", [EMPLOYEE]: "Employee One" };
  const labels = (
    messages as unknown as {
      equity: {
        capTable: { columns: Record<string, string> };
        waterfall: { columns: { total: string } };
      };
    }
  ).equity;
  const exportLabels = {
    title: "Cap table",
    dateRange: "As of",
    class: labels.capTable.columns.class!,
    holder: labels.capTable.columns.holder!,
    kind: () => "common",
    pool: "Available pool",
    column: (key: string) =>
      labels.capTable.columns[key === "instrumentOutstanding" ? "optionOutstanding" : key]!,
    total: labels.waterfall.columns.total,
  };
  // The page groups digits and shows a dash for none; the file keeps exact text.
  const plain = (value: string) => {
    const bare = value
      .replace(/[,%]/g, "")
      .replace(/(\.\d*?)0+$/, "$1")
      .replace(/\.$/, "");
    return bare === "—" || bare === "0" ? "" : bare;
  };
  for (const [dimension, instrument, query] of [
    ["class", "all", ""],
    ["holder", "all", ""],
    ["holder", "option", ""],
    ["holder", "share", ""],
    ["holder", "all", "employee"],
    ["class", "option", "cs"],
  ] as const) {
    const params = { sub: SUB, view: "captable", by: dimension, instrument, q: query };
    const view = {
      context: { ...context(), params },
      asOfControl,
      dimension,
      instrument,
      query,
      table: capTable,
      parties,
      hasAccountPolicy: true,
      accountsSetupHref: "/admin/setup/equity-account-policies",
      reportHref: null,
      asOfReportHref: null,
    };
    const screen = await mount(
      <EquityCapTablePanel view={view} />,
      `/equity?${new URLSearchParams(params)}`,
    );
    try {
      const exported = capTableExportData(
        {
          entity: { id: SUB, name: "Main", currency: "USD" },
          table: capTable,
          parties,
          hasAccountPolicy: true,
        },
        { dimension, instrument, query },
        exportLabels,
      ).groups[0]!;
      const headers = [...screen.host.querySelectorAll("th")].map((cell) => text(cell));
      assert.deepEqual(
        exported.columns,
        headers,
        `${dimension}/${instrument}/${query}: the same columns`,
      );
      const rows = [...screen.host.querySelectorAll("tbody tr")].map((row) =>
        [...row.querySelectorAll("td")].map((cell) => plain(text(cell))),
      );
      assert.equal(
        exported.rows.length,
        rows.length,
        `${dimension}/${instrument}/${query}: the same lines and totals row`,
      );
      exported.rows.forEach((row, index) => {
        assert.deepEqual(
          row.slice(1).map((cell) => plain(String(cell))),
          rows[index]!.slice(1),
          `${dimension}/${instrument}/${query}: line ${index} values`,
        );
      });
    } finally {
      await screen.close();
    }
  }
});

const periods = [
  { id: "p11", label: "P11 FY2026", endsOn: "2026-11-30", closeHref: "/close?run=close-p11" },
  {
    id: "p10",
    label: "P10 FY2026",
    endsOn: "2026-10-31",
    closeHref: "/close?fy=2026&q=P10+FY2026",
  },
];
const runsView = (overrides: Record<string, unknown> = {}) => ({
  context: context(),
  run: "compensation" as const,
  lines: "expense" as const,
  periods,
  periodId: "p11",
  throughDate: "2026-11-30",
  compensation: {
    subsidiaryId: SUB,
    throughDate: "2026-11-30",
    currency: "USD",
    lastRunThrough: "2026-10-31",
    total: "1250.0000",
    releaseTotal: "0.0000",
    releases: [],
    due: true,
    catchUpTotal: "0.0000",
    blocked: null,
    lines: [
      {
        securityId: "o1",
        securityNumber: "OPT-0001",
        holderPartyId: EMPLOYEE,
        kind: "option" as const,
        cumulative: "5250.0000",
        previous: "4000.0000",
        period: "1250.0000",
        catchUp: "0.0000",
      },
    ],
  },
  interest: null,
  refusal: null,
  refusalAction: null,
  catchUp: null,
  blocked: null,
  compensationRuns: [
    {
      id: "run1",
      throughDate: "2026-10-31",
      total: "4000.0000",
      currency: "USD",
      journalEntryId: "je1",
      entryNumber: "EQ-SBC-2026-10-31",
      releaseTotal: "1800.0000",
      releaseJournalEntryId: "je2",
      releaseEntryNumber: "EQ-RSR-2026-10-31",
      createdAt: "2026-11-02",
    },
  ],
  interestRuns: [],
  parties: { [EMPLOYEE]: "Employee One" },
  historyOpen: false,
  historyHref: `/equity?sub=${SUB}&view=compensation&history=1`,
  historyCloseHref: `/equity?sub=${SUB}&view=compensation`,
  reportHref: "/reports/custom/run/r3",
  periodsSetupHref: "/admin/setup/period-close",
  ...overrides,
});

test("stock compensation posts as a period run from its table toolbar, with run history one click away", async () => {
  const screen = await mount(
    <EquityRunsPanel view={runsView()} />,
    `/equity?view=compensation&sub=${SUB}`,
  );
  try {
    const toolbarLabels = [...screen.host.querySelectorAll("label span")].map((span) => text(span));
    for (const label of ["Run", "Period", "Lines"])
      assert.ok(toolbarLabels.includes(label), `${label} is a toolbar filter`);
    const post = [...screen.host.querySelectorAll("button")].find(
      (button) => text(button) === "Post stock compensation for P11 FY2026",
    );
    assert.ok(post && !post.disabled, "the run action names its period");
    assert.ok(
      post.closest("table") === null && post.closest("div")?.textContent?.includes("Run history"),
      "the action sits with the run filters, not in the body",
    );
    assert.equal(
      screen.host.querySelector(`a[href="/equity?sub=${SUB}&view=compensation&history=1"]`)
        ?.textContent,
      "Run history",
    );
    assert.equal(
      screen.host.querySelector('a[href="/reports/custom/run/r3"]')?.textContent,
      "Open the expense schedule report",
    );
    assert.ok(text(screen.host).includes("This run is a period close task."));
    assert.equal(
      screen.host.querySelector('a[href="/close?run=close-p11"]')?.textContent,
      "Open the P11 FY2026 close",
      "the close link opens this period’s close",
    );
    assert.ok(
      text(screen.host).includes("Through Nov 30, 2026"),
      "dates read in the native format",
    );
    assert.equal(screen.host.querySelectorAll("button[role=tab]").length, 0, "no sub-tabs");
  } finally {
    await screen.close();
  }
  const reader = await mount(
    <EquityRunsPanel view={runsView({ context: context({ canManage: false }) })} />,
  );
  try {
    assert.ok(
      ![...reader.host.querySelectorAll("button")].some((button) =>
        text(button).startsWith("Post "),
      ),
      "readers see the run without the post action",
    );
  } finally {
    await reader.close();
  }
  const posted = await mount(
    <EquityRunsPanel view={runsView({ periodId: "p10", throughDate: "2026-10-31" })} />,
  );
  try {
    const post = [...posted.host.querySelectorAll("button")].find((button) =>
      text(button).startsWith("Post stock compensation"),
    )!;
    assert.equal(post.disabled, true, "a period already run cannot post again");
    assert.ok(text(posted.host).includes("Posted for this period"));
  } finally {
    await posted.close();
  }
  const interest = await mount(
    <EquityRunsPanel
      view={runsView({
        run: "interest",
        compensation: null,
        interest: {
          subsidiaryId: SUB,
          throughDate: "2026-11-30",
          currency: "USD",
          lastRunThrough: null,
          total: "82.1900",
          lines: [],
          due: true,
          blocked: null,
        },
      })}
    />,
  );
  try {
    assert.ok(
      [...interest.host.querySelectorAll("button")].some(
        (button) => text(button) === "Post note interest for P11 FY2026",
      ),
    );
    assert.ok(
      ![...interest.host.querySelectorAll("label span")].some((span) => text(span) === "Lines"),
      "note interest has no release lines",
    );
  } finally {
    await interest.close();
  }
  const blocked = {
    message:
      "The stock compensation run through Nov 30, 2026 falls in P11 FY2026, which ends on Nov 30, 2026, after today (Nov 20, 2026).",
    remedy: "Run through the end of a period that has ended by today.",
  };
  const early = await mount(
    <EquityRunsPanel
      view={runsView({
        blocked,
        catchUp:
          "$106.70 of stock compensation recognized through Oct 31, 2026 was recorded after the run through that date and has not posted.",
      })}
    />,
  );
  try {
    const post = [...early.host.querySelectorAll("button")].find((button) =>
      text(button).startsWith("Post stock compensation"),
    )!;
    assert.equal(post.disabled, true, "a period that has not ended cannot post");
    const notices = [...early.host.querySelectorAll("[role=status]")].map((node) => text(node));
    assert.ok(
      notices.some(
        (notice) =>
          notice.includes("after today (Nov 20, 2026)") &&
          notice.includes("Run through the end of a period that has ended"),
      ),
      "the run says why it cannot post yet",
    );
    assert.ok(
      notices.some((notice) => notice.startsWith("$106.70 of stock compensation")),
      "cost recorded after the last run is due with its amount",
    );
  } finally {
    await early.close();
  }
  const caughtUp = await mount(
    <EquityRunsPanel
      view={runsView({ compensation: { ...runsView().compensation, catchUpTotal: "106.7000" } })}
    />,
  );
  try {
    assert.ok(
      text(caughtUp.host).includes(
        "includes $106.70 recognized through Oct 31, 2026 and recorded after the run through that date",
      ),
      "the run names what it catches up",
    );
  } finally {
    await caughtUp.close();
  }
  const unconfigured = await mount(
    <EquityRunsPanel
      view={runsView({ periods: [], periodId: null, throughDate: null, compensation: null })}
    />,
  );
  try {
    assert.ok(text(unconfigured.host).includes("No accounting periods"));
    assert.equal(
      unconfigured.host.querySelector('a[href="/admin/setup/period-close"]')?.textContent,
      "Set up periods",
    );
  } finally {
    await unconfigured.close();
  }
});

const SA = "c0000000-0000-4000-8000-0000000000a1";
const scenario = {
  entity: { id: SUB, name: "Northstar Cloud", currency: "USD" },
  grossExitValue: "67200000.0000",
  transactionFees: "0.0000",
  result: {
    exitValue: "67200000.0000",
    pricePerCommonShare: "3.2000000000",
    classes: [
      {
        shareClassId: SA,
        code: "SERIESA",
        kind: "preferred" as const,
        seniority: 2,
        participationMode: "none" as const,
        converted: true,
        preference: "0.0000",
        participation: "14000000.0000",
        total: "14000000.0000",
        perShare: "3.2000000000",
        preferenceEntitlement: "14000000.0000",
        participationCap: null,
        alternativeTotal: "14000000.0000",
      },
      {
        shareClassId: COMMON,
        code: "CS",
        kind: "common" as const,
        seniority: 0,
        participationMode: "none" as const,
        converted: false,
        preference: "0.0000",
        participation: "53200000.0000",
        total: "53200000.0000",
        perShare: "3.2000000000",
        preferenceEntitlement: "0.0000",
        participationCap: null,
        alternativeTotal: null,
      },
    ],
    payouts: [
      {
        securityId: "s1",
        holderPartyId: HOLDER,
        kind: "share" as const,
        shareClassId: SA,
        amount: "14000000.0000",
      },
      {
        securityId: "s2",
        holderPartyId: HOLDER,
        kind: "share" as const,
        shareClassId: COMMON,
        amount: "53200000.0000",
      },
    ],
    holders: [{ holderPartyId: HOLDER, amount: "67200000.0000", percent: "100.0000" }],
    safes: [],
    unallocated: "0.0000",
  },
  curve: [],
  parties: { [HOLDER]: "Founder One" },
  classes: { [SA]: "SERIESA", [COMMON]: "CS" },
};

test("the waterfall opens computed on the latest post-money, with preset multiples and each class decision explained", async () => {
  const view = {
    context: { ...context(), params: { sub: SUB, view: "waterfall" } },
    asOfControl,
    anchor: { roundName: "Series A", closedOn: "2025-09-30", postMoney: "67200000.0000" },
    presets: [
      { multiple: "0.5", value: "33600000.0000" },
      { multiple: "1", value: "67200000.0000" },
      { multiple: "2", value: "134400000.0000" },
      { multiple: "5", value: "336000000.0000" },
    ],
    classOrder: [COMMON, SA],
    inputs: {
      exitValue: "67200000.0000",
      transactionFees: "",
      unvestedAwards: "participate" as const,
      changeOfControl: true,
      terminated: false,
    },
    scenario,
    refusal: null,
  };
  const screen = await mount(
    <EquityWaterfallPanel view={view} />,
    `/equity?view=waterfall&sub=${SUB}`,
  );
  try {
    const chips = [...screen.host.querySelectorAll("button[aria-pressed]")];
    assert.deepEqual(
      chips.map((chip) => [text(chip), chip.getAttribute("aria-pressed")]),
      [
        ["0.5×", "false"],
        ["1×", "true"],
        ["2×", "false"],
        ["5×", "false"],
      ],
    );
    const exit = screen.host.querySelector<HTMLInputElement>("input[inputmode=decimal]")!;
    assert.equal(exit.value, "67,200,000.00", "the exit reads as a localized amount");
    await act(async () => {
      exit.focus();
    });
    assert.equal(
      exit.value,
      "67200000",
      "editing shows the digits without grouping or ledger zeros",
    );
    assert.deepEqual(
      [exit.selectionStart, exit.selectionEnd],
      [0, 8],
      "selected, so typing replaces the amount",
    );
    await act(async () => {
      exit.blur();
    });
    const body = text(screen.host);
    for (const label of [
      "Proceeds to holders",
      "Per common share",
      "Payment cascade",
      "Conversion decisions",
      "As of",
    ])
      assert.ok(body.includes(label), label);
    assert.ok(
      body.includes(
        "Converts to common for $14,000,000.00; keeping its $14,000,000.00 preference would pay $14,000,000.00.",
      ),
    );
    const payouts = [...screen.host.querySelectorAll("tbody tr")].map(cells);
    assert.equal(payouts.length, 3);
    assert.ok(payouts[0]!.startsWith("SERIESA Converts to common"));
    assert.equal(payouts[2], "Total $67,200,000.00 100.00%", "the payouts sum to the proceeds");
  } finally {
    await screen.close();
  }
  const prompt = await mount(
    <EquityWaterfallPanel
      view={{
        ...view,
        anchor: null,
        presets: [],
        inputs: { ...view.inputs, exitValue: "" },
        scenario: null,
      }}
    />,
  );
  try {
    assert.ok(text(prompt.host).includes("Enter an exit value"));
    assert.ok(text(prompt.host).includes("No priced round in USD anchors the presets yet."));
    assert.equal(prompt.host.querySelectorAll("button[aria-pressed]").length, 0);
  } finally {
    await prompt.close();
  }
});

const pending = (requestedBy: string): PendingRequest => ({
  id: "r0000000-0000-4000-8000-000000000001",
  action: "reserve_change",
  subjectId: "p1",
  subjectLabel: "EIP",
  effectiveOn: "2026-07-15",
  reason: "Board approved a pool top-up",
  requestedBy,
  requestedByName: "Equity Manager",
  createdAt: "2026-07-15T10:00:00Z",
});

test("a pending governed action links to the Inbox, and only its requester may withdraw it there", async () => {
  const own = await mount(
    <PendingActions context={{ pending: [pending(ACTOR)], actorId: ACTOR }} />,
  );
  try {
    assert.ok(
      text(own.host).includes(
        "Reserve change · EIP · effective Jul 15, 2026 · requested by Equity Manager",
      ),
      "the date reads in the native format",
    );
    assert.equal(
      own.host.querySelector("a")?.getAttribute("href"),
      "/inbox?tab=submitted",
      "the requester follows it to their submissions",
    );
    assert.equal(text(own.host.querySelector("a")), "Open Inbox");
    assert.ok(
      [...own.host.querySelectorAll("button")].some(
        (button) => text(button) === "Withdraw submission",
      ),
    );
  } finally {
    await own.close();
  }
  const other = await mount(
    <PendingActions
      context={{ pending: [pending("u0000000-0000-4000-8000-000000000099")], actorId: ACTOR }}
    />,
  );
  try {
    assert.equal(
      other.host.querySelector("a")?.getAttribute("href"),
      "/inbox",
      "everyone else follows it to the approvals home",
    );
    assert.equal(
      other.host.querySelectorAll("button").length,
      0,
      "no one else is offered the withdrawal",
    );
  } finally {
    await other.close();
  }
});

test("run history opens each posted entry, release entries included, through the native journal-entry link", async () => {
  const screen = await mount(
    <EquityRunsPanel view={runsView({ historyOpen: true })} />,
    `/equity?view=compensation&sub=${SUB}&history=1`,
  );
  try {
    const dialog = document.querySelector("[role=dialog]") ?? screen.host;
    const links = [...dialog.querySelectorAll("a")].map((link) => [
      text(link),
      link.getAttribute("href"),
    ]);
    assert.ok(
      links.some(([label, href]) => label === "EQ-SBC-2026-10-31" && href?.includes("txn=je1")),
      JSON.stringify(links),
    );
    assert.ok(
      links.some(([label, href]) => label === "EQ-RSR-2026-10-31" && href?.includes("txn=je2")),
      "the restricted-stock release entry is linked",
    );
    assert.ok(
      !links.some(([, href]) => href?.includes("/journal?entry=")),
      "never the manual-journal editor",
    );
    assert.ok(text(dialog).includes("Oct 31, 2026"));
    assert.ok(text(dialog).includes("$1,800.00"), "the deposits the run released");
  } finally {
    await screen.close();
  }
});

test("the cap table totals fill authorized shares and percentages, and the holder view carries the unallocated pool", async () => {
  const base = {
    context: { ...context(), params: { sub: SUB, view: "captable" } },
    asOfControl,
    query: "",
    table: capTable,
    parties: { [HOLDER]: "Founder One", [EMPLOYEE]: "Employee One" },
    hasAccountPolicy: true,
    accountsSetupHref: "/admin/setup/equity-account-policies",
    reportHref: null,
    asOfReportHref: null,
  };
  const byClass = await mount(
    <EquityCapTablePanel
      view={{ ...base, dimension: "class" as const, instrument: "all" as const }}
    />,
  );
  try {
    const rows = [...byClass.host.querySelectorAll("tbody tr")].map(cells);
    assert.equal(
      rows.at(-1),
      "Total 10,000,000 4,000,000 4,000,000 48,000 952,000 5,000,000 100.00% 100.00%",
    );
  } finally {
    await byClass.close();
  }
  const byHolder = await mount(
    <EquityCapTablePanel
      view={{ ...base, dimension: "holder" as const, instrument: "all" as const }}
    />,
  );
  try {
    const rows = [...byHolder.host.querySelectorAll("tbody tr")].map(cells);
    assert.ok(rows.includes("Available pool — — — — 952,000 — 19.04%"), JSON.stringify(rows));
    assert.equal(
      rows.at(-1),
      "Total 4,000,000 48,000 — — 5,000,000 100.00% 100.00%",
      "holders and the pool add up to the fully diluted total",
    );
  } finally {
    await byHolder.close();
  }
});

const securityRow = (overrides: Record<string, unknown> = {}) => ({
  id: "s0000000-0000-4000-8000-000000000001",
  securityNumber: "OPT-0004",
  kind: "option" as const,
  holderPartyId: EMPLOYEE,
  holderName: "Employee One",
  shareClassCode: "CS",
  planCode: "EIP",
  issueDate: "2024-06-27",
  status: "outstanding",
  quantity: "48000",
  outstanding: "48000",
  vested: "12000",
  price: "0.7897999205",
  principal: null,
  outstandingAmount: null,
  resultingSecurityId: null,
  resultingSecurityNumber: null,
  currency: "USD",
  election83b: null,
  href: "/equity?view=securities&security=s1",
  ...overrides,
});

test("the securities register reads dates and prices in the native formats and keeps its page in the URL", async () => {
  const rows = Array.from({ length: 12 }, (_, index) =>
    securityRow({
      id: `s0000000-0000-4000-8000-0000000000${String(index).padStart(2, "0")}`,
      securityNumber: `OPT-${String(index + 1).padStart(4, "0")}`,
    }),
  );
  const view = {
    context: {
      ...context(),
      params: { sub: SUB, view: "securities" },
      list: { page: 2, query: "", sort: "default", dir: "asc" as const },
    },
    asOfControl,
    kind: null,
    status: null,
    holderPartyId: null,
    holders: [],
    rows,
    convertibles: [],
    reportHref: "/reports/custom/run/r1?period=custom&from=2026-12-15&to=2026-12-15",
  };
  const screen = await mount(
    <EquitySecuritiesPanel view={view} />,
    `/equity?view=securities&sub=${SUB}&page=2`,
  );
  try {
    const first = [...screen.host.querySelectorAll("tbody tr")].map(cells)[0]!;
    assert.ok(first.startsWith("OPT-0011"), "the second page opens from the URL");
    assert.ok(first.includes("Jun 27, 2024"), "the issue date reads natively");
    assert.ok(first.includes("$0.7898"), "a long stored price reads at four places");
    assert.equal(
      screen.host.querySelector('a[href^="/reports/custom/run/r1"]')?.getAttribute("href"),
      "/reports/custom/run/r1?period=custom&from=2026-12-15&to=2026-12-15",
      "the register opens as of this date",
    );
  } finally {
    await screen.close();
  }
});

test("the securities register filters by the search in the URL on load, never matching its own links", async () => {
  const kinds = ["option", "safe", "option", "safe", "share"] as const;
  const rows = kinds.map((kind, index) =>
    securityRow({
      id: `s0000000-0000-4000-8000-0000000001${String(index).padStart(2, "0")}`,
      kind,
      securityNumber: `${kind === "safe" ? "SAFE" : kind === "share" ? "CS" : "OPT"}-000${index + 1}`,
      // Each row's drawer link carries the list's own search, as the loader builds it.
      href: `/equity?sub=${SUB}&view=securities&q=SAFE&security=s${index}`,
    }),
  );
  const view = {
    context: {
      ...context(),
      params: { sub: SUB, view: "securities", q: "SAFE" },
      list: { page: 1, query: "SAFE", sort: "default", dir: "asc" as const },
    },
    asOfControl,
    kind: null,
    status: null,
    holderPartyId: null,
    holders: [],
    rows,
    convertibles: [],
    reportHref: null,
  };
  const screen = await mount(
    <EquitySecuritiesPanel view={view} />,
    `/equity?view=securities&sub=${SUB}&q=SAFE`,
  );
  try {
    assert.equal(
      (screen.host.querySelector('input[aria-label="Search"]') as HTMLInputElement).value,
      "SAFE",
    );
    const listed = [...screen.host.querySelectorAll("tbody tr")].map(cells);
    assert.deepEqual(
      listed.map((row) => row.split(" ")[0]),
      ["SAFE-0002", "SAFE-0004"],
      "only the SAFEs match, not every row whose link carries the search",
    );
    assert.equal(
      new URL(window.location.href).searchParams.get("q"),
      "SAFE",
      "the search stays in the URL",
    );
  } finally {
    await screen.close();
  }
});

test("the securities register sorts by the column in the URL, and its headers link the next sort", async () => {
  const rows = ["Zed Holder", "Ann Holder", "Mia Holder"].map((holderName, index) =>
    securityRow({
      id: `s0000000-0000-4000-8000-0000000002${String(index).padStart(2, "0")}`,
      securityNumber: `OPT-000${index + 1}`,
      holderName,
    }),
  );
  const view = {
    context: {
      ...context(),
      params: { sub: SUB, view: "securities", sort: "holder", dir: "desc" },
      list: { page: 1, query: "", sort: "holder", dir: "desc" as const },
    },
    asOfControl,
    kind: null,
    status: null,
    holderPartyId: null,
    holders: [],
    rows,
    convertibles: [],
    reportHref: null,
  };
  const screen = await mount(
    <EquitySecuritiesPanel view={view} />,
    `/equity?view=securities&sub=${SUB}&sort=holder&dir=desc`,
  );
  try {
    const listed = [...screen.host.querySelectorAll("tbody tr")].map(cells);
    assert.deepEqual(
      listed.map((row) => row.split(" ")[0]),
      ["OPT-0001", "OPT-0003", "OPT-0002"],
      "Zed, Mia, Ann",
    );
    const holderHeader = [...screen.host.querySelectorAll("thead a")].find(
      (link) => text(link) === "Holder",
    )!;
    const next = new URL(holderHeader.getAttribute("href")!, "http://localhost");
    assert.equal(next.searchParams.get("sort"), "holder");
    assert.equal(next.searchParams.get("dir"), "asc", "the active column flips direction");
    assert.equal(next.searchParams.get("view"), "securities");
  } finally {
    await screen.close();
  }
});

test("links into another view leave the list search, page and sort behind, and links within the view keep them", async () => {
  const { withParams } = await import("./shared");
  const params = {
    sub: SUB,
    view: "stakeholders",
    q: "Employee",
    page: "2",
    sort: "name",
    dir: "desc",
    asOf: "2026-06-30",
  };
  const other = new URL(
    withParams("/equity", params, { view: "securities", holder: "p1" }),
    "http://localhost",
  ).searchParams;
  assert.deepEqual([...other.keys()].sort(), ["asOf", "holder", "sub", "view"]);
  const same = new URL(withParams("/equity", params, { new: "stakeholder" }), "http://localhost")
    .searchParams;
  assert.equal(same.get("q"), "Employee");
  assert.equal(same.get("sort"), "name");
});

test("stakeholder search reads from the URL and writes back as it changes", async () => {
  const view = {
    context: {
      ...context(),
      params: { sub: SUB, view: "stakeholders" },
      list: { page: 1, query: "Employee", sort: "default", dir: "asc" as const },
    },
    asOfControl,
    table: capTable,
    parties: {
      [HOLDER]: { name: "Founder One", kind: "person", email: null },
      [EMPLOYEE]: { name: "Employee One", kind: "person", email: "employee@example.com" },
    },
  };
  const screen = await mount(
    <EquityStakeholdersPanel view={view} />,
    `/equity?view=stakeholders&sub=${SUB}&q=Employee`,
  );
  try {
    assert.equal(
      (screen.host.querySelector('input[aria-label="Search"]') as HTMLInputElement).value,
      "Employee",
    );
    const rows = [...screen.host.querySelectorAll("tbody tr")].map(cells);
    assert.equal(rows.length, 1);
    assert.ok(rows[0]!.startsWith("Employee One"));
    assert.equal(new URL(window.location.href).searchParams.get("q"), "Employee");
  } finally {
    await screen.close();
  }
});

test("a search or filter that matches nothing says so, while a list with no records teaches how to add one", async () => {
  const searching = (view: string, query: string) => ({
    ...context(),
    params: { sub: SUB, view, q: query },
    list: { page: 1, query, sort: "default", dir: "asc" as const },
  });
  const parties = {
    [HOLDER]: { name: "Founder One", kind: "person", email: null },
    [EMPLOYEE]: { name: "Employee One", kind: "person", email: null },
  };
  const structure = {
    entity: { id: SUB, name: "Northstar Cloud", currency: "USD" },
    classes: [],
    plans: [],
    rounds: [],
    voidedRounds: [],
  };
  const bodies: Record<string, string> = {};
  const read = async (name: string, node: React.ReactNode, url: string) => {
    const screen = await mount(node, url);
    try {
      bodies[name] = text(screen.host);
    } finally {
      await screen.close();
    }
  };
  await read(
    "classes",
    <EquityClassesPanel
      view={
        {
          context: searching("classes", "zzz"),
          asOfControl,
          structure,
          classRows: capTable.classes,
        } as never
      }
    />,
    `/equity?view=classes&sub=${SUB}&q=zzz`,
  );
  await read(
    "plans",
    <EquityPlansPanel
      view={
        {
          context: searching("plans", "zzz"),
          asOfControl,
          structure: {
            ...structure,
            plans: [
              {
                id: "p1",
                code: "EIP",
                name: "Equity Incentive Plan",
                shareClassId: COMMON,
                reserved: "1000000",
                adoptedOn: "2024-01-01",
              },
            ],
          },
          classRows: capTable.classes,
        } as never
      }
    />,
    `/equity?view=plans&sub=${SUB}&q=zzz`,
  );
  await read(
    "stakeholders",
    <EquityStakeholdersPanel
      view={{ context: searching("stakeholders", "zzz"), asOfControl, table: capTable, parties }}
    />,
    `/equity?view=stakeholders&sub=${SUB}&q=zzz`,
  );
  const capTableView = (query: string) => ({
    context: {
      ...context(),
      params: { sub: SUB, view: "captable", by: "holder", ...(query ? { q: query } : {}) },
    },
    asOfControl,
    dimension: "holder" as const,
    instrument: "all" as const,
    query,
    table: capTable,
    parties: { [HOLDER]: "Founder One", [EMPLOYEE]: "Employee One" },
    hasAccountPolicy: true,
    accountsSetupHref: "/admin/setup/equity-account-policies",
    reportHref: null,
    asOfReportHref: null,
  });
  await read(
    "capTable",
    <EquityCapTablePanel view={capTableView("zzz") as never} />,
    `/equity?view=captable&sub=${SUB}&by=holder&q=zzz`,
  );
  const securities = (
    filters: { status: string | null },
    rows: ReturnType<typeof securityRow>[],
  ) => ({
    context: {
      ...context(),
      params: {
        sub: SUB,
        view: "securities",
        ...(filters.status ? { status: filters.status } : {}),
      },
    },
    asOfControl,
    kind: null,
    status: filters.status,
    holderPartyId: null,
    holders: [],
    rows,
    convertibles: [],
    reportHref: null,
  });
  await read(
    "securitiesFiltered",
    <EquitySecuritiesPanel view={securities({ status: "void" }, [])} />,
    `/equity?view=securities&sub=${SUB}&status=void`,
  );
  await read(
    "securitiesEmpty",
    <EquitySecuritiesPanel view={securities({ status: null }, [])} />,
    `/equity?view=securities&sub=${SUB}`,
  );
  assert.ok(
    bodies.classes!.includes("No share classes match.") &&
      !bodies.classes!.includes("No share classes yet"),
    bodies.classes!,
  );
  assert.ok(
    bodies.plans!.includes("No equity plans match.") &&
      !bodies.plans!.includes("No equity plans yet"),
    bodies.plans!,
  );
  assert.ok(
    bodies.stakeholders!.includes("No holders match.") && !bodies.stakeholders!.includes("yet"),
    bodies.stakeholders!,
  );
  assert.ok(
    bodies.capTable!.includes("No holders match.") && !bodies.capTable!.includes("No holders yet"),
    bodies.capTable!,
  );
  assert.ok(
    bodies.securitiesFiltered!.includes("No securities match."),
    bodies.securitiesFiltered!,
  );
  assert.ok(
    bodies.securitiesEmpty!.includes("No securities yet. Use New security") &&
      !bodies.securitiesEmpty!.includes("match"),
    "an empty register teaches instead of claiming a mismatch",
  );
});

test("the round modeller names its pool top-up and pool share unambiguously, and a refused model shows its refusal instead of stale results", async () => {
  const originalFetch = globalThis.fetch;
  const responses = [
    new Response(
      JSON.stringify({
        result: {
          pricePerShare: "3.5172186210",
          postMoneyValuation: "80000000.0000",
          investorShares: "3980000",
          investorPercent: "17.5000",
          fullyDilutedAfter: "22742857",
          conversionShares: "0",
          poolTopUp: "931902",
          poolPercentAfter: "10.0000",
          antiDilutionShares: "0",
          investorCashRounding: "0.4100",
          dilution: [],
          conversions: [],
        },
        parties: {},
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ),
    new Response(
      JSON.stringify({
        error: "The investment must be greater than zero.",
        remedy: "Enter the new money the round raises.",
      }),
      { status: 422, headers: { "Content-Type": "application/json" } },
    ),
  ];
  globalThis.fetch = (async () => responses.shift()!) as typeof fetch;
  const view = {
    context: { ...context(), params: { sub: SUB, view: "rounds", model: "round" } },
    structure: {
      entity: { id: SUB, name: "Main", currency: "USD" },
      classes: [],
      plans: [],
      rounds: [],
      voidedRounds: [],
    },
    modelOpen: true,
    modelHref: "/equity?model=round",
    modelCloseHref: "/equity",
    roundId: null,
    roundCloseHref: "/equity?view=rounds",
  } as unknown as Parameters<typeof EquityRoundsPanel>[0]["view"];
  const screen = await mount(
    <EquityRoundsPanel view={view} />,
    `/equity?view=rounds&sub=${SUB}&model=round`,
  );
  try {
    const dialog = document.querySelector("[role=dialog]")!;
    const inputs = [...dialog.querySelectorAll("input")] as HTMLInputElement[];
    const type = async (input: HTMLInputElement, value: string) =>
      act(async () => {
        Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(
          input,
          value,
        );
        input.dispatchEvent(new window.Event("input", { bubbles: true }));
      });
    await type(inputs[0]!, "66000000");
    await type(inputs[1]!, "14000000");
    const run = [...dialog.querySelectorAll("button")].find((button) => text(button) === "Model")!;
    await act(async () => {
      run.click();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    const body = text(dialog);
    assert.ok(body.includes("Pool top-up931,902 new shares"), body);
    assert.ok(body.includes("Pool after the round10.00% of fully diluted"));
    assert.ok(body.includes("$3.5172"), "the round price reads at four places");
    await act(async () => {
      run.click();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    const refused = text(dialog);
    assert.ok(
      refused.includes("The investment must be greater than zero."),
      "the refusal pins beside the form",
    );
    assert.ok(!refused.includes("931,902"), "the refused run leaves no stale result");
  } finally {
    globalThis.fetch = originalFetch;
    await screen.close();
  }
});
