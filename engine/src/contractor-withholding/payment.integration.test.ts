import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { sql } from 'drizzle-orm';
import { db, withOrgContext } from '../platform/db.ts';
import { createScratchOrg, createScratchUser, dropScratchOrg, type ScratchOrg } from '../testing/fixtures.ts';
import { postDocument } from '../ledger/posting-document.ts';
import { createPaymentDocument, updateDraftPayment } from '../payments/payment-documents.ts';
import { computePaymentWithholdings, listWithholdingStandings, saveWithholdingStanding, storedPaymentWithholdings } from './service.ts';

const DB = Boolean(process.env.OPENBOOKS_DB_URL);
async function fixture(org: ScratchOrg, currency = 'GBP') {
  const actor = await createScratchUser(org.orgId, 'Contractor accountant', 'admin');
  await db.execute(sql`update app_roles set permissions='["admin.setup.manage","ap.pay"]'::jsonb where org_id=${org.orgId} and key='admin'`);
  await db.execute(sql`update orgs set base_currency='GBP', settings=jsonb_set(settings,'{features}',coalesce(settings->'features','{}'::jsonb)||'{"projects":true,"contractorWithholding":true}'::jsonb) where id=${org.orgId}`);
  await db.execute(sql`update subsidiaries set country='GB',base_currency='GBP' where org_id=${org.orgId} and id=${org.subsidiaryId}`);
  const fxRate = currency === 'GBP' ? '1' : '0.8';
  if (currency !== 'GBP') await db.execute(sql`insert into fx_rates(org_id,from_currency,to_currency,as_of,rate,rate_type,source) values(${org.orgId},${currency},'GBP',${org.date},${fxRate},'spot','manual')`);
  await db.execute(sql`insert into vendor_roles(org_id,party_id) values(${org.orgId},${org.vendorId})`);
  const enrollmentId = randomUUID(), standingId = randomUUID();
  await db.execute(sql`insert into withholding_enrollments(id,org_id,subsidiary_id,scheme_code,contractor_reference,liability_account_id,effective_from,created_by,updated_by) values(${enrollmentId},${org.orgId},${org.subsidiaryId},'GB_CIS','123PA00000000',${org.accounts.withholding},'2007-04-06',${actor},${actor})`);
  await db.execute(sql`insert into withholding_standings(id,org_id,party_id,scheme_code,band_code,verification_reference,valid_from,payee_reference,created_by,updated_by) values(${standingId},${org.orgId},${org.vendorId},'GB_CIS','NET','V1234567890','2007-04-06','1234567890',${actor},${actor})`);
  const billId = randomUUID();
  await db.execute(sql`insert into documents(id,org_id,kind,status,document_number,subsidiary_id,party_id,document_date,currency,fx_rate,subtotal,tax_total,total,created_by) values(${billId},${org.orgId},'vendor_bill','draft',${`BILL-${billId}`},${org.subsidiaryId},${org.vendorId},${org.date},${currency},${fxRate},'1000','0','1000',${actor})`);
  await db.execute(sql`insert into document_lines(org_id,document_id,line_number,account_id,quantity,unit_price,amount,tax_amount,withholding_treatment) values(${org.orgId},${billId},1,${org.accounts.cogs},'1','1000','1000','0','labour')`);
  await db.execute(sql`update documents set status='approved' where org_id=${org.orgId} and id=${billId}`);
  const deps = { control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank } };
  const billEntry = await postDocument(billId, deps);
  const openLineId = (await db.execute<{ id: string }>(sql`select id from journal_lines where org_id=${org.orgId} and entry_id=${billEntry} and account_id=${org.accounts.ap}`)).rows[0]!.id;
  const payment = await createPaymentDocument({ orgId: org.orgId, createdBy: actor, kind: 'vendor_payment', partyId: org.vendorId, subsidiaryId: org.subsidiaryId, bankAccountId: org.accounts.bank, documentDate: org.date, currency, fxRate, allowedSubsidiaryIds: null });
  await updateDraftPayment(payment.id, { allocations: [{ openLineId, sourceTransactionAmount:'1000', targetTransactionAmount:'1000', settlementRate:'1', settlementRateSource:'same_currency', settlementRateReference:'Same transaction currency' }] }, actor, org.orgId, { allowedSubsidiaryIds: null });
  return { actor, standingId, enrollmentId, billId, openLineId, payment, deps };
}

test('native direct posting balances cash and withheld tax and records one immutable deduction', { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try { await withOrgContext(org.orgId, async () => {
    const f = await fixture(org);
    const saved = (await db.execute<{ total: string; custom: unknown }>(sql`select total::text,custom from documents where org_id=${org.orgId} and id=${f.payment.id}`)).rows[0]!;
    assert.equal(saved.total,'800.0000');
    assert.equal(storedPaymentWithholdings(saved.custom)[0]!.deducted,'200.0000');
    await db.execute(sql`update documents set status='approved' where org_id=${org.orgId} and id=${f.payment.id}`);
    const entry = await postDocument(f.payment.id,f.deps,{deferEffects:true,audit:{actorId:f.actor,source:'ui'}});
    const legs = (await db.execute<{ account_id: string; amount: string }>(sql`select account_id,amount::text from journal_lines where org_id=${org.orgId} and entry_id=${entry} order by line_number`)).rows;
    assert.deepEqual(legs.map(l => [l.account_id,l.amount]),[[org.accounts.ap,'1000.0000'],[org.accounts.bank,'-800.0000'],[org.accounts.withholding,'-200.0000']]);
    const recorded = (await db.execute<{ deducted: string; payment_document_id: string; bill_document_id: string }>(sql`select deducted_amount::text as deducted,payment_document_id,bill_document_id from withholding_deductions where org_id=${org.orgId}`)).rows;
    assert.deepEqual(recorded,[{ deducted:'200.0000',payment_document_id:f.payment.id,bill_document_id:f.billId }]);
    await assert.rejects(() => postDocument(f.payment.id,f.deps),/already posted/);
    await assert.rejects(() => db.execute(sql`update withholding_deductions set deducted_amount=201 where org_id=${org.orgId}`),(error: unknown) => String((error as { cause?: unknown }).cause ?? error).includes('recorded withholding deduction'));
  }); } finally { await dropScratchOrg(org.orgId); }
});

test('foreign-currency payments freeze statutory reporting without changing transaction cash', { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try { await withOrgContext(org.orgId, async () => {
    const f = await fixture(org, 'EUR');
    const saved = (await db.execute<{ total: string; custom: unknown }>(sql`select total::text,custom from documents where org_id=${org.orgId} and id=${f.payment.id}`)).rows[0]!;
    const deduction = storedPaymentWithholdings(saved.custom)[0]!;
    assert.equal(saved.total, '800.0000');
    assert.equal(deduction.deducted, '200.0000');
    assert.equal(deduction.reporting.currency, 'GBP');
    assert.equal(deduction.reporting.paid, '800.0000');
    assert.equal(deduction.reporting.deducted, '160.0000');
    assert.equal(deduction.reporting.fx.observations[0]!.source, 'manual');
    await db.execute(sql`update documents set status='approved' where org_id=${org.orgId} and id=${f.payment.id}`);
    const entry = await postDocument(f.payment.id, f.deps, { deferEffects: true, audit: { actorId: f.actor, source: 'ui' } });
    const recorded = (await db.execute<{ currency: string; paid: string; deducted: string; transaction_currency: string; cash: string; digest: string }>(sql`select currency,paid_amount::text as paid,deducted_amount::text as deducted,transaction_currency,transaction_deducted_amount::text as cash,reporting_fx_evidence->>'digest' as digest from withholding_deductions where org_id=${org.orgId} and payment_document_id=${f.payment.id}`)).rows[0]!;
    assert.deepEqual(recorded, { currency: 'GBP', paid: '800.0000', deducted: '160.0000', transaction_currency: 'EUR', cash: '200.0000', digest: deduction.reporting.fx.digest });
    const legs = (await db.execute<{ account_id: string; amount: string }>(sql`select account_id,amount::text from journal_lines where org_id=${org.orgId} and entry_id=${entry} order by line_number`)).rows;
    assert.deepEqual(legs.map(l => [l.account_id,l.amount]), [[org.accounts.ap,'800.0000'],[org.accounts.bank,'-640.0000'],[org.accounts.withholding,'-160.0000']]);
  }); } finally { await dropScratchOrg(org.orgId); }
});

test('a changed native reporting quote refuses posting even when transaction tax remains unchanged', { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try { await withOrgContext(org.orgId, async () => {
    const f = await fixture(org, 'EUR');
    await db.execute(sql`update fx_rates set rate='0.9' where org_id=${org.orgId} and from_currency='EUR' and to_currency='GBP' and rate_type='spot'`);
    await db.execute(sql`update documents set status='approved' where org_id=${org.orgId} and id=${f.payment.id}`);
    await assert.rejects(() => postDocument(f.payment.id, f.deps, { deferEffects: true }), (error: unknown) => String((error as { remedy?: string }).remedy ?? error).includes('Save the payment again'));
    const result = (await db.execute<{ entries: number; deductions: number }>(sql`select (select count(*)::int from journal_entries where org_id=${org.orgId} and source_document_id=${f.payment.id}) as entries,(select count(*)::int from withholding_deductions where org_id=${org.orgId} and payment_document_id=${f.payment.id}) as deductions`)).rows[0];
    assert.deepEqual(result, { entries: 0, deductions: 0 });
    await db.execute(sql`delete from fx_rates where org_id=${org.orgId} and from_currency='EUR' and to_currency='GBP' and rate_type='spot'`);
    await assert.rejects(() => computePaymentWithholdings({ orgId:org.orgId, subsidiaryId:org.subsidiaryId, partyId:org.vendorId, paymentDate:org.date, currency:'EUR', allocations:[{openLineId:f.openLineId,targetTransactionAmount:'1000'}], discountAmount:'0', paymentDocumentId:f.payment.id }), (error: unknown) => String((error as { remedy?: string }).remedy).includes('Setup → Exchange Rates'));
  }); } finally { await dropScratchOrg(org.orgId); }
});

test('RCT authorisation amounts match statutory EUR for a sterling payment', { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try { await withOrgContext(org.orgId, async () => {
    const f = await fixture(org);
    await db.execute(sql`update subsidiaries set country='IE' where org_id=${org.orgId} and id=${org.subsidiaryId}`);
    await db.execute(sql`update withholding_enrollments set scheme_code='IE_RCT' where org_id=${org.orgId} and id=${f.enrollmentId}`);
    await db.execute(sql`update withholding_standings set scheme_code='IE_RCT',band_code='STANDARD' where org_id=${org.orgId} and id=${f.standingId}`);
    await db.execute(sql`insert into fx_rates(org_id,from_currency,to_currency,as_of,rate,rate_type,source) values(${org.orgId},'GBP','EUR',${org.date},'1.25','spot','manual')`);
    await updateDraftPayment(f.payment.id, { withholdingAuthorisation:'RCT-AUTH-2026', withholdingAuthorisedAmount:'200' }, f.actor, org.orgId, {allowedSubsidiaryIds:null});
    await db.execute(sql`update documents set status='approved' where org_id=${org.orgId} and id=${f.payment.id}`);
    await assert.rejects(() => postDocument(f.payment.id, f.deps, {deferEffects:true}), /EUR deduction amount/);
    await db.execute(sql`update documents set status='draft' where org_id=${org.orgId} and id=${f.payment.id}`);
    await updateDraftPayment(f.payment.id, { withholdingAuthorisedAmount:'250' }, f.actor, org.orgId, {allowedSubsidiaryIds:null});
    await db.execute(sql`update documents set status='approved' where org_id=${org.orgId} and id=${f.payment.id}`);
    await postDocument(f.payment.id, f.deps, {deferEffects:true,audit:{actorId:f.actor,source:'ui'}});
    const row = (await db.execute<{ currency: string; deducted: string; cash: string }>(sql`select currency,deducted_amount::text as deducted,transaction_deducted_amount::text as cash from withholding_deductions where org_id=${org.orgId} and payment_document_id=${f.payment.id}`)).rows[0];
    assert.deepEqual(row, { currency:'EUR', deducted:'250.0000', cash:'200.0000' });
  }); } finally { await dropScratchOrg(org.orgId); }
});

test('foreign threshold history catches up earlier allocations in the same payment exactly once', { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try { await withOrgContext(org.orgId, async () => {
    const f = await fixture(org);
    await db.execute(sql`update subsidiaries set country='DE' where org_id=${org.orgId} and id=${org.subsidiaryId}`);
    await db.execute(sql`update withholding_enrollments set scheme_code='DE_BAUABZUG' where org_id=${org.orgId} and id=${f.enrollmentId}`);
    await db.execute(sql`update withholding_standings set scheme_code='DE_BAUABZUG',band_code='STANDARD' where org_id=${org.orgId} and id=${f.standingId}`);
    await db.execute(sql`insert into fx_rates(org_id,from_currency,to_currency,as_of,rate,rate_type,source) values(${org.orgId},'GBP','EUR',${org.date},'1.25','spot','manual')`);
    const secondBill = randomUUID();
    await db.execute(sql`insert into documents(id,org_id,kind,status,document_number,subsidiary_id,party_id,document_date,currency,fx_rate,subtotal,tax_total,total,created_by) values(${secondBill},${org.orgId},'vendor_bill','draft',${`BILL-${secondBill}`},${org.subsidiaryId},${org.vendorId},${org.date},'GBP','1','3800','0','3800',${f.actor})`);
    await db.execute(sql`insert into document_lines(org_id,document_id,line_number,account_id,quantity,unit_price,amount,tax_amount,withholding_treatment) values(${org.orgId},${secondBill},1,${org.accounts.cogs},'1','3800','3800','0','labour')`);
    await db.execute(sql`update documents set status='approved' where org_id=${org.orgId} and id=${secondBill}`);
    const secondEntry = await postDocument(secondBill, f.deps);
    const secondLine = (await db.execute<{ id: string }>(sql`select id from journal_lines where org_id=${org.orgId} and entry_id=${secondEntry} and account_id=${org.accounts.ap}`)).rows[0]!.id;
    await updateDraftPayment(f.payment.id, { allocations: [
      {openLineId:f.openLineId,sourceTransactionAmount:'1000',targetTransactionAmount:'1000',settlementRate:'1',settlementRateSource:'same_currency',settlementRateReference:'Same transaction currency'},
      {openLineId:secondLine,sourceTransactionAmount:'3800',targetTransactionAmount:'3800',settlementRate:'1',settlementRateSource:'same_currency',settlementRateReference:'Same transaction currency'},
    ] }, f.actor, org.orgId, {allowedSubsidiaryIds:null});
    const custom = (await db.execute<{ custom: unknown }>(sql`select custom from documents where org_id=${org.orgId} and id=${f.payment.id}`)).rows[0]!.custom;
    const rows = storedPaymentWithholdings(custom);
    assert.equal(rows[0]!.reporting.consideration, '1250.0000');
    assert.equal(rows[0]!.belowThreshold, true);
    assert.equal(rows[0]!.deducted, '0.0000');
    assert.equal(rows[1]!.reporting.consideration, '4750.0000');
    assert.equal(rows[1]!.reporting.catchUpBase, '1250.0000');
    assert.equal(rows[1]!.reporting.deducted, '900.0000');
    assert.equal(rows[1]!.deducted, '720.0000');
    await db.execute(sql`update documents set status='approved' where org_id=${org.orgId} and id=${f.payment.id}`);
    await postDocument(f.payment.id, f.deps, {deferEffects:true,audit:{actorId:f.actor,source:'ui'}});
    const history = (await db.execute<{ consideration: string; pending: string; tax: string }>(sql`select sum(consideration_amount)::text as consideration,(sum(base_amount) filter(where below_threshold)-sum(catch_up_base))::text as pending,sum(deducted_amount)::text as tax from withholding_deductions where org_id=${org.orgId}`)).rows[0];
    assert.deepEqual(history, {consideration:'6000.0000',pending:'0.0000',tax:'900.0000'});
  }); } finally { await dropScratchOrg(org.orgId); }
});

test('a changed standing refuses the approved payment and rolls back its journal and deductions', { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try { await withOrgContext(org.orgId, async () => {
    const f = await fixture(org);
    await db.execute(sql`update withholding_standings set band_code='HIGHER' where org_id=${org.orgId} and id=${f.standingId}`);
    await db.execute(sql`update documents set status='approved' where org_id=${org.orgId} and id=${f.payment.id}`);
    await assert.rejects(() => postDocument(f.payment.id,f.deps,{deferEffects:true}),(error: unknown) => String((error as { remedy?: string }).remedy ?? error).includes('Save the payment again'));
    const result = (await db.execute<{ status: string; entries: number; deductions: number }>(sql`select d.status,(select count(*)::int from journal_entries where org_id=d.org_id and source_document_id=d.id) as entries,(select count(*)::int from withholding_deductions where org_id=d.org_id and payment_document_id=d.id) as deductions from documents d where d.org_id=${org.orgId} and d.id=${f.payment.id}`)).rows[0];
    assert.deepEqual(result,{status:'approved',entries:0,deductions:0});
  }); } finally { await dropScratchOrg(org.orgId); }
});

test('an allocation cannot use another vendor bill as a withholding base', { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try { await withOrgContext(org.orgId, async () => {
    const f = await fixture(org);
    const wrongParty = randomUUID();
    await db.execute(sql`insert into parties(id,org_id,kind,display_name) values(${wrongParty},${org.orgId},'company','Other vendor')`);
    await db.execute(sql`insert into vendor_roles(org_id,party_id) values(${org.orgId},${wrongParty})`);
    await db.execute(sql`insert into withholding_standings(org_id,party_id,scheme_code,band_code,valid_from,created_by,updated_by) values(${org.orgId},${wrongParty},'GB_CIS','HIGHER','2007-04-06',${f.actor},${f.actor})`);
    await assert.rejects(() => computePaymentWithholdings({orgId:org.orgId,subsidiaryId:org.subsidiaryId,partyId:wrongParty,paymentDate:org.date,currency:'GBP',allocations:[{openLineId:f.openLineId,targetTransactionAmount:'1000'}],discountAmount:'0',paymentDocumentId:null}), /bill does not belong/);
  }); } finally { await dropScratchOrg(org.orgId); }
});

test('separate paying legal entities retain their own vendor verification and refuse ambiguous legacy standings', { skip: !DB }, async () => {
  const org = await createScratchOrg();
  const foreign = await createScratchOrg();
  try { await withOrgContext(org.orgId, async () => {
    const f = await fixture(org);
    const secondEntity = randomUUID();
    await db.execute(sql`insert into subsidiaries(id,org_id,parent_id,name,base_currency,country) values(${secondEntity},${org.orgId},${org.subsidiaryId},'Second paying company','GBP','GB')`);
    await db.execute(sql`insert into withholding_enrollments(org_id,subsidiary_id,scheme_code,contractor_reference,liability_account_id,effective_from,created_by,updated_by) values(${org.orgId},${secondEntity},'GB_CIS','456PA00000000',${org.accounts.withholding},'2007-04-06',${f.actor},${f.actor})`);
    await db.execute(sql`insert into party_subsidiaries(org_id,party_id,subsidiary_id) values(${org.orgId},${org.vendorId},${secondEntity})`);
    const standing = { partyId: org.vendorId, schemeCode: 'GB_CIS', bandCode: 'NET', verificationReference: 'FIRST-PAYER', validFrom: '2007-04-06' };
    const payment = { orgId: org.orgId, subsidiaryId: org.subsidiaryId, partyId: org.vendorId, paymentDate: org.date, currency: 'GBP', allocations: [{ openLineId: f.openLineId, targetTransactionAmount: '1000' }], discountAmount: '0', paymentDocumentId: null };
    await assert.rejects(() => computePaymentWithholdings(payment), (error: unknown) => String((error as { remedy?: string }).remedy).includes('this paying legal entity'));
    await assert.rejects(() => saveWithholdingStanding(db, org.orgId, standing, f.actor), /Select the paying legal entity/);
    await assert.rejects(() => saveWithholdingStanding(db, org.orgId, { ...standing, subsidiaryId: foreign.subsidiaryId }, f.actor), /belong to this organization/);
    await assert.rejects(() => saveWithholdingStanding(db, org.orgId, { ...standing, subsidiaryId: 'FIRST-PAYER' }, f.actor), /legal entity not found/);
    const first = await saveWithholdingStanding(db, org.orgId, { ...standing, subsidiaryId: org.subsidiaryId }, f.actor);
    const firstResult = await computePaymentWithholdings(payment);
    assert.equal(firstResult[0]!.standingId, first.id);
    assert.equal(firstResult[0]!.verificationReference, 'FIRST-PAYER');
    assert.equal(firstResult[0]!.deducted, '200.0000');
    const secondBill = randomUUID();
    await db.execute(sql`insert into documents(id,org_id,kind,status,document_number,subsidiary_id,party_id,document_date,currency,fx_rate,subtotal,tax_total,total,created_by) values(${secondBill},${org.orgId},'vendor_bill','draft',${`BILL-${secondBill}`},${secondEntity},${org.vendorId},${org.date},'GBP','1','1000','0','1000',${f.actor})`);
    await db.execute(sql`insert into document_lines(org_id,document_id,line_number,account_id,quantity,unit_price,amount,tax_amount,withholding_treatment) values(${org.orgId},${secondBill},1,${org.accounts.cogs},'1','1000','1000','0','labour')`);
    await db.execute(sql`update documents set status='approved' where org_id=${org.orgId} and id=${secondBill}`);
    const secondEntry = await postDocument(secondBill, f.deps);
    const secondLine = (await db.execute<{ id: string }>(sql`select id from journal_lines where org_id=${org.orgId} and entry_id=${secondEntry} and account_id=${org.accounts.ap}`)).rows[0]!.id;
    await assert.rejects(() => computePaymentWithholdings({ ...payment, subsidiaryId: secondEntity, allocations: [{ openLineId: secondLine, targetTransactionAmount: '1000' }] }), /no unambiguous paying legal entity/);
    const second = await saveWithholdingStanding(db, org.orgId, { ...standing, subsidiaryId: secondEntity, bandCode: 'HIGHER', verificationReference: 'SECOND-PAYER' }, f.actor);
    const secondResult = await computePaymentWithholdings({ ...payment, subsidiaryId: secondEntity, allocations: [{ openLineId: secondLine, targetTransactionAmount: '1000' }] });
    assert.equal(secondResult[0]!.standingId, second.id);
    assert.equal(secondResult[0]!.verificationReference, 'SECOND-PAYER');
    assert.equal(secondResult[0]!.deducted, '300.0000');
    const views = await listWithholdingStandings(db, org.orgId, org.vendorId);
    assert.equal(views.find(row => row.id === first.id)?.subsidiaryId, org.subsidiaryId);
    assert.equal(views.find(row => row.id === second.id)?.entityName, 'Second paying company');
  }); } finally { await dropScratchOrg(org.orgId); await dropScratchOrg(foreign.orgId); }
});

test('recorded legacy verification can bind to its proven payer but cannot be moved to another legal entity', { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try { await withOrgContext(org.orgId, async () => {
    const f = await fixture(org);
    await db.execute(sql`update documents set status='approved' where org_id=${org.orgId} and id=${f.payment.id}`);
    await postDocument(f.payment.id, f.deps, { deferEffects: true, audit: { actorId: f.actor, source: 'ui' } });
    const standing = { id: f.standingId, partyId: org.vendorId, schemeCode: 'GB_CIS', bandCode: 'NET', verificationReference: 'V1234567890', validFrom: '2007-04-06', payeeReference: '1234567890' };
    await saveWithholdingStanding(db, org.orgId, standing, f.actor);
    assert.equal((await listWithholdingStandings(db, org.orgId, org.vendorId))[0]!.subsidiaryId, org.subsidiaryId);
    const secondEntity = randomUUID();
    await db.execute(sql`insert into subsidiaries(id,org_id,parent_id,name,base_currency,country) values(${secondEntity},${org.orgId},${org.subsidiaryId},'Another paying company','GBP','GB')`);
    await assert.rejects(() => saveWithholdingStanding(db, org.orgId, { ...standing, subsidiaryId: secondEntity }, f.actor), /cannot move to another legal entity/);
    const evidence = (await db.execute<{ subsidiary_id: string; verification_reference: string }>(sql`select subsidiary_id,verification_reference from withholding_deductions where org_id=${org.orgId} and standing_id=${f.standingId}`)).rows[0]!;
    assert.deepEqual(evidence, { subsidiary_id: org.subsidiaryId, verification_reference: 'V1234567890' });
  }); } finally { await dropScratchOrg(org.orgId); }
});


test('disabled withholding and a US vendor flag do not transfer obligations between paying entities', { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try { await withOrgContext(org.orgId, async () => {
    const f = await fixture(org);
    const otherPayer = randomUUID();
    await db.execute(sql`insert into subsidiaries(id,org_id,parent_id,name,base_currency,country) values(${otherPayer},${org.orgId},${org.subsidiaryId},'Canadian payer','CAD','CA')`);
    await db.execute(sql`update vendor_roles set backup_withholding=true where org_id=${org.orgId} and party_id=${org.vendorId}`);
    const payment = { orgId: org.orgId, subsidiaryId: otherPayer, partyId: org.vendorId, paymentDate: org.date, currency: 'CAD', allocations: [{ openLineId: randomUUID(), targetTransactionAmount: '100' }], discountAmount: '0', paymentDocumentId: null };
    assert.deepEqual(await computePaymentWithholdings(payment), []);
    await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features,contractorWithholding}','false'::jsonb) where id=${org.orgId}`);
    assert.deepEqual(await computePaymentWithholdings(payment), []);
    await assert.rejects(() => computePaymentWithholdings({ ...payment, subsidiaryId: org.subsidiaryId, currency: 'GBP', allocations: [{ openLineId: f.openLineId, targetTransactionAmount: '1000' }] }), /active withholding obligation/);
  }); } finally { await dropScratchOrg(org.orgId); }
});
