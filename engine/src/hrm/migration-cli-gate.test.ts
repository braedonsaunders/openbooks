import assert from "node:assert/strict";
import test from "node:test";
import {
  decideProductionApply,
  type ProductionInterlockInput,
} from "./migration-cli-gate.ts";

// Static imports evaluate before the module body, so the launch command MUST
// set OPENBOOKS_DB_URL= explicitly. These tests never touch a database — the
// interlock decision is pure.
process.env.OPENBOOKS_DB_URL = "";
process.env.OPENBOOKS_MIGRATION_DB_URL = "";

const HASH = "a".repeat(64);

function input(overrides: Partial<ProductionInterlockInput> = {}): ProductionInterlockInput {
  return {
    nodeEnv: "test",
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

test("non-production applies proceed without controls", () => {
  assert.deepEqual(decideProductionApply(input({ apply: true })), { proceed: true });
  assert.deepEqual(
    decideProductionApply(input({ apply: true, nodeEnv: undefined })),
    { proceed: true },
  );
});

test("production apply without the acknowledgement flag refuses by code", () => {
  const decision = decideProductionApply(input({ apply: true, nodeEnv: "production" }));
  assert.equal(decision.proceed, false);
  assert.equal(decision.code, "production_apply_not_acknowledged");
  assert.match(decision.reason, /--allow-production/);
  assert.match(decision.reason, /--dry-run-hash/);
});

test("production apply with the flag but no hash refuses by code", () => {
  const decision = decideProductionApply(
    input({ apply: true, nodeEnv: "production", allowProduction: true }),
  );
  assert.equal(decision.proceed, false);
  assert.equal(decision.code, "dry_run_hash_missing");
  assert.match(decision.reason, /--dry-run-hash/);
});

test("mismatched hash refuses and names expected versus received", () => {
  const decision = decideProductionApply(
    input({
      apply: true,
      nodeEnv: "production",
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

test("matching hash proceeds", () => {
  assert.deepEqual(
    decideProductionApply(
      input({
        apply: true,
        nodeEnv: "production",
        allowProduction: true,
        dryRunHash: HASH,
      }),
    ),
    { proceed: true },
  );
});
