import assert from "node:assert/strict";
import test from "node:test";
import { openingLevySourceCorrectionRequestSha256 } from "./opening-levy-source-correction-authority.ts";

const correction = {
  requestId: "10000000-0000-4000-8000-000000000001",
  expectedAuthorityId: "10000000-0000-4000-8000-000000000002",
  expectedAllocationSha256: "a".repeat(64),
};

test("source correction requests bind reviewed authority, source, actor and reason deterministically", () => {
  const payload = {
    actorId: "10000000-0000-4000-8000-000000000003",
    sourceSha256: "b".repeat(64),
    reason: "Correct the original source certification",
  };
  const digest = openingLevySourceCorrectionRequestSha256(correction, payload);
  assert.equal(
    openingLevySourceCorrectionRequestSha256(correction, {
      reason: payload.reason,
      sourceSha256: payload.sourceSha256,
      actorId: payload.actorId,
    }),
    digest,
  );
  for (const change of [
    { actorId: correction.requestId },
    { sourceSha256: "c".repeat(64) },
    { reason: "Changed source reason" },
  ]) {
    assert.notEqual(
      openingLevySourceCorrectionRequestSha256(correction, { ...payload, ...change }),
      digest,
    );
  }
  assert.notEqual(
    openingLevySourceCorrectionRequestSha256(
      { ...correction, expectedAuthorityId: correction.requestId },
      payload,
    ),
    digest,
  );
  assert.notEqual(
    openingLevySourceCorrectionRequestSha256(
      { ...correction, expectedAllocationSha256: "d".repeat(64) },
      payload,
    ),
    digest,
  );
});

test("source correction requests refuse unknown native identities and missing reviewed allocation digests", () => {
  for (const change of [
    { requestId: "" },
    { expectedAuthorityId: "unknown" },
    { expectedAllocationSha256: "" },
    { expectedAllocationSha256: "A".repeat(64) },
  ]) {
    assert.throws(
      () => openingLevySourceCorrectionRequestSha256({ ...correction, ...change }, {}),
      /Reload the sealed opening certificate/,
    );
  }
});
