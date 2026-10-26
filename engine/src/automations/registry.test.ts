import test from "node:test";
import assert from "node:assert/strict";
import { assertWritableField, registryEntity, AutomationRegistryError } from "./registry.ts";

test("registry pins ten entities with allowlists", () => {
  assert.equal(registryEntity("employment")?.readableFields.includes("status"), true);
  assert.equal(registryEntity("nope"), null);
  // Employment versions change only through change requests.
  assert.throws(
    () => assertWritableField("employment", "department_id"),
    (e: unknown) =>
      e instanceof AutomationRegistryError && /change request/.test((e as Error).message),
  );
  assert.throws(() => assertWritableField("employment", "salary"), AutomationRegistryError);
  assert.throws(
    () => assertWritableField("mystery", "x"),
    (e: unknown) =>
      e instanceof AutomationRegistryError && /known: employment/.test((e as Error).message),
  );
});
