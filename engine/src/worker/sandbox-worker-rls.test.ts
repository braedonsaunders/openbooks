import assert from "node:assert/strict";
import test from "node:test";
import {
  assertProductionSourceKind,
  evaluateCloneRlsProof,
  unverifiedCloneRlsTables,
} from "../sandbox/verify-rls.ts";
import {
  REFRESH_CLONE_PROOF_PREFIX,
  refuseUnprovenRefreshReady,
  refreshReadyMatchesProvenClone,
  requireFoundSandbox,
} from "../sandbox/lifecycle.ts";

const PRODUCTION_ORG = "11111111-1111-4111-8111-111111111111";
const SANDBOX_ORG = "22222222-2222-4222-8222-222222222222";

function emptyTable(table: string) {
  return {
    table,
    bypassProduction: 0,
    bypassSandbox: 0,
    scopedProduction: 0,
    scopedSandbox: 0,
    scopedBogus: 0,
  };
}

function oneSidedTable(table: string, production: number) {
  return {
    table,
    bypassProduction: production,
    bypassSandbox: 0,
    scopedProduction: production,
    scopedSandbox: 0,
    scopedBogus: 0,
  };
}

test("clone RLS proof refuses an empty database instead of treating it as success", () => {
  // The previous standalone script treated scopedBogus===0 && total===0 as a
  // pass, so an empty database "proved" isolation. Isolation cannot be
  // observed without at least one tenant-scoped row.
  assert.throws(
    () =>
      evaluateCloneRlsProof({
        productionOrgId: PRODUCTION_ORG,
        sandboxOrgId: SANDBOX_ORG,
        tables: [emptyTable("journal_lines")],
      }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /isolation cannot be proven/);
      assert.match(error.message, /journal_lines/);
      assert.match(error.message, new RegExp(PRODUCTION_ORG));
      assert.match(error.message, new RegExp(SANDBOX_ORG));
      return true;
    },
  );
});

test("clone RLS proof names the table that leaked into a bogus tenant", () => {
  assert.throws(
    () =>
      evaluateCloneRlsProof({
        productionOrgId: PRODUCTION_ORG,
        sandboxOrgId: SANDBOX_ORG,
        tables: [
          {
            table: "accounts",
            bypassProduction: 12,
            bypassSandbox: 12,
            scopedProduction: 12,
            scopedSandbox: 12,
            scopedBogus: 0,
          },
          {
            table: "journal_lines",
            bypassProduction: 4,
            bypassSandbox: 4,
            scopedProduction: 4,
            scopedSandbox: 4,
            scopedBogus: 7,
          },
        ],
      }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /journal_lines/);
      assert.match(error.message, /7/);
      assert.match(error.message, /bogus/);
      assert.doesNotMatch(error.message, /accounts/);
      return true;
    },
  );
});

test("clone RLS proof refuses a scoped count that does not match the named tenant", () => {
  assert.throws(
    () =>
      evaluateCloneRlsProof({
        productionOrgId: PRODUCTION_ORG,
        sandboxOrgId: SANDBOX_ORG,
        tables: [
          {
            table: "journal_lines",
            bypassProduction: 4,
            bypassSandbox: 4,
            scopedProduction: 8,
            scopedSandbox: 4,
            scopedBogus: 0,
          },
        ],
      }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /journal_lines/);
      assert.match(error.message, /production/);
      assert.match(error.message, /8/);
      assert.match(error.message, /4/);
      return true;
    },
  );
  assert.throws(
    () =>
      evaluateCloneRlsProof({
        productionOrgId: PRODUCTION_ORG,
        sandboxOrgId: SANDBOX_ORG,
        tables: [
          {
            table: "journal_lines",
            bypassProduction: 4,
            bypassSandbox: 4,
            scopedProduction: 4,
            scopedSandbox: 8,
            scopedBogus: 0,
          },
        ],
      }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /journal_lines/);
      assert.match(error.message, /sandbox/);
      assert.match(error.message, /8/);
      assert.match(error.message, /4/);
      return true;
    },
  );
});

test("clone RLS proof refuses a dev-tier-shaped proof with only production-side rows", () => {
  // C-40: the old fixed trio (journal_lines, accounts, accounting_periods)
  // is never copied on a dev tier, so every table reads N == N on
  // production and 0 == 0 on the clone while observedRows stays positive
  // from production counts. A proof with no both-sides observation must
  // fail, naming the unverified tables instead of passing vacuously.
  assert.throws(
    () =>
      evaluateCloneRlsProof({
        productionOrgId: PRODUCTION_ORG,
        sandboxOrgId: SANDBOX_ORG,
        tables: [
          oneSidedTable("journal_lines", 41),
          oneSidedTable("accounts", 12),
          oneSidedTable("accounting_periods", 7),
        ],
      }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /zero verified rows/);
      assert.match(error.message, /unverified tables: .*journal_lines/);
      assert.match(error.message, /isolation cannot be proven/);
      assert.match(error.message, new RegExp(PRODUCTION_ORG));
      assert.match(error.message, new RegExp(SANDBOX_ORG));
      return true;
    },
  );
});

test("clone RLS proof accepts verified tables while reporting one-sided ones", () => {
  // A one-sided table is still leak-checked (a bogus leak throws) but never
  // counted as proof; the verified tables carry the proof.
  evaluateCloneRlsProof({
    productionOrgId: PRODUCTION_ORG,
    sandboxOrgId: SANDBOX_ORG,
    tables: [
      {
        table: "subsidiaries",
        bypassProduction: 2,
        bypassSandbox: 2,
        scopedProduction: 2,
        scopedSandbox: 2,
        scopedBogus: 0,
      },
      oneSidedTable("report_schedules", 3),
    ],
  });
  assert.deepEqual(
    unverifiedCloneRlsTables([
      {
        table: "subsidiaries",
        bypassProduction: 2,
        bypassSandbox: 2,
        scopedProduction: 2,
        scopedSandbox: 2,
        scopedBogus: 0,
      },
      oneSidedTable("report_schedules", 3),
      emptyTable("saved_views"),
    ]),
    ["report_schedules", "saved_views"],
  );
});

test("clone RLS proof refuses comparing a tenant to itself", () => {
  assert.throws(
    () =>
      evaluateCloneRlsProof({
        productionOrgId: PRODUCTION_ORG,
        sandboxOrgId: PRODUCTION_ORG,
        tables: [
          {
            table: "sandboxes",
            bypassProduction: 0,
            bypassSandbox: 1,
            scopedProduction: 0,
            scopedSandbox: 1,
            scopedBogus: 0,
          },
        ],
      }),
    /cannot compare a tenant to itself/,
  );
});

test("clone RLS proof accepts a production clone split that matches scoped reads", () => {
  evaluateCloneRlsProof({
    productionOrgId: PRODUCTION_ORG,
    sandboxOrgId: SANDBOX_ORG,
    tables: [
      {
        table: "journal_lines",
        bypassProduction: 4,
        bypassSandbox: 4,
        scopedProduction: 4,
        scopedSandbox: 4,
        scopedBogus: 0,
      },
      {
        table: "accounts",
        bypassProduction: 12,
        bypassSandbox: 12,
        scopedProduction: 12,
        scopedSandbox: 12,
        scopedBogus: 0,
      },
      {
        table: "sandboxes",
        bypassProduction: 0,
        bypassSandbox: 1,
        scopedProduction: 0,
        scopedSandbox: 1,
        scopedBogus: 0,
      },
    ],
  });
});

test("refresh ready write refuses a clone this request did not just prove", () => {
  const sandboxId = "44444444-4444-4444-8444-444444444444";
  const ours = `${REFRESH_CLONE_PROOF_PREFIX}aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa`;
  const theirs = `${REFRESH_CLONE_PROOF_PREFIX}bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb`;

  assert.equal(
    refreshReadyMatchesProvenClone(
      { status: "refreshing", lastError: ours },
      { proofToken: ours },
    ),
    true,
  );
  refuseUnprovenRefreshReady(
    { status: "refreshing", lastError: ours },
    { sandboxId, proofToken: ours },
  );

  assert.equal(
    refreshReadyMatchesProvenClone(
      { status: "refreshing", lastError: theirs },
      { proofToken: ours },
    ),
    false,
  );
  assert.throws(
    () =>
      refuseUnprovenRefreshReady(
        { status: "refreshing", lastError: theirs },
        { sandboxId, proofToken: ours },
      ),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, new RegExp(sandboxId));
      assert.match(error.message, new RegExp(ours));
      assert.match(error.message, new RegExp(theirs));
      return true;
    },
  );
  assert.throws(
    () =>
      refuseUnprovenRefreshReady(
        { status: "refreshing", lastError: null },
        { sandboxId, proofToken: ours },
      ),
    /row holds \(none\)/,
  );
  assert.throws(
    () =>
      refuseUnprovenRefreshReady(
        { status: "refreshing", lastError: ours },
        { sandboxId, proofToken: "not-a-proof-token" },
      ),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, new RegExp(sandboxId));
      assert.match(error.message, /not-a-proof-token/);
      return true;
    },
  );
});

test("requireFoundSandbox refuses a missing sandbox instead of succeeding", () => {
  const missingId = "33333333-3333-4333-8333-333333333333";
  for (const missing of [undefined, null, ""]) {
    assert.throws(
      () => requireFoundSandbox(missingId, missing),
      new RegExp(`sandbox not found: ${missingId}`),
    );
  }
  assert.deepEqual(requireFoundSandbox(missingId, { status: "ready" }), { status: "ready" });
});

test("clone RLS proof refuses a sandbox-kind source as production", () => {
  assert.throws(
    () => assertProductionSourceKind({ id: SANDBOX_ORG, env_kind: "sandbox" }),
    /not a production tenant/,
  );
});
