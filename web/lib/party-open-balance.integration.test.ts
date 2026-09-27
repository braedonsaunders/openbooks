import assert from 'node:assert/strict';
import test from 'node:test';
const { sql } = await import('drizzle-orm');
const { randomUUID } = await import('node:crypto');
const { db, withBypassContext, withOrgContext } = await import("@openbooks/engine/src/platform/db.ts");
const { createScratchOrg, dropScratchOrg } = await import("@openbooks/engine/src/testing/fixtures.ts");
const { loadParty } = await import("../app/api/parties/_lib");
const enabled = { skip: !process.env.OPENBOOKS_DB_URL };

// Document open balances are stored unsigned per document (the
// recompute sums abs() line amounts minus applications); the KIND carries the
// sign. The party directory summary must net unapplied credits against the
// customer's invoices instead of adding them with abs().
async function fixture(action: (org: Awaited<ReturnType<typeof createScratchOrg>>) => Promise<void>) {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    await withBypassContext(async () => {
      const invoice = randomUUID();
      await db.execute(sql`insert into documents(id,org_id,kind,status,document_number,document_date,party_id,currency,subtotal,tax_total,total,open_balance)
        values (${invoice},${org.orgId},'customer_invoice','draft','INV-BAL-1','2026-07-15',${org.customerId},'CAD',12000,0,12000,7000)`);
      const credit = randomUUID();
      await db.execute(sql`insert into documents(id,org_id,kind,status,document_number,document_date,party_id,currency,subtotal,tax_total,total,open_balance)
        values (${credit},${org.orgId},'customer_credit','draft','CM-BAL-1','2026-07-15',${org.customerId},'CAD',1000,0,1000,1000)`);
    });
    await withOrgContext(org.orgId, () => action(org));
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
}

test('party open balance nets an unapplied credit against its invoices', enabled, async () => fixture(async (org) => {
  const payload = await loadParty(org.customerId, org.orgId, null);
  assert.ok(payload, 'party must load');
  assert.equal(payload.transactionSummary.openCount, 2);
  const cad = payload.transactionSummary.currencies.find((c) => c.currency === 'CAD');
  assert.ok(cad, 'CAD summary must exist');
  assert.equal(cad.openBalance, '6000.0000');
}));

test('vendor open balance nets an unapplied credit against its bills', enabled, async () => fixture(async (org) => {
  const vendorId = org.vendorId;
  await withBypassContext(async () => {
    const bill = randomUUID();
    await db.execute(sql`insert into documents(id,org_id,kind,status,document_number,document_date,party_id,currency,subtotal,tax_total,total,open_balance)
      values (${bill},${org.orgId},'vendor_bill','draft','BILL-BAL-1','2026-07-15',${vendorId},'CAD',5000,0,5000,5000)`);
    const credit = randomUUID();
    await db.execute(sql`insert into documents(id,org_id,kind,status,document_number,document_date,party_id,currency,subtotal,tax_total,total,open_balance)
      values (${credit},${org.orgId},'vendor_credit','draft','VCRED-BAL-1','2026-07-15',${vendorId},'CAD',1000,0,1000,1000)`);
  });
  const payload = await loadParty(org.vendorId, org.orgId, null);
  assert.ok(payload, 'vendor must load');
  const cad = payload!.transactionSummary.currencies.find((c) => c.currency === 'CAD');
  assert.ok(cad, 'CAD summary must exist');
  assert.equal(cad.openBalance, '4000.0000');
}));


const partyRevisionCases = [
  { label: "party revision scope", register: async () => {
        const assert: typeof import('node:assert/strict') = (await import('node:assert/strict')).default;
        const test = (await import('node:test')).default;
        const { registerHooks } = await import('node:module');
        type SessionUser = import('./auth').SessionUser;
        const { stubModules } = await import('../testing/stub-modules.ts');
        const session: { user: SessionUser | null } = { user: null };
        Object.assign(globalThis, { __emailRevisionSession: session });
        stubModules({ intl: true, navigation: false, authz: false, features: false });

        registerHooks({ resolve(specifier, context, next) {
          if (specifier === './auth' && context.parentURL?.endsWith('/web/lib/authz.ts')) return { shortCircuit: true, url: 'data:text/javascript,export async function currentUser(){return globalThis.__emailRevisionSession.user}' };
          return next(specifier,context);
        }});
        const { sql } = await import('drizzle-orm');
        const { db, withOrgContext } = await import("@openbooks/engine/src/platform/db.ts");
        const { createScratchOrg, createScratchUser, dropScratchOrg } = await import("@openbooks/engine/src/testing/fixtures.ts");
        const { PATCH, GET } = await import("../app/api/parties/[id]/route");
        const { loadParty } = await import("../app/api/parties/_lib");
        for (const operation of ['read', 'save', 'stale']) {
          test(`party exact revision ${operation}`, { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
            const org = await createScratchOrg();
            try {
              const actor = await createScratchUser(org.orgId, 'Party administrator', 'reviewer');
              await db.execute(sql`update app_roles set permissions='["*"]'::jsonb where org_id=${org.orgId} and key='reviewer'`);
              session.user = { id:actor, orgId:org.orgId, name:'Party administrator', email:'party@scratch.test', roles:[], isSuperAdmin:false, envKind:'production', productionOrgId:org.orgId, homeOrgId:org.orgId, homeUserId:actor };
              await db.execute(sql`update parties set updated_at=date_trunc('second',now()+interval '1 day')+interval '123450 microseconds' where id=${org.customerId}`);
              const exact = (await db.execute<{revision:string}>(sql`select to_char(updated_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as revision from parties where id=${org.customerId}`)).rows[0]!.revision;
              const params = {params:Promise.resolve({id:org.customerId})};
              await withOrgContext(org.orgId,async()=>{
                const before = await GET(new Request('http://audit.local/api/parties'),params);
                const payload = await before.json();
                assert.equal(before.status,200,JSON.stringify(payload));
                if (operation === 'read') { assert.equal(payload.party.updated_at,exact); return; }
                if (operation === 'stale') await db.execute(sql`update parties set display_name='Concurrent edit',updated_at=updated_at+interval '1 microsecond' where id=${org.customerId}`);
                const response = await PATCH(new Request('http://audit.local/api/parties',{method:'PATCH',body:JSON.stringify({displayName:'Accepted edit',expectedUpdatedAt:payload.party.updated_at})}),params);
                assert.equal(response.status,operation === 'stale' ? 409 : 200,JSON.stringify(await response.json()));
              });
            } finally { session.user=null; await dropScratchOrg(org.orgId); }
          });
        }

        test('party summary excludes invoices from hidden entities', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
          const org=await createScratchOrg();
          try {
            const {randomUUID}=await import('node:crypto');
            const actor=await createScratchUser(org.orgId,'Scoped party reader','reviewer');
            const other=randomUUID();
            await db.execute(sql`insert into subsidiaries(id,org_id,parent_id,name,base_currency,country) values (${other},${org.orgId},${org.subsidiaryId},'Hidden entity','CAD','CA')`);
            await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features}',coalesce(settings->'features','{}'::jsonb)||'{"multiSubsidiary":true}'::jsonb) where id=${org.orgId}`);
            await db.execute(sql`update app_roles set permissions='["parties.read","parties.manage"]'::jsonb,subsidiary_restriction=${JSON.stringify({mode:'list',subsidiaryIds:[org.subsidiaryId]})}::jsonb where org_id=${org.orgId} and key='reviewer'`);
            session.user={id:actor,orgId:org.orgId,name:'Scoped reader',email:'reader@scratch.test',roles:[],isSuperAdmin:false,envKind:'production',productionOrgId:org.orgId,homeOrgId:org.orgId,homeUserId:actor};
            for(const [subsidiary,amount] of [[org.subsidiaryId,'100'],[other,'900']]){
              const id=randomUUID();
              await db.execute(sql`insert into documents(id,org_id,kind,document_number,document_date,party_id,subsidiary_id,currency) values (${id},${org.orgId},'customer_invoice',${id},${org.date},${org.customerId},${subsidiary},'CAD')`);
              await db.execute(sql`insert into document_lines(org_id,document_id,line_number,account_id,quantity,unit_price,amount) values (${org.orgId},${id},1,${org.accounts.revenue},1,${amount},${amount})`);
            }
            const response=await withOrgContext(org.orgId,()=>GET(new Request('http://audit.local/api/parties'),{params:Promise.resolve({id:org.customerId})}));
            const body=await response.json();
            assert.equal(response.status,200,JSON.stringify(body));
            assert.equal(body.transactionSummary.count,1);
            assert.equal(body.transactionSummary.currencies[0].total,'100.0000');
            // Both relation visibility and replacement preserve entities the editor
            // cannot inspect. A full replacement only owns the visible portion.
            await db.execute(sql`insert into party_subsidiaries(org_id,party_id,subsidiary_id) values
              (${org.orgId},${org.customerId},${org.subsidiaryId}),(${org.orgId},${org.customerId},${other})`);
            const visible = await loadParty(org.customerId,org.orgId,new Set([org.subsidiaryId]));
            assert.deepEqual(visible?.additionalSubsidiaryIds,[org.subsidiaryId]);
            const replaced = await withOrgContext(org.orgId,()=>PATCH(new Request('http://audit.local/api/parties',{
              method:'PATCH',body:JSON.stringify({expectedUpdatedAt:visible!.party.updated_at,additionalSubsidiaryIds:[]}),
            }),{params:Promise.resolve({id:org.customerId})}));
            assert.equal(replaced.status,200,JSON.stringify(await replaced.json()));
            assert.deepEqual((await db.execute<{subsidiary_id:string}>(sql`select subsidiary_id from party_subsidiaries where party_id=${org.customerId}`)).rows.map(row=>row.subsidiary_id),[other]);
            const none=await loadParty(org.customerId,org.orgId,new Set());
            assert.equal(none?.transactionSummary.count,0);
            assert.deepEqual(none?.transactionSummary.currencies,[]);
            const unrestricted=await loadParty(org.customerId,org.orgId,null);
            assert.equal(unrestricted?.transactionSummary.count,2);
            assert.equal(unrestricted?.transactionSummary.currencies[0]?.total,'1000.0000');
            await db.execute(sql`update parties set subsidiary_id=${other} where id=${org.customerId}`);
            assert.equal(await loadParty(org.customerId,org.orgId,new Set([org.subsidiaryId])),null);

          }finally{session.user=null;await dropScratchOrg(org.orgId);}
        });
  } },
] as const;

for (const row of partyRevisionCases) await row.register();


const partyDrawerCases = [
  { label: "balance due drawers", register: async () => {
        const assert: typeof import('node:assert/strict') = (await import('node:assert/strict')).default;
        const { randomUUID } = await import('node:crypto');
        const test = (await import('node:test')).default;
        const { sql } = await import('drizzle-orm')
        const { db, withBypass, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
        const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
        const { postDocument } = await import("@openbooks/engine/src/ledger/posting-document.ts");
        const { loadDocument } = await import("../../engine/src/ledger/document-service.ts");
        const { loadPdfRecordValues } = await import('./pdf-templates/values')

        /**
         * Drawer, customer PDF, and dunning share one balance-due reader
         * (engine/src/records/balance-due.ts). This test pins the two web surfaces to the
         * hand-computed figures: a partially paid invoice AND a partially consumed
         * credit memo. The credit is the leg trap — it is consumed through the
         * from-leg, so a to-leg-only reader reports the full 60 as still due on the
         * drawer and on the customer's PDF while the aging shows 35.
         */
        test('drawer and PDF agree on invoice and credit balances due', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
          const scratch = await withBypass(() => createScratchOrg())
          try {
            const actor = await withBypass(() => createScratchUser(scratch.orgId, 'Balance Drawer', 'admin'))
            const ids = await withBypass(async () => {
              async function postDoc(kind: string, total: string): Promise<{ id: string; line: string }> {
                const id = randomUUID()
                await db.execute(sql`insert into documents
                  (id, org_id, kind, status, document_number, subsidiary_id, party_id, document_date, due_date,
                   currency, fx_rate, subtotal, tax_total, total, created_by)
                  values (${id}, ${scratch.orgId}, ${kind}, 'draft', ${id}, ${scratch.subsidiaryId},
                    ${scratch.customerId}, '2026-07-01', '2026-07-20', 'CAD', '1', ${total}, 0, ${total}, ${actor})`)
                await db.execute(sql`insert into document_lines
                  (org_id, document_id, line_number, account_id, quantity, unit_price, amount, tax_amount, tax_input_amount)
                  values (${scratch.orgId}, ${id}, 1, ${scratch.accounts.revenue}, 1, ${total}, ${total}, 0, ${total})`)
                await db.execute(sql`update documents set status = 'approved' where id = ${id}`)
                const entry = await postDocument(id, { control: { ar: scratch.accounts.ar, ap: scratch.accounts.ap, bank: scratch.accounts.bank } })
                const line = (await db.execute<{ id: string }>(sql`select id from journal_lines
                  where entry_id = ${entry} and is_open_item`)).rows[0]!.id
                return { id, line }
              }
              const inv = await postDoc('customer_invoice', '100')
              const credit = await postDoc('customer_credit', '60')
              async function apply(fromLine: string, toLine: string, amount: string, ref: string): Promise<void> {
                const pay = randomUUID()
                if (fromLine === credit.line) {
                  await db.execute(sql`insert into applications
                    (org_id, from_line_id, to_line_id, amount, applied_on, source_amount, source_transaction_amount,
                     source_transaction_currency, target_transaction_amount, target_transaction_currency,
                     settlement_rate, settlement_rate_source, settlement_rate_reference, created_by, updated_by)
                    values (${scratch.orgId}, ${fromLine}, ${toLine}, ${amount}, '2026-07-12', ${amount}, ${amount},
                      'CAD', ${amount}, 'CAD', '1', 'same_currency', ${ref}, ${actor}, ${actor})`)
                  return
                }
                await db.execute(sql`insert into journal_entries
                  (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, memo, status, origin)
                  values (${pay}, ${scratch.orgId}, ${scratch.bookId}, ${scratch.subsidiaryId}, 'BAL-PAY', '2026-07-12',
                    ${scratch.periodId}, 'pay', 'draft', 'manual')`)
                await db.execute(sql`insert into journal_lines
                  (org_id, entry_id, line_number, account_id, subsidiary_id, party_id, amount, currency, txn_amount, fx_rate, is_open_item)
                  values (${scratch.orgId}, ${pay}, 1, ${scratch.accounts.bank}, ${scratch.subsidiaryId}, ${scratch.customerId},
                      ${amount}, 'CAD', ${amount}, '1', false),
                         (${scratch.orgId}, ${pay}, 2, ${scratch.accounts.ar}, ${scratch.subsidiaryId}, ${scratch.customerId},
                      -${amount}::numeric, 'CAD', -${amount}::numeric, '1', true)`)
                await db.execute(sql`update journal_entries set status = 'posted', posted_at = now() where id = ${pay}`)
                const payLine = (await db.execute<{ id: string }>(sql`select id from journal_lines
                  where entry_id = ${pay} and is_open_item`)).rows[0]!.id
                await db.execute(sql`insert into applications
                  (org_id, from_line_id, to_line_id, amount, applied_on, source_amount, source_transaction_amount,
                   source_transaction_currency, target_transaction_amount, target_transaction_currency,
                   settlement_rate, settlement_rate_source, settlement_rate_reference, created_by, updated_by)
                  values (${scratch.orgId}, ${payLine}, ${toLine}, ${amount}, '2026-07-12', ${amount}, ${amount},
                    'CAD', ${amount}, 'CAD', '1', 'same_currency', ${ref}, ${actor}, ${actor})`)
              }
              await apply('', inv.line, '40', 'DRAWER-PAY-TEST')
              await apply(credit.line, inv.line, '25', 'DRAWER-CREDIT-TEST')
              return { inv: inv.id, credit: credit.id }
            })
            // Reads run in the scratch org's scope: importing a web reader replaces
            // the test bypass, so an unscoped read silently returns zero rows.
            await withOrgContext(scratch.orgId, async () => {
              const invDrawer = await loadDocument(ids.inv, scratch.orgId)
              assert.equal(String(invDrawer!.doc.applied), '65.0000')
              assert.equal(String(invDrawer!.doc.balance_due), '35.0000')
              const creditDrawer = await loadDocument(ids.credit, scratch.orgId)
              assert.equal(String(creditDrawer!.doc.applied), '25.0000')
              assert.equal(String(creditDrawer!.doc.balance_due), '35.0000')
              // PDF values are locale money-formatted: pin the number through the
              // formatting rather than the exact glyphs.
              const invPdf = await loadPdfRecordValues('customer_invoice', scratch.orgId, ids.inv, null)
              assert.match(String(invPdf!.values.balance_due), /35[.,]00/)
              const creditPdf = await loadPdfRecordValues('customer_credit', scratch.orgId, ids.credit, null)
              assert.match(String(creditPdf!.values.balance_due), /35[.,]00/)
            })
          } finally {
            await withBypass(() => dropScratchOrg(scratch.orgId))
          }
        })
  } },
] as const;

for (const row of partyDrawerCases) await row.register();
