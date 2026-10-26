// Cleared rules reach domain validation and retain their named refusal and remedy.

import { test } from "node:test";
import assert from "node:assert/strict";
import { fieldTimeSettingsBody, normalizeFieldTimeSettingsBody } from "./settings-body.ts";
import { validateFieldTimeSettings } from "@openbooks/engine/hrm/field-time/settings";
import { FieldTimeError } from "@openbooks/engine/hrm/field-time/errors";

const fullRules = {
  roundingIncrement: 15,
  roundingMode: "nearest",
  unpaidBreakMinutes: 30,
  autoCloseHours: 16,
  signatureRequired: true,
  equipmentToleranceHours: "0.5",
  photoRequired: false,
};

test("a complete rule set parses and validates", () => {
  const parsed = fieldTimeSettingsBody.safeParse(fullRules);
  assert.equal(parsed.success, true);
  const settings = validateFieldTimeSettings(normalizeFieldTimeSettingsBody(parsed.data));
  assert.deepEqual(settings, {
    rounding: { incrementMinutes: 15, mode: "nearest" },
    unpaidBreakMinutes: 30,
    autoCloseHours: 16,
    signatureRequired: true,
    equipmentToleranceHours: "0.5",
    photoRequired: false,
  });
});

for (const [key, code, remedy] of [
  ["roundingMode", "rounding_not_declared", /Rounding mode is not declared.*Timesheets setup/],
  [
    "equipmentToleranceHours",
    "equipment_tolerance_not_declared",
    /Equipment tolerance.*Timesheets setup/,
  ],
  [
    "signatureRequired",
    "signature_rule_not_declared",
    /signature rule is not declared.*Timesheets setup/,
  ],
  ["photoRequired", "photo_rule_not_declared", /photo rule is not declared.*Timesheets setup/],
  ["roundingIncrement", "rounding_not_declared", /Rounding is not declared.*Timesheets setup/],
  [
    "unpaidBreakMinutes",
    "break_rule_not_declared",
    /unpaid break rule is not declared.*Timesheets setup/,
  ],
  ["autoCloseHours", "auto_close_not_declared", /Auto-close is not declared.*Timesheets setup/],
] as const) {
  for (const value of [null, undefined])
    test(`an undeclared ${key} (${value}) retains its named refusal and remedy`, () => {
      const parsed = fieldTimeSettingsBody.safeParse({ ...fullRules, [key]: value });
      assert.equal(parsed.success, true, "null must pass the transport schema to the validator");
      assert.throws(
        () => validateFieldTimeSettings(normalizeFieldTimeSettingsBody(parsed.data)),
        (error: unknown) =>
          error instanceof FieldTimeError && error.code === code && remedy.test(error.message),
      );
    });
}

test("explicit zero tolerance and disabled evidence rules remain declared", () => {
  const settings = validateFieldTimeSettings({
    ...fullRules,
    equipmentToleranceHours: "0",
    signatureRequired: false,
    photoRequired: false,
  });
  assert.equal(settings.equipmentToleranceHours, "0");
  assert.equal(settings.signatureRequired, false);
  assert.equal(settings.photoRequired, false);
});

test("a wrong-typed key still fails at the boundary carrying its field path", () => {
  const parsed = fieldTimeSettingsBody.safeParse({ ...fullRules, autoCloseHours: "16" });
  assert.equal(parsed.success, false);
  assert.equal(parsed.error.issues[0]?.path.join("."), "autoCloseHours");
});
