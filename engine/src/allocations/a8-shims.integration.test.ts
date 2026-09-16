import assert from "node:assert/strict";
import test from "node:test";
import { createScratchOrg, dropScratchOrg, seedFlowActors } from "../test-fixtures.ts";
import { getDimensionValueLabels } from "./a8-shims.ts";

// Driver evaluation landed with A2 (drivers.ts): vector resolution is
// covered by drivers.integration.test.ts and the preview route test. This
// file keeps the A8-owned display helper: dimension value labels.

const DB = !!process.env.OPENBOOKS_DB_URL;

test("dimension value labels resolve names, unknown ids stay bare", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    await seedFlowActors(org.orgId);
    const labels = await getDimensionValueLabels(org.orgId, "subsidiary", [org.subsidiaryId]);
    assert.equal(labels.size, 1);
    assert.ok((labels.get(org.subsidiaryId) ?? "").length > 0);
    assert.deepEqual(await getDimensionValueLabels(org.orgId, "subsidiary", []), new Map());
    // Custom segments have no label table: the caller falls back to ids.
    assert.deepEqual(
      await getDimensionValueLabels(org.orgId, "extra:region", [org.subsidiaryId]),
      new Map(),
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
