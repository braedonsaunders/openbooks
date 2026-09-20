import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { evaluateBillsForRelease } from "../compliance/compliance.ts";
import { postDocument } from "../ledger/posting-document.ts";
import { createPaymentDocument, updateDraftPayment } from "./payment-documents.ts";
import { openItemsForParty } from "./payment-queries.ts";
import { postPaymentWithApplications } from "./payment-posting.ts";
import { sameCurrencyAllocation } from "./settlement-policy.ts";
import { submitAndReleaseIfUngated } from "../flows/submit.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
} from "../testing/fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

/**
 * Fraud probe (wave 2, B8): a subcontractor compliance policy with
 * `block_payment` enforcement must stop payment on EVERY payment path — the
 * release evaluator's own docstring says "every payment path routes through:
 * pay-run creation, run readiness, and posting". Pay-run creation, readiness,
 * and run posting all enforce it, but the ad-hoc payment post does not, so a
 * compliance-blocked bill can be paid by posting a vendor_payment directly.
 */

test("an ad-hoc payment cannot pay a compliance-blocked bill", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actor = await createScratchUser(org.orgId, "Clerk", "ap_clerk");
    // Opt the org into subcontractor compliance.
    await db.execute(sql`update orgs set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{features,subcontractorCompliance}', 'true'::jsonb) where id = ${org.orgId}`);
    // A vendor class plus a block_payment insurance requirement (no expiry,
    // no verification: a missing certificate alone must block).
    const classId = randomUUID();
    const vendorId = randomUUID();
    const requirementId = randomUUID();
    await db.execute(sql`insert into compliance_classes (id, org_id, code, name, is_active, created_by)
      values (${classId}, ${org.orgId}, 'SUB', 'Subcontractors', true, ${actor})`);
    await db.execute(sql`insert into parties (id, org_id, kind, display_name, subsidiary_id, created_by)
      values (${vendorId}, ${org.orgId}, 'vendor', 'Blocked vendor', ${org.subsidiaryId}, ${actor})`);
    await db.execute(sql`insert into vendor_roles (org_id, party_id, ap_account_id, compliance_class_id, is_active, created_by)
      values (${org.orgId}, ${vendorId}, ${org.accounts.ap}, ${classId}, true, ${actor})`);
    await db.execute(sql`insert into compliance_requirements
      (id, org_id, code, name, category, class_id, requires_expiry, enforcement, requires_verification, is_active, created_by)
      values (${requirementId}, ${org.orgId}, 'COI', 'Certificate of insurance', 'insurance', null,
        false, 'block_payment', false, true, ${actor})`);

    // Post a bill for the non-compliant vendor. block_payment (unlike
    // block_bill) must not stop recording the liability.
    const billId = randomUUID();
    await db.execute(sql`insert into documents
      (id, org_id, kind, status, document_number, subsidiary_id, party_id, document_date, currency, fx_rate, subtotal, tax_total, total, created_by)
      values (${billId}, ${org.orgId}, 'vendor_bill', 'draft', 'BILL-BLOCKED-1',
        ${org.subsidiaryId}, ${vendorId}, ${org.date}, 'CAD', '1', '100', '0', '100', ${actor})`);
    await db.execute(sql`insert into document_lines
      (org_id, document_id, line_number, account_id, quantity, unit_price, amount, tax_amount, tax_input_amount)
      values (${org.orgId}, ${billId}, 1, ${org.accounts.cogs}, '1', '100', '100', '0', '100')`);
    await db.execute(sql`update documents set status = 'approved' where org_id = ${org.orgId} and id = ${billId}`);
    await postDocument(billId, { control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank } });

    // Control: the release evaluator blocks this bill.
    const decisions = await evaluateBillsForRelease({
      orgId: org.orgId,
      bills: [{
        documentId: billId, documentNumber: "BILL-BLOCKED-1", partyId: vendorId,
        vendorName: "Blocked vendor", projectId: null, documentDate: org.date, amount: "100", currency: "CAD",
      }],
      asOf: org.date,
    });
    assert.equal(decisions[0]!.decision, "blocked", "control: the bill is compliance-blocked");

    // The attack: pay the blocked bill ad-hoc, outside any pay run.
    const open = await openItemsForParty(vendorId, "ap", org.orgId);
    const line = open.find((item) => item.documentId === billId);
    assert.ok(line, "bill has an open payable line");
    const payment = await createPaymentDocument({
      orgId: org.orgId, kind: "vendor_payment", createdBy: actor, partyId: vendorId,
      bankAccountId: org.accounts.bank, subsidiaryId: org.subsidiaryId, documentDate: org.date,
    });
    await updateDraftPayment(payment.id, {
      allocations: [sameCurrencyAllocation(line!.lineId, "100")],
    }, actor, org.orgId);
    await submitAndReleaseIfUngated("vendor_payment", payment.id, actor);
    await assert.rejects(
      postPaymentWithApplications(payment.id, [sameCurrencyAllocation(line!.lineId, "100")], actor),
      /compliance/i,
      "ad-hoc payment of a compliance-blocked bill must be refused",
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
