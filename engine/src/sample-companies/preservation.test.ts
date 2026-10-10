import assert from "node:assert/strict";
import test from "node:test";
import { assertSampleSettingsPreserved } from "./preservation.ts";

test("refresh preserves configured values and announcements while adding required demonstrated gates", () => {
  const before = { features: { banking: false, payroll: false }, onboarding: { setupComplete: false },
    home: { announcements: [{ id: "industry-demo", title: "Operator's review notes" }] }, payroll: { countries: ["CA"], netPayAccountId: "configured-account" }, demoData: { version: 4 } };
  const after = { ...before, features: { ...before.features, banking: true }, demoData: { version: 5 } };
  assert.doesNotThrow(() => assertSampleSettingsPreserved(before, after, "general_business"));
  assert.throws(() => assertSampleSettingsPreserved(before, { ...after, payroll: { ...before.payroll, netPayAccountId: "another-account" } }, "general_business"), /payroll.netPayAccountId/);
  assert.throws(() => assertSampleSettingsPreserved(before, { ...after, features: { ...after.features, payroll: true } }, "general_business"), /features.payroll/);
  assert.throws(() => assertSampleSettingsPreserved(before, { ...after, home: { announcements: [{ id: "industry-demo", title: "Replacement" }] } }, "general_business"), /home.announcements/);
  assert.throws(() => assertSampleSettingsPreserved(before, { ...after, onboarding: { setupComplete: true } }, "general_business"), /onboarding.setupComplete/);
});
