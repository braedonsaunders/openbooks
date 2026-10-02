import { test } from "node:test";
import assert from "node:assert/strict";
import { BenefitsError } from "./errors.ts";
import { windowsOverlap } from "./benefits-math.ts";

test("window overlap needs same kind, same scope, and shared days", () => {
  const base = { kind: "open_enrollment", opensOn: "2026-10-01", closesOn: "2026-10-31", employerSubsidiaryId: null, departmentId: null };
  assert.equal(windowsOverlap(base, { ...base }), true);
  assert.equal(windowsOverlap(base, { ...base, opensOn: "2026-11-01", closesOn: "2026-11-30" }), false);
  assert.equal(windowsOverlap(base, { ...base, kind: "new_hire" }), false);
  assert.equal(
    windowsOverlap(base, { ...base, employerSubsidiaryId: "11111111-1111-1111-1111-111111111111" }),
    false,
  );
  // Shared boundary day still overlaps.
  assert.equal(windowsOverlap(base, { ...base, opensOn: "2026-10-31", closesOn: "2026-11-30" }), true);
});

test("window dates reject impossible calendar days with a usable remedy", () => {
  const base = {kind:'open_enrollment',opensOn:'2026-02-30',closesOn:'2026-03-01',employerSubsidiaryId:null,departmentId:null};
  assert.throws(() => windowsOverlap(base,base), (error: unknown) => error instanceof BenefitsError && /has 28 days/.test(error.message));
});
