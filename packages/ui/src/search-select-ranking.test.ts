import assert from "node:assert/strict";
import test from "node:test";
import { hasExactMatch, matchTier, rankOptions } from "./search-select-ranking";

const vendors = [
  { value: "costa", label: "Costa Rica Imports" },
  { value: "coned", label: "Consolidated Edison", keywords: ["CONED"] },
  { value: "staples", label: "Staples Business Advantage", keywords: ["STAPLES"] },
  { value: "grainger", label: "Grainger" },
  { value: "grant", label: "Grant Thornton LLP" },
  { value: "msft", label: "Microsoft Corporation", keywords: ["MSFT"] },
];

test("a label prefix outranks a substring match", () => {
  assert.deepEqual(
    rankOptions(vendors, "sta").map((option) => option.value),
    ["staples", "costa"],
  );
});

test("organization codes find their record although the label never contains them", () => {
  assert.deepEqual(
    rankOptions(vendors, "msft").map((option) => option.value),
    ["msft"],
  );
  assert.deepEqual(
    rankOptions(vendors, "coned").map((option) => option.value),
    ["coned"],
  );
});

test("a word inside the label matches from its start, and multi-word queries match in any order", () => {
  assert.deepEqual(
    rankOptions(vendors, "edi").map((option) => option.value),
    ["coned"],
  );
  assert.deepEqual(
    rankOptions(vendors, "adv sta").map((option) => option.value),
    ["staples"],
  );
});

test("recent choices break ties within a tier but never lift a weaker match", () => {
  assert.deepEqual(
    rankOptions(vendors, "gra").map((option) => option.value),
    ["grainger", "grant"],
  );
  assert.deepEqual(
    rankOptions(vendors, "gra", ["grant"]).map((option) => option.value),
    ["grant", "grainger"],
  );
  assert.deepEqual(
    rankOptions(vendors, "sta", ["costa"]).map((option) => option.value),
    ["staples", "costa"],
  );
});

test("accents and case do not matter", () => {
  assert.equal(matchTier({ value: "x", label: "Société Générale" }, "societe"), 1);
  assert.equal(matchTier({ value: "x", label: "Grainger" }, "GRAINGER"), 0);
});

test("an empty query keeps the caller order and a non-match is excluded", () => {
  assert.deepEqual(
    rankOptions(vendors, "").map((option) => option.value),
    vendors.map((option) => option.value),
  );
  assert.equal(matchTier(vendors[3]!, "zzz"), null);
});

test("exact matches are recognised by label or keyword", () => {
  assert.equal(hasExactMatch(vendors, "staples"), true);
  assert.equal(hasExactMatch(vendors, "grainger"), true);
  assert.equal(hasExactMatch(vendors, "grain"), false);
});
