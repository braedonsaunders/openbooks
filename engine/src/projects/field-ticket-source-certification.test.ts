import assert from "node:assert/strict";
import test from "node:test";
import {
  certifyFieldTicketSourceIdentity,
  classifyExistingSourceMarker,
  certificationProjectionChangesOnlyMetadata,
  fieldTicketSourceCertificationRequestSha256,
  nativePointInTimeFingerprint,
  FieldTicketSourceCertificationError,
  type CertifyFieldTicketSourceIdentityInput,
} from "./field-ticket-source-certification.ts";

const ACTOR = "11111111-1111-4111-8111-111111111111";
const OTHER_ACTOR = "22222222-2222-4222-8222-222222222222";

const input = (
  overrides: Partial<CertifyFieldTicketSourceIdentityInput> = {},
): CertifyFieldTicketSourceIdentityInput => ({
  orgId: "33333333-3333-4333-8333-333333333333",
  actorId: ACTOR,
  requestId: "44444444-4444-4444-8444-444444444444",
  nativeDocumentId: "55555555-5555-4555-8555-555555555555",
  expectedNativeRevision: "7",
  sourceSystem: "legacy-app",
  sourceTicketId: "100",
  sourceFileId: "66666666-6666-4666-8666-666666666666",
  sourceVersionId: "77777777-7777-4777-8777-777777777777",
  sourceFileSha256: "a".repeat(64),
  attestation: "I reviewed the source export against this native ticket and attest this crosswalk.",
  reason: "The native ticket has no source identity and this is its reviewed source ticket.",
  explicitReferenceMap: {
    jobRef: "JOB-1",
    customerRef: "C1",
    foremanRef: "F1",
    superintendentRef: "S1",
    projectId: "88888888-8888-4888-8888-888888888888",
    customerPartyId: "99999999-9999-4999-8999-999999999999",
    foremanPartyId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    superintendentPartyId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  },
  ...overrides,
});

test("a stored source marker is classified as absent, exact, partial or conflicting", () => {
  assert.equal(classifyExistingSourceMarker({}, "legacy-app", "100"), "absent");
  assert.equal(classifyExistingSourceMarker({ retained: true }, "legacy-app", "100"), "absent");
  assert.equal(
    classifyExistingSourceMarker(
      { source: { system: "legacy-app", externalId: "100" } },
      "legacy-app",
      "100",
    ),
    "exact",
  );
  assert.equal(
    classifyExistingSourceMarker({ source: { system: "legacy-app" } }, "legacy-app", "100"),
    "partial",
  );
  assert.equal(
    classifyExistingSourceMarker({ source: "legacy-app" }, "legacy-app", "100"),
    "partial",
  );
  assert.equal(
    classifyExistingSourceMarker(
      { source: { system: "other", externalId: "100" } },
      "legacy-app",
      "100",
    ),
    "conflict",
  );
  assert.equal(
    classifyExistingSourceMarker(
      { source: { system: "legacy-app", externalId: "101" } },
      "legacy-app",
      "100",
    ),
    "conflict",
  );
});

test("no source identity is inferred from a native ticket number", async () => {
  // The command refuses a malformed request before any database work: a
  // caller must name the exact source ticket and retained file, so a
  // number alone can never become a guessed binding.
  await assert.rejects(
    certifyFieldTicketSourceIdentity(input({ sourceTicketId: "  " })),
    (error: unknown) =>
      error instanceof FieldTicketSourceCertificationError &&
      /exact source ticket id/.test(error.message),
  );
  await assert.rejects(
    certifyFieldTicketSourceIdentity(input({ sourceFileSha256: "not-a-hash" })),
    (error: unknown) =>
      error instanceof FieldTicketSourceCertificationError && /SHA-256/.test(error.message),
  );
});

test("an exact request payload hash is stable and binds the actor", () => {
  const payload = input();
  const { orgId: _orgId, actorId: _actorId, ...rest } = payload;
  const first = fieldTicketSourceCertificationRequestSha256(ACTOR, rest);
  assert.equal(first, fieldTicketSourceCertificationRequestSha256(ACTOR, { ...rest }));
  assert.notEqual(first, fieldTicketSourceCertificationRequestSha256(OTHER_ACTOR, rest));
  assert.notEqual(
    first,
    fieldTicketSourceCertificationRequestSha256(ACTOR, { ...rest, sourceTicketId: "101" }),
  );
  assert.match(first, /^[a-f0-9]{64}$/);
});

test("the point-in-time fingerprint is deterministic over canonical native evidence", () => {
  const pointInTime = {
    document: { id: "d1", total: "95.0000", revision_seq: "7" },
    timeEntries: [{ id: "t1", hours: "8.0000" }],
  };
  assert.equal(
    nativePointInTimeFingerprint(pointInTime),
    nativePointInTimeFingerprint(JSON.parse(JSON.stringify(pointInTime))),
  );
  assert.notEqual(
    nativePointInTimeFingerprint(pointInTime),
    nativePointInTimeFingerprint({ ...pointInTime, timeEntries: [{ id: "t1", hours: "9.0000" }] }),
  );
});

test("only the source projection and revision stamps may differ after certification", () => {
  const before = {
    document: {
      id: "d1",
      status: "approved",
      total: "95.0000",
      revision_seq: "7",
      updated_at: "t0",
      updated_by: "u0",
      custom: { retained: "native context" },
    },
    documentLines: [{ id: "l1", amount: "95.0000" }],
    timeEntries: [{ id: "t1", hours: "8.0000" }],
    laborSnapshots: [{ id: "s1", revision: 1 }],
  };
  const after = JSON.parse(JSON.stringify(before)) as typeof before;
  (after.document as Record<string, unknown>).revision_seq = "8";
  (after.document as Record<string, unknown>).updated_at = "t1";
  (after.document as Record<string, unknown>).updated_by = "u1";
  ((after.document as Record<string, unknown>).custom as Record<string, unknown>).source = {
    system: "legacy-app",
    externalId: "100",
  };
  assert.equal(certificationProjectionChangesOnlyMetadata(before, after), true);

  const financialChange = JSON.parse(JSON.stringify(after)) as typeof before;
  (financialChange.document as Record<string, unknown>).total = "96.0000";
  assert.equal(certificationProjectionChangesOnlyMetadata(before, financialChange), false);

  const timeChange = JSON.parse(JSON.stringify(after)) as typeof before;
  timeChange.timeEntries[0] = { id: "t1", hours: "9.0000" };
  assert.equal(certificationProjectionChangesOnlyMetadata(before, timeChange), false);

  const statusChange = JSON.parse(JSON.stringify(after)) as typeof before;
  (statusChange.document as Record<string, unknown>).status = "draft";
  assert.equal(certificationProjectionChangesOnlyMetadata(before, statusChange), false);
});
