import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
registerHooks({ resolve(specifier, context, next) {
  if (specifier === "server-only") return { shortCircuit: true, url: "data:text/javascript,export {}" };
  return next(specifier, context);
} });
const { sql } = await import("drizzle-orm");
const { db, withOrgContext } = await import("@openbooks/engine/src/db.ts");
const { createScratchOrg, dropScratchOrg } = await import("@openbooks/engine/src/test-fixtures.ts");
const { postDocument } = await import("@openbooks/engine/src/posting.ts");
const { bankBalances, openItems } = await import("./cash/core");
for (const path of ["partial month", "completed month", "receivables", "payables"] as const) {
  for (const mode of ["all", "restricted", "empty"] as const) {
    test(`Cash ledger ${path}: ${mode}`, { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
      const org = await createScratchOrg();
      let foreignOrgId: string | undefined;
      try {
        const hidden = randomUUID(); const secondBook = randomUUID();
        await db.execute(sql`insert into subsidiaries(id,org_id,parent_id,name,base_currency,country) values (${hidden},${org.orgId},${org.subsidiaryId},'Hidden','CAD','CA')`);
        await db.execute(sql`insert into accounting_books(id,org_id,code,name,is_primary,is_active,posts_gl) values (${secondBook},${org.orgId},'TAX','Tax book',false,true,true)`);
        const subIds = mode === 'all' ? undefined : mode === 'empty' ? [] : [org.subsidiaryId];
        if (path === 'partial month' || path === 'completed month') {
          foreignOrgId = (await createScratchOrg()).orgId;
          for (const [sub, book, amount] of [[org.subsidiaryId,org.bookId,'100'], [hidden,org.bookId,'999'], [org.subsidiaryId,secondBook,'700']]) {
            const entry = randomUUID();
            await db.execute(sql`insert into journal_entries(id,org_id,book_id,subsidiary_id,entry_number,posting_date,period_id,status,origin)
              values (${entry},${org.orgId},${book},${sub},${entry},${org.date},${org.periodId},'draft','manual')`);
            await db.execute(sql`insert into journal_lines(org_id,entry_id,line_number,account_id,subsidiary_id,amount,currency,txn_amount,fx_rate)
              values (${org.orgId},${entry},1,${org.accounts.bank},${sub},${amount},'CAD',${amount},1),
                (${org.orgId},${entry},2,${org.accounts.revenue},${sub},${'-'+amount},'CAD',${'-'+amount},1)`);
            await db.execute(sql`update journal_entries set status='posted',posted_at=now() where id=${entry}`);
          }
          await withOrgContext(org.orgId, async () => {
            const banks = await bankBalances(path === 'completed month' ? '2026-08-15' : org.date, subIds);
            if (mode === 'empty') assert.deepEqual(banks, []);
            else {
              assert.equal(banks.find(bank => bank.id === org.accounts.bank)?.balance, mode === 'all' ? '1099.0000' : '100.0000');
              assert.equal(banks.length, 1);
              assert.equal(banks[0]?.id, org.accounts.bank);
            }
          });
        } else {
          await db.execute(sql`insert into party_subsidiaries(org_id,party_id,subsidiary_id)
            values (${org.orgId},${org.customerId},${hidden}),(${org.orgId},${org.vendorId},${hidden})`);
          for (const [sub, amount, label] of [[org.subsidiaryId,'100','Visible'],[hidden,'999','Hidden']]) {
            const id = randomUUID();
            const receivable = path === 'receivables';
            await db.execute(sql`insert into documents(id,org_id,kind,status,document_number,subsidiary_id,party_id,document_date,currency,fx_rate)
              values (${id},${org.orgId},${receivable ? 'customer_invoice' : 'vendor_bill'},'draft',${label},${sub},${receivable ? org.customerId : org.vendorId},${org.date},'CAD',1)`);
            await db.execute(sql`insert into document_lines(org_id,document_id,line_number,account_id,quantity,unit_price,amount,tax_amount,tax_input_amount)
              values (${org.orgId},${id},1,${receivable ? org.accounts.revenue : org.accounts.adjustment},1,${amount},${amount},0,0)`);
            await db.execute(sql`update documents set status='approved' where id=${id}`);
            await postDocument(id, { control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank } });
          }
          await withOrgContext(org.orgId, async () => {
            const items = await openItems(org.orgId, path === 'receivables' ? 'ar' : 'ap', org.date, subIds);
            assert.equal(items.length, mode === 'all' ? 2 : mode === 'empty' ? 0 : 1);
            if (mode === 'restricted') {
              assert.equal(items[0]?.docNumber, 'Visible');
              assert.equal(items[0]?.remaining, '100.0000');
            }
          });
        }
      } finally { await dropScratchOrg(org.orgId); if (foreignOrgId) await dropScratchOrg(foreignOrgId); }
    });
  }
}

for (const method of ['gl_history_average', 'credit_card_cycle', 'bank_register_history'] as const) {
  for (const mode of ['all', 'restricted', 'empty'] as const) {
    test(`Cash history ${method}: ${mode}`, { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
      const org = await createScratchOrg();
      try {
        const hidden = randomUUID(); const secondBook = randomUUID(); const card = randomUUID();
        await db.execute(sql`insert into subsidiaries(id,org_id,parent_id,name,base_currency,country) values (${hidden},${org.orgId},${org.subsidiaryId},'Hidden','CAD','CA')`);
        await db.execute(sql`insert into accounting_books(id,org_id,code,name,is_primary,is_active,posts_gl) values (${secondBook},${org.orgId},'TAX','Tax book',false,true,true)`);
        await db.execute(sql`insert into accounts(id,org_id,number,name,type) values (${card},${org.orgId},'2090','Card','liability_card')`);
        const target = method === 'credit_card_cycle' ? card : method === 'bank_register_history' ? org.accounts.bank : org.accounts.adjustment;
        const counter = method === 'gl_history_average' ? org.accounts.bank : org.accounts.adjustment;
        for (const [sub, book, amount, status] of [[org.subsidiaryId,org.bookId,'100','posted'], [hidden,org.bookId,'999','posted'], [org.subsidiaryId,secondBook,'700','posted'], [org.subsidiaryId,org.bookId,'900','draft']]) {
          const entry = randomUUID(); const signed = method === 'gl_history_average' ? amount : '-'+amount;
          const opposite = method === 'gl_history_average' ? '-'+amount : amount;
          await db.execute(sql`insert into journal_entries(id,org_id,book_id,subsidiary_id,entry_number,posting_date,period_id,status,origin)
            values (${entry},${org.orgId},${book},${sub},${entry},${org.date},${org.periodId},'draft','manual')`);
          await db.execute(sql`insert into journal_lines(org_id,entry_id,line_number,account_id,subsidiary_id,amount,currency,txn_amount,fx_rate)
            values (${org.orgId},${entry},1,${target},${sub},${signed},'CAD',${signed},1),
              (${org.orgId},${entry},2,${counter},${sub},${opposite},'CAD',${opposite},1)`);
          if (status === 'posted') await db.execute(sql`update journal_entries set status='posted',posted_at=now() where id=${entry}`);
        }
        await withOrgContext(org.orgId, async () => {
          const { categoryWeekly } = await import('./cash/core');
          const category = await categoryWeekly(org.orgId, { id: randomUUID(), name: 'Review', direction: 'outflow', method,
            accountIds: [target], cardAccountIds: [target], bankAccountIds: [target], includeJournals: true, historyWeeks: 4 },
            '2026-07-20', ['2026-07-19','2026-07-26','2026-08-02','2026-08-09'],
            { arWeekly: {}, apWeekly: {}, cashStart: '0.0000', subIds: mode === 'all' ? undefined : mode === 'empty' ? [] : [org.subsidiaryId] });
          const amount = mode === 'all' ? '1099.0000' : mode === 'empty' ? '0.0000' : '100.0000';
          const field = method === 'gl_history_average' ? 'sourceTotal' : method === 'credit_card_cycle' ? 'currentBalance' : 'rawAverage';
          assert.equal(category.meta[field], amount);
          if (mode === 'empty') assert.equal(category.total, '0.0000');
        });
      } finally { await dropScratchOrg(org.orgId); }
    });
  }
}
