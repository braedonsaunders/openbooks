import assert from "node:assert/strict";
import test from "node:test";

const { stubModules } = await import("../../../../testing/stub-modules");
stubModules({ navigation: "export function useRouter(){return {push(){},refresh(){},replace(){}}}", intl: true });

const React = await import("react");
Object.assign(globalThis, { React });
const { renderToStaticMarkup } = await import("react-dom/server");
const { NextIntlClientProvider } = await import("next-intl");
const messages = (await import("../../../../messages/en")).default;
const {
  BomRevisionEvidence,
  ChangeEvidence,
  RoutingRevisionEvidence,
  humanizeFieldKey,
} = await import("./ChangeEvidence");

function render(node: React.ReactElement): string {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
      {node}
    </NextIntlClientProvider>,
  );
}

const COMP_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const COMP_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const COMP_C = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const WC = "dddddddd-dddd-dddd-dddd-dddddddddddd";
const names = {
  [COMP_A]: "RM-1 — Steel blank",
  [COMP_B]: "RM-2 — Bracket",
  [COMP_C]: "RM-3 — Gasket",
  [WC]: "WC-1 — Assembly",
};

test("humanized keys read as labels instead of the catch-all", () => {
  assert.equal(humanizeFieldKey("customMystery"), "Custom mystery");
  assert.equal(humanizeFieldKey("some_snake_key"), "Some snake key");
  assert.equal(humanizeFieldKey("quantityPer"), "Quantity per");
});

test("recipe revisions render as an old-vs-new diff with named components", () => {
  const markup = render(
    <BomRevisionEvidence
      before={{
        kind: "assembly",
        version: "v1",
        lines: [
          { componentItemId: COMP_A, quantityPer: "16", sortOrder: 0, effectiveFrom: "2026-01-01", effectiveTo: null, operationSeq: 10, scrapPct: "0", isByproduct: false, quantityBasis: "per_unit" },
          { componentItemId: COMP_B, quantityPer: "1.0000", sortOrder: 1, effectiveFrom: "2026-01-01", effectiveTo: null, operationSeq: null, scrapPct: null, isByproduct: false, quantityBasis: "per_unit" },
        ],
      }}
      after={{
        components: [
          { componentItemId: COMP_A, quantityPer: "18", sortOrder: 0, effectiveFrom: "2026-07-15", effectiveTo: null, operationSeq: 10, scrapPct: "1.5000", isByproduct: false, quantityBasis: "per_unit" },
          { componentItemId: COMP_C, quantityPer: "0.4464", sortOrder: 1, effectiveFrom: "2026-07-15", effectiveTo: null, operationSeq: 20, scrapPct: null, isByproduct: true, quantityBasis: "per_unit" },
        ],
      }}
      names={names}
    />,
  );
  assert.match(markup, /RM-1 — Steel blank/, "components resolve to code and name");
  assert.match(markup, /RM-3 — Gasket/, "added components resolve too");
  assert.match(markup, /Added/, "added lines are marked");
  assert.match(markup, /Removed/, "removed lines are retained and marked");
  assert.match(markup, /Changed/, "changed lines are marked");
  assert.match(markup, /16 → 18/, "changed lines carry old → new values");
  assert.match(markup, /By-product output/, "flags use catalog labels");
  assert.doesNotMatch(markup, /Additional accounting detail/, "no catch-all labels");
  assert.doesNotMatch(markup, new RegExp(COMP_A), "no raw component ids");
  assert.doesNotMatch(markup, new RegExp(COMP_B), "no raw removed-component ids");
});

test("routing revisions render operations with work centers and times", () => {
  const markup = render(
    <RoutingRevisionEvidence
      evidence={{
        candidate: {
          id: "routing-1",
          code: "RTG-7",
          effectiveFrom: "2026-07-15",
          operations: [
            { sequence: 10, name: "Assemble housing", workCenterId: WC, setupMinutes: "5", runMinutesPerUnit: "0.4464", laborMinutesPerUnit: "1.0000", qualityGate: "none", backflushAt: "finish", laborTimeSource: "reported" },
          ],
        },
        active: [],
        supersedes: [{ id: "old-routing", version: 3, effectiveFrom: "2025-01-01", effectiveTo: "2026-07-15" }],
      }}
      names={names}
    />,
  );
  assert.match(markup, /Assemble housing/, "operations render by name");
  assert.match(markup, /WC-1 — Assembly/, "work centers resolve to code and name");
  assert.match(markup, /0\.4464/, "exact times render unrounded");
  assert.match(markup, /Superseded revisions/, "superseded revisions are named");
  assert.match(markup, /Version 3/, "superseded versions render");
  assert.doesNotMatch(markup, new RegExp(WC), "no raw work-center ids");
  assert.doesNotMatch(markup, /Additional accounting detail/, "no catch-all labels");
});

test("other proposals label every known field and humanize the rest", () => {
  const grant = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";
  const markup = render(
    <ChangeEvidence
      value={{ grantId: grant, estimate: "1500.00", customMystery: "x" }}
      names={{ [grant]: "GR-9 — Prepaid grant" }}
    />,
  );
  assert.match(markup, /Grant/, "known fields use catalog labels");
  assert.match(markup, /Settlement estimate/, "known fields use catalog labels");
  assert.match(markup, /GR-9 — Prepaid grant/, "referenced ids resolve");
  assert.match(markup, /Custom mystery/, "unknown fields humanize their key");
  assert.doesNotMatch(markup, /Additional accounting detail/, "no catch-all labels");
  assert.doesNotMatch(markup, new RegExp(grant), "no raw ids");
});
