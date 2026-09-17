import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { registerHooks } from 'node:module';
import test from 'node:test';
registerHooks({ resolve(specifier,context,next) {
  if(specifier === 'server-only')return {shortCircuit:true,url:'data:text/javascript,export {}'};
  return next(specifier,context);
} });
const {sql}=await import('drizzle-orm');
const {db,withBypassContext,withOrgContext}=await import('@openbooks/engine/src/db.ts');
const {createScratchOrg,dropScratchOrgReporting:dropScratchOrg}=await import('@openbooks/engine/src/test-fixtures.ts');
const {postDocument}=await import('@openbooks/engine/src/posting.ts');
const {openItems}=await import('./cash/open-items');
const {agingByParty,agingDetail}=await import('./reports/aging');

/**
 * F-p3-001 / P5.1: the dashboard AP tile and the formal AP aging agree on one
 * basis — an expense report contributes exactly its out-of-pocket open lines.
 * Company-paid legs are never open items; personal debits sit on asset-side
 * accounts outside the AP scope; legacy card-override reports (the live
 * tenant's 8,663-shape) contribute nothing.
 *
 * The fixture deliberately wires the industry-preset shape (employee payable
 * typed liability_current_other, invisible in BOTH surfaces before the fix)
 * and types the employee receivable asset_receivable, so the pre-fix code
 * would surface the personal balance as a document-less AR row.
 */
test('AP tile and AP aging agree: only out-of-pocket expense amounts age', {skip:!process.env.OPENBOOKS_DB_URL}, async()=>{
  const org=await withBypassContext(()=>createScratchOrg());
  try{
    // Seeds run under the bypass boundary (scratch-fixture contract); reads
    // run inside the org context, exactly as the product surfaces do.
    const employeePayable=randomUUID(),employeeReceivable=randomUUID(),cardLiability=randomUUID();
    await withBypassContext(async()=>{
    await db.execute(sql`insert into accounts (id,org_id,number,name,type,is_summary,is_active,eliminate,reconcilable,required_dimensions,custom,subsidiary_include_children) values
      (${employeePayable},${org.orgId},'2110','Employee Reimbursements Payable','liability_current_other',false,true,false,false,'[]'::jsonb,'{}'::jsonb,true),
      (${employeeReceivable},${org.orgId},'1400','Employee Advances','asset_receivable',false,true,false,false,'[]'::jsonb,'{}'::jsonb,true),
      (${cardLiability},${org.orgId},'2050','Corporate Card Clearing','liability_card',false,true,false,false,'[]'::jsonb,'{}'::jsonb,true)`);
    await db.execute(sql`update orgs set settings=jsonb_set(jsonb_set(coalesce(settings,'{}'::jsonb),'{controlAccounts,employeePayable}',to_jsonb(${employeePayable}::text),true),'{controlAccounts,employeeReceivable}',to_jsonb(${employeeReceivable}::text),true) where id=${org.orgId}`);
    const employee=randomUUID();
    await db.execute(sql`insert into parties (id,org_id,kind,display_name,is_active,custom) values (${employee},${org.orgId},'employee','Riley Fieldworker',true,'{}'::jsonb)`);
    await db.execute(sql`insert into employee_roles (id,org_id,party_id) values (${randomUUID()},${org.orgId},${employee})`);
    const card=randomUUID();
    await db.execute(sql`insert into payment_cards (id,org_id,holder_party_id,liability_account_id,label,is_active) values (${card},${org.orgId},${employee},${cardLiability},'Field card',true)`);
    const deps={control:{ar:org.accounts.ar,ap:org.accounts.ap,bank:org.accounts.bank,employeePayable,employeeReceivable}};

    async function post(n:string,lines:{desc:string;amount:string;settlement?:string|null}[],cardId:string|null,override:string|null){
      const id=randomUUID();
      const total=lines.reduce((a,l)=>a+Number(l.amount),0).toFixed(2);
      await db.execute(sql`insert into documents (id,org_id,kind,status,document_number,document_date,party_id,subsidiary_id,currency,subtotal,tax_total,total,payment_card_id,custom)
        values (${id},${org.orgId},'expense_report','draft',${n},${org.date},${employee},${org.subsidiaryId},'CAD',${total},'0',${total},${cardId},${JSON.stringify(override?{controlAccountId:override}:{})}::jsonb)`);
      let i=1;
      for(const l of lines){
        if(l.settlement===undefined){
          await db.execute(sql`insert into document_lines (id,org_id,document_id,line_number,account_id,description,quantity,unit_price,amount,tax_amount)
            values (${randomUUID()},${org.orgId},${id},${i},${org.accounts.cogs},${l.desc},'1',${l.amount},${l.amount},'0')`);
        }else{
          await db.execute(sql`insert into document_lines (id,org_id,document_id,line_number,account_id,description,quantity,unit_price,amount,tax_amount,settlement_type)
            values (${randomUUID()},${org.orgId},${id},${i},${org.accounts.cogs},${l.desc},'1',${l.amount},${l.amount},'0',${l.settlement})`);
        }
        i++;
      }
      await db.execute(sql`update documents set status='approved' where id=${id} and org_id=${org.orgId}`);
      await postDocument(id,deps);
      return id;
    }

    // R1: plain out-of-pocket on the preset payable. R2: legacy card-override
    // (NULL settlement, the tenant's shape). R3: all three settlements at once.
    await post('EXP-READ-1',[{desc:'Mileage',amount:'75.50',settlement:'out_of_pocket'}],null,null);
    await post('EXP-READ-2',[{desc:'Hotel',amount:'400.00'}],null,cardLiability);
    await post('EXP-READ-3',[
      {desc:'Mileage',amount:'100.00',settlement:'out_of_pocket'},
      {desc:'Hotel',amount:'200.00',settlement:'company_paid'},
      {desc:'Minibar',amount:'300.00',settlement:'personal'},
    ],card,null);
    });

    await withBypassContext(()=>withOrgContext(org.orgId,async()=>{
      const tile=await openItems(org.orgId,'ap',org.date);
      const tileTotal=tile.reduce((a,t)=>a+Number(t.remaining),0).toFixed(2);
      assert.equal(tileTotal,'175.50');
      assert.deepEqual(tile.map((t)=>t.docNumber).sort(),['EXP-READ-1','EXP-READ-3']);

      const aging=await agingByParty('ap',org.date,undefined,org.orgId);
      assert.equal(String(aging.totals.total),'175.5000');
      assert.equal(aging.rows.length,1);
      assert.equal(aging.rows[0]!.partyName,'Riley Fieldworker');

      const detail=await agingDetail('ap',org.date,undefined,org.orgId);
      assert.equal(String(detail.totals.total),String(aging.totals.total));
      assert.deepEqual(detail.rows.map((r)=>r.reference).sort(),['EXP-READ-1','EXP-READ-3']);

      // The personal balance ages nowhere: no AP row carries it (shown above
      // by the exact 175.50), and the AR aging must not surface it as a
      // document-less residual row even though the receivable account is
      // asset_receivable-typed.
      const arAging=await agingByParty('ar',org.date,undefined,org.orgId);
      assert.equal(arAging.rows.length,0);
      const arTile=await openItems(org.orgId,'ar',org.date);
      assert.equal(arTile.length,0);
    }));
  }finally{
    await withBypassContext(()=>dropScratchOrg(org.orgId));
  }
});

/**
 * The edit API requires an explicit settlement on every newly written line
 * (0171): NULL is an honest state for pre-migration history, never for a
 * line this API writes. A line without one is a 422, not a silent default.
 */
test('expense lines without an explicit settlement are refused at the edit API', {skip:!process.env.OPENBOOKS_DB_URL}, async()=>{
  const org=await withBypassContext(()=>createScratchOrg());
  try{
    const {prepareExpenseEdit}=await import('./expense-edit');
    const line={accountId:org.accounts.cogs,description:'Mileage',amount:'10.00'};
    await withBypassContext(async()=>{
      await assert.rejects(
        prepareExpenseEdit({lines:[line]}, {orgId:org.orgId,existingCustom:{},existingDocumentDate:org.date}),
        /settlement is required/,
      );
      const ok=await prepareExpenseEdit({lines:[{...line,settlementType:'out_of_pocket'}]}, {orgId:org.orgId,existingCustom:{},existingDocumentDate:org.date});
      assert.equal(ok.preparedLines!.length,1);
      assert.equal(ok.preparedLines![0]!.settlementType,'out_of_pocket');
    });
  }finally{
    await withBypassContext(()=>dropScratchOrg(org.orgId));
  }
});
