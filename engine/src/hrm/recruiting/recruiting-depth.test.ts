import assert from "node:assert/strict";
import test from "node:test";
import {
  BOOKING_TOKEN_TTL_MS,
  createRecruitingToken,
  hashRecruitingToken,
  verifyRecruitingToken,
} from "./tokens.ts";
import { blindVisibleCardIds, RATING_VALUES } from "./scorecards.ts";
import { validateAvailabilityWindows } from "./scheduling.ts";
import {
  hashOfferDocument,
  renderOfferDocument,
  sealSignatureEvidence,
  type OfferClause,
} from "./offers-signing.ts";
import { pgTextArray, pgUuidArray } from "./depth.ts";
import { matchTags } from "./pools.ts";
import { ANONYMIZED_DISPLAY_NAME, retentionScopeMatches } from "./retention.ts";
import { requireCompensation } from "./requisitions.ts";

// The token signer reads the secret live from process.env (never a stored
// constant): pin a test-only secret and restore it afterwards.
const priorSecret = process.env.FLOWS_EMAIL_SECRET;
process.env.FLOWS_EMAIL_SECRET = "openbooks-test-only-recruiting-secret";
test.after(() => {
  if (priorSecret === undefined) delete process.env.FLOWS_EMAIL_SECRET;
  else process.env.FLOWS_EMAIL_SECRET = priorSecret;
});

const ID_A = "11111111-1111-4111-8111-111111111111";
const ID_B = "22222222-2222-4222-8222-222222222222";
const ID_C = "33333333-3333-4333-8333-333333333333";

test("requisition compensation refuses a reversed exact-decimal range", () => {
  assert.throws(
    () => requireCompensation({ min: "120000.0001", max: "120000.0000", currency: "USD", basis: "annual" }),
    (error: unknown) => error instanceof Error && error.message.includes("minimum is no greater"),
  );
  assert.deepEqual(requireCompensation({ min: "120000.0000", max: "120000.0001", currency: "USD", basis: "annual" }), {
    min: "120000.0000", max: "120000.0001", currency: "USD", basis: "annual",
  });
});

test("booking tokens verify for their purpose and row, and nowhere else", () => {
  const token = createRecruitingToken({ purpose: "book", rowId: ID_A });
  const claims = verifyRecruitingToken(token, "book");
  assert.ok(claims);
  assert.equal(claims.rowId, ID_A);
  assert.equal(claims.purpose, "book");
  // A booking link never opens an offer or the feed.
  assert.equal(verifyRecruitingToken(token, "offer"), null);
  assert.equal(verifyRecruitingToken(token, "feed"), null);
});

test("tampered and expired tokens are refused without throwing", () => {
  const token = createRecruitingToken({ purpose: "offer", rowId: ID_A });
  const [payload, sig] = token.split(".");
  assert.equal(verifyRecruitingToken(`${payload}.${sig!.split("").reverse().join("")}`, "offer"), null);
  assert.equal(verifyRecruitingToken("not-a-token", "offer"), null);
  assert.equal(verifyRecruitingToken("", "offer"), null);
  const expired = createRecruitingToken({ purpose: "book", rowId: ID_A, expiresAt: Date.now() - 1000 });
  assert.equal(verifyRecruitingToken(expired, "book"), null);
  // Token reuse after expiry refuses by expiry, not by crash.
  const live = createRecruitingToken({ purpose: "book", rowId: ID_A, expiresAt: Date.now() + BOOKING_TOKEN_TTL_MS });
  assert.ok(verifyRecruitingToken(live, "book"));
});

test("token hashes are stable hex and hide the raw token", () => {
  const token = createRecruitingToken({ purpose: "book", rowId: ID_A });
  const hash = hashRecruitingToken(token);
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.equal(hash, hashRecruitingToken(token));
  assert.ok(!hash.includes(ID_A));
});

test("blind rule: an interviewer reads others only after submitting their own", () => {
  const cards = [
    { id: "s1", interviewerPartyId: ID_A, submittedAt: null },
    { id: "s2", interviewerPartyId: ID_B, submittedAt: "2026-09-01T10:00:00Z" },
  ];
  // Before submitting: own card only, others hidden, blinded.
  const before = blindVisibleCardIds({ viewerPartyId: ID_A, privileged: false, cards });
  assert.equal(before.mine, "s1");
  assert.deepEqual(before.otherIds, []);
  assert.equal(before.blinded, true);
  // After submitting: the other verdict opens.
  const after = blindVisibleCardIds({
    viewerPartyId: ID_A,
    privileged: false,
    cards: [
      { id: "s1", interviewerPartyId: ID_A, submittedAt: "2026-09-01T11:00:00Z" },
      { id: "s2", interviewerPartyId: ID_B, submittedAt: "2026-09-01T10:00:00Z" },
    ],
  });
  assert.equal(after.mine, "s1");
  assert.deepEqual(after.otherIds, ["s2"]);
  assert.equal(after.blinded, false);
  // A privileged viewer (hiring manager / manage) reads the full set.
  const manager = blindVisibleCardIds({ viewerPartyId: ID_C, privileged: true, cards });
  assert.equal(manager.mine, null);
  assert.deepEqual(manager.otherIds, ["s1", "s2"]);
  assert.equal(manager.blinded, false);
  // A non-participant with no privilege sees nothing identifiable.
  const outsider = blindVisibleCardIds({ viewerPartyId: ID_C, privileged: false, cards });
  assert.equal(outsider.mine, null);
  assert.deepEqual(outsider.otherIds, []);
  assert.equal(outsider.blinded, true);
});

test("rating values order the verdicts increasingly", () => {
  assert.ok(RATING_VALUES.strong_no! < RATING_VALUES.no!);
  assert.ok(RATING_VALUES.no! < RATING_VALUES.yes!);
  assert.ok(RATING_VALUES.yes! < RATING_VALUES.strong_yes!);
});

test("availability windows must be ordered, dated, and zoned", () => {
  const windows = validateAvailabilityWindows([
    { startsAt: "2026-10-01T09:00:00Z", endsAt: "2026-10-01T10:00:00Z", timezone: "America/Toronto" },
  ]);
  assert.equal(windows.length, 1);
  assert.throws(() => validateAvailabilityWindows([]), /at least one availability window/);
  assert.throws(
    () =>
      validateAvailabilityWindows([
        { startsAt: "2026-10-01T10:00:00Z", endsAt: "2026-10-01T09:00:00Z", timezone: "America/Toronto" },
      ]),
    /ends before it starts/,
  );
  assert.throws(
    () => validateAvailabilityWindows([{ startsAt: "2026-10-01T09:00:00Z", endsAt: "2026-10-01T10:00:00Z", timezone: "" }]),
    /needs a timezone/,
  );
});

const CLAUSES: OfferClause[] = [
  { key: "probation", label: "Probation", body: "A {{probation_months}}-month probation applies.", defaultOn: true },
  { key: "remote", label: "Remote", body: "Remote work per policy.", defaultOn: false },
];

test("offer documents render data plus selected clauses, and refuse invented ones", () => {
  const rendered = renderOfferDocument({
    bodyTemplate: "Dear {{candidate_name}}, the {{job_title}} role pays {{compensation_amount}}.",
    clauses: CLAUSES,
    selectedClauseKeys: ["probation"],
    data: { candidate_name: "A. Candidate", job_title: "Welder", compensation_amount: "45.00", probation_months: "3" },
  });
  assert.ok(rendered.includes("A. Candidate"));
  assert.ok(rendered.includes("3-month probation"));
  assert.ok(!rendered.includes("Remote work"));
  assert.throws(
    () =>
      renderOfferDocument({
        bodyTemplate: "Hi {{candidate_name}}",
        clauses: CLAUSES,
        selectedClauseKeys: ["golden-parachute"],
        data: {},
      }),
    /not on this template/,
  );
});

test("signature evidence seals name, time, IP hash, and document hash", () => {
  const documentHash = hashOfferDocument("rendered letter");
  assert.match(documentHash, /^[0-9a-f]{64}$/);
  const first = sealSignatureEvidence({
    signerName: "A. Candidate",
    signedAt: "2026-09-21T10:00:00Z",
    ipHash: "ipexample",
    documentHash,
    offerId: ID_A,
    version: 2,
  });
  const second = sealSignatureEvidence({
    signerName: "A. Candidate",
    signedAt: "2026-09-21T10:00:00Z",
    ipHash: "ipexample",
    documentHash,
    offerId: ID_A,
    version: 2,
  });
  // Deterministic seal over the same inputs; any input change reseals.
  assert.equal(first.seal, second.seal);
  assert.equal(first.evidence.document_hash, documentHash);
  const resealed = sealSignatureEvidence({
    signerName: "A. Candidate",
    signedAt: "2026-09-21T10:00:00Z",
    ipHash: "ipexample",
    documentHash: hashOfferDocument("different letter"),
    offerId: ID_A,
    version: 2,
  });
  assert.notEqual(resealed.seal, first.seal);
});

test("array literals bind as single pg-array params", () => {
  assert.equal(pgUuidArray([ID_A, ID_B]), `{${ID_A},${ID_B}}`);
  assert.throws(() => pgUuidArray(["not-a-uuid"]), /not a valid UUID/);
  assert.equal(pgTextArray(["a,b", 'c"d']), `{"a,b","c\\"d"}`);
  assert.equal(pgTextArray([]), `{}`);
});

test("tag rediscovery matches case-insensitively on declared tags", () => {
  assert.deepEqual(matchTags(["TIG", "Night Shift"], ["tig"]), ["TIG"]);
  assert.deepEqual(matchTags(["SMAW"], ["tig"]), []);
  assert.deepEqual(matchTags([], ["tig"]), []);
});

test("retention scope fails closed on unreadable scopes", () => {
  assert.equal(retentionScopeMatches({}, ["CA"]), true);
  assert.equal(retentionScopeMatches({ applies_to: "all" }, []), true);
  assert.equal(retentionScopeMatches({ applies_to: "countries", countries: ["CA"] }, ["CA"]), true);
  assert.equal(retentionScopeMatches({ applies_to: "countries", countries: ["CA"] }, ["US"]), false);
  assert.equal(retentionScopeMatches({ applies_to: "provinces" }, ["CA"]), false);
  assert.equal(ANONYMIZED_DISPLAY_NAME, "Anonymized candidate");
});
