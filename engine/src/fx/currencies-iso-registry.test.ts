import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  NON_TRANSACTABLE_ISO_CODES,
  SUPPORTED_CURRENCIES,
} from "./currencies.ts";

const vendored = JSON.parse(
  readFileSync(new URL("./iso-4217.json", import.meta.url), "utf8"),
) as {
  source: string;
  retrieved: string;
  entries: { code: string; numeric: string; name: string; minorUnits: number | null }[];
};

/**
 * The registry is the product's ISO 4217 contract: every transactable active
 * code with its official minor units. This test pins it against the vendored
 * ISO table (source + retrieval date recorded in the JSON) and refuses drift
 * in either direction — an ISO amendment (new code, changed minor units,
 * renamed currency) or a casual registry edit fails here until the vendored
 * table and the registry are consciously updated together.
 */
test("vendored ISO 4217 table carries its provenance", () => {
  assert.match(vendored.source, /ISO 4217/);
  assert.match(vendored.retrieved, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(vendored.entries.length >= 170, "vendored table must hold the full active list");
});

test("registry covers exactly the transactable ISO 4217 codes", () => {
  const expected = new Map(
    vendored.entries.filter((e) => e.minorUnits !== null).map((e) => [e.code, e]),
  );
  const actual = new Map(SUPPORTED_CURRENCIES.map((c) => [c.code, c]));
  assert.deepEqual(
    [...actual.keys()].sort(),
    [...expected.keys()].sort(),
    "registry must add/remove codes exactly when the vendored ISO table does",
  );
  for (const [code, row] of expected) {
    assert.equal(
      actual.get(code)!.minorUnits,
      row.minorUnits,
      `${code} minor units must match the ISO table`,
    );
  }
});

test("registry names match ISO except the pinned legacy display names", () => {
  // Grandfathered demonym-prefixed display names already seeded into tenant
  // databases (readOnly reference rows): renaming them would churn every
  // tenant's pickers for zero financial benefit. Everything else is exact ISO.
  const legacyNames = new Map([
    ["GBP", "British Pound"],
    ["JPY", "Japanese Yen"],
    ["CNY", "Chinese Yuan"],
    ["ZAR", "South African Rand"],
    ["PLN", "Polish Zloty"],
    ["HUF", "Hungarian Forint"],
    ["ILS", "Israeli Shekel"],
    ["KRW", "South Korean Won"],
    ["THB", "Thai Baht"],
    ["IDR", "Indonesian Rupiah"],
    ["VND", "Vietnamese Dong"],
    ["NGN", "Nigerian Naira"],
    ["PKR", "Pakistani Rupee"],
    ["ISK", "Icelandic Krona"],
  ]);
  const isoByCode = new Map(vendored.entries.map((e) => [e.code, e.name]));
  for (const c of SUPPORTED_CURRENCIES) {
    const want = legacyNames.get(c.code) ?? isoByCode.get(c.code);
    assert.equal(c.name, want, `${c.code} name drifted from its pinned source`);
  }
  for (const [code, name] of legacyNames) {
    assert.notEqual(
      isoByCode.get(code),
      name,
      `${code} legacy pin is stale — ISO now uses this name, drop the pin`,
    );
  }
});

test("non-transactable ISO entries stay excluded and fail closed", () => {
  // Supranational units, bond-market units, test codes and XXX carry no ISO
  // minor unit, so no quantum exists to round them with. They stay out of the
  // registry (documents validation rejects them for lack of a row) and this
  // pins exactly which entries those are — an ISO change here must be a
  // conscious product decision, not silent drift.
  const nullMinor = vendored.entries
    .filter((e) => e.minorUnits === null)
    .map((e) => e.code)
    .sort();
  assert.deepEqual([...NON_TRANSACTABLE_ISO_CODES].sort(), nullMinor);
  const registry = new Set(SUPPORTED_CURRENCIES.map((c) => c.code));
  for (const code of NON_TRANSACTABLE_ISO_CODES) {
    assert.ok(!registry.has(code), `${code} has no minor unit and must not be transactable`);
  }
});

test("registry is sorted, unique, and ledger-compatible", () => {
  const codes = SUPPORTED_CURRENCIES.map((c) => c.code);
  assert.deepEqual(codes, [...codes].sort(), "registry stays sorted by code for reviewability");
  assert.equal(new Set(codes).size, codes.length, "currency codes must be unique");
  for (const c of SUPPORTED_CURRENCIES) {
    assert.match(c.code, /^[A-Z]{3}$/, "codes are ISO alpha-3");
    assert.ok(c.name.length > 0, `${c.code} needs a display name`);
    assert.ok(
      Number.isInteger(c.minorUnits) && c.minorUnits >= 0 && c.minorUnits <= 4,
      `${c.code} minor units must fit the ledger's 0–4 quantum`,
    );
  }
});
