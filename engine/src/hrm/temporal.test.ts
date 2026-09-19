import assert from "node:assert/strict";
import test from "node:test";
import {
  AmbiguousRevisionError,
  EmptyIntervalError,
  EmptyRecordedWindowError,
  InvalidCivilDateError,
  InvalidRecordedStampError,
  NoRevisionError,
  OverlappingIntervalsError,
  TemporalError,
  assertNoOverlap,
  compareCivilDates,
  containsDate,
  intervalsOverlap,
  isCivilDate,
  makeEffectiveInterval,
  makeRecordedRevision,
  parseCivilDate,
  resolveAsOf,
  type AsOfQuery,
  type EffectiveInterval,
  type RecordedRevision,
  type TemporalErrorCode,
} from "./temporal.ts";

function refusalCode(fn: () => unknown): TemporalErrorCode {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof TemporalError);
    return err.code;
  }
  assert.fail("expected a TemporalError refusal");
}

test("accepts real calendar dates including leap boundaries", () => {
  for (const iso of [
    "0001-01-01",
    "1970-01-01",
    "2000-02-29",
    "2024-02-29",
    "2026-01-31",
    "9999-12-31",
  ]) {
    assert.equal(parseCivilDate(iso), iso);
    assert.equal(isCivilDate(iso), true);
  }
});

test("rejects impossible February and month/day ranges", () => {
  for (const iso of [
    "2023-02-29",
    "1900-02-29",
    "2100-02-29",
    "2024-04-31",
    "2026-00-10",
    "2026-13-01",
    "2026-01-00",
    "2026-01-32",
  ]) {
    assert.throws(() => parseCivilDate(iso), InvalidCivilDateError);
    assert.equal(isCivilDate(iso), false);
  }
  assert.equal(refusalCode(() => parseCivilDate("2023-02-29")), "INVALID_DATE");
});

test("rejects malformed shapes and non-strings", () => {
  for (const value of [
    "",
    "2026-1-1",
    "26-01-01",
    "0000-01-01",
    "10000-01-01",
    " 2026-01-01",
    "2026-01-01 ",
    "2026-01-01T00:00:00Z",
    "2026/01/01",
    null,
    undefined,
    20260101,
    {},
    [],
  ]) {
    assert.throws(() => parseCivilDate(value), InvalidCivilDateError);
    assert.equal(isCivilDate(value), false);
  }
});

test("rejects trailing newlines and surrounding whitespace on dates", () => {
  for (const iso of [
    "2026-01-01\n",
    "2026-01-01\r",
    "2026-01-01\r\n",
    "2026-01-01\t",
    "2026-01-01 ",
    "\n2026-01-01",
    "\t2026-01-01",
  ]) {
    assert.throws(() => parseCivilDate(iso), InvalidCivilDateError, JSON.stringify(iso));
    assert.equal(isCivilDate(iso), false);
  }
});

test("rejects trailing newlines and whitespace on recorded stamps", () => {
  const effective = makeEffectiveInterval("2026-01-01", null);
  for (const stamp of [
    "2026-01-01T00:00:00Z\n",
    "2026-01-01T00:00:00Z\r\n",
    "2026-01-01T00:00:00Z\r",
    "2026-01-01T00:00:00Z ",
    "2026-01-01T00:00:00Z\t",
  ]) {
    assert.throws(
      () => makeRecordedRevision(effective, stamp, null, "v"),
      InvalidRecordedStampError,
      JSON.stringify(stamp),
    );
    assert.throws(
      () => makeRecordedRevision(effective, "2026-01-01T00:00:00Z", stamp, "v"),
      InvalidRecordedStampError,
      JSON.stringify(stamp),
    );
  }
  assert.throws(
    () => resolveAsOf(
      [makeRecordedRevision(effective, "2026-01-01T00:00:00Z", null, "v")],
      { effective: "2026-03-01", asKnown: "2026-03-01T00:00:00Z\n" },
    ),
    InvalidRecordedStampError,
  );
});

test("bigint and circular unknowns keep the named refusal", () => {
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  const hostile: unknown[] = [1n, circular, { nested: { deep: [circular] } }, Symbol("d")];
  for (const value of hostile) {
    assert.throws(() => parseCivilDate(value), InvalidCivilDateError);
    assert.equal(isCivilDate(value), false);
  }
  assert.throws(
    () => makeRecordedRevision(makeEffectiveInterval("2026-01-01", null), 1n, null, "v"),
    InvalidRecordedStampError,
  );
});

test("refusal messages stay bounded on hostile input", () => {
  const long = `2026-01-01${"x".repeat(500)}`;
  try {
    parseCivilDate(long);
    assert.fail("expected refusal");
  } catch (err) {
    assert.ok(err instanceof InvalidCivilDateError);
    assert.ok(err.message.length < 200, `message ran to ${err.message.length} chars`);
  }
});

test("isCivilDate agrees with parseCivilDate over a mixed corpus", () => {
  const corpus: unknown[] = [
    "2024-02-29", "2023-02-29", "2026-06-15", "not-a-date",
    "", null, 42, "0001-01-01", "9999-12-31", "2026-13-40",
  ];
  for (const value of corpus) {
    let parses = true;
    try {
      parseCivilDate(value);
    } catch {
      parses = false;
    }
    assert.equal(isCivilDate(value), parses, `guard disagrees for ${String(value)}`);
  }
});

test("compareCivilDates orders, equates, and stays transitive", () => {
  assert.equal(compareCivilDates("2026-01-01", "2026-01-02"), -1);
  assert.equal(compareCivilDates("2026-01-02", "2026-01-01"), 1);
  assert.equal(compareCivilDates("2026-01-01", "2026-01-01"), 0);
  const corpus = [
    "0001-01-01", "1900-02-28", "1969-12-31", "1970-01-01",
    "2000-02-29", "2024-02-28", "2024-02-29", "2024-03-01",
    "2026-01-01", "2026-02-15", "9999-12-31",
  ].map((iso) => parseCivilDate(iso));
  for (const a of corpus) {
    for (const b of corpus) {
      for (const c of corpus) {
        if (compareCivilDates(a, b) <= 0 && compareCivilDates(b, c) <= 0) {
          assert.ok(compareCivilDates(a, c) <= 0, `${a} <= ${b} <= ${c} broke`);
        }
      }
    }
  }
  const byGrid = [...corpus].sort(compareCivilDates);
  const byString = [...corpus].sort();
  assert.deepEqual(byGrid, byString);
});

test("makeEffectiveInterval builds bounded and unbounded windows", () => {
  assert.deepEqual(makeEffectiveInterval("2026-01-01", "2026-02-01"), {
    start: "2026-01-01", end: "2026-02-01",
  });
  assert.deepEqual(makeEffectiveInterval("2026-01-01", null), {
    start: "2026-01-01", end: null,
  });
});

test("makeEffectiveInterval rejects empty and malformed windows", () => {
  assert.throws(() => makeEffectiveInterval("2026-02-01", "2026-02-01"), EmptyIntervalError);
  assert.throws(() => makeEffectiveInterval("2026-03-01", "2026-02-01"), EmptyIntervalError);
  assert.throws(() => makeEffectiveInterval("2026-01-01", undefined), InvalidCivilDateError);
  assert.throws(() => makeEffectiveInterval("nope", null), InvalidCivilDateError);
  assert.equal(refusalCode(() => makeEffectiveInterval("2026-02-01", "2026-02-01")), "EMPTY_INTERVAL");
});

test("containsDate is half-open with an unbounded null end", () => {
  const bounded = makeEffectiveInterval("2026-01-01", "2026-02-01");
  assert.equal(containsDate(bounded, "2026-01-01"), true);
  assert.equal(containsDate(bounded, "2026-01-31"), true);
  assert.equal(containsDate(bounded, "2026-02-01"), false);
  assert.equal(containsDate(bounded, "2025-12-31"), false);
  const open = makeEffectiveInterval("2026-01-01", null);
  assert.equal(containsDate(open, "2026-01-01"), true);
  assert.equal(containsDate(open, "9999-12-31"), true);
  assert.equal(containsDate(open, "2025-12-31"), false);
});

test("containsDate matches half-open string comparison over a grid", () => {
  const dates = ["2025-12-31", "2026-01-01", "2026-01-15", "2026-02-01", "2026-05-01"];
  const intervals: EffectiveInterval[] = [
    makeEffectiveInterval("2026-01-01", "2026-02-01"),
    makeEffectiveInterval("2026-01-15", null),
  ];
  for (const interval of intervals) {
    for (const date of dates) {
      const expected =
        date >= interval.start && (interval.end === null || date < interval.end);
      assert.equal(containsDate(interval, date), expected, `${date} in ${interval.start}..${interval.end}`);
    }
  }
});

test("intervalsOverlap follows && semantics; adjacency is not overlap", () => {
  const left = makeEffectiveInterval("2026-01-01", "2026-03-01");
  const inner = makeEffectiveInterval("2026-02-01", "2026-02-15");
  const same = makeEffectiveInterval("2026-01-01", "2026-03-01");
  const adjacent = makeEffectiveInterval("2026-03-01", "2026-04-01");
  const before = makeEffectiveInterval("2025-11-01", "2026-01-01");
  const openTail = makeEffectiveInterval("2026-02-01", null);
  const openEarly = makeEffectiveInterval("2025-01-01", null);
  assert.equal(intervalsOverlap(left, inner), true);
  assert.equal(intervalsOverlap(left, same), true);
  assert.equal(intervalsOverlap(left, openTail), true);
  assert.equal(intervalsOverlap(openTail, openEarly), true);
  assert.equal(intervalsOverlap(left, adjacent), false);
  assert.equal(intervalsOverlap(adjacent, left), false);
  assert.equal(intervalsOverlap(left, before), false);
  assert.equal(intervalsOverlap(before, left), false);
});

test("assertNoOverlap accepts empty, single, and adjacent chains", () => {
  assertNoOverlap([]);
  assertNoOverlap([makeEffectiveInterval("2026-01-01", null)]);
  assertNoOverlap([
    makeEffectiveInterval("2026-01-01", "2026-02-01"),
    makeEffectiveInterval("2026-02-01", "2026-03-01"),
    makeEffectiveInterval("2026-03-01", null),
  ]);
});

test("assertNoOverlap refuses overlap and containment, order-independently", () => {
  const overlapping = [
    makeEffectiveInterval("2026-01-01", "2026-03-01"),
    makeEffectiveInterval("2026-02-01", "2026-04-01"),
  ];
  assert.throws(() => assertNoOverlap(overlapping), OverlappingIntervalsError);
  assert.throws(() => assertNoOverlap([...overlapping].reverse()), OverlappingIntervalsError);
  assert.throws(
    () => assertNoOverlap([
      makeEffectiveInterval("2026-01-01", null),
      makeEffectiveInterval("2026-02-01", "2026-02-15"),
    ]),
    OverlappingIntervalsError,
  );
  assert.equal(
    refusalCode(() => assertNoOverlap(overlapping)),
    "OVERLAP",
  );
});

test("overlap validation is per identity, so concurrent assignments pass", () => {
  const assignmentA = [
    makeEffectiveInterval("2026-01-01", "2026-06-01"),
    makeEffectiveInterval("2026-06-01", null),
  ];
  const assignmentB = [makeEffectiveInterval("2026-03-01", null)];
  assertNoOverlap(assignmentA);
  assertNoOverlap(assignmentB);
});

test("recorded stamps accept sub-second precision and reject non-UTC shapes", () => {
  const chain = makeRecordedRevision(
    makeEffectiveInterval("2026-01-01", null),
    "2026-01-01T00:00:00.000001Z",
    null,
    "v1",
  );
  assert.equal(chain.recordedAt, "2026-01-01T00:00:00.000001Z");
  makeRecordedRevision(
    makeEffectiveInterval("2026-01-01", null),
    "2026-01-01T00:00:00Z",
    "2026-02-01T12:30:45.123456789Z",
    "v1",
  );
  for (const stamp of [
    "2026-01-01T00:00:00+00:00",
    "2026-01-01 00:00:00Z",
    "2026-01-01T00:00:00",
    "2026-01-01T00:00:60Z",
    "2026-01-01T00:00:00.1234567890Z",
    "2026-13-01T00:00:00Z",
    "2026-01-01T24:00:00Z",
    123,
    null,
  ]) {
    assert.throws(
      () => makeRecordedRevision(makeEffectiveInterval("2026-01-01", null), stamp, null, "v1"),
      InvalidRecordedStampError,
    );
  }
  assert.equal(
    refusalCode(() => makeRecordedRevision(
      makeEffectiveInterval("2026-01-01", null), "2026-01-01T00:00:00+00:00", null, "v1",
    )),
    "INVALID_RECORDED_STAMP",
  );
});

test("recorded windows reject empty bounds", () => {
  const effective = makeEffectiveInterval("2026-01-01", null);
  assert.throws(
    () => makeRecordedRevision(effective, "2026-02-01T00:00:00Z", "2026-02-01T00:00:00Z", "v"),
    EmptyRecordedWindowError,
  );
  assert.throws(
    () => makeRecordedRevision(effective, "2026-02-01T00:00:00Z", "2026-01-01T00:00:00Z", "v"),
    EmptyRecordedWindowError,
  );
  assert.equal(
    refusalCode(() => makeRecordedRevision(
      effective, "2026-02-01T00:00:00Z", "2026-02-01T00:00:00Z", "v",
    )),
    "EMPTY_RECORDED_WINDOW",
  );
});

function supersessionChain(): RecordedRevision<string>[] {
  return [
    makeRecordedRevision(
      makeEffectiveInterval("2026-01-01", null),
      "2026-01-01T00:00:00Z",
      "2026-02-01T00:00:00Z",
      "original",
    ),
    makeRecordedRevision(
      makeEffectiveInterval("2026-03-01", null),
      "2026-02-01T00:00:00Z",
      null,
      "replacement",
    ),
  ];
}

test("superseded facts stay dead: Feb15 as-known Feb2 is NoRevision", () => {
  const query: AsOfQuery = { effective: "2026-02-15", asKnown: "2026-02-02T00:00:00Z" };
  assert.throws(() => resolveAsOf(supersessionChain(), query), NoRevisionError);
  assert.equal(refusalCode(() => resolveAsOf(supersessionChain(), query)), "NO_REVISION");
});

test("recorded filter applies before effective membership", () => {
  const chain = supersessionChain();
  assert.equal(
    resolveAsOf(chain, { effective: "2026-01-15", asKnown: "2026-01-15T00:00:00Z" }).payload,
    "original",
  );
  assert.equal(
    resolveAsOf(chain, { effective: "2026-03-15", asKnown: "2026-02-02T00:00:00Z" }).payload,
    "replacement",
  );
  assert.throws(
    () => resolveAsOf(chain, { effective: "2026-01-15", asKnown: "2026-02-02T00:00:00Z" }),
    NoRevisionError,
    "narrowed-away history is gone as of the correction, not resurrected",
  );
});

test("handoff at the exact recorded boundary selects only the new revision", () => {
  const chain = supersessionChain();
  assert.equal(
    resolveAsOf(chain, { effective: "2026-03-15", asKnown: "2026-02-01T00:00:00Z" }).payload,
    "replacement",
  );
  assert.throws(
    () => resolveAsOf(chain, { effective: "2026-01-15", asKnown: "2026-02-01T00:00:00Z" }),
    NoRevisionError,
  );
});

test("effective boundary selects the next interval", () => {
  const chain = [
    makeRecordedRevision(
      makeEffectiveInterval("2026-01-01", "2026-02-01"), "2026-01-01T00:00:00Z", null, "jan",
    ),
    makeRecordedRevision(
      makeEffectiveInterval("2026-02-01", null), "2026-01-01T00:00:00Z", null, "feb",
    ),
  ];
  assert.equal(
    resolveAsOf(chain, { effective: "2026-02-01", asKnown: "2026-03-01T00:00:00Z" }).payload,
    "feb",
  );
  assert.equal(
    resolveAsOf(chain, { effective: "2026-01-31", asKnown: "2026-03-01T00:00:00Z" }).payload,
    "jan",
  );
});

test("two live applicable revisions refuse, even with distinct recordedAt", () => {
  const sloppy = [
    makeRecordedRevision(
      makeEffectiveInterval("2026-01-01", null), "2026-01-01T00:00:00Z", null, "original",
    ),
    makeRecordedRevision(
      makeEffectiveInterval("2026-01-01", null), "2026-02-01T00:00:00Z", null, "correction",
    ),
  ];
  assert.throws(
    () => resolveAsOf(sloppy, { effective: "2026-03-01", asKnown: "2026-03-01T00:00:00Z" }),
    AmbiguousRevisionError,
  );
  assert.equal(
    refusalCode(() => resolveAsOf(sloppy, {
      effective: "2026-03-01", asKnown: "2026-03-01T00:00:00Z",
    })),
    "AMBIGUOUS_REVISION",
  );
});

test("identical duplicate live revisions refuse rather than deduplicate", () => {
  const twice = [
    makeRecordedRevision(
      makeEffectiveInterval("2026-01-01", null), "2026-01-01T00:00:00Z", null, "same",
    ),
    makeRecordedRevision(
      makeEffectiveInterval("2026-01-01", null), "2026-01-01T00:00:00Z", null, "same",
    ),
  ];
  assert.throws(
    () => resolveAsOf(twice, { effective: "2026-05-01", asKnown: "2026-05-01T00:00:00Z" }),
    AmbiguousRevisionError,
  );
});

test("microsecond-distinct stamps order instead of collapsing", () => {
  const chain = [
    makeRecordedRevision(
      makeEffectiveInterval("2026-01-01", null),
      "2026-02-01T00:00:00.000001Z",
      "2026-02-01T00:00:00.000002Z",
      "first",
    ),
    makeRecordedRevision(
      makeEffectiveInterval("2026-01-01", null),
      "2026-02-01T00:00:00.000002Z",
      null,
      "second",
    ),
  ];
  assert.equal(
    resolveAsOf(chain, { effective: "2026-03-01", asKnown: "2026-02-01T00:00:00.000001Z" }).payload,
    "first",
  );
  assert.equal(
    resolveAsOf(chain, { effective: "2026-03-01", asKnown: "2026-02-01T00:00:00.000002Z" }).payload,
    "second",
  );
});

test("trailing-zero fractions are the same instant for handoff", () => {
  const chain = [
    makeRecordedRevision(
      makeEffectiveInterval("2026-01-01", null),
      "2026-01-01T00:00:00Z",
      "2026-02-01T00:00:00.1Z",
      "first",
    ),
    makeRecordedRevision(
      makeEffectiveInterval("2026-01-01", null),
      "2026-02-01T00:00:00.100Z",
      null,
      "second",
    ),
  ];
  assert.equal(
    resolveAsOf(chain, { effective: "2026-03-01", asKnown: "2026-02-01T00:00:00.100000Z" }).payload,
    "second",
  );
});

test("resolution is independent of input order", () => {
  const chain: RecordedRevision<string>[] = [
    makeRecordedRevision(
      makeEffectiveInterval("2026-01-01", "2026-02-01"),
      "2026-01-01T00:00:00Z",
      null,
      "jan",
    ),
    makeRecordedRevision(
      makeEffectiveInterval("2026-02-01", "2026-03-01"),
      "2026-01-01T00:00:00Z",
      null,
      "feb",
    ),
    makeRecordedRevision(
      makeEffectiveInterval("2026-03-01", null),
      "2026-01-01T00:00:00Z",
      null,
      "mar",
    ),
  ];
  const orders = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
  for (const order of orders) {
    const shuffled: RecordedRevision<string>[] = [];
    for (const i of order) {
      const revision = chain[i];
      assert.ok(revision !== undefined);
      shuffled.push(revision);
    }
    assert.equal(
      resolveAsOf(shuffled, { effective: "2026-02-15", asKnown: "2026-04-01T00:00:00Z" }).payload,
      "feb",
    );
  }
});

test("malformed revisions and queries fail closed", () => {
  const ok = makeRecordedRevision(
    makeEffectiveInterval("2026-01-01", null), "2026-01-01T00:00:00Z", null, "v",
  );
  const badEffective = { ...ok, effective: { start: "2026-02-01", end: "2026-01-01" } };
  assert.throws(
    () => resolveAsOf([badEffective as RecordedRevision<string>], {
      effective: "2026-03-01", asKnown: "2026-03-01T00:00:00Z",
    }),
    EmptyIntervalError,
  );
  const badWindow = { ...ok, recordedUntil: "2025-01-01T00:00:00Z" };
  assert.throws(
    () => resolveAsOf([badWindow], { effective: "2026-03-01", asKnown: "2026-03-01T00:00:00Z" }),
    EmptyRecordedWindowError,
  );
  assert.throws(
    () => resolveAsOf([ok], { effective: "not-a-date", asKnown: "2026-03-01T00:00:00Z" }),
    InvalidCivilDateError,
  );
  assert.throws(
    () => resolveAsOf([ok], { effective: "2026-03-01", asKnown: "2026-03-01" }),
    InvalidRecordedStampError,
  );
});
