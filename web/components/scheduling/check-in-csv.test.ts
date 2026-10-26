import assert from "node:assert/strict";
import test from "node:test";
import { csvRows, parseCheckInCsv } from "./check-in-csv";

test("a time-clock export becomes UTC check-ins that keep every source column", () => {
  const parsed = parseCheckInCsv(
    [
      "Source_Event_ID,source_worker_id,kind,occurred_at,terminal,note",
      'E-1,BADGE-7,clock_in,2026-03-08T08:58:00-05:00,Front door,"Late bus, ""express"""',
      "E-2,BADGE-7,CLOCK_OUT,2026-03-08 17:01:30Z,Front door,",
    ].join("\r\n"),
  );
  assert.deepEqual(parsed.problems, []);
  assert.deepEqual(
    parsed.events.map((event) => [
      event.sourceEventId,
      event.kind,
      event.occurredAt,
      event.sourceVersion,
    ]),
    [
      ["E-1", "clock_in", "2026-03-08T13:58:00.000Z", 1],
      ["E-2", "clock_out", "2026-03-08T17:01:30.000Z", 1],
    ],
  );
  assert.equal(parsed.events[0]!.sourcePayload.note, 'Late bus, "express"');
  assert.equal(parsed.events[0]!.supersedesId, null);
});

test("times without an offset, unknown kinds, bad versions and repeated source versions are refused by line", () => {
  const parsed = parseCheckInCsv(
    [
      "source_event_id,source_worker_id,kind,occurred_at,source_version",
      "E-1,W-1,clock_in,2026-11-01T01:30:00,1",
      "E-2,W-1,lunch,2026-11-01T06:30:00Z,1",
      "E-3,W-1,clock_out,2026-11-01T14:00:00Z,0",
      "E-4,W-1,clock_out,2026-11-01T14:00:00Z,2",
      "E-4,W-1,clock_out,2026-11-01T14:05:00Z,2",
      "E-5,,clock_in,2026-11-01T14:00:00Z,1",
      "E-6,W-1,clock_in",
    ].join("\n"),
  );
  assert.deepEqual(parsed.problems, [
    { code: "time", line: 2 },
    { code: "kind", line: 3 },
    { code: "version", line: 4 },
    { code: "duplicate", line: 6, firstLine: 5 },
    { code: "blank", line: 7 },
    { code: "columns", line: 8 },
  ]);
  assert.deepEqual(
    parsed.events.map((event) => [event.sourceEventId, event.sourceVersion]),
    [["E-4", 2]],
  );
});

test("a file without the required header columns or rows admits nothing", () => {
  assert.deepEqual(parseCheckInCsv("source_event_id,kind\nE-1,clock_in").problems, [
    { code: "missing_column", column: "source_worker_id" },
    { code: "missing_column", column: "occurred_at" },
  ]);
  assert.deepEqual(
    parseCheckInCsv("\uFEFFsource_event_id,source_worker_id,kind,occurred_at\n\n").problems,
    [{ code: "empty" }],
  );
  assert.deepEqual(csvRows('a,"b\nc"\n\n'), [["a", "b\nc"]]);
});
