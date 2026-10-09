import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withOrgContext } from "../platform/db.ts";
import { createScratchOrg, createScratchUser, dropScratchOrg } from "../testing/fixtures.ts";
import { postDocument } from "../ledger/posting-document.ts";
import { createPaymentDocument, updateDraftPayment } from "../payments/payment-documents.ts";

test("a statutory threshold catch-up can settle a vendor entirely through withheld tax with no bank movement", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await createScratchOrg();
  try { await withOrgContext(org.orgId, async () => {
    const actor = await createScratchUser(org.orgId, "Payables accountant", "admin");
    await db.execute(sql`update app_roles set permissions='["ap.pay","documents.manage"]'::jsonb where org_id=${org.orgId} and key='admin'`);
    await db.execute(sql`update orgs set base_currency='EUR',settings=jsonb_set(settings,'{features}',coalesce(settings->'features','{}'::jsonb)||'{"contractorWithholding":true}'::jsonb) where id=${org.orgId}`);
    await db.execute(sql`update subsidiaries set base_currency='EUR',country='DE' where org_id=${org.orgId} and id=${org.subsidiaryId}`);
    await db.execute(sql`insert into vendor_roles(org_id,party_id) values(${org.orgId},${org.vendorId})`);
    await db.execute(sql`insert into withholding_enrollments(org_id,subsidiary_id,scheme_code,contractor_reference,liability_account_id,effective_from,created_by,updated_by)
      values(${org.orgId},${org.subsidiaryId},'DE_BAUABZUG','12/345/67890',${org.accounts.withholding},'2002-01-01',${actor},${actor})`);
    await db.execute(sql`insert into withholding_standings(org_id,subsidiary_id,party_id,scheme_code,band_code,valid_from,created_by,updated_by)
      values(${org.orgId},${org.subsidiaryId},${org.vendorId},'DE_BAUABZUG','STANDARD','2002-01-01',${actor},${actor})`);
    const deps = { control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank } };
    const settle = async (amount: string) => {
      const bill = randomUUID();
      await db.execute(sql`insert into documents(id,org_id,kind,status,document_number,subsidiary_id,party_id,document_date,currency,fx_rate,subtotal,tax_total,total,created_by)
        values(${bill},${org.orgId},'vendor_bill','draft',${`BILL-${bill}`},${org.subsidiaryId},${org.vendorId},${org.date},'EUR','1',${amount},'0',${amount},${actor})`);
      await db.execute(sql`insert into document_lines(org_id,document_id,line_number,account_id,quantity,unit_price,amount,tax_amount,withholding_treatment)
        values(${org.orgId},${bill},1,${org.accounts.cogs},'1',${amount},${amount},'0','labour')`);
      await db.execute(sql`update documents set status='approved' where org_id=${org.orgId} and id=${bill}`);
      const entry = await postDocument(bill, deps);
      const openLine = (await db.execute<{ id: string }>(sql`select id from journal_lines where org_id=${org.orgId} and entry_id=${entry} and account_id=${org.accounts.ap}`)).rows[0]!.id;
      const payment = await createPaymentDocument({ orgId: org.orgId, createdBy: actor, kind: 'vendor_payment', partyId: org.vendorId,
        subsidiaryId: org.subsidiaryId, bankAccountId: org.accounts.bank, documentDate: org.date, currency: 'EUR', allowedSubsidiaryIds: null });
      await updateDraftPayment(payment.id, { allocations: [{ openLineId: openLine, sourceTransactionAmount: amount, targetTransactionAmount: amount,
        settlementRate: '1', settlementRateSource: 'same_currency', settlementRateReference: 'Same transaction currency' }] }, actor, org.orgId, { allowedSubsidiaryIds: null });
      await db.execute(sql`update documents set status='approved' where org_id=${org.orgId} and id=${payment.id}`);
      return { id: payment.id, entry: await postDocument(payment.id, deps, { deferEffects: true, audit: { actorId: actor, source: 'ui' } }) };
    };
    await settle('5000');
    const crossing = await settle('100');
    const header = (await db.execute<{ total: string; amount: string }>(sql`select total::text,custom->>'withholdingAmount' as amount from documents where org_id=${org.orgId} and id=${crossing.id}`)).rows[0];
    assert.deepEqual(header, { total: '0.0000', amount: '100.0000' });
    const legs = (await db.execute<{ account_id: string; amount: string }>(sql`select account_id,amount::text from journal_lines where org_id=${org.orgId} and entry_id=${crossing.entry}`)).rows;
    assert.equal(legs.filter(row => row.account_id === org.accounts.bank).every(row => row.amount === '0.0000'), true);
    assert.equal(legs.find(row => row.account_id === org.accounts.ap)?.amount, '100.0000');
    assert.equal(legs.find(row => row.account_id === org.accounts.withholding)?.amount, '-100.0000');
    const evidence = (await db.execute<{ deducted: string; outstanding: string; waived: string }>(sql`select deducted_amount::text as deducted,uncollected_amount::text as outstanding,
      (select reason->>'amount' from jsonb_array_elements(reasons) reason where reason->>'code'='deduction_capped') as waived
      from withholding_deductions where org_id=${org.orgId} and payment_document_id=${crossing.id}`)).rows[0];
    assert.deepEqual(evidence, { deducted: '100.0000', outstanding: '0.0000', waived: '665.0000' });
  }); } finally { await dropScratchOrg(org.orgId); }
});
