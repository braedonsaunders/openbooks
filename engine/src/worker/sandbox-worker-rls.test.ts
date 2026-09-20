import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { evaluateCloneRlsProof } from "../sandbox/verify-rls.ts";
import {
  REFRESH_CLONE_PROOF_PREFIX,
  refuseUnprovenRefreshReady,
  refreshReadyMatchesProvenClone,
  requireFoundSandbox,
} from "../sandbox/lifecycle.ts";

const source = readFileSync(
  new URL("./sandbox-worker.ts", import.meta.url),
  "utf8",
);
const lifecycleSource = readFileSync(
  new URL("../sandbox/lifecycle.ts", import.meta.url),
  "utf8",
);
const verifyRlsSource = readFileSync(
  new URL("../sandbox/verify-rls.ts", import.meta.url),
  "utf8",
);

const PRODUCTION_ORG = "11111111-1111-4111-8111-111111111111";
const SANDBOX_ORG = "22222222-2222-4222-8222-222222222222";

function deleteSandboxSource(): string {
  const start = lifecycleSource.indexOf("export async function deleteSandbox");
  assert.ok(start >= 0, "deleteSandbox must exist in lifecycle.ts");
  return lifecycleSource.slice(start);
}

function createSandboxSource(): string {
  const start = lifecycleSource.indexOf("export async function createSandbox");
  const end = lifecycleSource.indexOf("export async function refreshSandbox");
  assert.ok(start >= 0 && end > start, "createSandbox must precede refreshSandbox");
  return lifecycleSource.slice(start, end);
}

function refreshSandboxSource(): string {
  const start = lifecycleSource.indexOf("export async function refreshSandbox");
  const end = lifecycleSource.indexOf("export async function resetSandbox");
  assert.ok(start >= 0 && end > start, "refreshSandbox must precede resetSandbox");
  return lifecycleSource.slice(start, end);
}

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

test("sandbox jobs execute inside an explicit trusted boundary", () => {
  // Sandbox operations span two tenants (production source + sandbox clone),
  // so the payload processor must cross a trusted boundary: a queue callback
  // carries no request store, and without it the deny-by-default GUCs make
  // every entry read return zero rows (creates/refreshes throw not-found,
  // deletes silently no-op).
  const processor = source.slice(
    source.indexOf("export async function processSandboxJobData"),
    source.indexOf("export function createSandboxWorker"),
  );
  assert.match(processor, /withBypassContext\(async \(\) => \{/);
});

test("the sandbox worker callback delegates to the bounded payload processor", () => {
  const worker = source.slice(source.indexOf("export function createSandboxWorker"));
  assert.match(worker, /processSandboxJobData\(job\.data\)/);
  assert.doesNotMatch(worker, /createSandbox\(|refreshSandbox\(|resetSandbox\(|deleteSandbox\(/);
});

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

function assertProofBeforeReady(label: string, fnSource: string) {
  const proofAt = fnSource.indexOf("verifyCloneRls(");
  assert.ok(proofAt >= 0, `${label} must call verifyCloneRls`);
  const readyWrites = [...fnSource.matchAll(/status = 'ready'/g)].map((match) => match.index ?? -1);
  assert.ok(readyWrites.length >= 1, `${label} must still mark ready after the proof`);
  for (const readyAt of readyWrites) {
    assert.ok(
      proofAt < readyAt,
      `${label} must not write status='ready' before verifyCloneRls (proof at ${proofAt}, ready at ${readyAt})`,
    );
  }
}

test("createSandbox re-verifies RLS against the clone it just created", () => {
  const create = createSandboxSource();
  assert.match(lifecycleSource, /from "\.\/verify-rls\.ts"/);
  assert.match(create, /verifyCloneRls\(\{/);
  assert.match(create, /productionOrgId: input\.productionOrgId/);
  assert.match(create, /sandboxOrgId/);
  assert.match(refreshSandboxSource(), /verifyCloneRls\(\{/);
  assert.match(verifyRlsSource, /launchedAsCli|pathToFileURL/);
});

test("create and refresh do not mark the sandbox ready until clone RLS proof succeeds", () => {
  assertProofBeforeReady("createSandbox", createSandboxSource());
  assertProofBeforeReady("refreshSandbox", refreshSandboxSource());
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

  const refresh = refreshSandboxSource();
  assert.match(refresh, /withSandboxRefreshLock\(/);
  assert.doesNotMatch(refresh, /advisoryLockKey:/);
  assert.match(refresh, /last_error = \$\{proofToken\}/);
  assert.match(refresh, /refuseUnprovenRefreshReady\(/);
});

test("requireFoundSandbox refuses a missing sandbox instead of succeeding", () => {
  const missingId = "33333333-3333-4333-8333-333333333333";
  assert.throws(
    () => requireFoundSandbox(missingId, undefined),
    new RegExp(`sandbox not found: ${missingId}`),
  );
  assert.throws(
    () => requireFoundSandbox(missingId, null),
    new RegExp(`sandbox not found: ${missingId}`),
  );
  assert.throws(
    () => requireFoundSandbox(missingId, ""),
    new RegExp(`sandbox not found: ${missingId}`),
  );
  assert.equal(requireFoundSandbox(missingId, "org-1"), "org-1");
  assert.deepEqual(requireFoundSandbox(missingId, { status: "ready" }), { status: "ready" });
});

test("deleteSandbox treats a missing sandbox row as a failure", () => {
  const del = deleteSandboxSource();
  assert.match(lifecycleSource, /export function requireFoundSandbox/);
  assert.equal((del.match(/requireFoundSandbox\(/g) ?? []).length, 2);
  assert.doesNotMatch(del, /if \(!orgId\) return;/);
  assert.doesNotMatch(del, /if \(!current\) return;/);
});
