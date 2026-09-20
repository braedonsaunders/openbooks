import assert from "node:assert/strict";
import test from "node:test";
import {
  computeVacancy,
  effectiveOverlaps,
  formatFte,
  HrmPositionError,
  parseFte,
  positionDisagreements,
  PositionOverfilledError,
  PositionUnderfundedError,
  vacancyRefusalFor,
} from "./positions.ts";
import { HrmChangeRequestError, validateChangePayload } from "./change-requests.ts";

/**
 * Pure position/vacancy math (no database). Every refusal below is produced
 * by the real function — no doubles — and every message assertion names the
 * remedy, because the message is the entire product of a failing check.
 */

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof HrmPositionError || error instanceof HrmChangeRequestError);
    return error.code;
  }
  assert.fail("expected a refusal");
}

test("fte parses exact ten-thousandths and formats the stored shape", () => {
  assert.equal(parseFte("1"), 10000n);
  assert.equal(parseFte("1.5"), 15000n);
  assert.equal(parseFte("1.5000"), 15000n);
  assert.equal(parseFte("0.0001"), 1n);
  assert.equal(formatFte(15000n), "1.5000");
  assert.equal(formatFte(0n), "0.0000");
  assert.equal(formatFte(-2500n), "-0.2500");
});

test("fte refuses non-decimal inputs by name", () => {
  assert.equal(codeOf(() => parseFte("-1")), "INVALID_INPUT");
  assert.equal(codeOf(() => parseFte("NaN")), "INVALID_INPUT");
  assert.equal(codeOf(() => parseFte("1e3")), "INVALID_INPUT");
  assert.equal(codeOf(() => parseFte("")), "INVALID_INPUT");
  assert.equal(codeOf(() => parseFte("1.00001")), "INVALID_INPUT");
  assert.equal(codeOf(() => parseFte("1,5")), "INVALID_INPUT");
  assert.equal(codeOf(() => parseFte(null)), "INVALID_INPUT");
  assert.throws(() => parseFte("abc"), /non-negative decimal with up to 4 fraction digits/);
});

test("vacancy reports planned, funded, filled and vacant exactly", () => {
  const vacancy = computeVacancy({ plannedFte: "1.0000", fundedFte: "1.0000", filledFte: "0.5000" });
  assert.equal(vacancy.vacantFte, "0.5000");
  assert.equal(vacancy.overFilled, false);
  assert.equal(vacancy.underFunded, false);
  assert.equal(vacancy.overFunded, false);
});

test("vacancy never clamps a negative over-fill to zero", () => {
  const vacancy = computeVacancy({ plannedFte: "1.0000", fundedFte: "1.0000", filledFte: "1.5000" });
  assert.equal(vacancy.vacantFte, "-0.5000");
  assert.equal(vacancy.overFilled, true);
});

test("vacancy flags under-funding and over-funding separately", () => {
  const under = computeVacancy({ plannedFte: "1.0000", fundedFte: "0.5000", filledFte: "1.0000" });
  assert.equal(under.underFunded, true);
  assert.equal(under.overFunded, false);
  const over = computeVacancy({ plannedFte: "1.0000", fundedFte: "1.5000", filledFte: "1.0000" });
  assert.equal(over.overFunded, true);
  assert.equal(over.underFunded, false);
});

test("vacancy sums without float drift", () => {
  // 0.1 + 0.2 in floats is 0.30000000000000004; ten-thousandths stay exact.
  const vacancy = computeVacancy({ plannedFte: "0.3000", fundedFte: "0.3000", filledFte: "0.3000" });
  assert.equal(vacancy.vacantFte, "0.0000");
  assert.equal(vacancy.overFilled, false);
});

test("over-filled refusal names the position and the remedy", () => {
  const vacancy = computeVacancy({ plannedFte: "1.0000", fundedFte: "2.0000", filledFte: "1.5000" });
  const refusal = vacancyRefusalFor("ENG-1042", vacancy);
  assert.ok(refusal instanceof PositionOverfilledError);
  assert.equal(refusal.code, "OVER_FILLED");
  assert.match(refusal.message, /ENG-1042/);
  assert.match(refusal.message, /1\.5000/);
  assert.match(refusal.message, /1\.0000/);
  assert.match(refusal.message, /revise the position|move an assignment/);
});

test("under-funded refusal names the position and the remedy", () => {
  const vacancy = computeVacancy({ plannedFte: "2.0000", fundedFte: "0.5000", filledFte: "1.0000" });
  const refusal = vacancyRefusalFor("ENG-1042", vacancy);
  assert.ok(refusal instanceof PositionUnderfundedError);
  assert.equal(refusal.code, "UNDER_FUNDED");
  assert.match(refusal.message, /ENG-1042/);
  assert.match(refusal.message, /fund the period|move an assignment/);
});

test("over-filling takes precedence over under-funding in one breach", () => {
  const vacancy = computeVacancy({ plannedFte: "1.0000", fundedFte: "0.5000", filledFte: "1.5000" });
  const refusal = vacancyRefusalFor("ENG-1042", vacancy);
  assert.ok(refusal instanceof PositionOverfilledError);
});

test("a covered plan produces no refusal", () => {
  const vacancy = computeVacancy({ plannedFte: "1.0000", fundedFte: "1.0000", filledFte: "1.0000" });
  assert.equal(vacancyRefusalFor("ENG-1042", vacancy), null);
});

test("disagreement warns only on fields set on both sides", () => {
  const position = { title: "Engineer", departmentId: "d1", locationId: "l1" };
  assert.deepEqual(
    positionDisagreements("ENG-1042", position, { title: null, departmentId: null, locationId: null }),
    [],
  );
  assert.deepEqual(
    positionDisagreements("ENG-1042", position, { title: "Engineer", departmentId: "d1", locationId: "l1" }),
    [],
  );
  const warnings = positionDisagreements(
    "ENG-1042",
    position,
    { title: "Senior Engineer", departmentId: "d2", locationId: "l1" },
  );
  assert.equal(warnings.length, 2);
  assert.match(warnings[0]!, /ENG-1042/);
  assert.match(warnings[0]!, /keeps its own title/);
  assert.match(warnings[1]!, /keeps its own department/);
});

test("blank assignment titles are uninherited content, not disagreement", () => {
  const warnings = positionDisagreements(
    "ENG-1042",
    { title: "Engineer", departmentId: null, locationId: null },
    { title: "   ", departmentId: null, locationId: null },
  );
  assert.deepEqual(warnings, []);
});

test("effective overlap is half-open: adjacency is not overlap", () => {
  assert.equal(
    effectiveOverlaps({ effective_from: "2026-01-01", effective_to: "2026-04-01" }, "2026-04-01", null),
    false,
  );
  assert.equal(
    effectiveOverlaps({ effective_from: "2026-01-01", effective_to: null }, "2026-04-01", null),
    true,
  );
  assert.equal(
    effectiveOverlaps({ effective_from: "2026-01-01", effective_to: "2026-06-01" }, "2026-04-01", "2026-05-01"),
    true,
  );
});

test("position_assignment payload validates the link and the window", () => {
  const parsed = validateChangePayload({
    kind: "position_assignment",
    assignmentKey: "primary",
    positionId: "11111111-1111-4111-8111-111111111111",
  });
  assert.equal(parsed.kind, "position_assignment");
  const unassign = validateChangePayload({
    kind: "position_assignment",
    assignmentKey: "primary",
    positionId: null,
  });
  assert.equal(unassign.kind, "position_assignment");
  assert.equal(codeOf(() => validateChangePayload({ kind: "position_assignment", assignmentKey: "primary" })), "INVALID_PAYLOAD");
  assert.equal(
    codeOf(() => validateChangePayload({ kind: "position_assignment", assignmentKey: "primary", positionId: "nope" })),
    "INVALID_PAYLOAD",
  );
  assert.equal(
    codeOf(() =>
      validateChangePayload({
        kind: "position_assignment",
        assignmentKey: "primary",
        positionId: null,
        effectiveFrom: "2026-05-01",
        effectiveTo: "2026-04-01",
      }),
    ),
    "INVALID_PAYLOAD",
  );
});
