import { add, mul, neg } from "../money/money.ts";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { createPaymentDocument, updateDraftPayment } from "../payments/payment-documents.ts";
import { postPaymentWithApplications } from "../payments/payment-posting.ts";
import { submitAndReleaseIfUngated } from "../flows/submit.ts";
import { scenarioRecordId, type DemoContext } from "./scenarios.ts";
import { SampleCompanyError } from "./provisioning-failures.ts";

export async function installOperatingPayments(c: DemoContext): Promise<void> {
  const scope = new Set([c.subsidiaryId]);
  for (const kind of ["vendor_payment", "customer_payment"] as const) for (let n = 1; n <= 3; n++) {
    const memo = `Demonstration operating ${kind === "vendor_payment" ? "supplier settlement" : "customer receipt"} ${n}`;
    // The native payment writer owns UUIDs and numbering. Tenant-local authored
    // memo plus kind identifies the versioned scenario; ambiguous identity refuses.
    const prior = (await db.execute<{ id: string; status: string }>(sql`select id,status from documents where org_id=${c.orgId} and kind=${kind} and memo=${memo}`)).rows;
    if (prior.length > 1) throw new SampleCompanyError(`Multiple native payments match ${memo}; review their provenance before refreshing.`);
    if (prior.length) continue;
    const sourceId = scenarioRecordId(c, "documents", `operations-${kind === "vendor_payment" ? "vendor_bill" : "customer_invoice"}-${n}`);
    const source = (await db.execute<{ partyId: string; openLineId: string; amount: string }>(sql`
      select d.party_id as "partyId",l.id as "openLineId",abs(l.txn_amount)::text as amount
      from documents d join journal_lines l on l.org_id=d.org_id and l.entry_id=d.posted_entry_id
      join accounts a on a.org_id=l.org_id and a.id=l.account_id
      where d.org_id=${c.orgId} and d.id=${sourceId} and d.status='posted'
        and a.type=${kind === "vendor_payment" ? "liability_payable" : "asset_receivable"}
    `)).rows;
    if (source.length !== 1) throw new SampleCompanyError("A demonstration payment needs exactly one posted payable or receivable source; review its source transaction before refreshing.");
    const row = source[0]!;
    const creditId = scenarioRecordId(c, "documents", `operations-${kind === "vendor_payment" ? "vendor_credit" : "customer_credit"}-1`);
    const credit = n === 1 ? (await db.execute<{ id: string; amount: string }>(sql`select l.id,abs(l.txn_amount)::text as amount from documents d
      join journal_lines l on l.org_id=d.org_id and l.entry_id=d.posted_entry_id join accounts a on a.org_id=l.org_id and a.id=l.account_id
      where d.org_id=${c.orgId} and d.id=${creditId} and d.status='posted' and d.party_id=${row.partyId}
        and a.type=${kind === "vendor_payment" ? "liability_payable" : "asset_receivable"}`)).rows[0] : undefined;
    const amount = n === 2 ? mul(row.amount, "0.50") : credit ? add(row.amount, neg(credit.amount)) : row.amount;
    const payment = await createPaymentDocument({ orgId: c.orgId, createdBy: c.actorId, kind, allowedSubsidiaryIds: scope,
      partyId: row.partyId, bankAccountId: scenarioRecordId(c, "accounts", "settlement-bank"), subsidiaryId: c.subsidiaryId,
      documentDate: c.operationDate ?? c.date, currency: c.currency, memo });
    await updateDraftPayment(payment.id, { allocations: [{ openLineId: row.openLineId, sourceTransactionAmount: amount,
      targetTransactionAmount: amount, settlementRate: "1", settlementRateSource: "same_currency", settlementRateReference: "Same transaction currency" }], ...(credit ? { creditAllocations: [{ fromLineId: credit.id, toLineId: row.openLineId, amount: credit.amount, sourceDocumentId: creditId }] } : {}) }, c.actorId, c.orgId, { allowedSubsidiaryIds: scope });
    const release = await submitAndReleaseIfUngated(kind, payment.id, c.actorId);
    if (release.flowError || release.gated || !release.autoApproved) throw new SampleCompanyError("The sample payment requires independent approval; review its native Flow before retrying.");
    await postPaymentWithApplications(payment.id, undefined, c.actorId, "api");
  }
}
