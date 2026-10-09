import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { sql } from 'drizzle-orm';
import { db, withBypassContext, withOrgTransaction } from '../platform/db.ts';
import { postDocument } from '../ledger/posting-document.ts';
import { cmp } from '../money/money.ts';
import { ScopeNotFoundError } from '../organization/subsidiary-scope.ts';
import { createScratchOrg, createScratchUser, dropScratchOrg, type ScratchOrg } from '../testing/fixtures.ts';
import { EInvoiceConfigurationError, issueNativeEInvoice, loadNativeEInvoice, type EInvoiceActor } from './service.ts';

const DB = Boolean(process.env.OPENBOOKS_DB_URL);

async function sellerFixture(org: ScratchOrg, country = 'DE', baseCurrency = 'CAD'): Promise<EInvoiceActor> {
  return withBypassContext(async () => {
    const actorId = await createScratchUser(org.orgId, 'Invoice issuer', 'invoice_issuer');
    await db.execute(sql`update app_roles set permissions='["documents.manage"]'::jsonb where org_id=${org.orgId} and key='invoice_issuer'`);
    await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features}','{"einvoicing":true,"multiCurrency":true}'::jsonb) where id=${org.orgId}`);
    await db.execute(sql`update subsidiaries set country=${country}, base_currency=${baseCurrency}, legal_name='Seller Limited' where org_id=${org.orgId} and id=${org.subsidiaryId}`);
    await db.execute(sql`insert into customer_roles(org_id,party_id,ar_account_id,currency,einvoice_buyer_reference)
      values(${org.orgId},${org.customerId},${org.accounts.ar},${baseCurrency},'BUYER-DEFAULT')`);
    await db.execute(sql`insert into addresses(org_id,party_id,line1,city,postal_code,country,is_default_billing)
      values(${org.orgId},${org.customerId},'2 Customer Street','City','123456',${country},true)`);
    await db.execute(sql`insert into einvoice_settings(org_id,subsidiary_id,default_profile,address_line1,city,postcode,
      legal_registration_id,electronic_address,electronic_address_scheme,payment_means_code,untaxed_line_category,
      untaxed_exemption_reason,created_by,updated_by)
      values(${org.orgId},${org.subsidiaryId},'en16931-ubl','1 Seller Street','City','123456',
        'SELLER-REG','seller@example.test','EM','1','O','Outside the scope of VAT',${actorId},${actorId})`);
    return { orgId: org.orgId, actorId, allowedSubsidiaryIds: new Set([org.subsidiaryId]) };
  });
}

async function postedInvoice(org: ScratchOrg, currency = 'CAD', taxCodeId: string | null = null, kind = 'customer_invoice'): Promise<string> {
  return withBypassContext(async () => {
    const id = randomUUID();
    await db.execute(sql`insert into documents(id,org_id,kind,document_number,party_id,subsidiary_id,document_date,
      posting_date,due_date,currency,fx_rate,status,reference_number,memo)
      values(${id},${org.orgId},${kind},${`INV-${id.slice(0,8)}`},${org.customerId},${org.subsidiaryId},${org.date},
        ${org.date},${org.date},${currency},${currency === 'USD' ? '2' : '1'},'draft','DOCUMENT-REFERENCE','Correction of invoiced services')`);
    const line = (await db.execute<{ id: string }>(sql`insert into document_lines(org_id,document_id,line_number,account_id,description,quantity,unit,
      unit_price,amount,tax_code_id,tax_amount)
      values(${org.orgId},${id},1,${org.accounts.revenue},'Professional services','1','EA','100','100',${taxCodeId},${taxCodeId ? '9' : '0'}) returning id`)).rows[0]!;
    if (taxCodeId) {
      await db.execute(sql`insert into document_line_tax_components(org_id,document_line_id,tax_code_id,sequence,rate_percent,taxable_amount,tax_amount,recoverable_amount,nonrecoverable_amount,calculation_type,collected_account_id) values(${org.orgId},${line.id},${taxCodeId},1,'9','100','9','0','9','standard',${org.accounts.taxOutput})`);
    }
    await db.execute(sql`update documents set status='approved' where org_id=${org.orgId} and id=${id}`);
    await postDocument(id, { control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank } });
    return id;
  });
}

const noPdf = async (): Promise<Uint8Array> => { throw new Error('PDF renderer refused'); };

test('native issuance serializes retries, retains exact archives and rolls back failed hybrid issuance', { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actor = await sellerFixture(org);
    const id = await postedInvoice(org);
    const read = (options = {}) => withOrgTransaction(org.orgId, () => loadNativeEInvoice(db, actor, id, options));
    assert.equal((await read()).invoice.buyerReference, 'DOCUMENT-REFERENCE');
    assert.equal((await read({ buyerReference: null })).invoice.buyerReference, null);
    const [first, retry] = await Promise.all([
      issueNativeEInvoice(actor, id, { profile: 'en16931-ubl' }, noPdf),
      issueNativeEInvoice(actor, id, { profile: 'en16931-ubl' }, noPdf),
    ]);
    assert.equal(first.id, retry.id);
    assert.equal(first.sha256, retry.sha256);
    assert.deepEqual(first.content, retry.content);
    await assert.rejects(issueNativeEInvoice(actor, id, { profile: 'facturx' }, noPdf), /PDF renderer refused/);
    await withOrgTransaction(org.orgId, async () => {
      const counts = (await db.execute<{ archives: number; audits: number }>(sql`select
        (select count(*)::int from einvoice_documents where org_id=${org.orgId} and document_id=${id}) as archives,
        (select count(*)::int from audit_log where org_id=${org.orgId} and table_name='einvoice_documents' and row_id=${first.id}) as audits`)).rows[0];
      assert.deepEqual(counts, { archives: 1, audits: 1 });
      await db.execute(sql`delete from einvoice_settings where org_id=${org.orgId}`);
    });
    const archived = await issueNativeEInvoice(actor, id, { profile: 'en16931-ubl', buyerReference: null }, noPdf);
    assert.deepEqual(archived, first, 'replay does not remap current seller configuration or replace archived buyer reference');
    await assert.rejects(issueNativeEInvoice({ ...actor, allowedSubsidiaryIds: new Set() }, id, { profile: 'en16931-ubl' }, noPdf), ScopeNotFoundError);
    await assert.rejects(issueNativeEInvoice({ ...actor, actorId: randomUUID() }, id, { profile: 'en16931-ubl' }, noPdf), ScopeNotFoundError);
    await withOrgTransaction(org.orgId, () => db.execute(sql`update app_roles set permissions='[]'::jsonb where org_id=${org.orgId}`));
    await assert.rejects(issueNativeEInvoice(actor, id, { profile: 'en16931-ubl' }, noPdf), ScopeNotFoundError);
    await withOrgTransaction(org.orgId, async () => {
      await db.execute(sql`update app_roles set permissions='["documents.manage"]'::jsonb where org_id=${org.orgId}`);
      await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features,einvoicing}','false'::jsonb) where id=${org.orgId}`);
    });
    await assert.rejects(issueNativeEInvoice(actor, id, { profile: 'en16931-ubl' }, noPdf), ScopeNotFoundError);
  } finally { await dropScratchOrg(org.orgId); }
});

test('Singapore foreign-currency mapping refuses a posting without SGD functional-currency evidence', { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    await withBypassContext(() => db.execute(sql`insert into currencies(code,name,minor_units) values('USD','US Dollar',2)
      on conflict(code) do nothing`)); // Registry replay is a benign conflict on a shared ISO currency.
    const actor = await sellerFixture(org, 'SG', 'CAD');
    const id = await postedInvoice(org, 'USD');
    await assert.rejects(withOrgTransaction(org.orgId, () => loadNativeEInvoice(db, actor, id, { profile: 'pint-sg' })),
      (error: unknown) => error instanceof EInvoiceConfigurationError && /original posting in an SGD/.test(error.message));
  } finally { await dropScratchOrg(org.orgId); }
});

test('native credit references point to the invoice being corrected and respect tenant scope', { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actor = await sellerFixture(org);
    const invoiceId = await postedInvoice(org);
    const creditId = await postedInvoice(org, 'CAD', null, 'customer_credit');
    await withBypassContext(() => db.execute(sql`insert into document_links(org_id,from_document_id,to_document_id,link_type,reason,requested_by,requested_at)
      values(${org.orgId},${creditId},${invoiceId},'corrects','Correct invoiced services',${actor.actorId},now())`));
    await withOrgTransaction(org.orgId, async () => {
      const invoice = await loadNativeEInvoice(db, actor, invoiceId);
      const credit = await loadNativeEInvoice(db, actor, creditId);
      assert.equal(credit.invoice.typeCode, '381');
      assert.deepEqual(credit.invoice.precedingInvoices, [{ number: invoice.invoice.number, issueDate: org.date }]);
      assert.deepEqual(invoice.invoice.precedingInvoices, []);
      await assert.rejects(loadNativeEInvoice(db, { ...actor, orgId: randomUUID() }, creditId), ScopeNotFoundError);
    });
  } finally { await dropScratchOrg(org.orgId); }
});

test('Singapore mapping uses GST identities and original SGD journal amounts without current FX or tax accounts', { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    await withBypassContext(() => db.execute(sql`insert into currencies(code,name,minor_units) values('SGD','Singapore Dollar',2),('USD','US Dollar',2)
      on conflict(code) do nothing`)); // Global currency registry rows are shared reference data.
    const actor = await sellerFixture(org, 'SG', 'SGD');
    const taxCodeId = randomUUID();
    await withBypassContext(async () => {
      for (const scheme of ['gst', 'vat']) {
        const jurisdictionId = randomUUID();
        await db.execute(sql`insert into tax_jurisdictions(id,org_id,code,name,country,tax_type)
          values(${jurisdictionId},${org.orgId},${scheme},${scheme},'SG',${scheme})`);
        await db.execute(sql`insert into tax_registrations(org_id,subsidiary_id,jurisdiction_id,registration_number,effective_from)
          values(${org.orgId},${org.subsidiaryId},${jurisdictionId},${scheme === 'gst' ? 'GST-SELLER' : 'VAT-SELLER'},'2026-01-01')`);
      }
      await db.execute(sql`insert into party_tax_ids(org_id,party_id,scheme,value) values
        (${org.orgId},${org.customerId},'gst','GST-BUYER'),(${org.orgId},${org.customerId},'vies','VAT-BUYER')`);
      await db.execute(sql`insert into tax_codes(id,org_id,code,name,collected_account_id,einvoice_category,einvoice_effective_from)
        values(${taxCodeId},${org.orgId},'GST9','GST 9%',${org.accounts.taxOutput},'SR','2026-01-01')`);
      await db.execute(sql`insert into tax_rates(org_id,tax_code_id,rate_percent,effective_from)
        values(${org.orgId},${taxCodeId},'9','2026-01-01')`);
    });
    const id = await postedInvoice(org, 'USD', taxCodeId);
    await withOrgTransaction(org.orgId, async () => {
      const { invoice } = await loadNativeEInvoice(db, actor, id, { profile: 'pint-sg' });
      assert.equal(invoice.uuid, id);
      assert.equal(invoice.seller.vatId, 'GST-SELLER');
      assert.equal(invoice.buyer.vatId, 'GST-BUYER');
      assert.equal(invoice.taxCurrency, 'SGD');
      assert.equal(cmp(invoice.taxTotalInTaxCurrency!, '18'), 0);
      assert.equal(cmp(invoice.accountingCurrencyTotals!.taxInclusive, '218'), 0);
      assert.equal(cmp(invoice.accountingCurrencyTotals!.taxExclusive, '200'), 0);
      await db.execute(sql`update tax_codes set collected_account_id=${org.accounts.deferred} where org_id=${org.orgId} and id=${taxCodeId}`);
      const after = await loadNativeEInvoice(db, actor, id, { profile: 'pint-sg' });
      assert.deepEqual(after.invoice.accountingCurrencyTotals, invoice.accountingCurrencyTotals);
      assert.equal(after.invoice.taxTotalInTaxCurrency, invoice.taxTotalInTaxCurrency);
    });
    const failed = await postedInvoice(org, 'USD');
    await withOrgTransaction(org.orgId, async () => {
      await db.execute(sql`update einvoice_settings set untaxed_line_category=null,untaxed_exemption_reason=null where org_id=${org.orgId}`);
      await assert.rejects(loadNativeEInvoice(db, actor, failed, { profile: 'pint-sg' }), EInvoiceConfigurationError);
    });
  } finally { await dropScratchOrg(org.orgId); }
});


test('native seller instructions retain domestic payment accounts and provider identifiers', { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actor = await sellerFixture(org);
    const id = await postedInvoice(org);
    await withBypassContext(() => db.execute(sql`update einvoice_settings set payment_means_code='30',payee_account_id='123-456789',payee_bic='021 000021' where org_id=${org.orgId} and subsidiary_id=${org.subsidiaryId}`));
    const issued = await issueNativeEInvoice(actor, id, { profile: 'en16931-ubl' }, noPdf);
    const archive = await withBypassContext(() => db.execute<{ content: Uint8Array }>(sql`select content from einvoice_documents where org_id=${org.orgId} and id=${issued.id}`));
    const xml = new TextDecoder().decode(archive.rows[0]!.content);
    assert.match(xml, /<cbc:ID>123456789<\/cbc:ID>/);
    assert.match(xml, /<cbc:ID>021000021<\/cbc:ID>/);
  } finally { await dropScratchOrg(org.orgId); }
});
