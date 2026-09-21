import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { receivingMatchingVintageWeightsFromComputed } from "./consolidated-matching-replay.ts";

const SOURCE = readFileSync(new URL("./consolidated-matching-replay.ts", import.meta.url), "utf8");
const WORKPAPER = readFileSync(new URL("./asset-basis-workpaper.ts", import.meta.url), "utf8");

function sliceExport(name: string, next: string): string {
  const start = SOURCE.indexOf(`export async function ${name}`);
  const end = SOURCE.indexOf(`export async function ${next}`);
  assert.ok(start >= 0 && end > start, `${name} must precede ${next}`);
  return SOURCE.slice(start, end);
}

test("GET matching replay preview peeks the replacement and does not lock the financial change", () => {
  const preview = sliceExport("previewTaxMatchingReplay", "proposeTaxMatchingReplay");
  assert.match(preview, /buildReplayPreview\([\s\S]*"peek"\)/);
  assert.doesNotMatch(preview, /loadFinancialChange|fencedReplayPreview|"lock"/);
});

test("propose matching replay peeks seed identity, takes one fence, then locks the replacement", () => {
  const propose = sliceExport("proposeTaxMatchingReplay", "applyTaxMatchingReplay");
  const peekAt = propose.indexOf('readReplacementPaper(db, orgId, input.replacementWorkpaperChangeId, "peek")');
  const fenceAt = propose.indexOf("fencedReplayPreview");
  assert.ok(peekAt >= 0 && peekAt < fenceAt, "propose must peek the replacement before the lifecycle fence");
  assert.doesNotMatch(propose, /loadReplacementPaper|loadFinancialChange/);
  const fenced = SOURCE.slice(
    SOURCE.indexOf("async function fencedReplayPreview"),
    SOURCE.indexOf("export async function previewTaxMatchingReplay"),
  );
  assert.match(fenced, /readReplacementPaper\([\s\S]*"peek"\)/);
  const peekFence = fenced.indexOf('"peek"');
  const lockFence = fenced.indexOf("lockAssetTaxLifecycle");
  const lockedRead = fenced.indexOf('"lock"');
  assert.ok(peekFence >= 0 && peekFence < lockFence && lockFence < lockedRead);
  assert.equal((fenced.match(/lockAssetTaxLifecycle/g) ?? []).length, 1, "one fence, not an incremental second lock");
});

test("replay reconstructs header carryover+excess weights and carries the frozen transfer date", () => {
  assert.match(SOURCE, /receivingMatchingVintageWeightsFromComputed/);
  assert.match(SOURCE, /transferOn: args.paper.effectiveOn/);
  assert.match(SOURCE, /tax_matching_generation_repair/);
  assert.match(
    SOURCE,
    /approve tax_matching_generation_repair on this live replacement citing the last paper that still has posted matching/,
  );
});

test("header-only carryover+excess reconstructs both receiving vintage weights", () => {
  const weights = receivingMatchingVintageWeightsFromComputed({
    recognition: "taxable",
    section168i7Kind: "consolidated_group",
    placedInServiceOn: "2023-01-01",
    buyerPlacedInServiceOn: "2025-08-20",
    originalUnadjustedBasis: "100.00",
    carryoverBasis: "80.00",
    excessBasis: "50.00",
  }, "2025-08-20");
  assert.deepEqual(weights, [
    { vintageKey: "excess:2025-08-20:2025-08-20", amount: "50.0000" },
    { vintageKey: "carryover:2023-01-01:2025-08-20", amount: "100.0000" },
  ]);
});

test("reversal proposal checks required predecessor replay after the fenced idempotent return", () => {
  const propose = WORKPAPER.slice(
    WORKPAPER.indexOf("export async function proposeTaxAssetBasisReversal"),
    WORKPAPER.indexOf("export async function applyTaxAssetBasisReversal"),
  );
  const idempotent = propose.indexOf("if (prior) return prior");
  const already = propose.indexOf("this tax basis workpaper has already been reversed");
  const required = propose.indexOf("assertRequiredMatchingReplayBeforeReversal");
  assert.ok(idempotent >= 0 && already > idempotent && required > already);
  const apply = WORKPAPER.slice(WORKPAPER.indexOf("export async function applyTaxAssetBasisReversal"));
  const fence = apply.indexOf("lockAssetTaxLifecycle");
  const applied = apply.indexOf('if (change.status === "applied")');
  const applyRequired = apply.indexOf("assertRequiredMatchingReplayBeforeReversal");
  assert.ok(applied >= 0 && applied < fence && fence < applyRequired);
});

test("apply matching replay locks its own change, then uses the same single fence before the replacement row", () => {
  const apply = SOURCE.slice(
    SOURCE.indexOf("export async function applyTaxMatchingReplay"),
    SOURCE.indexOf("export async function proposeTaxMatchingReplayReversal"),
  );
  const ownLock = apply.indexOf("loadFinancialChange(db, orgId, changeId)");
  const fenceAt = apply.indexOf("fencedReplayPreview");
  assert.ok(ownLock >= 0 && ownLock < fenceAt, "apply locks the replay change before the lifecycle fence");
  assert.equal((apply.match(/lockAssetTaxLifecycle/g) ?? []).length, 0, "apply must not take a second fence besides fencedReplayPreview");
});
