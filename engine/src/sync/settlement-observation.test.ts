import assert from "node:assert/strict";
import test from "node:test";
import {
  applicationLinksDigest,
  assertSettlementObservation,
  settlementDigest,
  type SettlementObservation,
} from "./settlement-observation.ts";

const links = [
  {
    paymentRef: "20",
    appliedRef: "10",
    amount: "25",
    currency: "CAD",
    paymentAccountRef: "AP",
    appliedAccountRef: "AP",
  },
];
function observation(): SettlementObservation {
  return {
    version: 1,
    source: "netsuite",
    sourceAccount: "TEST",
    bookRef: "1",
    scope: { kind: "all" },
    consistency: "repeated_read",
    observedFrom: "2026-07-01T00:00:00Z",
    observedThrough: "2026-07-01T00:00:01Z",
    rawLinks: 1,
    eligibleLinks: 1,
    graphDigest: settlementDigest(links),
    applicationsDigest: applicationLinksDigest(links),
    exclusions: [],
    nonpostingRefs: [],
  };
}

test("settlement admission binds amounts, currency, accounts, source, and population", () => {
  const evidence = observation();
  assert.doesNotThrow(() => assertSettlementObservation(evidence, "netsuite", links, true));
  for (const overrides of [
    { amount: "26" },
    { currency: "USD" },
    { paymentAccountRef: "OTHER" },
    { paymentRef: "21" },
  ]) {
    assert.throws(
      () =>
        assertSettlementObservation(evidence, "netsuite", [{ ...links[0]!, ...overrides }], true),
      /does not authorize/,
    );
  }
  assert.throws(
    () => assertSettlementObservation(evidence, "qbo", links, true),
    /does not authorize/,
  );
  assert.throws(
    () => assertSettlementObservation({ ...evidence, rawLinks: 0 }, "netsuite", links, true),
    /does not authorize/,
  );
});

test("reference-scoped observations cannot authorize complete releases or unrelated links", () => {
  const evidence = { ...observation(), scope: { kind: "references" as const, refs: ["20"] } };
  assert.doesNotThrow(() => assertSettlementObservation(evidence, "netsuite", links, false));
  assert.throws(
    () => assertSettlementObservation(evidence, "netsuite", links, true),
    /does not authorize/,
  );
  assert.throws(
    () =>
      assertSettlementObservation(
        { ...evidence, scope: { kind: "references", refs: ["30"] } },
        "netsuite",
        links,
        false,
      ),
    /outside its reference scope/,
  );
});

test("nonposting exclusions must name precisely the endpoints protected from release", () => {
  const evidence: SettlementObservation = {
    ...observation(),
    rawLinks: 2,
    nonpostingRefs: ["21"],
    exclusions: [
      {
        paymentRef: "21",
        appliedRef: "10",
        paymentLineRef: "1",
        appliedLineRef: "0",
        amount: "25",
        paymentPosting: "F",
        appliedPosting: "T",
        paymentStatus: "A",
        appliedStatus: "A",
        reason: "nonposting_payment",
      },
    ],
  };
  assert.doesNotThrow(() => assertSettlementObservation(evidence, "netsuite", links, true));
  assert.throws(
    () => assertSettlementObservation({ ...evidence, nonpostingRefs: [] }, "netsuite", links, true),
    /exclusions do not match/,
  );
  assert.throws(
    () =>
      assertSettlementObservation(
        { ...evidence, exclusions: [{ ...evidence.exclusions[0]!, paymentPosting: "T" }] },
        "netsuite",
        links,
        true,
      ),
    /no explicit nonposting evidence/,
  );
});
