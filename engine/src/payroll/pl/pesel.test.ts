import assert from "node:assert/strict";
import test from "node:test";
import { isValidPesel, peselBirthYear } from "./pesel.ts";

/**
 * The PESEL century rule, proved against the statute's own three bands
 * (ustawa o ewidencji ludności, art. 15 ust. 2 pkt 2: +80 → 1800–1899,
 * +0 → 1900–1999, +20 → 2000–2099). Pure: no database.
 */

test("a 1900s PESEL derives its birth year", () => {
  // The pack's own example identifier: 44 05 14 → 14 May 1944.
  assert.equal(peselBirthYear("44051401359"), 1944);
});

test("the month band edges decode to the cited centuries for valid PESELs", () => {
  assert.equal(peselBirthYear("99010100002"), 1999);
  assert.equal(peselBirthYear("00010100008"), 1900);
  // Month +20 → 2000s: 02 32 24 → 24 December 2002.
  assert.equal(peselBirthYear("02322400001"), 2002);
  assert.equal(peselBirthYear("00210100004"), 2000);
  // 09 December 2009: month 12 + 20 → 32.
  assert.equal(peselBirthYear("09320900007"), 2009);
  // Month +80 → 1800s.
  assert.equal(peselBirthYear("00810100002"), 1800);
  // 1892 with month 12 + 80 → 92.
  assert.equal(peselBirthYear("92920100001"), 1892);
});

test("an uncited month band derives nothing, never a guessed century", () => {
  // 2100s/2200s codes (41–52, 61–72): the cited act states no band for
  // them, so they are unknown — the declared field stands alone.
  assert.equal(peselBirthYear("00410100003"), null);
  assert.equal(peselBirthYear("00610100007"), null);
  // Gaps between the bands are unknown too.
  for (const month of ["00", "13", "20", "33", "80", "93", "99"]) {
    assert.equal(peselBirthYear(`99${month}0100000`), null, `month ${month} must be unknown`);
  }
});

test("PESEL validation checks the encoded calendar date and statutory control digit", () => {
  assert.equal(isValidPesel("44051401359"), true);
  assert.equal(isValidPesel("44051401350"), false, "incorrect control digit is refused");
  assert.equal(isValidPesel("44023101353"), false, "February 31 is refused even with a matching control digit");
  assert.equal(isValidPesel("00222900009"), true, "29 February 2000 is a valid encoded date");
  assert.equal(isValidPesel("00222900008"), false, "the checksum still applies on leap day");
});

test("a malformed value derives nothing", () => {
  assert.equal(peselBirthYear(null), null);
  assert.equal(peselBirthYear(undefined), null);
  assert.equal(peselBirthYear(""), null);
  assert.equal(peselBirthYear("4405140135"), null);
  assert.equal(peselBirthYear("440514013599"), null);
  assert.equal(peselBirthYear("44051A01359"), null);
  assert.equal(peselBirthYear(" 44051401359"), null);
  assert.equal(peselBirthYear("44051401350"), null, "a PESEL with an invalid control digit derives no birth year");
  assert.equal(peselBirthYear("44023101353"), null, "an impossible encoded date derives no birth year");
});
