import assert from "node:assert/strict";
import test from "node:test";
import {
  decideProductionApply,
  EPHEMERAL_DATABASE_MARKER_PREFIX,
  type ProductionInterlockInput,
} from "./migration-cli-gate.ts";

// Static imports evaluate before the module body, so the launch command MUST
// set OPENBOOKS_DB_URL= explicitly. These tests never touch a database — the
// interlock decision is pure.
process.env.OPENBOOKS_DB_URL = "";
process.env.OPENBOOKS_MIGRATION_DB_URL = "";

const HASH = "a".repeat(64);
const EPHEMERAL = `${EPHEMERAL_DATABASE_MARKER_PREFIX}unit-test`;

function input(overrides: Partial<ProductionInterlockInput> = {}): ProductionInterlockInput {
  return {
    nodeEnv: "test",
    databaseMarker: EPHEMERAL,
    apply: false,
    allowProduction: false,
    dryRunHash: null,
    computedHash: HASH,
    ...overrides,
  };
}

test("dry runs proceed in every environment without controls", () => {
  assert.deepEqual(decideProductionApply(input({ nodeEnv: "production" })), { proceed: true });
  assert.deepEqual(decideProductionApply(input({ nodeEnv: undefined })), { proceed: true });
});

test("known-safe environment plus ephemeral database proceeds without controls", () => {
  assert.deepEqual(
    decideProductionApply(input({ apply: true, nodeEnv: "test" })),
    { proceed: true },
  );
  assert.deepEqual(
    decideProductionApply(input({ apply: true, nodeEnv: "development" })),
    { proceed: true },
  );
});

test("apply with no environment evidence refuses", () => {
  const decision = decideProductionApply(
    input({ apply: true, nodeEnv: undefined, databaseMarker: EPHEMERAL }),
  );
  assert.equal(decision.proceed, false);
  assert.equal(decision.code, "environment_unknown");
  assert.match(decision.reason, /not affirmatively known-safe/);
  assert.match(decision.reason, /--allow-production/);
  assert.match(decision.reason, /NODE_ENV=development/);
});

test("typo environment refuses as unknown, never as safe", () => {
  const decision = decideProductionApply(
    input({ apply: true, nodeEnv: "prodction", databaseMarker: EPHEMERAL }),
  );
  assert.equal(decision.proceed, false);
  assert.equal(decision.code, "environment_unknown");
});

test("unmarked database refuses even with a known-safe environment", () => {
  for (const marker of [null, undefined, "prod-primary", `${EPHEMERAL_DATABASE_MARKER_PREFIX}`]) {
    const decision = decideProductionApply(
      input({ apply: true, nodeEnv: "development", databaseMarker: marker }),
    );
    assert.equal(decision.proceed, false, `marker ${JSON.stringify(marker)} must not pass`);
    assert.equal(decision.code, "database_not_ephemeral");
    assert.match(decision.reason, /ephemeral/);
  }
});

test("production is never safe-harbor, even against an ephemeral database", () => {
  const decision = decideProductionApply(
    input({ apply: true, nodeEnv: "production", databaseMarker: EPHEMERAL }),
  );
  assert.equal(decision.proceed, false);
  assert.equal(decision.code, "production_apply_not_acknowledged");
  assert.match(decision.reason, /--allow-production/);
  assert.match(decision.reason, /--dry-run-hash/);
});

test("acknowledgement without the hash refuses by code", () => {
  const decision = decideProductionApply(
    input({ apply: true, nodeEnv: "production", databaseMarker: null, allowProduction: true }),
  );
  assert.equal(decision.proceed, false);
  assert.equal(decision.code, "dry_run_hash_missing");
  assert.match(decision.reason, /--dry-run-hash/);
});

test("mismatched hash refuses everywhere, including the safe harbor", () => {
  const decision = decideProductionApply(
    input({
      apply: true,
      nodeEnv: "test",
      databaseMarker: EPHEMERAL,
      allowProduction: true,
      dryRunHash: "b".repeat(64),
    }),
  );
  assert.equal(decision.proceed, false);
  assert.equal(decision.code, "dry_run_hash_mismatch");
  assert.match(decision.reason, new RegExp(`expected ${HASH}`));
  assert.match(decision.reason, new RegExp(`received ${"b".repeat(64)}`));
  assert.match(decision.reason, /Nothing was written/);
});

test("matching hash proceeds in every environment", () => {
  for (const env of ["production", "development", "test", undefined, "typo"] as const) {
    assert.deepEqual(
      decideProductionApply(
        input({
          apply: true,
          nodeEnv: env,
          databaseMarker: env === "development" ? null : EPHEMERAL,
          allowProduction: true,
          dryRunHash: HASH,
        }),
      ),
      { proceed: true },
    );
  }
});
