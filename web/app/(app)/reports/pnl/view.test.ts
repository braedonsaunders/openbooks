import assert from "node:assert/strict";
import test from "node:test";
import type { PnlData } from "./view";

const { pnlSpec } = await import("./view");

// enabling Multi-subsidiary crashed P&L with React error 441 —
// the loader converts the typed rates refusal into a banner with a derive
// link instead of throwing it out of SSR. These tests pin the spec half of
// that contract: given blocked data, the page shows the banner and hides
// the paper. (The loader half needs a database and has no unit interface.)
function blockedData(): PnlData {
  return {
    ratesBlocked: {
      code: "rates-not-derived",
      title: "Rates have not been derived",
      description: "No consolidated exchange rates for EUR for March 2026.",
      deriveLabel: "Derive rates",
      deriveHref: "/close",
    },
    ratesReady: false,
  } as unknown as PnlData;
}

function blocksOf(spec: unknown): Record<string, unknown>[] {
  const found: Record<string, unknown>[] = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (typeof node === "object" && node !== null) {
      found.push(node as Record<string, unknown>);
      for (const value of Object.values(node)) visit(value);
    }
  };
  visit((spec as { body: unknown }).body);
  return found;
}

test("a rates refusal renders as a derive banner gated on the block", () => {
  const blocks = blocksOf(pnlSpec(blockedData()));
  const banner = blocks.find((block) => block.widget === "empty-state");
  assert.ok(banner, "the blocked statement must render an empty-state banner");
  assert.deepEqual(
    banner.when,
    { $: "ratesBlocked" },
    "the banner shows exactly while the notice is set",
  );
  const props = banner.props as Record<string, unknown>;
  assert.equal(props.title, "Rates have not been derived");
  assert.equal(props.description, "No consolidated exchange rates for EUR for March 2026.");
  assert.equal(props.action, "link-button");
  const actionProps = props.actionProps as Record<string, unknown>;
  assert.equal(actionProps.href, "/close", "the banner must link to period close to derive rates");
  assert.equal(actionProps.label, "Derive rates");
});

test("the paper hides while rates are blocked", () => {
  const blocks = blocksOf(pnlSpec(blockedData()));
  const paper = blocks.find((block) => block.kind === "paper");
  assert.ok(paper, "the statement paper must still be in the spec");
  assert.deepEqual(
    paper.when,
    { $: "ratesReady" },
    "the paper shows only when rates are ready — no numbers beside the banner",
  );
});

// A custom period without valid bounds refuses in place: the filter bar stays
// so the operator can set the dates, the refusal names the remedy, and the
// paper hides. It never falls back to another window.
function incompletePeriodData(): PnlData {
  return {
    periodRefusal: "A custom period needs both a From and a To date, with From on or before To.",
    filterPeriodLabel: "Period",
    ratesBlocked: null,
    ratesReady: false,
  } as unknown as PnlData;
}

test("an incomplete custom period keeps the filter bar and names the remedy", () => {
  const spec = pnlSpec(incompletePeriodData());
  const header = (spec as unknown as { header: Record<string, unknown>[] }).header;
  assert.ok(
    header.some((block) => block.kind === "filter-bar"),
    "the filter bar stays so the dates can be set",
  );
  const refusal = blocksOf(spec).find(
    (block) =>
      block.widget === "empty-state" &&
      JSON.stringify(block.when) === JSON.stringify({ $: "periodRefusal" }),
  );
  assert.ok(refusal, "the refusal renders as an empty-state gated on the period refusal");
  const props = refusal.props as Record<string, unknown>;
  assert.equal(props.title, "Period");
  assert.equal(props.description, incompletePeriodData().periodRefusal);
});

test("the paper hides while the custom period is incomplete", () => {
  const blocks = blocksOf(pnlSpec(incompletePeriodData()));
  const paper = blocks.find((block) => block.kind === "paper");
  assert.deepEqual(
    paper?.when,
    { $: "ratesReady" },
    "no statement numbers render beside the refusal",
  );
});

test("historical evidence refusal keeps the native banner and directs the operator to its journal source", () => {
  const data = blockedData();
  data.ratesBlocked = {
    code: "historical-evidence-required",
    title: "Historical contribution evidence is required",
    description:
      "The exact source needs retained genuine layers and Accounting event approval before Apply.",
    actionLabel: "Review journal source",
    actionHref: "/journal?journalEntry=10000000-0000-4000-8000-000000000001",
  };
  const blocks = blocksOf(pnlSpec(data));
  const banner = blocks.find((block) => block.widget === "empty-state");
  assert.ok(banner);
  assert.deepEqual(banner.when, { $: "ratesBlocked" });
  const props = banner.props as Record<string, unknown>;
  assert.equal(props.description, data.ratesBlocked.description);
  const action = props.actionProps as Record<string, unknown>;
  assert.equal(action.href, data.ratesBlocked.actionHref);
  assert.equal(action.label, "Review journal source");
  assert.equal(data.ratesReady, false);
  const paper = blocks.find((block) => block.kind === "paper" || block.widget === "paper-view");
  assert.ok(paper);
  assert.deepEqual(paper.when, { $: "ratesReady" });
});
