import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'

/**
 * The aging must tie its control account to the cent.
 * Documents are not the whole control: unapplied receipts, direct control
 * journals, and legacy partyless opening balances post control lines with no
 * invoice/credit document behind them, and settlement dust (a payment line
 * whose stored base differs from the applied amount by a cent) leaves GL
 * balances no open document explains. The aging folds those in as an
 * explicit per-party residual — the "(no party)" row when no party is
 * stamped — so the totals always tie the control. A clean subledger reads
 * exactly as before (no phantom rows).
 */
const root = pathToFileURL(process.cwd() + '/').href
const { db, withBypassContext, withOrgContext } = (await import(root + 'engine/src/platform/db.ts')) as typeof import('@openbooks/engine/src/platform/db.ts')
const { sql } = await import(root + 'node_modules/drizzle-orm/index.js')
const { createScratchOrg, dropScratchOrg } = (await import(root + 'engine/src/testing/fixtures.ts')) as typeof import('@openbooks/engine/src/testing/fixtures.ts')
const { agingByParty, agingDetail } = (await import(root + 'web/lib/reports/aging.ts')) as typeof import('./reports/aging')

type ScratchOrg = Awaited<ReturnType<typeof createScratchOrg>>

const D = '2026-07-14'
const DUE = '2026-07-24'

async function postEntry(org: ScratchOrg, memo: string, legs: [string, string, string | null][]): Promise<string> {
  const entry = randomUUID()
  const num = `RES-${memo}-${entry.slice(0, 6)}`
  await db.execute(sql`insert into journal_entries (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, memo, status, origin)
    values (${entry}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId}, ${num}, ${D}, ${org.periodId}, ${num}, 'draft', 'manual')`)
  const rows = legs.map(([acct, amt, party], i) =>
    sql`(${org.orgId}, ${entry}, ${i + 1}, ${acct}, ${org.subsidiaryId}, ${amt}, 'CAD', ${amt}, '1', ${party}, ${(party !== null && (acct === org.accounts.ar || acct === org.accounts.ap)) as unknown as boolean}, ${num})`)
  await db.execute(sql`insert into journal_lines (org_id, entry_id, line_number, account_id, subsidiary_id, amount, currency, txn_amount, fx_rate, party_id, is_open_item, memo) values ${sql.join(rows, sql`, `)}`)
  await db.execute(sql`update journal_entries set status = 'posted', posted_at = now() where id = ${entry}`)
  return entry
}

async function lineId(entryId: string, accountId: string): Promise<string> {
  const r = await db.execute<{ id: string }>(sql`select id from journal_lines where entry_id = ${entryId} and account_id = ${accountId}`)
  assert.ok(r.rows[0], 'expected the line to exist')
  return r.rows[0]!.id
}

async function postInvoice(org: ScratchOrg, num: string, amount: string): Promise<string> {
  const entry = await postEntry(org, num, [[org.accounts.ar, amount, org.customerId], [org.accounts.revenue, `-${amount}`, null]])
  await db.execute(sql`insert into documents (id, org_id, kind, document_number, document_date, posting_date, due_date, currency, fx_rate, subtotal, tax_total, total, party_id, status, posted_entry_id, posting_period_id, open_balance)
    values (${randomUUID()}, ${org.orgId}, 'customer_invoice', ${num}, ${D}, ${D}, ${DUE}, 'CAD', '1', ${amount}, '0.0000', ${amount}, ${org.customerId}, 'posted', ${entry}, ${org.periodId}, ${amount})`)
  return entry
}

/** Presented-control truth in the residual's own scope: all books, control type, line dims. */
async function controlBalance(org: ScratchOrg, type: 'asset_receivable' | 'liability_payable', asOf: string): Promise<string> {
  const r = await db.execute<{ bal: string }>(sql`select coalesce(sum(l.amount), 0)::text as bal from journal_lines l
    join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id and e.status in ('posted', 'reversed')
    join accounts a on a.id = l.account_id and a.org_id = l.org_id
   where l.org_id = ${org.orgId} and a.type = ${type} and e.posting_date <= ${asOf}`)
  return r.rows[0]!.bal
}

test('partyless control balances surface as an explicit row and tie the control', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypassContext(() => createScratchOrg())
  try {
    await withBypassContext(async () => {
      await postInvoice(org, 'RES-INV-1', '1000.0000')
      // A direct control journal with no party and no document (the JE-00001 shape).
      await postEntry(org, 'NOPARTY', [[org.accounts.ar, '250.0000', null], [org.accounts.revenue, '-250.0000', null]])
    })
    await withOrgContext(org.orgId, async () => {
      const gl = await controlBalance(org, 'asset_receivable', D)
      assert.equal(gl, '1250.0000')
      const aging = await agingByParty('ar', D, undefined, org.orgId)
      assert.equal(aging.totals.total, gl, 'aging total ties the AR control with partyless lines present')
      const stray = aging.rows.find((row) => row.partyId === null)
      assert.ok(stray, 'partyless balance gets its own row')
      assert.equal(stray.partyName, null, 'the row renders through the existing (no party) label')
      assert.equal(stray.current, '250.0000', 'undated balances sit in current')
      assert.equal(stray.total, '250.0000')
      const customer = aging.rows.find((row) => row.partyId === org.customerId)
      assert.equal(customer?.total, '1000.0000', 'documented balances are untouched by the residual')
      // The detail view lists open items only: documentless balances stay out.
      const detail = await agingDetail('ar', D, undefined, org.orgId)
      assert.equal(detail.totals.total, '1000.0000')
      assert.ok(detail.rows.every((row) => row.partyId !== null))
    })
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId))
  }
})

test('settlement dust lands on the right party and the total still ties', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypassContext(() => createScratchOrg())
  try {
    await withBypassContext(async () => {
      const eInv = await postInvoice(org, 'RES-INV-2', '100.0000')
      // A 1c overpayment: the payment line posts 100.01 base while 100.00 applies.
      const ePay = await postEntry(org, 'OVERPAY', [[org.accounts.bank, '100.0100', null], [org.accounts.ar, '-100.0100', org.customerId]])
      await db.execute(sql`insert into applications (org_id, from_line_id, to_line_id, amount, source_amount, applied_on,
          source_transaction_amount, source_transaction_currency, target_transaction_amount, target_transaction_currency,
          settlement_rate, settlement_rate_source, settlement_rate_reference)
        values (${org.orgId}, ${await lineId(ePay, org.accounts.ar)}, ${await lineId(eInv, org.accounts.ar)},
          '100.0000', '100.0000', ${D}, '100.0000', 'CAD', '100.0000', 'CAD', 1, 'same_currency', 'RES-PROBE')`)
    })
    await withOrgContext(org.orgId, async () => {
      const gl = await controlBalance(org, 'asset_receivable', D)
      assert.equal(gl, '-0.0100', 'the control carries the 1c overpayment')
      const aging = await agingByParty('ar', D, undefined, org.orgId)
      assert.equal(aging.totals.total, gl, 'aging ties the control to the cent')
      const customer = aging.rows.find((row) => row.partyId === org.customerId)
      assert.ok(customer, 'the dust attributes to the customer, not to (no party)')
      assert.equal(customer.partyName, 'Acme Customer')
      assert.equal(customer.total, '-0.0100')
    })
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId))
  }
})

test('a clean subledger reads exactly as before: no residual rows', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypassContext(() => createScratchOrg())
  try {
    await withBypassContext(async () => {
      await postInvoice(org, 'RES-INV-3', '500.0000')
    })
    await withOrgContext(org.orgId, async () => {
      const aging = await agingByParty('ar', D, undefined, org.orgId)
      assert.equal(aging.totals.total, '500.0000')
      assert.ok(aging.rows.every((row) => row.partyId !== null), 'no (no party) row on a tied book')
      assert.deepEqual(
        aging.rows.map((r) => [r.partyName, r.current, r.total]),
        [['Acme Customer', '500.0000', '500.0000']],
      )
    })
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId))
  }
})

test('AP residual presents credit-normal control positive and names the vendor', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypassContext(() => createScratchOrg())
  try {
    await withBypassContext(async () => {
      const eBill = await postEntry(org, 'BILL', [[org.accounts.cogs, '300.0000', null], [org.accounts.ap, '-300.0000', org.vendorId]])
      await db.execute(sql`insert into documents (id, org_id, kind, document_number, document_date, posting_date, due_date, currency, fx_rate, subtotal, tax_total, total, party_id, status, posted_entry_id, posting_period_id, open_balance)
        values (${randomUUID()}, ${org.orgId}, 'vendor_bill', 'RES-BILL-1', ${D}, ${D}, ${DUE}, 'CAD', '1', '300.0000', '0.0000', '300.0000', ${org.vendorId}, 'posted', ${eBill}, ${org.periodId}, '300.0000')`)
      // A partyless AP top-up with no document.
      await postEntry(org, 'APTOP', [[org.accounts.cogs, '75.0000', null], [org.accounts.ap, '-75.0000', null]])
    })
    await withOrgContext(org.orgId, async () => {
      const gl = await controlBalance(org, 'liability_payable', D)
      assert.equal(gl, '-375.0000')
      const aging = await agingByParty('ap', D, undefined, org.orgId)
      assert.equal(aging.totals.total, '375.0000', 'AP aging presents the control positive and ties it')
      const stray = aging.rows.find((row) => row.partyId === null)
      assert.ok(stray, 'partyless AP balance gets its own row')
      assert.equal(stray.current, '75.0000')
    })
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId))
  }
})


const consolidatedRows = [
  { label: "aging cutover open balance", register: async () => {
        const { sql } = await import('drizzle-orm')
        const { db, env, withBypass, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
        const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
        const { postDocument } = await import("@openbooks/engine/src/ledger/posting-document.ts");
        const { agingByParty, agingDetail } = await import('./reports/aging')
        
        /**
         * The AR/AP aging rebuilds opens from posted open-item journal lines — it
         * never reads the documents.open_balance cache. That is safe for imported
         * cutover AR/AP only because a cache-only posted document cannot exist: the
         * schema requires every posted document to carry a posted entry
         * (documents_posted_period_required), and open_balance itself is derived
         * from that entry's lines (NULL without them), never imported as a bare
         * value. The first test pins the constraint; the second proves the shape an
         * importer actually produces — a kernel-posted invoice — is aged by both
         * readers.
         */
        test('a posted invoice without a posted entry is rejected, so the aging join cannot miss it', { skip: !env.OPENBOOKS_DB_URL }, async () => {
          const scratch = await withBypass(() => createScratchOrg())
          try {
            const actor = await withBypass(() => createScratchUser(scratch.orgId, 'Cutover Controller', 'admin'))
            const id = randomUUID()
            await withBypass(async () => {
              await db.execute(sql`insert into documents
                (id, org_id, kind, status, document_number, subsidiary_id, party_id, document_date,
                 currency, fx_rate, subtotal, tax_total, total, created_by)
                values (${id}, ${scratch.orgId}, 'customer_invoice', 'draft', ${id}, ${scratch.subsidiaryId},
                  ${scratch.customerId}, ${scratch.date}, 'CAD', '1', 500, 0, 500, ${actor})`)
              // A draft without an entry is fine …
              const draft = (await db.execute<{ status: string }>(sql`select status from documents where id = ${id}`)).rows[0]!
              assert.equal(draft.status, 'draft')
              // … but flipping it to posted with no posted entry — the phantom an
              // importer would have to create to escape the aging — is rejected.
              await assert.rejects(
                db.execute(sql`update documents set status = 'posted' where id = ${id}`),
                (error: unknown) => {
                  const cause = (error as { cause?: { code?: string; constraint?: string } }).cause
                  assert.equal(cause?.code, '23514')
                  assert.equal(cause?.constraint, 'documents_posted_period_required')
                  return true
                },
              )
            })
          } finally {
            await withBypass(() => dropScratchOrg(scratch.orgId))
          }
        })
        
        test('a kernel-posted cutover-shape invoice is aged from its posted lines', { skip: !env.OPENBOOKS_DB_URL }, async () => {
          const scratch = await withBypass(() => createScratchOrg())
          try {
            const actor = await withBypass(() => createScratchUser(scratch.orgId, 'Cutover Controller', 'admin'))
            await withBypass(async () => {
              const id = randomUUID()
              await db.execute(sql`insert into documents
                (id, org_id, kind, status, document_number, subsidiary_id, party_id, document_date,
                 currency, fx_rate, subtotal, tax_total, total, created_by)
                values (${id}, ${scratch.orgId}, 'customer_invoice', 'draft', ${id}, ${scratch.subsidiaryId},
                  ${scratch.customerId}, ${scratch.date}, 'CAD', '1', 500, 0, 500, ${actor})`)
              await db.execute(sql`insert into document_lines
                (org_id, document_id, line_number, account_id, quantity, unit_price, amount, tax_amount, tax_input_amount)
                values (${scratch.orgId}, ${id}, 1, ${scratch.accounts.revenue}, 1, 500, 500, 0, 500)`)
              await db.execute(sql`update documents set status = 'approved' where id = ${id}`)
              await postDocument(id, { control: { ar: scratch.accounts.ar, ap: scratch.accounts.ap, bank: scratch.accounts.bank } })
            })
            // Reads run in the scratch org's scope: importing the aging reader pulls
            // in the web request-org resolver, which denies every query outside an
            // explicit scope (pooled RLS), so a bare read sees zero rows.
            await withOrgContext(scratch.orgId, async () => {
              const aging = await agingByParty('ar', '2026-12-31', undefined, scratch.orgId)
              assert.equal(aging.rows.length, 1)
              assert.equal(aging.totals.total, '500.0000')
              const detail = await agingDetail('ar', '2026-12-31', undefined, scratch.orgId)
              assert.equal(detail.rows.length, 1)
              assert.equal(detail.totals.total, '500.0000')
            })
          } finally {
            await withBypass(() => dropScratchOrg(scratch.orgId))
          }
        })
  } },
] as const;

for(const row of consolidatedRows) await row.register();

const expenseSettlementReadersCases = [{ label: "expense-settlement-readers", register: async () => {
const assert = (await import("node:assert/strict")).default;
const { randomUUID } = await import("node:crypto");
const test = (await import("node:test")).default;
const {sql}=await import('drizzle-orm');
const {db,withBypassContext,withOrgContext}=await import('@openbooks/engine/src/platform/db.ts');
const {createScratchOrg,dropScratchOrgReporting:dropScratchOrg}=await import('@openbooks/engine/src/testing/fixtures.ts');
const { postDocument } = await import("@openbooks/engine/src/ledger/posting-document.ts");
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
}}] as const; for (const row of expenseSettlementReadersCases) await row.register();
