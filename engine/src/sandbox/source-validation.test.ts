import assert from "node:assert/strict";
import test from "node:test";
import { assertProductionSandboxSource } from "./source-validation.ts";

test("sandbox source validation accepts production and refuses other environment kinds", () => {
  assert.doesNotThrow(() => assertProductionSandboxSource({ env_kind: "production" }, "source-id"));
  assert.throws(
    () => assertProductionSandboxSource({ env_kind: "sandbox" }, "source-id"),
    /must be a production organization/,
  );
  assert.throws(
    () => assertProductionSandboxSource({ env_kind: "template" }, "source-id"),
    /must be a production organization/,
  );
});

test("sandbox source validation names a missing source", () => {
  assert.throws(() => assertProductionSandboxSource(null, "missing-id"), /production org not found: missing-id/);
});
