import assert from "node:assert/strict";
import test from "node:test";
import { withBypass, withOrgContext } from "../platform/db.ts";
import { createScratchOrg, dropScratchOrg } from "../testing/fixtures.ts";
import { createPaymentDocument, updateDraftPayment } from "./payment-documents.ts";
import { loadPaymentDocument } from "./payment-queries.ts";

test("authority deduction evidence survives native save and reopen, including explicit zero and clearing", {
  skip: !process.env.OPENBOOKS_DB_URL,
}, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    await withOrgContext(org.orgId, async () => {
      const draft = await createPaymentDocument({
        orgId: org.orgId, kind: "vendor_payment", createdBy: null,
        allowedSubsidiaryIds: null, partyId: org.vendorId,
        subsidiaryId: org.subsidiaryId, documentDate: org.date,
      });
      const save = (patch: Parameters<typeof updateDraftPayment>[1]) => updateDraftPayment(
        draft.id, patch, null, org.orgId, { allowedSubsidiaryIds: null },
      );
      const readEvidence = async () => {
        const loaded = await loadPaymentDocument(draft.id, "vendor_payment", org.orgId);
        assert.ok(loaded, "saved payment must be readable through the native loader");
        return loaded.doc.custom as { withholdingAuthorisation: string | null; withholdingAuthorisedAmount: string | null };
      };
      await save({ withholdingAuthorisation: " ROS-DA-1 ", withholdingAuthorisedAmount: "12.3400" });
      assert.equal((await readEvidence()).withholdingAuthorisedAmount, "12.3400");
      await save({ memo: "Payment evidence retained" });
      assert.equal((await readEvidence()).withholdingAuthorisation, "ROS-DA-1");
      assert.equal((await readEvidence()).withholdingAuthorisedAmount, "12.3400");
      await save({ withholdingAuthorisedAmount: "0" });
      assert.equal((await readEvidence()).withholdingAuthorisedAmount, "0.0000");
      for (const amount of ["-1", "0.00001", "1,00", "1000000000000000"]) {
        await assert.rejects(save({ withholdingAuthorisedAmount: amount }), /negative|exact decimal|out of range/);
        assert.equal((await readEvidence()).withholdingAuthorisedAmount, "0.0000", "refusal must preserve prior evidence");
      }
      await assert.rejects(save({ withholdingAuthorisation: "R".repeat(101) }), /100 characters/);
      await save({ withholdingAuthorisation: null, withholdingAuthorisedAmount: null });
      const cleared = await readEvidence();
      assert.equal(cleared.withholdingAuthorisation, null);
      assert.equal(cleared.withholdingAuthorisedAmount, null);
    });
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId));
  }
});
