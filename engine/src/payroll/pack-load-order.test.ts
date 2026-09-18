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
