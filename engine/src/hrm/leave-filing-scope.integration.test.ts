import { test } from "node:test";
import assert from "node:assert/strict";
import {
  dropScratchOrg,
} from "../testing/fixtures.ts";
import {
  DB,
  mkSecondSubsidiary,
  scopeRole,
  seedEmployment,
  setupHarness,
} from "../testing/hrm-harness.ts";
import { listLeaveFilingEmploymentOptions } from "./leave-read.ts";

/**
 * C-68 regression (integration partition): the leave filing picker must
 * apply the actor's legal-entity scope in SQL, not in JS after the page
 * LIMIT. Twenty-five alphabetically earlier out-of-scope employments must
 * not displace the fileable in-scope one into an empty page.
 */


const LEAVE_FILING_SCOPE_SPEC = {
  features: [],
  users: [
    { key: "managerAId", name: "Mara Manager", handle: "leave_manager_a" },
  ],
} as const;

async function setupFilingScopeHarness() {
  return setupHarness(LEAVE_FILING_SCOPE_SPEC, async (base) => {
    const subB = await mkSecondSubsidiary(base.org.orgId, base.org.subsidiaryId, { currency: "USD", country: "US" });
    // Twenty-five out-of-scope employments sorting before the in-scope one.
    for (let i = 0; i < 25; i++) {
      await seedEmployment(base.org.orgId, subB, { displayName: `Aardvark ${String(i).padStart(2, "0")}`, withVersion: false });
    }
    const inScopeEmploymentId = (await seedEmployment(base.org.orgId, base.org.subsidiaryId, { displayName: "Zed Zebulon", withVersion: false })).employmentId;
    await scopeRole(base.org.orgId, "leave_manager_a", ["hrm.leave.manage"], [base.org.subsidiaryId]);
    return { subB, inScopeEmploymentId };
  });
}

test("out-of-scope rows cannot displace the fileable in-scope picker option", { skip: !DB }, async () => {
  if (!DB) return;
  const h = await setupFilingScopeHarness();
  try {
    const options = await listLeaveFilingEmploymentOptions({ orgId: h.org.orgId, actorId: h.managerAId });
    const ids = options.map((o) => o.employmentId);
    assert.ok(ids.includes(h.inScopeEmploymentId), "the in-scope employment must survive the page");
    for (const option of options) {
      assert.match(option.label, /Zed Zebulon/, "no out-of-scope row may leak into the page");
    }
  } finally {
    await dropScratchOrg(h.org.orgId);
  }
});
