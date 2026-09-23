import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  allocateShiftNetMs,
  checkEquipmentTolerance,
  distributeProRata,
  hoursToQuantumUnits,
  insideCircle,
  insidePolygon,
  netShiftMs,
  quantumUnitsToHours,
  roundHours,
  roundingQuantumUnits,
  sameClockPayload,
  splitZoneDays,
  validateClockSequence,
  validateEventChronology,
  validateStages,
  type ClockPayload,
} from "./pure.ts";
import { FieldTimeError } from "./errors.ts";

function refuses(fn: () => void): string {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof FieldTimeError, "refusal is a FieldTimeError");
    return (e as FieldTimeError).message;
  }
  assert.fail("expected a refusal");
}

describe("rounding rules", () => {
  it("none keeps exact hours", () => {
    assert.equal(roundHours("7.1267", { incrementMinutes: 0, mode: "nearest" }), "7.1267");
  });
  it("nearest quarter rounds 7.13 to 7.25", () => {
    assert.equal(roundHours("7.13", { incrementMinutes: 15, mode: "nearest" }), "7.2500");
  });
  it("nearest quarter rounds 7.11 to 7.00", () => {
    assert.equal(roundHours("7.11", { incrementMinutes: 15, mode: "nearest" }), "7.0000");
  });
  it("up always rounds up a partial tenth", () => {
    assert.equal(roundHours("7.01", { incrementMinutes: 6, mode: "up" }), "7.1000");
  });
  it("down truncates a partial tenth", () => {
    assert.equal(roundHours("7.19", { incrementMinutes: 6, mode: "down" }), "7.1000");
  });
  it("exact steps are untouched in every mode", () => {
    assert.equal(roundHours("8.25", { incrementMinutes: 15, mode: "up" }), "8.2500");
    assert.equal(roundHours("8.25", { incrementMinutes: 15, mode: "down" }), "8.2500");
  });
  it("unknown increment is refused by name", () => {
    const msg = refuses(() => roundHours("8", { incrementMinutes: 10, mode: "nearest" }));
    assert.match(msg, /none, 6 or 15/);
  });
});

describe("break subtraction", () => {
  it("recorded breaks replace the auto-deduction up to their length", () => {
    // 8h shift, 45 recorded minutes, 30-minute rule → 7.25h net.
    assert.equal(netShiftMs(8 * 3_600_000, 45 * 60_000, 30), 7.25 * 3_600_000);
  });
  it("the declared rule applies when no break is recorded", () => {
    assert.equal(netShiftMs(8 * 3_600_000, 0, 30), 7.5 * 3_600_000);
  });
  it("breaks never drive net time negative", () => {
    assert.equal(netShiftMs(15 * 60_000, 60 * 60_000, 0), 0);
  });
  it("an undeclared rule refuses by name", () => {
    refuses(() => netShiftMs(8 * 3_600_000, 0, -1));
  });
});

describe("pro-rata dealing", () => {
  it("deals the exact total with the largest remainder", () => {
    assert.deepEqual(distributeProRata(10, [2, 1]), [7, 3]);
    assert.deepEqual(distributeProRata(0, [5, 5]), [0, 0]);
    assert.deepEqual(distributeProRata(7, [0, 0]), [0, 0]);
  });
  it("ties break to the earlier index, deterministically", () => {
    assert.deepEqual(distributeProRata(3, [1, 1, 1]), [1, 1, 1]);
    assert.deepEqual(distributeProRata(1, [1, 1]), [1, 0]);
  });
});

describe("shift-level break allocation", () => {
  const H = 3_600_000;
  it("deducts the declared break once across segments, not per segment", () => {
    // 08:00-16:00 with a noon project switch and a 30-minute rule:
    // 7.5h net, dealt 3.75h + 3.75h — never 7h.
    const nets = allocateShiftNetMs([4 * H, 4 * H], [0, 0], 30);
    assert.deepEqual(nets, [3.75 * H, 3.75 * H]);
  });
  it("recorded breaks cover the declared rule shift-wide", () => {
    // 45 recorded minutes in the first segment cover the 30-minute
    // rule, so the second segment keeps its full 4h.
    const nets = allocateShiftNetMs([4 * H, 4 * H], [45 * 60_000, 0], 30);
    assert.deepEqual(nets, [3.25 * H, 4 * H]);
  });
  it("the nets sum to the shift-level net rule", () => {
    const nets = allocateShiftNetMs([4 * H, 4 * H], [10 * 60_000, 0], 30);
    assert.equal(nets.reduce((a, b) => a + b, 0), netShiftMs(8 * H, 10 * 60_000, 30));
  });
  it("a break longer than the shift nets to zero, never negative", () => {
    assert.deepEqual(allocateShiftNetMs([4 * H], [0], 300), [0]);
  });
});

describe("round-once dealing", () => {
  const quarter = { incrementMinutes: 15, mode: "nearest" } as const;
  it("quanta match the rounding rule", () => {
    assert.equal(roundingQuantumUnits({ incrementMinutes: 0, mode: "nearest" }), 1);
    assert.equal(roundingQuantumUnits({ incrementMinutes: 6, mode: "up" }), 1000);
    assert.equal(roundingQuantumUnits(quarter), 2500);
  });
  it("hours round-trip through quanta", () => {
    assert.equal(hoursToQuantumUnits("7.5000", quarter), 30);
    assert.equal(quantumUnitsToHours(30, quarter), "7.5000");
    assert.equal(quantumUnitsToHours(1, quarter), "0.2500");
  });
  it("a value that is not a whole multiple of the quantum refuses", () => {
    refuses(() => hoursToQuantumUnits("7.1300", quarter));
  });
  it("UTC day splits are exact to the millisecond", () => {
    const pieces = splitZoneDays(
      Date.parse("2026-09-14T23:52:00.000Z"),
      Date.parse("2026-09-15T00:08:00.000Z"),
      "UTC",
    );
    assert.deepEqual(pieces.map((p) => p.date), ["2026-09-14", "2026-09-15"]);
    assert.deepEqual(pieces.map((p) => p.ms), [8 * 60_000, 8 * 60_000]);
  });
  it("a single-day span is one piece", () => {
    const pieces = splitZoneDays(
      Date.parse("2026-09-14T08:00:00.000Z"),
      Date.parse("2026-09-14T16:00:00.000Z"),
      "UTC",
    );
    assert.deepEqual(pieces, [{ date: "2026-09-14", ms: 8 * 3_600_000 }]);
  });
  it("a UTC-5 evening shift stays on its one local date", () => {
    // 20:00-24:00 Toronto time is 01:00-05:00Z: a UTC split would date
    // the whole shift on Jan 15.
    const pieces = splitZoneDays(
      Date.parse("2026-01-15T01:00:00.000Z"),
      Date.parse("2026-01-15T05:00:00.000Z"),
      "America/Toronto",
    );
    assert.deepEqual(pieces, [{ date: "2026-01-14", ms: 4 * 3_600_000 }]);
  });
  it("an overnight local shift splits at the business midnight", () => {
    // 22:00-02:00 Toronto time: local midnight is 05:00Z.
    const pieces = splitZoneDays(
      Date.parse("2026-01-15T03:00:00.000Z"),
      Date.parse("2026-01-15T07:00:00.000Z"),
      "America/Toronto",
    );
    assert.deepEqual(pieces, [
      { date: "2026-01-14", ms: 2 * 3_600_000 },
      { date: "2026-01-15", ms: 2 * 3_600_000 },
    ]);
  });
  it("an unknown zone refuses instead of guessing a boundary", () => {
    refuses(() => splitZoneDays(Date.parse("2026-01-15T01:00:00.000Z"), Date.parse("2026-01-15T05:00:00.000Z"), "Not/AZone"));
  });
  it("the 23:52-00:08 shift deals its single quarter deterministically", () => {
    // 16 minutes round once to one quarter; the 8/8-minute tie breaks
    // to the earlier day, and the posted entries sum to exactly 0.25.
    assert.deepEqual(distributeProRata(1, [8 * 60_000, 8 * 60_000]), [1, 0]);
  });
});

describe("geofence containment", () => {
  it("circle admits inside and refuses outside", () => {
    const center = { lat: 43.6532, lng: -79.3832 };
    assert.equal(insideCircle({ lat: 43.6533, lng: -79.3832 }, center, 100), true);
    assert.equal(insideCircle({ lat: 43.66, lng: -79.39 }, center, 100), false);
  });
  it("concave polygon admits the notch interior and refuses the bay", () => {
    // C-shaped block: the bay (right-middle) is outside though bounded on three sides.
    const polygon = [
      { lat: 0, lng: 0 },
      { lat: 0, lng: 10 },
      { lat: 4, lng: 10 },
      { lat: 4, lng: 6 },
      { lat: 6, lng: 6 },
      { lat: 6, lng: 10 },
      { lat: 10, lng: 10 },
      { lat: 10, lng: 0 },
    ];
    assert.equal(insidePolygon({ lat: 2, lng: 8 }, polygon), true);
    assert.equal(insidePolygon({ lat: 5, lng: 8 }, polygon), false);
    assert.equal(insidePolygon({ lat: 5, lng: 4 }, polygon), true);
  });
  it("fence line counts as inside", () => {
    const polygon = [
      { lat: 0, lng: 0 },
      { lat: 0, lng: 10 },
      { lat: 10, lng: 10 },
      { lat: 10, lng: 0 },
    ];
    assert.equal(insidePolygon({ lat: 0, lng: 5 }, polygon), true);
  });
});

describe("clock sequencing", () => {
  it("clock-in while clocked in is refused", () => {
    const msg = refuses(() => validateClockSequence("clock_in", { clockedIn: true, onBreak: false }));
    assert.match(msg, /Already clocked in/);
  });
  it("clock-out with no open pair is refused, never silently paired", () => {
    const msg = refuses(() => validateClockSequence("clock_out", { clockedIn: false, onBreak: false }));
    assert.match(msg, /No open clock-in/);
  });
  it("clock-out on an open break names the remedy", () => {
    const msg = refuses(() => validateClockSequence("clock_out", { clockedIn: true, onBreak: true }));
    assert.match(msg, /end the break/);
  });
  it("break_end with no break is refused", () => {
    refuses(() => validateClockSequence("break_end", { clockedIn: true, onBreak: false }));
  });
  it("a clean shift passes", () => {
    validateClockSequence("clock_in", { clockedIn: false, onBreak: false });
    validateClockSequence("break_start", { clockedIn: true, onBreak: false });
    validateClockSequence("break_end", { clockedIn: true, onBreak: true });
    validateClockSequence("clock_out", { clockedIn: true, onBreak: false });
  });
});

describe("event chronology", () => {
  const open = Date.parse("2026-09-14T11:00:00.000Z");
  it("a clock-out before its clock-in refuses by name", () => {
    const msg = refuses(() => validateEventChronology("clock_out", open, Date.parse("2026-09-14T10:30:00.000Z")));
    assert.match(msg, /clock-out.*not after the open clock-in/);
  });
  it("a close at the same instant as the open refuses", () => {
    refuses(() => validateEventChronology("switch", open, open));
  });
  it("break and switch events before the open refuse", () => {
    refuses(() => validateEventChronology("break_start", open, open - 1));
    refuses(() => validateEventChronology("switch", open, open - 60_000));
  });
  it("a close after the open passes", () => {
    validateEventChronology("clock_out", open, open + 1);
    validateEventChronology("switch", open, open + 3_600_000);
    validateEventChronology("break_end", open, open + 1_800_000);
  });
});

describe("offline payload identity", () => {
  const base: ClockPayload = {
    kind: "clock_in",
    occurredAtMs: Date.parse("2026-09-14T11:00:00.000Z"),
    employeePartyId: "11111111-1111-4111-8111-111111111111",
    projectId: "22222222-2222-4222-8222-222222222222",
    projectTaskId: null,
    costCodeRef: null,
    source: "mobile",
  };
  it("an identical replay matches", () => {
    assert.equal(sameClockPayload(base, { ...base }), true);
  });
  it("ids match case-insensitively", () => {
    assert.equal(
      sameClockPayload(base, { ...base, projectId: "22222222-2222-4222-8222-222222222222".toUpperCase() }),
      true,
    );
  });
  it("a different kind, instant, worker, project or source conflicts", () => {
    assert.equal(sameClockPayload(base, { ...base, kind: "clock_out" }), false);
    assert.equal(sameClockPayload(base, { ...base, occurredAtMs: base.occurredAtMs + 1 }), false);
    assert.equal(sameClockPayload(base, { ...base, employeePartyId: "33333333-3333-4333-8333-333333333333" }), false);
    assert.equal(sameClockPayload(base, { ...base, projectId: null }), false);
    assert.equal(sameClockPayload(base, { ...base, source: "kiosk" }), false);
  });
});

describe("stage validation", () => {
  it("a two-stage chain validates in order", () => {
    const stages = validateStages([
      { order: 2, approverKind: "payroll" },
      { order: 1, approverKind: "supervisor" },
    ]);
    assert.deepEqual(stages.map((s) => s.order), [1, 2]);
  });
  it("gapped orders are refused", () => {
    const msg = refuses(() => validateStages([{ order: 1, approverKind: "supervisor" }, { order: 3, approverKind: "payroll" }]));
    assert.match(msg, /without gaps/);
  });
  it("role without a key is refused", () => {
    refuses(() => validateStages([{ order: 1, approverKind: "role" }]));
  });
  it("empty chain is refused", () => {
    refuses(() => validateStages([]));
  });
});

describe("equipment tolerance", () => {
  it("equipment within tolerance passes", () => {
    checkEquipmentTolerance("8.0000", "8.5000", "1.0000");
  });
  it("equipment over tolerance names the remedy", () => {
    const msg = refuses(() => checkEquipmentTolerance("8.0000", "9.5000", "1.0000"));
    assert.match(msg, /split the equipment time/);
  });
});
