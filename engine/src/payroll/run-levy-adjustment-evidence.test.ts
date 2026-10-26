import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalEmployerLevyAdjustmentAmount,
  canonicalLevySourceKey,
  employerLevyAdjustmentEvidence,
  isEmployerLevyAdjustmentEvidenceCandidate,
  isEmployerLevyProgramKey,
  parseEmployerLevyAdjustmentEvidence,
} from "./run-levy-adjustment-evidence.ts";

const REQUEST = "26a32000-0000-4000-8000-000000000001";
const GROUP = "33231900-0000-4000-8000-000000000002";

test("employer levy adjustment evidence retains programme, group and source key", () => {
  const encoded = employerLevyAdjustmentEvidence({
    programKey: "ca_wcb",
    workerCompGroupId: GROUP,
    sourceKey: "source-card:43129:313",
    reason: "Recorded as issued per owner decision; source adjustment card 43129",
    sourceReference: "card export sha256 dcf68895 line 1244",
    requestId: REQUEST,
  });
  assert.deepEqual(parseEmployerLevyAdjustmentEvidence(encoded), {
    kind: "employer_levy_adjustment",
    programKey: "ca_wcb",
    workerCompGroupId: GROUP,
    sourceKey: "source-card:43129:313",
    reason: "Recorded as issued per owner decision; source adjustment card 43129",
    sourceReference: "card export sha256 dcf68895 line 1244",
    requestId: REQUEST,
  });
  assert.equal(isEmployerLevyAdjustmentEvidenceCandidate(encoded), true);
});

test("employer levy adjustment evidence refuses malformed programme, group and source key shapes", () => {
  assert.equal(isEmployerLevyProgramKey("ca_eht"), true);
  assert.equal(isEmployerLevyProgramKey("ca_wcb"), true);
  assert.equal(isEmployerLevyProgramKey("cpp"), false);
  assert.equal(isEmployerLevyProgramKey("income_tax"), false);
  assert.equal(canonicalLevySourceKey(" source-card:1 "), "source-card:1");
  assert.equal(canonicalLevySourceKey("has space"), null);
  assert.equal(canonicalLevySourceKey(""), null);
  // WCB without its group, and EHT with one, are both unrecordable.
  assert.equal(
    parseEmployerLevyAdjustmentEvidence(
      employerLevyAdjustmentEvidence({
        programKey: "ca_wcb",
        workerCompGroupId: null,
        sourceKey: "source-card:1",
        reason: "x",
        sourceReference: "y",
        requestId: REQUEST,
      }),
    ),
    null,
  );
  assert.equal(
    parseEmployerLevyAdjustmentEvidence(
      employerLevyAdjustmentEvidence({
        programKey: "ca_eht",
        workerCompGroupId: GROUP,
        sourceKey: "source-card:1",
        reason: "x",
        sourceReference: "y",
        requestId: REQUEST,
      }),
    ),
    null,
  );
  assert.equal(
    parseEmployerLevyAdjustmentEvidence(
      '{"kind":"employer_levy_adjustment","programKey":"ca_eht","workerCompGroupId":null,"sourceKey":"has space","reason":"x","sourceReference":"y","requestId":"bad"}',
    ),
    null,
  );
  assert.equal(
    isEmployerLevyAdjustmentEvidenceCandidate('{"kind" : "employer_levy_adjustment"'),
    true,
  );
  assert.equal(isEmployerLevyAdjustmentEvidenceCandidate("ordinary note"), false);
});

test("employer levy adjustment amount is cents-exact and positive", () => {
  assert.equal(canonicalEmployerLevyAdjustmentAmount("26.32"), "26.32");
  assert.throws(() => canonicalEmployerLevyAdjustmentAmount("-17.82"), /positive issued premium/);
  assert.throws(() => canonicalEmployerLevyAdjustmentAmount("0.00"), /positive issued premium/);
  assert.throws(() => canonicalEmployerLevyAdjustmentAmount("10.005"), /exact currency amount/);
});
