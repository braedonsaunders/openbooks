/**
 * A pack's prose may not contradict the registry it is in.
 *
 * Every pack was written while `PayrollCountry` was `"CA" | "US"`, so each
 * header explained how the pack was typed around a closed union and promised
 * it would "register unchanged once Orchestrate opens the type". The union
 * opened; ten packs are registered and installable; five headers still said
 * they registered nothing.
 *
 * That is not cosmetic. France's header block also carried the sentence
 * "`supported` stays empty until PAS withholds income tax end to end", and
 * that sentence was used — by a reader with every reason to trust it — to
 * conclude France should be `installable: false`, when the engine reproduces
 * DGFiP's own published PAS figures and pushes sixteen statutory lines. The
 * prose was the least reliable artifact in the file and it read as the most
 * authoritative one.
 *
 * So the phrases below are banned in pack sources: each asserts something the
 * registry now falsifies. A pack that genuinely is not registered should not
 * be in PAYROLL_COUNTRY_PACKS, which is what this iterates.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { PAYROLL_COUNTRY_PACKS } from "./packs.ts";

/**
 * Pack country → the source file its declaration and prose live in.
 *
 * Every pack is now a `<country>/pack.ts` with one import line in the registry,
 * CA and US included. Those two were object literals inside `packs.ts` until
 * the registry was made uniform — written before a second country existed, so
 * the registry file and the pack declaration were the same file, which left the
 * oldest and most complete packs as the only two a pack-level structural test
 * could not read. Canada's directory is `canada`, not `ca`.
 */
const PACK_FILES: Record<string, string> = {
  CA: "canada/pack.ts",
  US: "us/pack.ts",
  GB: "gb/pack.ts",
  DE: "de/pack.ts",
  FR: "fr/pack.ts",
  IE: "ie/pack.ts",
  AU: "au/pack.ts",
  IT: "it/pack.ts",
  NL: "nl/pack.ts",
  ES: "es/pack.ts",
  SG: "sg/pack.ts",
};

/**
 * Each entry is a phrase that was true before the union opened and is false
 * for any pack in the registry, with what it now misinforms a reader about.
 */
const STALE_CLAIMS: readonly { pattern: RegExp; why: string }[] = [
  {
    pattern: /PayrollCountry`? is still/i,
    why: "PayrollCountry is now keyof typeof PAYROLL_COUNTRY_PACKS",
  },
  {
    pattern: /"CA" \| "US"|'CA' \| 'US'/,
    why: "the union is no longer the two built-ins",
  },
  {
    pattern: /registers unchanged once/i,
    why: "the pack is already registered",
  },
  {
    pattern: /cannot be added to `?PAYROLL_COUNTRY_PACKS/i,
    why: "the pack is in PAYROLL_COUNTRY_PACKS",
  },
  {
    pattern: /[Rr]egisters nothing|[Nn]othing here is registered|registers nothing in any generic registry/,
    why: "the pack registers itself, its filings and its settings key",
  },
  {
    pattern: /[Rr]egistration is blocked/i,
    why: "registration happened",
  },
  {
    // Only a pack asserting its OWN pending state, which is the stale shape
    // ("installable: false until a tax year is transcribed", "stays
    // installable: false only for the labels"). packs.ts legitimately
    // describes what the field MEANS in general, and that is not a claim
    // about any pack.
    pattern: /(stays|remains) `?installable: false|`?installable: false`? (until|only|pending)/i,
    why: "the pack is installable; say what it refuses instead of when it will become installable",
  },
];

for (const [country, file] of Object.entries(PACK_FILES)) {
  test(`${country}'s pack source makes no stale pre-registration claim`, () => {
    const source = readFileSync(join("engine/src/payroll", file), "utf8");
    for (const { pattern, why } of STALE_CLAIMS) {
      const match = pattern.exec(source);
      assert.equal(
        match,
        null,
        `${file} says "${match?.[0]}" — ${why}. Prose that contradicts the code is read as `
        + "authoritative and acted on; update it in the same commit as the behaviour.",
      );
    }
  });
}

test("every registered pack has its source checked here", () => {
  // Guards the guard: a new country added to the registry without a PACK_FILES
  // entry would otherwise be silently unchecked.
  for (const country of Object.keys(PAYROLL_COUNTRY_PACKS)) {
    assert.ok(
      PACK_FILES[country],
      `${country} is registered but PACK_FILES names no source for it — add one, so its prose `
      + "is checked like every other pack's.",
    );
  }
});
