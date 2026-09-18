/**
 * AU 2026–27 Schedule 1 transcription integrity: every scale present with
 * the row count and the headline coefficients quoted from F2026L00716.
 * Engine assertions live in au-goldens.test.ts.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  AU_SCHEDULE1_SCALE1_2027,
  AU_SCHEDULE1_SCALE1_STSL_2027,
  AU_SCHEDULE1_SCALE2_2027,
  AU_SCHEDULE1_SCALE2_STSL_2027,
  AU_SCHEDULE1_SCALE3_2027,
  AU_SCHEDULE1_SCALE3_STSL_2027,
  AU_SCHEDULE1_SCALE4_2027,
  AU_SCHEDULE1_SCALE5_2027,
  AU_SCHEDULE1_SCALE5_STSL_2027,
  AU_SCHEDULE1_SCALE6_2027,
  AU_SCHEDULE1_SCALE6_STSL_2027,
  AU_SCHEDULE8_STSL_NO_THRESHOLD_2027,
  AU_SCHEDULE8_STSL_THRESHOLD_2027,
} from "./schedule1-2027.ts";

test("AU Schedule 1 base scales carry every instrument row", () => {
  assert.equal(AU_SCHEDULE1_SCALE1_2027.length, 7);
  assert.deepEqual(AU_SCHEDULE1_SCALE1_2027[2], { lessThan: "515", a: "0.1790", b: "0.1066" });
  assert.deepEqual(AU_SCHEDULE1_SCALE1_2027[6], { lessThan: null, a: "0.4700", b: "493.1893" });
  assert.equal(AU_SCHEDULE1_SCALE2_2027.length, 9);
  assert.deepEqual(AU_SCHEDULE1_SCALE2_2027[0], { lessThan: "362", a: null, b: null });
  assert.deepEqual(AU_SCHEDULE1_SCALE2_2027[8], { lessThan: null, a: "0.4700", b: "655.7704" });
  assert.equal(AU_SCHEDULE1_SCALE3_2027.length, 3);
  assert.deepEqual(AU_SCHEDULE1_SCALE3_2027[2], { lessThan: null, a: "0.4500", b: "474.0385" });
  assert.deepEqual(AU_SCHEDULE1_SCALE4_2027, { residentRate: "0.4700", foreignRate: "0.4500" });
  assert.equal(AU_SCHEDULE1_SCALE5_2027.length, 7);
  assert.equal(AU_SCHEDULE1_SCALE6_2027.length, 9);
});

test("AU Schedule 8 combined tables split at the STSL floors", () => {
  // Below the STSL floor the combined row repeats the base coefficients.
  assert.deepEqual(
    AU_SCHEDULE1_SCALE2_STSL_2027[6],
    { lessThan: "1337", a: "0.3200", b: "181.7319" },
  );
  assert.deepEqual(
    AU_SCHEDULE1_SCALE1_STSL_2027[4],
    { lessThan: "987", a: "0.3200", b: "71.6508" },
  );
  assert.deepEqual(
    AU_SCHEDULE1_SCALE3_STSL_2027[0],
    { lessThan: "1337", a: "0.3000", b: "0.3000" },
  );
  assert.equal(AU_SCHEDULE1_SCALE5_STSL_2027.length, 10);
  assert.equal(AU_SCHEDULE1_SCALE6_STSL_2027.length, 12);
  assert.deepEqual(AU_SCHEDULE1_SCALE5_STSL_2027[5], {
    lessThan: "2494",
    a: "0.4500",
    b: "382.2923",
  });
  assert.deepEqual(AU_SCHEDULE1_SCALE6_STSL_2027[7], {
    lessThan: "2494",
    a: "0.4600",
    b: "382.2923",
  });
  assert.deepEqual(AU_SCHEDULE8_STSL_THRESHOLD_2027[1], {
    lessThan: "2494",
    a: "0.15",
    b: "200.5615",
  });
  assert.deepEqual(AU_SCHEDULE8_STSL_NO_THRESHOLD_2027[1], {
    lessThan: "2144",
    a: "0.15",
    b: "148.0615",
  });
});
