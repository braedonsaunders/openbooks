import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { registerHooks } from 'node:module';
import test from 'node:test';

registerHooks({ resolve(specifier, context, next) {
  if (specifier === '../money-server' && context.parentURL?.includes('/analytics/')) {
    return { shortCircuit: true, url: 'data:text/javascript,export async function getMoneyFormatter(){return {money:String,moneyCompact:String}}' };
  }
  return next(specifier, context);
} });
const { sql } = await import('drizzle-orm');
const { db, withOrgContext, withBypassContext, withBypass } = await import('@openbooks/engine/src/platform/db.ts');
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts');
const { vendorData } = await import('./analytics/vendor-data');
const { spendVelocityData } = await import('./analytics/spend-velocity-data');
const { customerData, customerProfitability } = await import('./analytics/customer-data');

for (const view of ['vendor total', 'vendor months', 'spend accounts', 'spend vendors', 'spend revenue', 'spend categories', 'spend comparison', 'customer profitability'] as const) {
  for (const scenario of ['posted control', 'secondary book', 'draft entries', 'reversed history'] as const) {
    test(`Analytics ledger ${view}: ${scenario}`, { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
      const org = await withBypassContext(() => createScratchOrg());
      try {
        await withBypassContext(async () => {
          const project = randomUUID();
          const taxBook = randomUUID();
          await db.execute(sql`insert into projects(id,org_id,subsidiary_id,code,name,customer_id,status,is_active)
            values (${project},${org.orgId},${org.subsidiaryId},'LEDGER','Ledger project',${org.customerId},'active',true)`);
          await db.execute(sql`insert into accounting_books(id,org_id,code,name,is_primary,is_active,posts_gl)
            values (${taxBook},${org.orgId},'TAX','Tax',false,true,true)`);
          // Vendor bills post against a party holding a vendor role: vendor
          // spend counts only vendor-role parties.
          await db.execute(sql`insert into vendor_roles (id, org_id, party_id) values (${randomUUID()}, ${org.orgId}, ${org.vendorId})`);
          async function ledger(book: string, status: 'posted' | 'draft' | 'reversed', cost: string, revenue: string) {
            const entry = randomUUID();
            const document = randomUUID();
            await db.execute(sql`insert into documents(id,org_id,kind,document_number,document_date,posting_date,party_id,subsidiary_id,currency)
              values (${document},${org.orgId},'vendor_bill',${document},${org.date},${org.date},${org.vendorId},${org.subsidiaryId},'CAD')`);
            await db.execute(sql`insert into journal_entries(id,org_id,book_id,subsidiary_id,entry_number,posting_date,period_id,status,origin,source_document_id)
              values (${entry},${org.orgId},${book},${org.subsidiaryId},${entry},${org.date},${org.periodId},'draft','manual',${document})`);
            await db.execute(sql`insert into journal_lines(org_id,entry_id,line_number,account_id,subsidiary_id,project_id,party_id,amount,currency,txn_amount,fx_rate)
              values (${org.orgId},${entry},1,${org.accounts.cogs},${org.subsidiaryId},${project},${org.vendorId},${cost},'CAD',${cost},1),
              (${org.orgId},${entry},2,${org.accounts.bank},${org.subsidiaryId},${project},${org.vendorId},-${cost}::numeric,'CAD',-${cost}::numeric,1),
              (${org.orgId},${entry},3,${org.accounts.revenue},${org.subsidiaryId},${project},${org.customerId},-${revenue}::numeric,'CAD',-${revenue}::numeric,1),
              (${org.orgId},${entry},4,${org.accounts.bank},${org.subsidiaryId},${project},${org.customerId},${revenue},'CAD',${revenue},1)`);
            if (status !== 'draft') {
              await db.execute(sql`update journal_entries set status='posted',posted_at=now() where id=${entry}`);
              await db.execute(sql`update documents set status='posted',posted_entry_id=${entry},posting_period_id=${org.periodId} where id=${document}`);
            }
            if (status === 'reversed') {
              // Finding 5.2: posted→reversed needs a posted same-book mirror;
              // the mirror doubles as this scenario's offsetting entry.
              const mirror = randomUUID();
              await db.execute(sql`insert into journal_entries(id,org_id,book_id,subsidiary_id,entry_number,posting_date,period_id,status,origin,source_document_id,reverses_entry_id)
                values (${mirror},${org.orgId},${book},${org.subsidiaryId},${mirror},${org.date},${org.periodId},'draft','manual',
                  (select source_document_id from journal_entries where id=${entry} and org_id=${org.orgId}),${entry})`);
              await db.execute(sql`insert into journal_lines(org_id,entry_id,line_number,account_id,subsidiary_id,project_id,party_id,amount,currency,txn_amount,fx_rate)
                select ${org.orgId},${mirror},line_number,account_id,subsidiary_id,project_id,party_id,-amount,currency,-txn_amount,fx_rate
                  from journal_lines where entry_id=${entry} and org_id=${org.orgId} order by line_number`);
              await db.execute(sql`update journal_entries set status='posted',posted_at=now() where id=${mirror}`);
              await db.execute(sql`update journal_entries set status='reversed' where id=${entry}`);
            }
          }
          await ledger(org.bookId, 'posted', '100', '200');
          if (scenario === 'secondary book') await ledger(taxBook, 'posted', '700', '1400');
          if (scenario === 'draft entries') await ledger(org.bookId, 'draft', '900', '1800');
          if (scenario === 'reversed history') {
            await ledger(org.bookId, 'reversed', '300', '600');
          }
        });
        await withOrgContext(org.orgId, async () => {
          const period = { from: '2026-07-01', to: '2026-07-31', label: 'Ledger review' };
          if (view === 'vendor total' || view === 'vendor months') {
            const data = await vendorData(period, org.orgId, null);
            if (view === 'vendor total') assert.equal(data.totals.spend, '100.0000');
            else assert.equal(data.monthly.find(row => row.month === '2026-07')?.spend, '100.0000');
          } else if (view === 'customer profitability') {
            const loader = await customerData(period, org.orgId, null);
            const data = await customerProfitability(period, org.orgId, null, undefined, loader.kpis.totalRevenue);
            assert.equal(data.summary.totalRevenue, '200.0000');
            assert.equal(data.summary.totalCost, '100.0000');
            assert.equal(data.summary.totalGrossProfit, '100.0000');
          } else {
            const data = await spendVelocityData(org.orgId, period, null);
            if (view === 'spend accounts') assert.equal(data.summary.totalSpend, '100.0000');
            if (view === 'spend vendors') assert.equal(data.vendorVelocity.find(row => row.id === org.vendorId)?.totalSpend, '100.0000');
            if (view === 'spend revenue') assert.equal(data.revenue.totalRevenue, '200.0000');
            if (view === 'spend categories') assert.equal(data.expenseAnalysis.categories.find(row => row.categoryId === org.accounts.cogs)?.currentAmount, '100.0000');
            if (view === 'spend comparison') assert.equal(data.periodComparison.summary.currentTotal, '100.0000');
          }
        });
      } finally { await dropScratchOrg(org.orgId); }
    });
  }
}

const commitmentCases = [{ label: "analytics-commitment", register: async () => {

for (const scenario of ['empty', 'balanced', 'excess purchases'] as const) {
  test(`Single-month commitment summary: ${scenario}`, { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
    const org = await withBypassContext(() => createScratchOrg());
    try {
      await withBypassContext(async () => {
       if (scenario !== 'empty') {
        for (const kind of ['purchase_order', 'sales_order']) {
          const id = randomUUID();
          const total: '250' | '100' = scenario === 'excess purchases' && kind === 'purchase_order' ? '250' : '100';
          const inserted: { rows: { id: string }[] } = await db.execute<{ id: string }>(sql`insert into documents(id,org_id,kind,document_number,document_date,posting_date,party_id,subsidiary_id,currency,subtotal,tax_total,total)
            values (${id},${org.orgId},${kind},${id},${org.date},${org.date},${kind === 'purchase_order' ? org.vendorId : org.customerId},${org.subsidiaryId},'CAD',${total},0,${total}) returning id`);
          assert.deepEqual(inserted.rows.map(row => row.id), [id], `${scenario}: ${kind} commitment fixture is stored`);
        }
       }
      });
      await withOrgContext(org.orgId, async () => {
        const data = await spendVelocityData(org.orgId, { from: '2026-07-01', to: '2026-07-31', label: 'Commitment review' }, null);
        const { summary } = data.commitmentCliff;
        assert.equal(summary.totalPO, scenario === 'empty' ? '0.0000' : scenario === 'excess purchases' ? '250.0000' : '100.0000');
        assert.equal(summary.totalSO, scenario === 'empty' ? '0.0000' : '100.0000');
        assert.equal(summary.ratio, scenario === 'empty' ? 0 : scenario === 'excess purchases' ? 2.5 : 1);
        assert.equal(summary.status, scenario === 'excess purchases' ? 'critical' : 'healthy');
        // A single commitment month is no measurable velocity: null, never a
        // fabricated 0.
        assert.equal(summary.poVelocity, null);
        assert.equal(summary.soVelocity, null);
        assert.equal(summary.monthsToCliff, null);
      });
    } finally { await dropScratchOrg(org.orgId); }
  });
}
}}] as const; for (const row of commitmentCases) await row.register();

const paymentScopeCases = [{ label: "analytics-payment-scope", register: async () => {
const {customerData} = await import('./analytics/customer-data');
const {vendorData} = await import('./analytics/vendor-data');
for (const side of ['ar','ap'] as const) {
  for (const mode of ['all','restricted','empty'] as const) {
    test(`Analytics payment-history subsidiary scope ${side}: ${mode}`, {skip:!process.env.OPENBOOKS_DB_URL},async()=>{
      const org=await withBypass(()=>createScratchOrg());
      try {
        const actor=await withBypass(()=>createScratchUser(org.orgId,'History writer','admin'));
        await withBypass(async()=>{
          const hidden=randomUUID();const party=side === 'ar' ? org.customerId : org.vendorId;
          // Payment timeliness counts only vendor-role parties on the AP side.
          await db.execute(sql`insert into vendor_roles(id,org_id,party_id) values (${randomUUID()},${org.orgId},${org.vendorId})`);
          const account=side === 'ar' ? org.accounts.ar : org.accounts.ap;
          await db.execute(sql`insert into subsidiaries(id,org_id,parent_id,name,base_currency,country) values (${hidden},${org.orgId},${org.subsidiaryId},'Hidden','CAD','CA')`);
          for(const [sub,paidOn] of [[org.subsidiaryId,'2026-07-06'],[hidden,'2026-07-21']]) {
            const invoiceLine=randomUUID();const paymentLine=randomUUID();
            for(const [payment,line,date] of [[false,invoiceLine,'2026-07-01'],[true,paymentLine,paidOn]] as const) {
              const entry=randomUUID();const document=payment ? null : randomUUID();
              if(document) await db.execute(sql`insert into documents(id,org_id,kind,document_number,document_date,posting_date,due_date,party_id,subsidiary_id,currency,subtotal,tax_total,total) values (${document},${org.orgId},${side === 'ar' ? 'customer_invoice' : 'vendor_bill'},${document},${date},${date},${date},${party},${sub},'CAD',1,0,1)`);
              const debit=side === 'ar' ? !payment : payment;
              const amount=debit ? '1' : '-1';const opposite=debit ? '-1' : '1';
              await db.execute(sql`insert into journal_entries(id,org_id,book_id,subsidiary_id,entry_number,posting_date,period_id,status,origin,source_document_id) values (${entry},${org.orgId},${org.bookId},${sub},${entry},${date},${org.periodId},'draft','manual',${document})`);
              await db.execute(sql`insert into journal_lines(id,org_id,entry_id,line_number,account_id,subsidiary_id,party_id,is_open_item,amount,currency,txn_amount,fx_rate)
                values (${line},${org.orgId},${entry},1,${account},${sub},${party},true,${amount},'CAD',${amount},1),
                  (${randomUUID()},${org.orgId},${entry},2,${payment ? org.accounts.bank : side === 'ar' ? org.accounts.revenue : org.accounts.cogs},${sub},${party},false,${opposite},'CAD',${opposite},1)`);
              await db.execute(sql`update journal_entries set status='posted',posted_at=now() where id=${entry}`);
              if(document) await db.execute(sql`update documents set status='posted',posted_entry_id=${entry},posting_period_id=${org.periodId} where id=${document}`);
            }
            await db.execute(sql`insert into applications(org_id,from_line_id,to_line_id,amount,source_amount,source_transaction_amount,source_transaction_currency,target_transaction_amount,target_transaction_currency,settlement_rate,settlement_rate_source,settlement_rate_reference,applied_on,created_by,updated_by)
              values (${org.orgId},${paymentLine},${invoiceLine},1,1,1,'CAD',1,'CAD',1,'same_currency','History scope regression',${paidOn},${actor},${actor})`);
          }
        });
        await withOrgContext(org.orgId,async()=>{
          const allowed=mode === 'all' ? null : new Set(mode === 'empty' ? [] : [org.subsidiaryId]);
          const period={from:'2026-07-01',to:'2026-07-31',label:'Payment scope'};
          const data=side === 'ar' ? await customerData(period,org.orgId,allowed) : await vendorData(period,org.orgId,allowed);
          assert.equal(data.rows.length,mode === 'empty' ? 0 : 1);
          if(mode !== 'empty')assert.equal(data.rows[0]?.avgDaysToPay,mode === 'all' ? side === 'ar' ? 13 : 12.5 : 5);

        });
      } finally {await withBypass(()=>dropScratchOrg(org.orgId));}
    });
  }
}
}}] as const; for (const row of paymentScopeCases) await row.register();

const spenderCases = [{ label: "spender-ledger", register: async () => {
const {sql}=await import('drizzle-orm');
const {spendVelocityData}=await import('./analytics/spend-velocity-data');

for(const scenario of ['posted control','draft report','foreign currency','secondary projection'] as const){
  test(`Employee spend reconciles to the ledger: ${scenario}`,{skip:!process.env.OPENBOOKS_DB_URL},async()=>{
    const org=await withBypassContext(()=>createScratchOrg());
    try{
      const employee=randomUUID(),document=randomUUID(),taxBook=randomUUID();
      const currency=scenario === 'foreign currency' ? 'USD' : 'CAD';
      const base=scenario === 'foreign currency' ? '200' : '100';
      const fx=scenario === 'foreign currency' ? '2' : '1';
      await withBypassContext(async()=>{
      await db.execute(sql`insert into parties(id,org_id,kind,display_name,subsidiary_id) values (${employee},${org.orgId},'person','Employee',${org.subsidiaryId})`);
      await db.execute(sql`insert into documents(id,org_id,kind,document_number,document_date,posting_date,party_id,subsidiary_id,currency,fx_rate,subtotal,tax_total,total)
        values (${document},${org.orgId},'expense_report',${document},${org.date},${org.date},${employee},${org.subsidiaryId},${currency},${fx},100,0,100)`);
      async function post(book:string,amount:string,rate:string){
        const entry=randomUUID();
        await db.execute(sql`insert into journal_entries(id,org_id,book_id,subsidiary_id,entry_number,posting_date,period_id,status,origin,source_document_id)
          values (${entry},${org.orgId},${book},${org.subsidiaryId},${entry},${org.date},${org.periodId},'draft','manual',${document})`);
        await db.execute(sql`insert into journal_lines(org_id,entry_id,line_number,account_id,subsidiary_id,party_id,amount,currency,txn_amount,fx_rate)
          values (${org.orgId},${entry},1,${org.accounts.cogs},${org.subsidiaryId},${employee},${amount},${currency},100,${rate}),
          (${org.orgId},${entry},2,${org.accounts.bank},${org.subsidiaryId},${employee},-${amount}::numeric,${currency},-100,${rate})`);
        const posted=await db.execute<{id:string}>(sql`update journal_entries set status='posted',posted_at=now() where id=${entry} returning id`);
        assert.deepEqual(posted.rows.map(row=>row.id),[entry],`${scenario}: employee spend journal is posted`);
        return entry;
      }
      const entry=await post(org.bookId,base,fx);
      const postedDocument=await db.execute<{id:string}>(sql`update documents set status='posted',posted_entry_id=${entry},posting_period_id=${org.periodId} where id=${document} returning id`);
      assert.deepEqual(postedDocument.rows.map(row=>row.id),[document],`${scenario}: employee expense document is posted`);
      if(scenario === 'draft report'){
        const draft=randomUUID();
        await db.execute(sql`insert into documents(id,org_id,kind,document_number,document_date,posting_date,party_id,subsidiary_id,currency,subtotal,tax_total,total)
          values (${draft},${org.orgId},'expense_report',${draft},${org.date},${org.date},${employee},${org.subsidiaryId},'CAD',900,0,900)`);
      }
      if(scenario === 'secondary projection'){
        await db.execute(sql`insert into accounting_books(id,org_id,code,name,is_primary,is_active,posts_gl) values (${taxBook},${org.orgId},'TAX','Tax',false,true,true)`);
        await post(taxBook,'700','7');
      }
      });
      await withOrgContext(org.orgId,async()=>{
        const data=await spendVelocityData(org.orgId,{from:'2026-07-01',to:'2026-07-31',label:'Spend review'},null);
        assert.equal(data.summary.expensesTotal,`${base}.0000`,'primary ledger control');
        const spender=data.expenseAnalysis.topSpenders.find(row=>row.employeeId === employee);assert.ok(spender);
        assert.equal(spender.totalSpend,`${base}.0000`);
        assert.equal(spender.reportCount,1);
      });
    }finally{await dropScratchOrg(org.orgId);}
  });
}
}}] as const; for (const row of spenderCases) await row.register();

const vendorSettlementCases = [{ label: "vendor-settlement", register: async () => {
const {sql}=await import('drizzle-orm');
const {vendorData}=await import('./analytics/vendor-data');
for(const scenario of ['in-period payment','early payment','partial payment','future payment','future application','secondary-book payment'] as const){
  test(`Vendor settlement metrics: ${scenario}`,{skip:!process.env.OPENBOOKS_DB_URL},async()=>{
    const org=await withBypassContext(()=>createScratchOrg());
    try{
      await withBypassContext(async()=>{
      const actor=await createScratchUser(org.orgId,'Payment writer','admin');
      const invoice=randomUUID(),taxBook=randomUUID();
      // Settlement timeliness counts only vendor-role parties.
      await db.execute(sql`insert into vendor_roles(id,org_id,party_id) values (${randomUUID()},${org.orgId},${org.vendorId})`);
      await db.execute(sql`insert into accounting_books(id,org_id,code,name,is_primary,is_active,posts_gl) values (${taxBook},${org.orgId},'TAX','Tax',false,true,true)`);
      await db.execute(sql`insert into documents(id,org_id,kind,document_number,document_date,posting_date,due_date,party_id,subsidiary_id,currency,subtotal,tax_total,total)
        values (${invoice},${org.orgId},'vendor_bill',${invoice},'2026-07-01','2026-07-01','2026-07-10',${org.vendorId},${org.subsidiaryId},'CAD',100,0,100)`);
      async function entry(book:string,payment:boolean,date:string){
        const id=randomUUID(),line=randomUUID();
        const amount=payment ? scenario === 'partial payment' ? '40' : '100' : '-100';
        await db.execute(sql`insert into journal_entries(id,org_id,book_id,subsidiary_id,entry_number,posting_date,period_id,status,origin,source_document_id)
          values (${id},${org.orgId},${book},${org.subsidiaryId},${id},${date},${org.periodId},'draft','manual',${payment ? null : invoice})`);
        await db.execute(sql`insert into journal_lines(id,org_id,entry_id,line_number,account_id,subsidiary_id,party_id,is_open_item,due_date,amount,currency,txn_amount,fx_rate)
          values (${line},${org.orgId},${id},1,${org.accounts.ap},${org.subsidiaryId},${org.vendorId},true,'2026-07-10',${amount},'CAD',${amount},1),
          (${randomUUID()},${org.orgId},${id},2,${payment ? org.accounts.bank : org.accounts.cogs},${org.subsidiaryId},${org.vendorId},false,null,-${amount}::numeric,'CAD',-${amount}::numeric,1)`);
        const posted=await db.execute<{id:string}>(sql`update journal_entries set status='posted',posted_at=now() where id=${id} returning id`);
        assert.deepEqual(posted.rows.map(row=>row.id),[id],`${scenario}: vendor settlement journal is posted`);
        return {id,line};
      }
      const original=await entry(org.bookId,false,'2026-07-01');
      const postedInvoice=await db.execute<{id:string}>(sql`update documents set status='posted',posted_entry_id=${original.id},posting_period_id=${org.periodId} where id=${invoice} returning id`);
      assert.deepEqual(postedInvoice.rows.map(row=>row.id),[invoice],`${scenario}: vendor bill is posted`);
      const book=scenario === 'secondary-book payment' ? taxBook : org.bookId;
      const target=scenario === 'secondary-book payment' ? await entry(book,false,'2026-07-01') : original;
      const paidOn=scenario === 'future payment' ? '2026-07-21' : scenario === 'early payment' ? '2026-07-06' : '2026-07-12';
      const appliedOn=scenario === 'future application' ? '2026-07-21' : paidOn;
      const payment=await entry(book,true,paidOn);
      await db.execute(sql`insert into applications(org_id,from_line_id,to_line_id,amount,source_amount,source_transaction_amount,source_transaction_currency,target_transaction_amount,target_transaction_currency,settlement_rate,settlement_rate_source,settlement_rate_reference,applied_on,created_by,updated_by)
        values (${org.orgId},${payment.line},${target.line},${scenario === 'partial payment' ? '40' : '100'},${scenario === 'partial payment' ? '40' : '100'},${scenario === 'partial payment' ? '40' : '100'},'CAD',${scenario === 'partial payment' ? '40' : '100'},'CAD',1,'same_currency','Payment cutoff review',${appliedOn},${actor},${actor})`);
      });
      await withOrgContext(org.orgId,async()=>{
        const data=await vendorData({from:'2026-07-01',to:'2026-07-15',label:'Cutoff review'},org.orgId,null);
        const row=data.rows.find(row=>row.id === org.vendorId);assert.ok(row);
        const paid=scenario === 'in-period payment' || scenario === 'early payment';
        assert.equal(row.paidBills,paid ? 1 : 0);
        assert.equal(row.avgDaysToPay,paid ? scenario === 'early payment' ? 5 : 11 : null);
        assert.equal(row.onTimePct,paid ? scenario === 'early payment' ? 1 : 0 : null);
        // Settled late spend is canonical money; with nothing settled in the
        // window the row keeps the loader's "0" seed, as elsewhere.
        assert.equal(row.lateSpend,scenario === 'in-period payment' ? '100.0000' : scenario === 'partial payment' ? '40.0000' : scenario === 'early payment' ? '0.0000' : '0');
      });
    }finally{await dropScratchOrg(org.orgId);}
  });
}
}}] as const; for (const row of vendorSettlementCases) await row.register();

const customerCutoffCases = [{ label: "customer-payment-cutoff", register: async () => {
const {sql}=await import('drizzle-orm');
const {customerData}=await import('./analytics/customer-data');
for(const scenario of ['in-period payment','future payment','future application','secondary-book payment'] as const){
  test(`Customer payment cutoff: ${scenario}`,{skip:!process.env.OPENBOOKS_DB_URL},async()=>{
    const org=await withBypass(()=>createScratchOrg());
    try{
      const actor=await withBypass(()=>createScratchUser(org.orgId,'Payment writer','admin'));
      await withBypass(async()=>{
        const invoice=randomUUID(),taxBook=randomUUID();
        await db.execute(sql`insert into accounting_books(id,org_id,code,name,is_primary,is_active,posts_gl) values (${taxBook},${org.orgId},'TAX','Tax',false,true,true)`);
        await db.execute(sql`insert into documents(id,org_id,kind,document_number,document_date,posting_date,due_date,party_id,subsidiary_id,currency,subtotal,tax_total,total)
          values (${invoice},${org.orgId},'customer_invoice',${invoice},'2026-07-01','2026-07-01','2026-07-01',${org.customerId},${org.subsidiaryId},'CAD',100,0,100)`);
        async function entry(book:string,payment:boolean,date:string){
          const id=randomUUID(),line=randomUUID();
          const amount=payment ? '-100' : '100';
          await db.execute(sql`insert into journal_entries(id,org_id,book_id,subsidiary_id,entry_number,posting_date,period_id,status,origin,source_document_id)
            values (${id},${org.orgId},${book},${org.subsidiaryId},${id},${date},${org.periodId},'draft','manual',${payment ? null : invoice})`);
          await db.execute(sql`insert into journal_lines(id,org_id,entry_id,line_number,account_id,subsidiary_id,party_id,is_open_item,amount,currency,txn_amount,fx_rate)
            values (${line},${org.orgId},${id},1,${org.accounts.ar},${org.subsidiaryId},${org.customerId},true,${amount},'CAD',${amount},1),
            (${randomUUID()},${org.orgId},${id},2,${payment ? org.accounts.bank : org.accounts.revenue},${org.subsidiaryId},${org.customerId},false,-${amount}::numeric,'CAD',-${amount}::numeric,1)`);
          await db.execute(sql`update journal_entries set status='posted',posted_at=now() where id=${id}`);
          return {id,line};
        }
        const original=await entry(org.bookId,false,'2026-07-01');
        await db.execute(sql`update documents set status='posted',posted_entry_id=${original.id},posting_period_id=${org.periodId} where id=${invoice}`);
        const book=scenario === 'secondary-book payment' ? taxBook : org.bookId;
        const target=scenario === 'secondary-book payment' ? await entry(book,false,'2026-07-01') : original;
        const paidOn=scenario === 'future payment' ? '2026-07-21' : '2026-07-06';
        const appliedOn=scenario === 'future application' ? '2026-07-21' : paidOn;
        const payment=await entry(book,true,paidOn);
        await db.execute(sql`insert into applications(org_id,from_line_id,to_line_id,amount,source_amount,source_transaction_amount,source_transaction_currency,target_transaction_amount,target_transaction_currency,settlement_rate,settlement_rate_source,settlement_rate_reference,applied_on,created_by,updated_by)
          values (${org.orgId},${payment.line},${target.line},100,100,100,'CAD',100,'CAD',1,'same_currency','Payment cutoff review',${appliedOn},${actor},${actor})`);
      });
      await withOrgContext(org.orgId,async()=>{
        const data=await customerData({from:'2026-07-01',to:'2026-07-15',label:'Cutoff review'},org.orgId,null);
        const row=data.rows.find(row=>row.id === org.customerId);assert.ok(row);
        const paid=scenario === 'in-period payment';
        assert.equal(row.paymentRate,paid ? 100 : 0);
        assert.equal(row.avgDaysToPay,paid ? 5 : null);
        assert.equal(row.overdueCount,paid ? 0 : 1);
      });
    }finally{await withBypass(()=>dropScratchOrg(org.orgId));}
  });
}
}}] as const; for (const row of customerCutoffCases) await row.register();

const calendarCases = [{ label: "analytics-calendar", register: async () => {
const {withBypass,withOrgContext} = await import('@openbooks/engine/src/platform/db.ts');
const {healthData} = await import('./analytics/health-data');
const {financialHealth} = await import('./analytics/financial-health');
const {customerData} = await import('./analytics/customer-data');
const {vendorData} = await import('./analytics/vendor-data');
const {spendVelocityData} = await import('./analytics/spend-velocity-data');

// Every analytics reader accepts the leap-day-adjacent ranges and returns the
// requested period unchanged. Empty scratch orgs make its zero-valued
// aggregate defaults independently observable.
const { inclusiveCalendarDays } = await import('@openbooks/engine/src/platform/civil-date.ts')

const ranges = [
  { from: '2024-02-01', to: '2024-02-29' },
  { from: '2024-02-29', to: '2024-03-31' },
  { from: '2024-03-01', to: '2024-03-31' },
] as const;

test('the health dashboard echoes each calendar range with zero aggregates', async () => {
  assert.equal(ranges.length, 3, 'the calendar suite covers three ranges; an empty list would vacate every assertion below');
  const org = await withBypass(() => createScratchOrg());
  try {
    await withOrgContext(org.orgId, async () => {
      for (const range of ranges) {
        const result = await healthData({ ...range, label: 'Calendar review' }, org.orgId, null);
        assert.deepEqual(
          [result.period?.from, result.period?.to, result.period?.label],
          [range.from, range.to, 'Calendar review'],
        );
        assert.equal(result.figures.revenue, '0.0000');
        assert.equal(result.monthly.length, 12);
        assert.equal(result.budget.totals.actual, '0.0000');
        assert.deepEqual(result.segments.department, []);
      }
    });
  } finally { await withBypass(() => dropScratchOrg(org.orgId)); }
});

test('the health score echoes each calendar range with zero figures', async () => {
  assert.equal(ranges.length, 3, 'the calendar suite covers three ranges; an empty list would vacate every assertion below');
  const org = await withBypass(() => createScratchOrg());
  try {
    await withOrgContext(org.orgId, async () => {
      for (const range of ranges) {
        const result = await financialHealth({ ...range, label: 'Calendar review' }, org.orgId, null);
        assert.deepEqual(
          [result.period.from, result.period.to, result.period.label, result.period.days],
          [range.from, range.to, 'Calendar review', inclusiveCalendarDays(range.from, range.to)],
        );
        assert.equal(result.figures.revenue, '0.0000');
        assert.equal(result.figures.netIncome, '0.0000');
      }
    });
  } finally { await withBypass(() => dropScratchOrg(org.orgId)); }
});

test('the customer view echoes each calendar range with zero customers', async () => {
  assert.equal(ranges.length, 3, 'the calendar suite covers three ranges; an empty list would vacate every assertion below');
  const org = await withBypass(() => createScratchOrg());
  try {
    await withOrgContext(org.orgId, async () => {
      for (const range of ranges) {
        const result = await customerData({ ...range, label: 'Calendar review' }, org.orgId, null);
        assert.deepEqual(result.period, { ...range, label: 'Calendar review' });
        assert.deepEqual(result.rows, []);
        assert.equal(result.kpis.totalRevenue, '0.0000');
        assert.equal(result.kpis.totalCustomers, 0);
      }
    });
  } finally { await withBypass(() => dropScratchOrg(org.orgId)); }
});

test('the vendor view echoes each calendar range with zero spend', async () => {
  assert.equal(ranges.length, 3, 'the calendar suite covers three ranges; an empty list would vacate every assertion below');
  const org = await withBypass(() => createScratchOrg());
  try {
    await withOrgContext(org.orgId, async () => {
      for (const range of ranges) {
        const result = await vendorData({ ...range, label: 'Calendar review' }, org.orgId, null);
        assert.deepEqual(result.period, { ...range, label: 'Calendar review' });
        assert.deepEqual(result.rows, []);
        assert.equal(result.totals.vendors, 0);
        assert.equal(result.totals.spend, "0");
      }
    });
  } finally { await withBypass(() => dropScratchOrg(org.orgId)); }
});

test('the spend velocity view echoes each calendar range with zero spend', async () => {
  assert.equal(ranges.length, 3, 'the calendar suite covers three ranges; an empty list would vacate every assertion below');
  const org = await withBypass(() => createScratchOrg());
  try {
    await withOrgContext(org.orgId, async () => {
      for (const range of ranges) {
        const result = await spendVelocityData(org.orgId, { ...range, label: 'Calendar review' }, null);
        assert.deepEqual(result.period, { ...range, label: 'Calendar review' });
        assert.equal(result.summary.totalSpend, "0");
        assert.equal(result.summary.accountCount, 0);
      }
    });
  } finally { await withBypass(() => dropScratchOrg(org.orgId)); }
});
}}] as const; for (const row of calendarCases) await row.register();

const trueCostCases = [{ label: "true-cost-ledger", register: async () => {
const {sql}=await import('drizzle-orm');
const {trueCostData}=await import('./analytics/true-cost-data');

for(const view of ['overhead','prior rate','monthly','applied burden','revenue base','cost base','labor base'] as const){
  for(const scenario of ['posted control','extra books and drafts'] as const){
    test(`True Cost primary ledger ${view}: ${scenario}`,{skip:!process.env.OPENBOOKS_DB_URL},async()=>{
      const org=await withBypassContext(()=>createScratchOrg());
      try{
        await withBypassContext(async()=>{
        // A dedicated COGS account: retyping the shared baseline cogs
        // account is unrestorable — the accounts-type guard (correctly)
        // refuses the teardown revert while this test's own journal lines
        // still reference it, which fails the reset and taints the slot.
        const taxBook=randomUUID(),department=randomUUID(),employee=randomUUID(),project=randomUUID(),priorPeriod=randomUUID();
        const rent=randomUUID(),wages=randomUUID(),applied=randomUUID(),group=randomUUID(),cogs=randomUUID();
        await db.execute(sql`insert into accounting_books(id,org_id,code,name,is_primary,is_active,posts_gl) values (${taxBook},${org.orgId},'TAX','Tax',false,true,true)`);
        await db.execute(sql`insert into accounting_periods(id,org_id,fiscal_year,period_number,name,starts_on,ends_on,is_adjustment,fiscal_calendar_id) select ${priorPeriod},${org.orgId},2026,6,'2026-06','2026-06-01','2026-06-30',false,fiscal_calendar_id from accounting_periods where id=${org.periodId}`);
        await db.execute(sql`insert into departments(id,org_id,name) values (${department},${org.orgId},'Operations')`);
        await db.execute(sql`insert into parties(id,org_id,kind,display_name,subsidiary_id) values (${employee},${org.orgId},'person','Worker',${org.subsidiaryId})`);
        await db.execute(sql`insert into projects(id,org_id,subsidiary_id,code,name,customer_id,status,is_active) values (${project},${org.orgId},${org.subsidiaryId},'BURDEN','Burden project',${org.customerId},'active',true)`);
        await db.execute(sql`insert into accounts(id,org_id,number,name,type) values
          (${rent},${org.orgId},'6601','Office rent','expense'),(${wages},${org.orgId},'6602','Wages','expense'),(${applied},${org.orgId},'4901','Burden applied','income_other'),(${cogs},${org.orgId},'5001','Cost of goods','cogs')`);
        await db.execute(sql`insert into account_groups(id,org_id,dimension,key,name) values (${group},${org.orgId},'burden','rent','Rent')`);
        await db.execute(sql`insert into account_group_members(org_id,group_id,account_id,dimension) values (${org.orgId},${group},${rent},'burden')`);
        for(const date of ['2026-06-15',org.date])await db.execute(sql`insert into time_entries(org_id,employee_party_id,worked_on,hours,project_id,item_id,department_id,is_billable,cost_rate,status) values (${org.orgId},${employee},${date},10,${project},${org.items.service},${department},true,4,'approved')`);
        async function entry(book:string,status:'posted'|'draft',date:string,account:string,amount:string){
          const id=randomUUID();
          await db.execute(sql`insert into journal_entries(id,org_id,book_id,subsidiary_id,entry_number,posting_date,period_id,status,origin) values (${id},${org.orgId},${book},${org.subsidiaryId},${id},${date},${date === org.date ? org.periodId : priorPeriod},'draft','manual')`);
          await db.execute(sql`insert into journal_lines(org_id,entry_id,line_number,account_id,subsidiary_id,department_id,amount,currency,txn_amount,fx_rate) values
            (${org.orgId},${id},1,${account},${org.subsidiaryId},${department},${amount},'CAD',${amount},1),
            (${org.orgId},${id},2,${org.accounts.bank},${org.subsidiaryId},${department},-${amount}::numeric,'CAD',-${amount}::numeric,1)`);
          if(status === 'posted'){
            const posted=await db.execute<{id:string}>(sql`update journal_entries set status='posted',posted_at=now() where id=${id} returning id`);
            assert.deepEqual(posted.rows.map(row=>row.id),[id],`${scenario}: true-cost journal is posted`);
          }
        }
        for(const [account,amount] of [[rent,'100'],[wages,'40'],[cogs,'30'],[org.accounts.revenue,'-200'],[applied,'-10']])await entry(org.bookId,'posted',org.date,account!,amount!);
        await entry(org.bookId,'posted','2026-06-15',rent,'50');
        if(scenario === 'extra books and drafts'){
          for(const [book,status,amount] of [[taxBook,'posted','700'],[org.bookId,'draft','900']] as const){
            for(const account of [rent,wages,cogs,org.accounts.revenue,applied])await entry(book,status,org.date,account,account === org.accounts.revenue || account === applied ? '-'+amount : amount);
            await entry(book,status,'2026-06-15',rent,amount);
          }
        }
        });
        await withOrgContext(org.orgId,async()=>{
          const data=await trueCostData(org.orgId,{from:'2026-07-01',to:'2026-07-31',label:'Ledger review'},null);
          if(view === 'overhead')assert.equal(data.kpis.totalOverhead,100);
          if(view === 'prior rate')assert.equal(data.kpis.compositeRateChangePct,100);
          if(view === 'monthly')assert.equal(data.monthly.find(row=>row.month === '2026-07')?.burden,'100.0000');
          if(view === 'applied burden'){assert.equal(data.kpis.burdenApplied,10);assert.equal(data.hasBurdenGL,true);}
          if(view === 'revenue base')assert.equal(data.bases.revenue.total,210);
          if(view === 'cost base')assert.equal(data.bases.directCost.total,30);
          if(view === 'labor base')assert.equal(data.bases.laborDollars.total,40);
        });
      }finally{await dropScratchOrg(org.orgId);}
    });
  }
}


const consolidatedRows = [
  { label: "true cost approved status", register: async () => {
        const { pathToFileURL }=await import("node:url");
        /**
         * True Cost's labour bases must read approved time only — the same rule as
         * utilization, project profitability hours and the time drill-down. Draft,
         * submitted and rejected hours inflated billed/total hours, understating every
         * hours-based burden rate.
         */
        const root = pathToFileURL(process.cwd() + '/').href
        const { db, withBypassContext, withOrgContext } = (await import(root + 'engine/src/platform/db.ts')) as typeof import('@openbooks/engine/src/platform/db.ts')
        const { sql } = await import(root + 'node_modules/drizzle-orm/index.js')
        const { createScratchOrg, dropScratchOrg } = (await import(root + 'engine/src/testing/fixtures.ts')) as typeof import('@openbooks/engine/src/testing/fixtures.ts')
        const { trueCostData } = (await import(root + 'web/lib/analytics/true-cost-data.ts')) as typeof import('./analytics/true-cost-data')

        test('true cost labour bases count approved time only', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
          const org = await withBypassContext(() => createScratchOrg())
          try {
            await withBypassContext(async () => {
              const employee = randomUUID()
              await db.execute(sql`insert into parties (id, org_id, kind, display_name, subsidiary_id)
                values (${employee}, ${org.orgId}, 'person', 'True Cost Worker', ${org.subsidiaryId})`)
              for (const [status, hours] of [['approved', '8'], ['draft', '8'], ['submitted', '4'], ['rejected', '2']] as const) {
                await db.execute(sql`insert into time_entries (org_id, employee_party_id, worked_on, hours, project_id, item_id, is_billable, cost_rate, status)
                  values (${org.orgId}, ${employee}, ${org.date}, ${hours}, null, ${org.items.service}, true, '10', ${status})`)
              }
            })
            await withOrgContext(org.orgId, async () => {
              const data = await trueCostData(org.orgId, { from: '2026-07-01', to: '2026-07-31', label: 'July 2026' }, null)
              assert.equal(data.kpis.totalHours, 8, 'draft/submitted/rejected hours must not inflate true-cost bases')
              assert.equal(data.kpis.billedHours, 8)
            })
          } finally {
            await withBypassContext(() => dropScratchOrg(org.orgId))
          }
        })
  } },
] as const;

for(const row of consolidatedRows) await row.register();
}}] as const; for (const row of trueCostCases) await row.register();

const analyticsScopeCases = [{ label: "analytics-scope", register: async () => {
const assert: typeof import("node:assert/strict") = (await import("node:assert/strict")).default;
const { randomUUID } = await import("node:crypto");
const { registerHooks } = await import("node:module");
const { resolveAppModule } = await import("./test-module-hooks");
const { pathToFileURL } = await import("node:url");
const test = (await import("node:test")).default;
const React = await import("react");
type SessionUser = import("./auth").SessionUser;
const { stubModules } = await import("../testing/stub-modules.ts");
const root = pathToFileURL(process.cwd() + '/').href;
const state: { user: SessionUser | null } = { user: null };
const period = { from: '2026-07-01', to: '2026-07-31', label: 'Scope review' };
Object.assign(globalThis, { __analyticsScope: state, React });
stubModules({ intl: true, navigation: false, authz: false, features: false });
registerHooks({ resolve(specifier, context, next) {
  if (specifier === './auth' && context.parentURL?.endsWith('/web/lib/authz.ts')) return { shortCircuit: true, url: 'data:text/javascript,export async function currentUser(){return globalThis.__analyticsScope.user}' };
  if (specifier.endsWith('/lib/periods') && /analytics\/(customer-intelligence|vendor-performance|spend-velocity)\/(?:page\.tsx|view\.ts)$/.test(context.parentURL ?? '')) return { shortCircuit: true, url: 'data:text/javascript,export async function resolvePeriod(){return '+JSON.stringify(period)+'}' };
  if (specifier === '../money-server' && context.parentURL?.includes('/analytics/')) return { shortCircuit: true, url: 'data:text/javascript,export async function getMoneyFormatter(){return {money:String,moneyCompact:String}}' };
  const app = resolveAppModule(specifier, context, next, root);
  if (app) return app;
  return next(specifier, context);
} });
const { sql } = await import('drizzle-orm');
const { db, withBypass, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts');
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts');
const { getAuthz } = await import('./authz');
const { customerData, customerProfitability, isProfitLeak } = await import('./analytics/customer-data');
const { analyticsConfig } = await import('./analytics/config');
const { vendorData } = await import('./analytics/vendor-data');
const { spendVelocityData } = await import('./analytics/spend-velocity-data');
const { add } = await import('@openbooks/engine/src/money/money.ts');
// The page LOADERS. The `page` boundary below asks whether the page applies
// the reader's subsidiary scope, and that decision lives in the loader — the
// spec only names where the resolved data is drawn. Reading the loader output
// is both the honest place to assert it and stable against how the page is
// arranged; digging props out of a rendered element stopped working when
// `ModuleView` became the single render path.
const { loadCustomerIntelligence } = await import('../app/(app)/analytics/customer-intelligence/view');
const { loadVendorPerformance } = await import('../app/(app)/analytics/vendor-performance/view');
const { loadSpendVelocity } = await import('../app/(app)/analytics/spend-velocity/view');
const { executeAssistantTool } = await import('./assistant/registry');
type Summary = { kpis?: { totalRevenue: string | number }; totals?: { spend: string | number }; summary?: { totalSpend: string | number }; commitmentCliff?: { summary: { totalPO: string; totalSO: string } }; expenseAnalysis?: { topSpenders: { totalSpend: string }[] | { items: { totalSpend: string }[] } } };

for (const surface of ['customer', 'vendor', 'spend'] as const) {
  for (const boundary of ['service', 'page', 'assistant'] as const) {
    for (const mode of ['all', 'restricted', 'empty'] as const) {
      test(`Analytics subsidiary access ${surface} ${boundary}: ${mode}`, { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
        const org = await withBypass(() => createScratchOrg());
        try {
          const actor = await withBypass(() => createScratchUser(org.orgId, 'Analytics reviewer', 'analytics_reviewer'));
          await withBypass(async () => {
            const restriction = mode === 'all' ? { mode: 'all' } : { mode: 'list', subsidiaryIds: mode === 'empty' ? [] : [org.subsidiaryId] };
            await db.execute(sql`update app_roles set permissions='["reports.read","assistant.use"]'::jsonb,subsidiary_restriction=${JSON.stringify(restriction)}::jsonb where org_id=${org.orgId} and key='analytics_reviewer'`);
            state.user = { id: actor, orgId: org.orgId, name: 'Analytics reviewer', email: 'analytics@scratch.test', roles: [], isSuperAdmin: false, envKind: 'production', productionOrgId: org.orgId, homeOrgId: org.orgId, homeUserId: actor };
            const hidden = randomUUID();
            await db.execute(sql`insert into subsidiaries(id,org_id,parent_id,name,base_currency,country) values (${hidden},${org.orgId},${org.subsidiaryId},'Private entity','CAD','CA')`);
            for (const [sub, amount, name] of [[org.subsidiaryId, '100', 'Visible'], [hidden, '999', 'PRIVATE-ANALYTICS-EVIDENCE']]) {
              const party = randomUUID(), project = randomUUID();
              await db.execute(sql`insert into parties(id,org_id,kind,display_name,subsidiary_id) values (${party},${org.orgId},'organization',${name},${sub})`);
              // Vendor spend counts only vendor-role parties: these seeded
              // organizations bill and report expenses as vendors.
              await db.execute(sql`insert into vendor_roles(id,org_id,party_id) values (${randomUUID()},${org.orgId},${party})`);
              await db.execute(sql`insert into projects(id,org_id,subsidiary_id,code,name,customer_id,status,is_active) values (${project},${org.orgId},${sub},${project},${name},${party},'active',true)`);
              for (const kind of ['vendor_bill', 'customer_invoice', 'expense_report'] as const) {
                const entry = randomUUID(), doc = randomUUID();
                const total = kind === 'expense_report' ? sub === org.subsidiaryId ? '2' : '20' : amount;
                const signed = kind === 'customer_invoice' ? '-'+total : total;
                const account = kind === 'customer_invoice' ? org.accounts.revenue : org.accounts.cogs;
                await db.execute(sql`insert into documents(id,org_id,kind,document_number,document_date,posting_date,due_date,party_id,subsidiary_id,currency,subtotal,tax_total,total)
                  values (${doc},${org.orgId},${kind},${doc},${org.date},${org.date},${org.date},${party},${sub},'CAD',${total},0,${total})`);
                await db.execute(sql`insert into journal_entries(id,org_id,book_id,subsidiary_id,entry_number,posting_date,period_id,status,origin,source_document_id)
                  values (${entry},${org.orgId},${org.bookId},${sub},${entry},${org.date},${org.periodId},'draft','manual',${doc})`);
                await db.execute(sql`insert into journal_lines(org_id,entry_id,line_number,account_id,subsidiary_id,project_id,party_id,amount,currency,txn_amount,fx_rate)
                  values (${org.orgId},${entry},1,${account},${sub},${project},${party},${signed},'CAD',${signed},1),
                  (${org.orgId},${entry},2,${org.accounts.bank},${sub},${project},${party},-${signed}::numeric,'CAD',-${signed}::numeric,1)`);
                await db.execute(sql`update journal_entries set status='posted',posted_at=now() where id=${entry}`);
                await db.execute(sql`update documents set status='posted',posted_entry_id=${entry},posting_period_id=${org.periodId} where id=${doc}`);
              }
              for (const kind of ['purchase_order','sales_order']) {
                const doc = randomUUID();
                await db.execute(sql`insert into documents(id,org_id,kind,document_number,document_date,posting_date,party_id,subsidiary_id,currency,subtotal,tax_total,total)
                  values (${doc},${org.orgId},${kind},${doc},${org.date},${org.date},${party},${sub},'CAD',${amount},0,${amount})`);
              }
            }
          });
          await withOrgContext(org.orgId, async () => {
            const authz = await getAuthz(); assert.ok(authz);
            let data: Summary;
            let profitability: unknown;
            if (boundary === 'service') {
              data = surface === 'customer' ? await customerData(period, org.orgId, authz.allowedSubsidiaryIds)
                : surface === 'vendor' ? await vendorData(period, org.orgId, authz.allowedSubsidiaryIds)
                : await spendVelocityData(org.orgId, period, authz.allowedSubsidiaryIds);
              if (surface === 'customer') {
                const total = data.kpis?.totalRevenue;
                assert.ok(total !== undefined, 'the customer loader carries its period total for the leak share');
                profitability = await customerProfitability(period, org.orgId, authz.allowedSubsidiaryIds, undefined, String(total));
              }
            } else if (boundary === 'page') {
              const load = surface === 'customer' ? loadCustomerIntelligence
                : surface === 'vendor' ? loadVendorPerformance : loadSpendVelocity;
              const loaded = await load({}) as { data: Summary; profitability?: unknown };
              data = loaded.data; profitability = loaded.profitability;
            } else {
              const tool = surface === 'customer' ? 'analytics_customer_intelligence' : surface === 'vendor' ? 'analytics_vendor_performance' : 'analytics_spend_velocity';
              const result = await executeAssistantTool(authz, tool, { fromDate: period.from, toDate: period.to });
              assert.equal(result.ok, true); assert.ok(result.ok);
              data = result.data as Summary;
              profitability = (result.data as { profitability?: unknown }).profitability;
            }
            const expectedRevenue = mode === 'all' ? 1099 : mode === 'empty' ? 0 : 100;
            const expected = surface === 'customer' ? expectedRevenue : mode === 'all' ? 1121 : mode === 'empty' ? 0 : 102;
            // Loader money travels as exact decimal strings on the service and
            // page boundaries; the customer assistant tool serializes numbers.
            const want = surface === 'customer' && boundary !== 'assistant' ? expectedRevenue.toFixed(4) : expected;
            const expectedMoney = mode === 'all' ? '1121.0000' : mode === 'empty' ? '0' : '102.0000';
            assert.equal(surface === 'customer' ? data.kpis?.totalRevenue : surface === 'vendor' ? data.totals?.spend : data.summary?.totalSpend, surface === 'customer' ? want : expectedMoney);
            assert.equal(JSON.stringify(data).includes('PRIVATE-ANALYTICS-EVIDENCE'), mode === 'all');
            if (surface === 'spend') {
              // Cliff totals are exact money strings.
              assert.equal(data.commitmentCliff?.summary.totalPO, expectedRevenue.toFixed(4));
              assert.equal(data.commitmentCliff?.summary.totalSO, expectedRevenue.toFixed(4));
              const spenders = data.expenseAnalysis?.topSpenders;
              assert.ok(spenders);
              // Spender amounts are exact decimal strings: sum them exactly,
              // since 0 + "2.0000" + "20.0000" concatenates instead of adding.
              assert.equal(
                (Array.isArray(spenders) ? spenders : spenders.items).reduce((total, row) => add(total, row.totalSpend), "0"),
                mode === "all" ? "22.0000" : mode === "empty" ? "0" : "2.0000",
              );
            }
            if (surface === 'customer') {
              assert.equal((profitability as { summary: { totalRevenue: string } }).summary.totalRevenue, expectedRevenue.toFixed(4));
              assert.equal(JSON.stringify(profitability).includes('PRIVATE-ANALYTICS-EVIDENCE'), mode === 'all');
              // The leak share divides the loader's scoped period total: every
              // flagged customer re-derived here from that total must agree.
              // A denominator that counted hidden subsidiaries would clear
              // flags the dashboard shows (or set ones it does not).
              if (boundary === 'service') {
                const cfg = await analyticsConfig(org.orgId, 'customerIntelligence');
                const cuts = { revenueSharePct: cfg.profitLeakRevenueSharePct!, marginTarget: cfg.profitLeakMarginTarget! };
                const total = String(data.kpis?.totalRevenue);
                for (const c of (profitability as { customers: { customerId: string; totalRevenue: string; marginPct: number | null; isFakeChampion: boolean }[] }).customers) {
                  assert.equal(c.isFakeChampion, isProfitLeak({ revenue: c.totalRevenue, totalRevenue: total, marginPct: c.marginPct }, cuts), `leak flag for ${c.customerId} divides the loader total`);
                }
              }
            }
          });
        } finally { state.user = null; await withBypass(() => dropScratchOrg(org.orgId)); }
      });
    }
  }
}
}}] as const; for (const row of analyticsScopeCases) await row.register();

const insightBookCases = [{ label: "insight primary book scope", register: async () => {
  const { stubModules } = await import('../testing/stub-modules.ts');
  stubModules({ intl: true, navigation: { source: 'export function redirect(){throw new Error("redirect")};export function useRouter(){throw new Error("no router")}' }, authz: false, features: false });
  const hooks = registerHooks({ resolve(specifier, context, next) {
    if (specifier === 'next/headers') return { shortCircuit: true, url: 'data:text/javascript,export async function headers(){throw new Error("no headers")};export async function cookies(){throw new Error("no cookies")}' };
    return next(specifier, context);
  }});
  const insightBooksModule: string = './insight-books.ts?analytics-ledger';
  const { resolveInsightBookScope } = await import(insightBooksModule) as typeof import('./insight-books');
  hooks.deregister();
  const plan: import('@openbooks/analytics').InsightQuery = { source: 'ledger_lines', measures: [{ agg: 'sum', field: 'amount' }], dimensions: [{ field: 'posting_date', bin: 'month' }] };
  test('insight book scope defaults to the primary and never silently falls back', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
    const org = await withBypassContext(() => createScratchOrg());
    try {
      assert.deepEqual(await withBypassContext(() => resolveInsightBookScope(org.orgId, plan)), [org.bookId]);
      await assert.rejects(withBypassContext(() => db.execute(sql`insert into accounting_books(id,org_id,code,name,is_primary,is_active,posts_gl)
        values (${randomUUID()},${org.orgId},'ALT','Alternate',true,true,true)`)),
        (error: unknown) => String((error as { cause?: { detail?: string } }).cause?.detail ?? '').includes('already exists'));
      await withBypassContext(() => db.execute(sql`update accounting_books set is_primary=false where org_id=${org.orgId}`));
      await assert.rejects(withBypassContext(() => resolveInsightBookScope(org.orgId, plan)), /exactly one active primary/);
      await withBypassContext(() => db.execute(sql`update accounting_books set is_primary=true where id=${org.bookId}`));
      assert.equal(await withBypassContext(() => resolveInsightBookScope(org.orgId, { ...plan, filters: [{ field: 'book_id', op: 'eq', value: org.bookId }] })), null);
      assert.equal(await withBypassContext(() => resolveInsightBookScope(org.orgId, { ...plan, dimensions: [{ field: 'book' }] })), null);
      assert.equal(await withBypassContext(() => resolveInsightBookScope(org.orgId, { source: 'documents', measures: [{ agg: 'sum', field: 'total' }] })), undefined);
    } finally { await withBypassContext(() => dropScratchOrg(org.orgId)); }
  });
}}] as const;
for (const row of insightBookCases) await row.register();
