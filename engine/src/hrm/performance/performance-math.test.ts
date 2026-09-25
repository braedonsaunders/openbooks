import assert from "node:assert/strict";
import test from "node:test";
import {
  assertProgressPercent,
  assertRatingInScale,
  computeTurnover,
  parseAppliesScope,
  parseCivilDay,
  parseRatingScale,
  PerformanceMathError,
  scopeMatchesEmployment,
} from "./performance-math.ts";

/**
 * Pure performance/retention math over fixed inputs — unit partition (no
 * database). Every refusal asserts its code AND its message: the message is
 * the entire product of a failing check. Red-proofs revert the fix in the
 * sibling implementation and show these assertions fail.
 */

test("parseRatingScale accepts a well-formed scale", () => {
  assert.deepEqual(parseRatingScale({ min: 1, max: 5, labels: ["low", "high"] }), {
    min: "1",
    max: "5",
    labels: ["low", "high"],
  });
  assert.deepEqual(parseRatingScale({ min: "1.5", max: "4.5" }).labels, []);
});

test("parseRatingScale refuses malformed scales by name", () => {
  // One row per malformed shape; every row keeps its own message patterns —
  // the message is the product of the refusal, so no two rows share asserts.
  const cases: { name: string; input: unknown; patterns: RegExp[] }[] = [
    { name: "inverted", input: { min: 5, max: 1 }, patterns: [/inverted/, /min 5 is not below max 1/] },
    { name: "missing", input: null, patterns: [/no readable rating scale/, /before opening the cycle/] },
    { name: "wide span", input: { min: 0, max: 100 }, patterns: [/more than 99 points/] },
    { name: "non-string labels", input: { min: 1, max: 5, labels: ["ok", 3] }, patterns: [/labels must be an array of strings/] },
  ];
  for (const { name, input, patterns } of cases) {
    assert.throws(() => parseRatingScale(input), (e: unknown) => {
      assert.ok(e instanceof PerformanceMathError, `${name} refuses as PerformanceMathError`);
      for (const pattern of patterns) assert.match(e.message, pattern, `${name} names its remedy`);
      return true;
    });
  }
});

test("assertRatingInScale accepts the inclusive bounds", () => {
  const scale = parseRatingScale({ min: 1, max: 5, labels: [] });
  assertRatingInScale(scale, "1", "Impact");
  assertRatingInScale(scale, "5", "Impact");
  assertRatingInScale(scale, "3.5", "Impact");
});

test("assertRatingInScale names the question outside the scale", () => {
  const scale = parseRatingScale({ min: 1, max: 5, labels: [] });
  assert.throws(() => assertRatingInScale(scale, "6", "Customer impact"), (e: unknown) => {
    assert.ok(e instanceof PerformanceMathError);
    assert.match(e.message, /"Customer impact"/);
    assert.match(e.message, /outside the template scale 1 to 5/);
    return true;
  });
});

test("assertRatingInScale refuses a non-decimal rating", () => {
  const scale = parseRatingScale({ min: 1, max: 5, labels: [] });
  assert.throws(() => assertRatingInScale(scale, "excellent", "Impact"), (e: unknown) => {
    assert.ok(e instanceof PerformanceMathError);
    assert.match(e.message, /must be a decimal rating/);
    return true;
  });
});

test("rating values beyond the persisted four-decimal scale are refused instead of truncated", () => {
  const scale = parseRatingScale({ min: "1", max: "5", labels: [] });
  assert.throws(
    () => assertRatingInScale(scale, "4.00001", "Customer impact"),
    /more than four decimal places.*persist at scale 4/,
  );
  assert.throws(
    () => parseRatingScale({ min: "1.00001", max: "5", labels: [] }),
    /at most four decimal places.*persist at scale 4/,
  );
});

test("assertProgressPercent accepts 0 and 100 and refuses the rest", () => {
  assert.equal(assertProgressPercent(0), 0);
  assert.equal(assertProgressPercent(100), 100);
  for (const bad of [-1, 101, 12.5, "50", null]) {
    assert.throws(() => assertProgressPercent(bad), (e: unknown) => {
      assert.ok(e instanceof PerformanceMathError);
      assert.match(e.message, /whole percent from 0 to 100/);
      return true;
    });
  }
});

test("parseAppliesScope reads the two slots and refuses unknown keys", () => {
  assert.deepEqual(parseAppliesScope({}), { employerSubsidiaryId: null, departmentId: null });
  assert.deepEqual(parseAppliesScope({ employer_subsidiary_id: "s1", department_id: null }), {
    employerSubsidiaryId: "s1",
    departmentId: null,
  });
  assert.throws(() => parseAppliesScope({ region: "x" }), (e: unknown) => {
    assert.ok(e instanceof PerformanceMathError);
    assert.match(e.message, /unknown key "region"/);
    return true;
  });
});

test("scopeMatchesEmployment filters by the set slots only", () => {
  const all = parseAppliesScope({});
  assert.equal(scopeMatchesEmployment(all, { employerSubsidiaryId: "s", departmentId: "d" }), true);
  const scoped = parseAppliesScope({ employer_subsidiary_id: "s", department_id: null });
  assert.equal(scopeMatchesEmployment(scoped, { employerSubsidiaryId: "s", departmentId: "d" }), true);
  assert.equal(scopeMatchesEmployment(scoped, { employerSubsidiaryId: "t", departmentId: "d" }), false);
});

test("parseCivilDay refuses non-dates", () => {
  assert.equal(parseCivilDay("2026-06-15", "period start"), "2026-06-15");
  assert.throws(() => parseCivilDay("2026-02-30", "period start"), /real calendar date/);
  assert.throws(() => parseCivilDay("tomorrow", "period start"), /YYYY-MM-DD/);
});

test("computeTurnover divides terminations by average headcount on a fixed series", () => {
  // 100 at start, 80 at end (average 90), 9 leavers: 6 voluntary,
  // 3 regrettable, tenures 100/200/300/400 days across four of them.
  const result = computeTurnover({
    headcountStart: 100,
    headcountEnd: 80,
    terminations: 9,
    voluntary: 6,
    regrettable: 3,
    tenureDays: [100, 200, 300, 400],
  });
  assert.equal(result.turnoverRate, 9 / 90);
  assert.equal(result.voluntaryRate, 6 / 90);
  assert.equal(result.involuntaryRate, 3 / 90);
  assert.equal(result.regrettableShare, 3 / 9);
  assert.equal(result.medianTenureDays, 250);
});

test("computeTurnover yields null rates on an empty period instead of dividing", () => {
  const result = computeTurnover({
    headcountStart: 0,
    headcountEnd: 0,
    terminations: 0,
    voluntary: 0,
    regrettable: 0,
    tenureDays: [],
  });
  assert.equal(result.turnoverRate, null);
  assert.equal(result.voluntaryRate, null);
  assert.equal(result.involuntaryRate, null);
  assert.equal(result.regrettableShare, null);
  assert.equal(result.medianTenureDays, null);
});

test("computeTurnover refuses voluntary above terminations", () => {
  assert.throws(
    () =>
      computeTurnover({
        headcountStart: 10,
        headcountEnd: 10,
        terminations: 2,
        voluntary: 3,
        regrettable: 0,
        tenureDays: [],
      }),
    (e: unknown) => {
      assert.ok(e instanceof PerformanceMathError);
      assert.match(e.message, /cannot exceed all leavers/);
      return true;
    },
  );
});

test("computeTurnover takes the odd-count median exactly", () => {
  const result = computeTurnover({
    headcountStart: 10,
    headcountEnd: 10,
    terminations: 3,
    voluntary: 1,
    regrettable: 1,
    tenureDays: [30, 365, 90],
  });
  assert.equal(result.medianTenureDays, 90);
});
