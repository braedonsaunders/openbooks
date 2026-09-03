import assert from "node:assert/strict";
import { test } from "node:test";
import { withOrg } from "../db.ts";
import { createDocumentsFlowAdapter } from "./documents-adapter.ts";
import { getFlowAdapter } from "./registry.ts";
import {
  createScratchOrg,
  dropScratchOrg,
  seedDraftDocument,
  seedFlowActors,
} from "../test-fixtures.ts";

/**
 * Scheduled fan-out tenant isolation (fnd_mtlnbr4x_wd5odm): candidate reads
 * back one flow's firing must never see another org's records.
 *
 * The firing wraps in withOrg(flow.orgId), but the pooled connections the
 * adapter's queries actually run on do not inherit that client's
 * transaction-local scope — and under an ambient bypass resolver (as the
 * scheduler tick and this suite run with) unscoped reads see every tenant.
 * The adapter therefore carries its own explicit org_id predicate and fails
 * closed with no ambient tenant, instead of trusting withOrg's RLS GUCs.
 */

const DB = !!process.env.OPENBOOKS_DB_URL;

test("documents fan-out candidates stay inside the firing org", { skip: !DB }, async () => {
  const orgA = await createScratchOrg();
  const orgB = await createScratchOrg();
  try {
    const actorsA = await seedFlowActors(orgA.orgId);
    const actorsB = await seedFlowActors(orgB.orgId);
    const aDocs: string[] = [];
    for (let i = 0; i < 3; i++) {
      aDocs.push(
        await seedDraftDocument(orgA.orgId, {
          kind: "vendor_bill",
          createdBy: actorsA.submitterId,
          number: `CAND-A-${i}`,
        }),
      );
    }
    for (let i = 0; i < 5; i++) {
      await seedDraftDocument(orgB.orgId, {
        kind: "vendor_bill",
        createdBy: actorsB.submitterId,
        number: `CAND-B-${i}`,
      });
    }

    const candidates = await withOrg(orgA.orgId, () =>
      createDocumentsFlowAdapter("vendor_bill").findCandidateIds!(100),
    );
    assert.deepEqual(new Set(candidates), new Set(aDocs), "only the firing org's docs are candidates");

    const otherWay = await withOrg(orgB.orgId, () =>
      getFlowAdapter("vendor_bill")!.findCandidateIds!(100),
    );
    assert.equal(otherWay.length, 5, "the neighboring org sees exactly its own docs");
    assert.ok(otherWay.every((id) => !aDocs.includes(id)));
  } finally {
    await dropScratchOrg(orgA.orgId);
    await dropScratchOrg(orgB.orgId);
  }
});

test("documents fan-out refuses to read without an ambient tenant", { skip: !DB }, async () => {
  await assert.rejects(
    () => createDocumentsFlowAdapter("vendor_bill").findCandidateIds!(10),
    /ambient tenant context/,
    "an unscoped candidate read fails closed instead of scanning every tenant",
  );
});
