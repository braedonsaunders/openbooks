import assert from "node:assert/strict";
import test from "node:test";
import {
  addedModuleCapabilities,
  assertModulePermitted,
  assertModuleSeparationOfDuties,
  ModuleCapabilityError,
  moduleUpgradeRequiresReapproval,
  resolveModuleGrants,
} from "./capabilities.ts";

const RECORDS_READ = "records.read";
const RECORDS_CREATE = "records.create";
const GL_POST = "gl.post";
const CATALOGUE = [GL_POST, RECORDS_CREATE, RECORDS_READ, "ap.post", "ar.post"];

test("install grants the approved subset intersected with the installer's effective permissions", () => {
  const resolution = resolveModuleGrants({
    requested: [RECORDS_READ, RECORDS_CREATE, GL_POST],
    approved: [RECORDS_READ, RECORDS_CREATE],
    installerEffective: [RECORDS_READ],
    knownPermissions: CATALOGUE,
  });
  assert.deepEqual(resolution.granted, [RECORDS_READ]);
  assert.deepEqual(resolution.withheld, [GL_POST, RECORDS_CREATE]);
});

test("a module with no overlap runs with zero permissions rather than failing open", () => {
  const resolution = resolveModuleGrants({
    requested: [GL_POST],
    approved: [GL_POST],
    installerEffective: [RECORDS_READ],
    knownPermissions: CATALOGUE,
  });
  assert.deepEqual(resolution.granted, []);
  assert.deepEqual(resolution.withheld, [GL_POST]);
});

test("grants are deterministic: deduplicated and sorted regardless of input order", () => {
  const resolution = resolveModuleGrants({
    requested: [GL_POST, RECORDS_READ, RECORDS_READ],
    approved: [GL_POST, RECORDS_READ, GL_POST],
    installerEffective: [GL_POST, RECORDS_READ],
    knownPermissions: CATALOGUE,
  });
  assert.deepEqual(resolution.granted, [GL_POST, RECORDS_READ]);
});

test("a requested permission outside the platform catalogue is a manifest error", () => {
  assert.throws(
    () =>
      resolveModuleGrants({
        requested: ["ledger.nuke"],
        approved: ["ledger.nuke"],
        installerEffective: ["ledger.nuke"],
        knownPermissions: CATALOGUE,
      }),
    (error: unknown) =>
      error instanceof ModuleCapabilityError && error.code === "unknown_permission",
  );
});

test("an approval granting what the manifest never requested is refused", () => {
  assert.throws(
    () =>
      resolveModuleGrants({
        requested: [RECORDS_READ],
        approved: [RECORDS_READ, GL_POST],
        installerEffective: [RECORDS_READ, GL_POST],
        knownPermissions: CATALOGUE,
      }),
    (error: unknown) =>
      error instanceof ModuleCapabilityError && error.code === "grant_exceeds_request",
  );
});

test("blank permission strings are rejected instead of silently dropped", () => {
  assert.throws(
    () =>
      resolveModuleGrants({
        requested: ["  "],
        approved: [],
        installerEffective: [],
        knownPermissions: CATALOGUE,
      }),
    (error: unknown) =>
      error instanceof ModuleCapabilityError && error.code === "invalid_permission",
  );
});

test("projection executors permit only granted ∩ installer-effective permissions", () => {
  assert.doesNotThrow(() =>
    assertModulePermitted({
      grantedPermissions: [RECORDS_READ, RECORDS_CREATE],
      installerEffectivePermissions: [RECORDS_READ],
      requiredPermission: RECORDS_READ,
    }),
  );
  assert.throws(
    () =>
      assertModulePermitted({
        grantedPermissions: [RECORDS_READ, RECORDS_CREATE],
        installerEffectivePermissions: [RECORDS_READ],
        // Granted by the admin but the installer never held it: the executor
        // must refuse, or a low-privilege installer could arm a module with
        // permissions they could not exercise themselves.
        requiredPermission: RECORDS_CREATE,
      }),
    (error: unknown) =>
      error instanceof ModuleCapabilityError && error.code === "capability_denied",
  );
  assert.throws(
    () =>
      assertModulePermitted({
        grantedPermissions: [RECORDS_READ],
        installerEffectivePermissions: [RECORDS_READ],
        requiredPermission: GL_POST,
      }),
    (error: unknown) =>
      error instanceof ModuleCapabilityError && error.code === "capability_denied",
  );
});

test("an upgrade adding capabilities requires re-approval; narrowing does not", () => {
  assert.equal(moduleUpgradeRequiresReapproval([RECORDS_READ], [RECORDS_READ, GL_POST]), true);
  assert.deepEqual(addedModuleCapabilities([RECORDS_READ], [RECORDS_READ, GL_POST]), [GL_POST]);
  assert.equal(moduleUpgradeRequiresReapproval([RECORDS_READ, GL_POST], [RECORDS_READ]), false);
  assert.deepEqual(addedModuleCapabilities([RECORDS_READ, GL_POST], [RECORDS_READ]), []);
  assert.equal(moduleUpgradeRequiresReapproval([RECORDS_READ], [RECORDS_READ]), false);
});

test("the requester can never approve their own module install", () => {
  assert.throws(
    () => assertModuleSeparationOfDuties("user-1", "user-1"),
    (error: unknown) =>
      error instanceof ModuleCapabilityError && error.code === "self_approval",
  );
  assert.doesNotThrow(() => assertModuleSeparationOfDuties("user-1", "user-2"));
});

test("separation of duties fails closed on anonymous actors", () => {
  assert.throws(
    () => assertModuleSeparationOfDuties("", "user-2"),
    (error: unknown) =>
      error instanceof ModuleCapabilityError && error.code === "invalid_actor",
  );
  assert.throws(
    () => assertModuleSeparationOfDuties("user-1", "  "),
    (error: unknown) =>
      error instanceof ModuleCapabilityError && error.code === "invalid_actor",
  );
});

test("self-approval opt-out is explicit and never the default", () => {
  assert.doesNotThrow(() =>
    assertModuleSeparationOfDuties("user-1", "user-1", { allowSelfApproval: true }),
  );
});
