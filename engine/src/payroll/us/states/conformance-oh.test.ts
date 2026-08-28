/** Ohio school-district declaration conformance goldens. */
import assert from "node:assert/strict";
import test from "node:test";
import { OH_SCHOOL_DISTRICTS_2026, ohSchoolDistrict } from "./oh.ts";

test("Ohio 2026 district declarations retain the Department's legal names", () => {
  const expected = new Map([
    ["1105", "West Liberty-Salem LSD (1.00% expires 2027; 0.25% expires 2036; 0.50% CPT)"],
    ["1905", "Mississinawa Valley LSD (0.75% expires 2031; 1.00% CPT)"],
    ["2602", "Evergreen LSD (0.25% expires 2027; 0.50% expires 2029; 0.75% CPT)"],
    ["2605", "Pike-Delta-York LSD (existing 1% expires 2026, 1.25% CPT begins 2027)"],
    ["4902", "Jonathan Alder LSD (0.75% expires 2026, 0.50% expires 2031)"],
    ["5708", "New Lebanon LSD (0.75% expires 2030; 0.50% expires 2031)"],
    ["6805", "Twin Valley Community LSD (0.75% expires 2027; 0.75% expires 2028)"],
    ["6901", "Columbus Grove LSD (0.75% expires 2030; 0.25% expires 2032)"],
    ["6909", "Pandora-Gilboa LSD (1.00% expires 2036; 0.75% expires 2033)"],
    ["7201", "Clyde-Green Springs EVSD (0.50% expires 2030; 1.00% CPT)"],
    ["8705", "North Baltimore LSD (1.00% expires 2027; 0.25% expires 2034)"],
  ]);

  for (const [code, name] of expected) {
    assert.equal(ohSchoolDistrict("2026-01-01", code)?.name, name, code);
    assert.equal(OH_SCHOOL_DISTRICTS_2026.find((district) => district.code === code)?.name, name, code);
  }
});
