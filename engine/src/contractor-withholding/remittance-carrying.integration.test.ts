import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withOrgContext, withOrgTransaction } from "../platform/db.ts";
import { createScratchOrg, createScratchUser, dropScratchOrg, type ScratchOrg } from "../testing/fixtures.ts";
import { loadDocument, loadDocumentEditCurrent } from "../ledger/document-service.ts";
import { applyDocumentEdit } from "../ledger/document-write.ts";
import { submitAndReleaseIfUngated } from "../flows/submit.ts";
import { postDocument } from "../ledger/posting-document.ts";
import { requestDocumentVoid } from "../ledger/document-void.ts";
import { createPaymentDocument, updateDraftPayment } from "../payments/payment-documents.ts";
import { createWithholdingRemittance, fileWithholdingReturn, loadWithholdingReturn, prepareWithholdingReturn } from "./service.ts";
import { createWithholdingDeposit, listWithholdingDeposits } from "./deposits.ts";
import { fromUnits, toUnits } from "../money/money.ts";

const enabled={skip:!process.env.OPENBOOKS_DB_URL};
async function fixture(org:ScratchOrg,deposit=false) {
  const actor=await createScratchUser(org.orgId,"Withholding accountant","admin");
  const enrollment=randomUUID(),authority=randomUUID();
  await db.execute(sql`insert into accounting_periods(org_id,fiscal_year,period_number,name,starts_on,ends_on,is_adjustment,fiscal_calendar_id)
    select ${org.orgId},extract(year from month_start)::integer,extract(month from month_start)::integer,
      to_char(month_start,'YYYY-MM'),month_start::date,(month_start+interval '1 month'-interval '1 day')::date,false,p.fiscal_calendar_id
      from accounting_periods p cross join generate_series('2026-08-01'::date,'2027-12-01'::date,interval '1 month') month_start
     where p.org_id=${org.orgId} and p.id=${org.periodId}`);
  await db.execute(sql`update app_roles set permissions='["ap.pay","documents.manage","admin.setup.manage"]'::jsonb where org_id=${org.orgId} and key='admin'`);
  await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features}',coalesce(settings->'features','{}'::jsonb)||'{"contractorWithholding":true,"multiCurrency":true}'::jsonb) where id=${org.orgId}`);
  await db.execute(sql`insert into parties(id,org_id,kind,display_name) values(${authority},${org.orgId},'company','Tax authority')`);
  await db.execute(sql`insert into vendor_roles(org_id,party_id,backup_withholding) values(${org.orgId},${org.vendorId},${deposit}),(${org.orgId},${authority},false)`);
  const statutoryCurrency=deposit ? 'USD' : 'GBP';
  await db.execute(sql`update subsidiaries set country=${deposit ? 'US' : 'GB'} where org_id=${org.orgId} and id=${org.subsidiaryId}`);
  await db.execute(sql`insert into fx_rates(org_id,from_currency,to_currency,as_of,rate,rate_type,source) values(${org.orgId},'EUR',${statutoryCurrency},${org.date},'0.8','spot','manual'),(${org.orgId},'EUR','CAD',${org.date},'0.96','spot','manual'),(${org.orgId},${statutoryCurrency},'CAD',${org.date},'1.5','spot','manual')`);
  const policy={calendar:{from:'2026-01-01',to:'2027-12-31',closedDates:['2026-04-16','2027-04-16'],sourceReference:'Authority deposit calendar'},lookback:{taxYear:2024,totalTax:'1000',sourceReference:'Filed annual return'}};
  await db.execute(sql`insert into withholding_enrollments(id,org_id,subsidiary_id,scheme_code,contractor_reference,liability_account_id,authority_party_id,effective_from,remittance_schedule_code,remittance_policy,created_by,updated_by)
    values(${enrollment},${org.orgId},${org.subsidiaryId},${deposit ? 'US_BACKUP_WITHHOLDING' : 'GB_CIS'},${deposit ? '12-3456789' : '123PA00000000'},${org.accounts.withholding},${authority},'2018-01-01',${deposit ? 'US_MONTHLY' : null},${deposit ? JSON.stringify(policy) : null}::jsonb,${actor},${actor})`);
  if(!deposit) await db.execute(sql`insert into withholding_standings(org_id,subsidiary_id,party_id,scheme_code,band_code,verification_reference,valid_from,payee_reference,created_by,updated_by) values(${org.orgId},${org.subsidiaryId},${org.vendorId},'GB_CIS','NET','V1234567890','2018-01-01','1234567890',${actor},${actor})`);
  const deps={control:{ar:org.accounts.ar,ap:org.accounts.ap,bank:org.accounts.bank}};
  const post=async(id:string)=>{
    const document=(await loadDocument(id,org.orgId))!;
    if(document.doc.status==='draft') assert.equal((await submitAndReleaseIfUngated(document.doc.kind as string,id,actor)).autoApproved,true);
    return postDocument(id,deps,{audit:{actorId:actor,source:'ui'}});
  };
  const settle=async()=>{
    const amount='625';
    const functionalRate=(await db.execute<{rate:string}>(sql`select rate::text from fx_rates where org_id=${org.orgId} and from_currency='EUR' and to_currency='CAD' and rate_type='spot' order by as_of desc limit 1`)).rows[0]!.rate;
    const bill=randomUUID();
    await db.execute(sql`insert into documents(id,org_id,kind,status,document_number,subsidiary_id,party_id,document_date,currency,fx_rate,subtotal,tax_total,total,created_by) values(${bill},${org.orgId},'vendor_bill','draft',${`BILL-${bill}`},${org.subsidiaryId},${org.vendorId},${org.date},'EUR',${functionalRate},${amount},0,${amount},${actor})`);
    await db.execute(sql`insert into document_lines(org_id,document_id,line_number,account_id,quantity,unit_price,amount,withholding_treatment) values(${org.orgId},${bill},1,${org.accounts.cogs},1,${amount},${amount},'labour')`);
    const entry=await post(bill);
    const openLine=(await db.execute<{id:string}>(sql`select id from journal_lines where org_id=${org.orgId} and entry_id=${entry} and account_id=${org.accounts.ap}`)).rows[0]!.id;
    const payment=await createPaymentDocument({orgId:org.orgId,createdBy:actor,kind:'vendor_payment',partyId:org.vendorId,subsidiaryId:org.subsidiaryId,bankAccountId:org.accounts.bank,documentDate:org.date,currency:'EUR',fxRate:functionalRate,allowedSubsidiaryIds:null});
    await updateDraftPayment(payment.id,{allocations:[{openLineId:openLine,sourceTransactionAmount:amount,targetTransactionAmount:amount,settlementRate:'1',settlementRateSource:'same_currency',settlementRateReference:'Same transaction currency'}]},actor,org.orgId,{allowedSubsidiaryIds:null});
    const paymentEntry=await post(payment.id);
    return {paymentId:payment.id,entry:paymentEntry};
  };
  const initial=await settle();
  const period=(await db.execute<{period:string}>(sql`select period_start::text as period from withholding_deductions where org_id=${org.orgId} and payment_document_id=${initial.paymentId}`)).rows[0]!.period;
  const prepareReturn=()=>withOrgTransaction(org.orgId,()=>prepareWithholdingReturn(db,org.orgId,{enrollmentId:enrollment,periodStart:period},actor));
  const remit=async(reference='AUTH-FILING')=>{
    const prepared=await prepareReturn();
    await withOrgTransaction(org.orgId,()=>fileWithholdingReturn(db,org.orgId,{returnId:prepared.id,filingReference:reference,confirmed:true},actor));
    return withOrgTransaction(org.orgId,()=>createWithholdingRemittance(db,org.orgId,{returnId:prepared.id},actor));
  };
  const reverse=()=>requestDocumentVoid({documentId:initial.paymentId,orgId:org.orgId,actorId:actor,reason:'Correct contractor settlement',reversalDate:org.date,allowedSubsidiaryIds:null});
  const legs=async(entry:string)=>(await db.execute<{accountId:string;amount:string;currency:string;txnAmount:string}>(sql`select account_id as "accountId",amount::text,currency,txn_amount::text as "txnAmount" from journal_lines where org_id=${org.orgId} and entry_id=${entry} order by line_number`)).rows;
  const balance=async(account:string)=>(await db.execute<{amount:string}>(sql`select coalesce(sum(l.amount),0)::text as amount from journal_lines l join journal_entries e on e.org_id=l.org_id and e.id=l.entry_id where l.org_id=${org.orgId} and l.account_id=${account} and e.status in ('posted','reversed')`)).rows[0]!.amount;
  return {actor,enrollment,initial,statutoryCurrency,post,settle,prepareReturn,remit,reverse,legs,balance};
}
async function scenario(run:(org:ScratchOrg,f:Awaited<ReturnType<typeof fixture>>)=>Promise<void>,deposit=false) {
  const org=await createScratchOrg();
  try {await withOrgContext(org.orgId,async()=>run(org,await fixture(org,deposit)));} finally {await dropScratchOrg(org.orgId);}
}
async function saveNativeAuthorityDocument(org: ScratchOrg, actor: string, documentId: string) {
  const before = (await loadDocument(documentId, org.orgId))!;
  const current = (await loadDocumentEditCurrent(documentId, org.orgId))!;
  await applyDocumentEdit(documentId, current, {
    expectedUpdatedAt: current.updatedAt, memo: "Authority source reviewed", internalNotes: "Payment evidence confirmed",
    partyId: before.doc.party_id as string, documentDate: before.doc.document_date as string,
    dueDate: before.doc.due_date as string, subsidiaryId: org.subsidiaryId,
    lines: before.lines.map(line => ({ lineId: line.id as string, accountId: line.account_id as string,
      description: line.description as string, quantity: line.quantity as string, unitPrice: line.unit_price as string,
      amount: line.amount as string, taxCodeId: null, taxGroupId: null, taxAmount: null, taxOverridden: false,
      withholdingTreatment: "excluded", withholdingMaterialsCost: null, custom: {}, extraDims: {} })),
  }, { orgId: org.orgId, userId: actor, source: "ui", runFlows: false });
  const after = (await loadDocument(documentId, org.orgId))!;
  assert.equal(after.doc.memo, "Authority source reviewed");
  assert.deepEqual(after.lines, before.lines);
  assert.deepEqual(after.doc.custom, before.doc.custom);
  const locked = (await loadDocumentEditCurrent(documentId, org.orgId))!;
  await assert.rejects(() => applyDocumentEdit(documentId, locked, {
    expectedUpdatedAt: locked.updatedAt, memo: "Must roll back", partyId: org.vendorId,
  }, { orgId: org.orgId, userId: actor, source: "ui", runFlows: false }), /authority document retains/);
  assert.deepEqual(await loadDocument(documentId, org.orgId), after);
}

const journalRouteStateKey = Symbol.for("openbooks.authority-journal-native-test");
let journalAuthHooks: ReturnType<typeof registerHooks> | undefined;
test.after(() => journalAuthHooks?.deregister());
let nativeJournalRoutes: typeof import("../../../web/app/api/journals/[id]/route.ts") | undefined;
async function saveNativeAuthorityJournal(org: ScratchOrg, actor: string, documentId: string) {
  (globalThis as typeof globalThis & Record<symbol, unknown>)[journalRouteStateKey] = {
    user: { id: actor, orgId: org.orgId }, permissions: new Set(["gl.read", "gl.post"]), allowedSubsidiaryIds: null,
  };
  if (!nativeJournalRoutes) {
    journalAuthHooks = registerHooks({
      resolve(specifier, context, nextResolve) {
        if (specifier === "../../../../lib/authz" || (specifier === "@/lib/authz" && context.parentURL?.includes("/lib/api/route"))) return { url: "mock:authority-journal-authz", shortCircuit: true };
        return nextResolve(specifier, context);
      },
      load(url, context, nextLoad) {
        if (url === "mock:authority-journal-authz") return { format: "module", shortCircuit: true, source: `
          export async function guardPermission(){ return globalThis[Symbol.for('openbooks.authority-journal-native-test')] }
          export function guardSubsidiaryScope(){ return null }
          export function subsidiariesInScope(){ return true }
        ` };
        return nextLoad(url, context);
      },
    });
    nativeJournalRoutes = await import("../../../web/app/api/journals/[id]/route.ts");
  }
  const context = { params: Promise.resolve({ id: documentId }) };
  const get = async () => {
    const response = await nativeJournalRoutes!.GET(new Request(`http://localhost/api/journals/${documentId}`), context);
    assert.equal(response.status, 200);
    return await response.json() as { doc: Record<string, unknown>; lines: Record<string, unknown>[] };
  };
  const before = await get();
  const body = { expectedUpdatedAt: before.doc.updated_at, partyId: before.doc.party_id,
    documentDate: before.doc.document_date, referenceNumber: "Authority source reviewed", memo: "Reviewed functional correction",
    subsidiaryId: org.subsidiaryId, extraDims: {}, custom: {},
    lines: before.lines.map(line => ({ accountId: line.account_id, description: line.description, amount: line.amount,
      partyId: line.party_id, departmentId: line.department_id, projectId: line.project_id,
      subsidiaryId: line.subsidiary_id, extraDims: line.extra_dims, custom: line.custom })),
  };
  const patch = (payload: unknown) => nativeJournalRoutes!.PATCH(new Request(`http://localhost/api/journals/${documentId}`, {
    method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
  }), context);
  const saved = await patch(body);
  assert.equal(saved.status, 200, await saved.clone().text());
  const after = await get();
  assert.deepEqual(after.lines, before.lines);
  assert.deepEqual(after.doc.custom, before.doc.custom);
  assert.equal(after.doc.total, before.doc.total);
  const storedHeader = (await db.execute<{ total: string }>(sql`select total::text from documents where org_id=${org.orgId} and id=${documentId}`)).rows[0]!;
  assert.equal(storedHeader.total, before.doc.total);
  assert.equal(after.doc.memo, "Reviewed functional correction");
  const sourceKey = Object.hasOwn(before.doc.custom as object, "withholdingDeposit") ? "withholdingDeposit" : "withholdingRemittance";
  for (const changed of [
    { documentDate: "2026-01-01" }, { partyId: org.vendorId },
    { lines: body.lines.map((line,index) => index === 1 ? { ...line, accountId: org.accounts.cogs } : line) },
    { lines: body.lines.map((line,index) => ({ ...line, amount: index === 0 ? "1" : "-1" })) },
    { custom: { [sourceKey]: null } }, { extraDims: { source: "changed" } },
  ]) {
    const response = await patch({ ...body, expectedUpdatedAt: after.doc.updated_at, memo: "Must roll back", ...changed });
    assert.equal(response.status, 422, await response.clone().text());
    assert.deepEqual(await get(), after);
  }
}

const accountTotal=(rows:{accountId:string;amount:string}[],account:string)=>fromUnits(rows.filter(row=>row.accountId===account).reduce((total,row)=>total+toUnits(row.amount),0n));

test('authority remittance clears the original CAD carrying amount and recognizes the changed statutory quote',enabled,async()=>scenario(async(org,f)=>{
  const original=(await f.legs(f.initial.entry)).find(row=>row.accountId===org.accounts.withholding)!;
  assert.deepEqual([original.amount,original.currency,original.txnAmount],['-120.0000','GBP','-100.0000']);
  const remittance=await f.remit();
  assert.equal(remittance.kind,'vendor_bill');
  await saveNativeAuthorityDocument(org,f.actor,remittance.documentId);
  const entry=await f.post(remittance.documentId),rows=await f.legs(entry);
  assert.equal(accountTotal(rows,org.accounts.withholding),'120.0000');
  assert.equal(accountTotal(rows,org.accounts.ap),'-150.0000');
  assert.equal(accountTotal(rows,org.accounts.fxGainLoss),'30.0000');
  assert.equal(await f.balance(org.accounts.withholding),'0.0000');
  assert.equal(fromUnits(rows.reduce((sum,row)=>sum+toUnits(row.amount),0n)),'0.0000');
  const foreign=(await db.execute<{currency:string;amount:string}>(sql`select l.currency,sum(l.txn_amount)::text as amount from journal_lines l join journal_entries e on e.org_id=l.org_id and e.id=l.entry_id where l.org_id=${org.orgId} and l.account_id=${org.accounts.withholding} and e.status='posted' group by l.currency`)).rows;
  assert.ok(foreign.every(row=>toUnits(row.amount)===0n));
  await assert.rejects(()=>f.post(remittance.documentId),/already posted/);
}));

test('a missing realized FX account refuses atomically and leaves the authority draft and source deduction intact',enabled,async()=>scenario(async(org,f)=>{
  const remittance=await f.remit();
  await db.execute(sql`update orgs set settings=settings #- '{controlAccounts,fxRealizedGainLoss}' where id=${org.orgId}`);
  await assert.rejects(()=>f.post(remittance.documentId),/realized FX gain\/loss account.*Configure/i);
  const state=(await db.execute<{status:string;entry:string|null;count:number}>(sql`select status,posted_entry_id as entry,(select count(*)::int from journal_entries where org_id=d.org_id and source_document_id=d.id) as count from documents d where org_id=${org.orgId} and id=${remittance.documentId}`)).rows[0];
  assert.deepEqual(state,{status:'approved',entry:null,count:0});
  assert.equal(await f.balance(org.accounts.withholding),'-120.0000');
  assert.equal((await db.execute(sql`select 1 from withholding_deductions where org_id=${org.orgId} and payment_document_id=${f.initial.paymentId} and status='posted'`)).rows.length,1);
}));

test('a revised negative remittance credits the previous posted carrying amount rather than its current statutory quote',enabled,async()=>scenario(async(org,f)=>{
  const first=await f.remit();await f.post(first.documentId);
  await f.reverse();
  const credit=await f.remit('AUTH-AMENDMENT');
  assert.equal(credit.kind,'vendor_credit');
  await saveNativeAuthorityDocument(org,f.actor,credit.documentId);
  const rows=await f.legs(await f.post(credit.documentId));
  assert.equal(accountTotal(rows,org.accounts.withholding),'-120.0000');
  assert.equal(accountTotal(rows,org.accounts.ap),'150.0000');
  assert.equal(accountTotal(rows,org.accounts.fxGainLoss),'-30.0000');
  assert.equal(await f.balance(org.accounts.withholding),'0.0000');
}));

test('equal statutory figures with replacement payment evidence require review and generate only the functional correction journal',enabled,async()=>scenario(async(org,f)=>{
  const first=await f.remit();await f.post(first.documentId);await f.reverse();
  await db.execute(sql`update fx_rates set rate='1.2' where org_id=${org.orgId} and from_currency='EUR' and to_currency='CAD'`);
  const replacement=await f.settle();
  const prepared=await f.prepareReturn();
  assert.equal(prepared.revision,2);assert.equal(prepared.unchanged,false);
  const ret=await loadWithholdingReturn(db,org.orgId,prepared.id);
  assert.equal(ret.sourceOnlyRevision,true);assert.equal(ret.priorFilingReference,'AUTH-FILING');
  await assert.rejects(()=>withOrgTransaction(org.orgId,()=>fileWithholdingReturn(db,org.orgId,{returnId:prepared.id,filingReference:'AUTH-FILING'},f.actor)),/source correction was reviewed/);
  await withOrgTransaction(org.orgId,()=>fileWithholdingReturn(db,org.orgId,{returnId:prepared.id,filingReference:'',confirmed:true},f.actor));
  const correction=await withOrgTransaction(org.orgId,()=>createWithholdingRemittance(db,org.orgId,{returnId:prepared.id},f.actor));
  assert.equal(correction.kind,'journal');
  await saveNativeAuthorityJournal(org,f.actor,correction.documentId);
  const rows=await f.legs(await f.post(correction.documentId));
  assert.equal(accountTotal(rows,org.accounts.withholding),'30.0000');
  assert.equal(accountTotal(rows,org.accounts.fxGainLoss),'-30.0000');
  assert.equal(rows.some(row=>row.accountId===org.accounts.ap),false);
  assert.equal(await f.balance(org.accounts.withholding),'0.0000');
  assert.equal((await f.legs(replacement.entry)).find(row=>row.accountId===org.accounts.withholding)!.amount,'-150.0000');
}));

test('deposit corrections credit a reversed settled source and release the complete native correction through governed void',enabled,async()=>scenario(async(org,f)=>{
  const first=await withOrgTransaction(org.orgId,()=>createWithholdingDeposit(db,org.orgId,{enrollmentId:f.enrollment,throughDate:org.date},f.actor));
  const initialRows=await f.legs(f.initial.entry);
  assert.equal(accountTotal(initialRows,org.accounts.withholding),'-144.0000');
  await f.post(first.documentId);await f.reverse();
  assert.equal((await listWithholdingDeposits(db,org.orgId,f.enrollment))[0]!.sourceChanged,true);
  await assert.rejects(()=>withOrgTransaction(org.orgId,()=>createWithholdingDeposit(db,org.orgId,{enrollmentId:f.enrollment,throughDate:org.date},f.actor)),/changed source payments/);
  const credit=await withOrgTransaction(org.orgId,()=>createWithholdingDeposit(db,org.orgId,{enrollmentId:f.enrollment,throughDate:org.date,amendsDocumentId:first.documentId},f.actor));
  assert.equal(credit.kind,'vendor_credit');
  await saveNativeAuthorityDocument(org,f.actor,credit.documentId);
  const rows=await f.legs(await f.post(credit.documentId));
  assert.equal(accountTotal(rows,org.accounts.withholding),'-144.0000');
  assert.equal(accountTotal(rows,org.accounts.ap),'180.0000');
  assert.equal(accountTotal(rows,org.accounts.fxGainLoss),'-36.0000');
  assert.equal(await f.balance(org.accounts.withholding),'0.0000');
  const voided=await requestDocumentVoid({documentId:credit.documentId,orgId:org.orgId,actorId:f.actor,reason:'Replace deposit correction',reversalDate:org.date,allowedSubsidiaryIds:null});
  assert.equal(voided.status,'voided');
  const reversalRows=await f.legs(voided.reversalEntryId!);
  assert.equal(accountTotal(reversalRows,org.accounts.withholding),'144.0000');
  assert.equal(accountTotal(reversalRows,org.accounts.fxGainLoss),'36.0000');
},true));

test('a replaced deposit source at unchanged statutory tax clears through a reviewable journal without another authority payable',enabled,async()=>scenario(async(org,f)=>{
  const first=await withOrgTransaction(org.orgId,()=>createWithholdingDeposit(db,org.orgId,{enrollmentId:f.enrollment,throughDate:org.date},f.actor));
  await f.post(first.documentId);await f.reverse();
  await db.execute(sql`update fx_rates set rate='1.2' where org_id=${org.orgId} and from_currency='EUR' and to_currency='CAD'`);
  await f.settle();
  const correction=await withOrgTransaction(org.orgId,()=>createWithholdingDeposit(db,org.orgId,{enrollmentId:f.enrollment,throughDate:org.date,amendsDocumentId:first.documentId},f.actor));
  assert.equal(correction.kind,'journal');
  await saveNativeAuthorityJournal(org,f.actor,correction.documentId);
  const rows=await f.legs(await f.post(correction.documentId));
  assert.equal(accountTotal(rows,org.accounts.withholding),'36.0000');
  assert.equal(accountTotal(rows,org.accounts.fxGainLoss),'-36.0000');
  assert.equal(rows.some(row=>row.accountId===org.accounts.ap),false);
  assert.equal(await f.balance(org.accounts.withholding),'0.0000');
  const listed=await listWithholdingDeposits(db,org.orgId,f.enrollment);
  assert.ok(listed.every(row=>row.sourceChanged===false));
  await assert.rejects(()=>withOrgTransaction(org.orgId,()=>createWithholdingDeposit(db,org.orgId,{enrollmentId:f.enrollment,throughDate:org.date,amendsDocumentId:correction.documentId},f.actor)),/No statutory or functional/);
  await assert.rejects(()=>requestDocumentVoid({documentId:first.documentId,orgId:org.orgId,actorId:f.actor,reason:'Reverse earlier deposit',reversalDate:org.date,allowedSubsidiaryIds:null}),/carries this document's posted liability movement/);
},true));
