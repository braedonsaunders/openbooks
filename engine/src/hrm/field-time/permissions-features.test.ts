/**
 * HR-20 durable gate tests: field-time features and permissions.
 *
 * feature-registry.test.ts is truncated mid-test at the base tip, so
 * these pins live here until the integrator repairs that file — the
 * assertions are the same shape (registered, defaulted, parented,
 * granted to the same built-in roles as time.read/manage).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FEATURE_BY_KEY, featureEnabled } from "../../organization/feature-registry.ts";
import {
  BUILT_IN_ROLES,
  PERMISSION_CATALOGUE,
  PERMISSION_GROUPS,
} from "../../organization/permissions.ts";

describe("field-time features", () => {
  it("fieldTime rides timeTracking and needs projects", () => {
    const def = FEATURE_BY_KEY.get("fieldTime");
    assert.ok(def, "fieldTime must be registered");
    assert.equal(def.defaultEnabled, false);
    assert.equal(def.parentKey, "timeTracking");
    assert.deepEqual(def.requiresAll, ["projects"]);
  });
  it("all six sub-features hang under fieldTime", () => {
    for (const key of [
      "fieldTimeGeofence",
      "fieldTimePhoto",
      "fieldTimeKiosk",
      "fieldTimeCrewEntry",
      "fieldTimeEquipment",
      "fieldTimeMultiStageApproval",
    ]) {
      const sub = FEATURE_BY_KEY.get(key);
      assert.ok(sub, `${key} must be registered`);
      assert.equal(sub.parentKey, "fieldTime");
      assert.equal(sub.defaultEnabled, false);
    }
    assert.deepEqual(FEATURE_BY_KEY.get("fieldTimeEquipment")!.requiresAll, ["equipment"]);
  });
  it("a stale stored override never resurrects a child while the parent is off", () => {
    assert.equal(featureEnabled({ fieldTime: false, fieldTimeKiosk: true }, "fieldTimeKiosk"), false);
    assert.equal(
      featureEnabled({ projects: true, timeTracking: true, fieldTime: true, fieldTimeKiosk: true }, "fieldTimeKiosk"),
      true,
    );
  });
  it("office orgs never see a clock: fieldTime dies with timeTracking", () => {
    assert.equal(
      featureEnabled({ projects: true, timeTracking: false, fieldTime: true }, "fieldTime"),
      false,
    );
  });
});

describe("field-time permissions", () => {
  it("the catalogue holds the three field-time keys", () => {
    for (const key of ["time.clock", "time.crew.enter", "time.kiosk.manage"]) {
      assert.ok((PERMISSION_CATALOGUE as readonly string[]).includes(key), `${key} must exist in the catalogue`);
    }
  });
  it("the time group lists them", () => {
    const group = PERMISSION_GROUPS.find((g) => g.key === "time");
    assert.ok(group, "time group must exist");
    for (const key of ["time.clock", "time.crew.enter", "time.kiosk.manage"]) {
      assert.ok(group.permissions.some((p) => p.key === key), `time group must list ${key}`);
    }
  });
  it("time.clock rides every built-in role", () => {
    for (const [name, role] of Object.entries(BUILT_IN_ROLES)) {
      assert.ok(
        (role.permissions as readonly string[]).includes("time.clock"),
        `${name} must grant time.clock`,
      );
    }
  });
  it("crew entry and kiosk management stay with operations roles", () => {
    for (const name of ["controller", "accountant"]) {
      const perms = BUILT_IN_ROLES[name]!.permissions as readonly string[];
      assert.ok(perms.includes("time.crew.enter"), `${name} must grant time.crew.enter`);
      assert.ok(perms.includes("time.kiosk.manage"), `${name} must grant time.kiosk.manage`);
    }
    const approver = BUILT_IN_ROLES["approver"]!.permissions as readonly string[];
    assert.ok(!approver.includes("time.crew.enter"), "approver must not enter crew time");
  });
});
