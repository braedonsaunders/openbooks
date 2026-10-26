import assert from "node:assert/strict";
import test from "node:test";

const { stubModules } = await import("../../../testing/stub-modules");
stubModules({
  navigation: true,
  intl: true,
  authz: true,
  features: true,
  extra: {
    "server-only": "export {}",
    "@openbooks/analytics/viz": "export function InsightChart(){return null}",
  },
});
const { equitySpec, EQUITY_VIEWS, VIEW_NEW_ACTION } = await import("./view");
const messages = (await import("../../../messages/en/index.ts")).default as unknown as {
  equity: { new: { actions: Record<string, string> } };
};

type Data = Parameters<typeof equitySpec>[0];
type Node = Record<string, unknown>;

function collect(node: unknown, match: (node: Node) => boolean, out: Node[] = []): Node[] {
  if (Array.isArray(node)) for (const item of node) collect(item, match, out);
  else if (node && typeof node === "object") {
    if (match(node as Node)) out.push(node as Node);
    for (const value of Object.values(node)) collect(value, match, out);
  }
  return out;
}
const widgets = (spec: unknown) =>
  collect(spec, (node) => typeof node.widget === "string").map((node) => node.widget as string);
const tiles = (spec: unknown) => collect(spec, (node) => node.kind === "stat-tile");

const base = {
  title: "Equity & cap table",
  description: "",
  entityPicker: [{ id: "s", label: "Northstar Cloud" }],
  entityLabel: "Legal entity",
  subsidiaryId: "s",
  asOf: "2026-10-18",
  asOfControl: { defaultPeriod: "today", periodPresets: ["today", "custom"] },
  hasEntity: true,
  noEntity: false,
  emptyTitle: "",
  emptyDescription: "",
  onOverview: false,
  onCapTable: false,
  onSecurities: false,
  onRounds: false,
  onWaterfall: false,
  onCompensation: false,
  onClasses: false,
  onPlans: false,
  onStakeholders: false,
  overview: null,
  hasRoundPulse: false,
  labels: {},
  capTable: null,
  securities: null,
  stakeholders: null,
  structure: null,
  rounds: null,
  waterfall: null,
  runs: null,
  drawerOpen: false,
  drawer: null,
  newOpen: false,
  newRecord: null,
};

const overview = {
  tiles: {
    fullyDiluted: "21,080,512",
    fullyDilutedSub: "17,290,000 outstanding as converted",
    pool: "1,204,000",
    poolSub: "5.7% of fully diluted",
    price: "$3.20",
    priceSub: "Series A · Sep 30, 2025",
    raised: "$18M",
    raisedSub: "Priced rounds $17.6M · SAFEs and notes $0.4M",
    compensation: "$412K",
    compensationSub: "Posted since Jan 1, 2026",
  },
  ownershipHint: "Fully diluted · Oct 18, 2026",
  ownership: [],
  roundPulse: { postMoney: "$67M", preMoney: "$53M", raised: "$14M" },
  attention: [],
  directory: [],
  activity: [],
  roundHref: "/equity?view=rounds&model=round",
};

test("every view offers at most one primary New action, labelled with the record it creates", () => {
  assert.deepEqual(Object.keys(VIEW_NEW_ACTION).sort(), [...EQUITY_VIEWS].sort());
  const labels = Object.fromEntries(
    EQUITY_VIEWS.map((view) => [
      view,
      VIEW_NEW_ACTION[view] ? messages.equity.new.actions[VIEW_NEW_ACTION[view]!] : null,
    ]),
  );
  assert.deepEqual(labels, {
    overview: "New security",
    captable: "New security",
    securities: "New security",
    rounds: "New round",
    waterfall: null,
    compensation: null,
    classes: "New share class",
    plans: "New plan",
    stakeholders: "New stakeholder",
  });
  for (const view of EQUITY_VIEWS) {
    const spec = equitySpec({
      ...base,
      view,
      newAction: { href: `/equity?new=x`, label: "New security" },
      hasNewAction: true,
    } as Data);
    const header = collect(
      (spec as { header: unknown }).header,
      (node) => node.widget === "link-button",
    );
    assert.equal(header.length, 1, `${view} has one primary action in the header`);
    assert.ok(
      !widgets(spec).includes("module-home-tabs"),
      `${view} leaves its tabs to the shared local navigation`,
    );
  }
});

test("the overview composes the module-home cockpit; working views carry no vitals", () => {
  const spec = equitySpec({
    ...base,
    view: "overview",
    onOverview: true,
    overview,
    hasRoundPulse: true,
    newAction: null,
    hasNewAction: false,
  } as Data);
  assert.equal(tiles(spec).length, 5, "five vitals tiles");
  for (const name of [
    "equity-ownership",
    "equity-activity",
    "ap-pulse",
    "attention-list",
    "directory-section",
    "equity-as-of",
  ]) {
    assert.ok(widgets(spec).includes(name), `${name} is on the overview`);
  }
  assert.ok(!widgets(spec).includes("kpi-strip"));
  for (const view of EQUITY_VIEWS.filter((key) => key !== "overview")) {
    const working = equitySpec({ ...base, view, newAction: null, hasNewAction: false } as Data);
    assert.equal(tiles(working).length, 0, `${view} shows no KPI tiles`);
    assert.ok(!widgets(working).includes("kpi-strip"), `${view} shows no KPI strip`);
  }
});

test("the overview leads its body with the as-of control and keeps the header to the title, description and actions", () => {
  const spec = equitySpec({
    ...base,
    view: "overview",
    onOverview: true,
    overview,
    hasRoundPulse: true,
    newAction: null,
    hasNewAction: false,
  } as Data);
  assert.ok(
    !widgets((spec as { header: unknown }).header).includes("equity-as-of"),
    "the header leaves room for its description",
  );
  assert.ok(widgets((spec as { body: unknown }).body).includes("equity-as-of"));
});
