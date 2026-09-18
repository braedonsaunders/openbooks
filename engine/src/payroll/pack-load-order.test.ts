import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";

// NOTE: these pack imports intentionally come BEFORE the registry import
// below. packs.ts imports every pack to build PAYROLL_COUNTRY_PACKS, so a
// pack subtree that imports a runtime binding back out of packs.ts closes a
// module cycle, and entering via the pack dies with
// "Cannot access '<CC>_PAYROLL_PACK' before initialization" (F-reg-002:
// PayrollPackError lived in packs.ts; five packs imported it back).
// Every pack subtree must therefore take runtime bindings only from leaf
// modules (../payroll-error.ts), never from ../packs.ts. This file proves
// it in the entry order that bites: packs first, registry last. (Run
// standalone with `node --import tsx` — import order is what it exercises.)
import { AU_PAYROLL_PACK } from "./au/pack.ts";
import { GB_PACK } from "./gb/pack.ts";
import { DE_PAYROLL_PACK } from "./de/pack.ts";
import { FR_PAYROLL_PACK } from "./fr/pack.ts";
import { IE_PAYROLL_PACK } from "./ie/pack.ts";
import { IT_PAYROLL_PACK } from "./it/pack.ts";
import { NL_PAYROLL_PACK } from "./nl/pack.ts";
import { ES_PAYROLL_PACK } from "./es/pack.ts";
import { PAYROLL_COUNTRY_PACKS } from "./packs.ts";

test("every registered pack loads before the registry is entered", () => {
  // If any pack subtree still runtime-imports packs.ts, the import above
  // throws before this body runs — that is the assertion.
  const packs = {
    GB: GB_PACK,
    DE: DE_PAYROLL_PACK,
    FR: FR_PAYROLL_PACK,
    IE: IE_PAYROLL_PACK,
    AU: AU_PAYROLL_PACK,
    IT: IT_PAYROLL_PACK,
    NL: NL_PAYROLL_PACK,
    ES: ES_PAYROLL_PACK,
  } as const;
  assert.deepEqual(Object.keys(PAYROLL_COUNTRY_PACKS), [
    "CA", "US", "GB", "DE", "FR", "IE", "AU", "IT", "NL", "ES",
  ]);
  for (const [country, pack] of Object.entries(packs)) {
    assert.equal(pack.country, country, `${country} pack country`);
    assert.equal(
      PAYROLL_COUNTRY_PACKS[country]?.country,
      country,
      `${country} registry entry`,
    );
  }
});

test("no pack file imports a runtime binding out of packs.ts", () => {
  // F-reg-002, four times over. `packs.ts` imports every country pack to build
  // PAYROLL_COUNTRY_PACKS, so a pack importing a RUNTIME binding back out of it
  // closes a load-order-dependent cycle: whichever pack the import order reaches
  // first crashes with "Cannot access 'X' before initialization".
  //
  // It kept coming back because PayrollPackError lived in packs.ts for the whole
  // life of the project and payroll-error.ts is new — so every new pack file
  // reached for the old home. Round 1 found it in 2 packs; the parent checked and
  // found 5; the registration shard found a 6th in au/tax-year-2027.ts; and three
  // more arrived with the DE and FR engines (de/pap.ts, fr/tables-2026.ts,
  // fr/compute-statutory.ts). A runtime probe only catches the pack the current
  // order happens to hit first, so this scan is the thing that actually holds.
  //
  // TYPE-only imports from packs.ts are fine — they are erased at runtime.
  const root = join("engine", "src", "payroll");
  const offenders: string[] = [];
  for (const country of readdirSync(root, { withFileTypes: true })) {
    if (!country.isDirectory()) continue;
    const dir = join(root, country.name);
    const walk = (at: string): void => {
      for (const entry of readdirSync(at, { withFileTypes: true })) {
        const path = join(at, entry.name);
        if (entry.isDirectory()) { walk(path); continue; }
        if (!/\.[cm]?tsx?$/.test(entry.name)) continue;
        // Test files are leaf CONSUMERS: nothing imports them, so they cannot be
        // part of the registry's cycle. gb/pack.test.ts legitimately imports the
        // runtime `taxYearFor` from packs.ts.
        if (/\.test\.[cm]?tsx?$/.test(entry.name)) continue;
        for (const [index, line] of readFileSync(path, "utf8").split("\n").entries()) {
          if (!/from\s+"\.\.\/packs\.ts"/.test(line)) continue;
          if (/^\s*import\s+type\s/.test(line)) continue;
          const braced = /^\s*import\s*\{(.*)\}/.exec(line);
          const runtime = braced
            ? braced[1]!.split(",").map((s) => s.trim()).filter((s) => s && !s.startsWith("type "))
            : [];
          if (runtime.length > 0) offenders.push(`${path}:${index + 1}: ${line.trim()}`);
        }
      }
    };
    walk(dir);
  }
  assert.deepEqual(
    offenders,
    [],
    "import runtime bindings from a leaf (payroll-error.ts), never from packs.ts:\n"
      + offenders.join("\n"),
  );
});
