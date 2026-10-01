import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { statementEvidence } from "./benefit-statement.ts";

import {
  canonicalSnapshotJson,
  snapshotsMatch,
} from "./settlement.ts";

// Pure unit coverage for the settlement digest comparison. These tests run
// without a database: they prove the idempotent-retry identity check
// survives a PostgreSQL jsonb round trip, which reorders object keys.

const FRESH: Record<string, unknown> = {
  digest: "3936b594a635216f03c26bfeddd2e352e1be338e9e90e2267e0106e88bfe94f0",
  bookId: "77ce7dae-bfb0-490c-8b89-2fb0027ec2b1",
  measuredValue: "10000.0000",
  poolValue: "1000.0000",
  currency: "USD",
  minorUnits: 2,
  legalEntityId: "e3b37da3-2b19-42c4-9df1-b11fbe86414a",
  entryIds: ["e8034127-8e72-4175-b2ee-4a45faee765f"],
  sourceAccounts: ["55294a20-263e-4a9d-a05e-e591b1a7cb73"],
  periodBasis: { kind: "calendar" },
  metric: "net_profit",
  scope: "company",
  programRevision: 3,
  memberships: [
    {
      employmentId: "f2ee17de-9c0a-4e1b-91cd-afe6d006b47b",
      effectiveFrom: "2026-01-01",
      effectiveTo: null,
      weight: null,
      role: null,
    },
  ],
  hoursAttribution: [],
};

// Simulates the jsonb write/read round trip: same facts, keys reordered.
const ROUND_TRIPPED: Record<string, unknown> = {
  scope: "company",
  bookId: "77ce7dae-bfb0-490c-8b89-2fb0027ec2b1",
  digest: "3936b594a635216f03c26bfeddd2e352e1be338e9e90e2267e0106e88bfe94f0",
  metric: "net_profit",
  currency: "USD",
  entryIds: ["e8034127-8e72-4175-b2ee-4a45faee765f"],
  poolValue: "1000.0000",
  minorUnits: 2,
  legalEntityId: "e3b37da3-2b19-42c4-9df1-b11fbe86414a",
  sourceAccounts: ["55294a20-263e-4a9d-a05e-e591b1a7cb73"],
  periodBasis: { kind: "calendar" },
  programRevision: 3,
  measuredValue: "10000.0000",
  memberships: [
    {
      role: null,
      weight: null,
      effectiveTo: null,
      employmentId: "f2ee17de-9c0a-4e1b-91cd-afe6d006b47b",
      effectiveFrom: "2026-01-01",
    },
  ],
  hoursAttribution: [],
};

describe("canonicalSnapshotJson", () => {
  test("object key order does not change the canonical form", () => {
    assert.equal(
      canonicalSnapshotJson({ b: 1, a: [{ y: 2, x: 1 }] }),
      canonicalSnapshotJson({ a: [{ x: 1, y: 2 }], b: 1 }),
    );
  });

  test("array order stays significant", () => {
    assert.notEqual(
      canonicalSnapshotJson(["a", "b"]),
      canonicalSnapshotJson(["b", "a"]),
    );
  });
});

describe("snapshotsMatch", () => {
  test("matches after a key-reordering jsonb round trip", () => {
    assert.equal(snapshotsMatch(ROUND_TRIPPED, FRESH), true);
    assert.equal(snapshotsMatch(FRESH, ROUND_TRIPPED), true);
  });

  test("refuses a changed digest", () => {
    assert.equal(
      snapshotsMatch({ ...FRESH, digest: "deadbeef" }, FRESH),
      false,
    );
  });

  test("refuses changed membership facts", () => {
    assert.equal(
      snapshotsMatch(
        { ...FRESH, memberships: [] },
        FRESH,
      ),
      false,
    );
  });

  test("refuses changed measured value with the same digest", () => {
    assert.equal(
      snapshotsMatch({ ...FRESH, measuredValue: "9999.0000" }, FRESH),
      false,
    );
  });
});


describe("frozen financial source identity", () => {
  for (const field of ["bookId", "fiscalCalendarId", "periodBasis", "postingFacts", "approvedHoursFacts", "memberships", "hoursAttribution", "sourceAccounts", "recipients"]) {
    test(`refuses changed ${field} even when the award value stays the same`, () => {
      assert.equal(snapshotsMatch(FRESH, { ...FRESH, [field]: "changed" }), false);
    });
  }
});

test("statement evidence cannot disclose financial sources or allocation fractions", () => {
  assert.deepEqual(statementEvidence({
    kind: "incentive-settlement", programRevision: 3, payableAfter: "2026-08-01",
    measuredValue: "1000000.0000", poolValue: "100000.0000",
    computation: { share: "1/10", explanation: "1/10 of 100000", value: "10000.0000" },
    sourceSnapshot: { revenueTotal: "1000000.0000" },
  }), { kind: "incentive-settlement", programRevision: 3, payableAfter: "2026-08-01" });
});
