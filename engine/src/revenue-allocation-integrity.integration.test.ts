import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { sql } from 'drizzle-orm';
import { db } from './db.ts';
import { createScratchOrg, dropScratchOrg, seedFlowActors } from './test-fixtures.ts';
import { createObligationsFromInvoice } from './revenue-recognition.ts';

for (const scenario of ['unit quantities', 'excluded allocation', 'mixed allocation', 'dated fair value', 'fractional quantities', 'partial legacy replay', 'zero selling price'] as const) {
  test(`revenue contract integrity: ${scenario}`, { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
    const org = await createScratchOrg();
    try {
      const actorId = (await seedFlowActors(org.orgId)).adminId;
      const ruleId = randomUUID(), documentId = randomUUID();
      await db.execute(sql`insert into recognition_rules (id,org_id,code,name,method,recognition_periods,deferred_account_id,recognized_account_id)
        values (${ruleId},${org.orgId},'ALLOCATION','Allocation rule','point_in_time',1,${org.accounts.deferred},${org.accounts.recognized})`);
      await db.execute(sql`update items set recognition_rule_id=${ruleId},standalone_selling_price=${scenario === 'zero selling price' ? '0' : '100'},revenue_allocation=${scenario === 'excluded allocation' ? 'exclude' : 'normal'} where org_id=${org.orgId} and id=${org.items.service}`);
      if (scenario === 'mixed allocation') {
        await db.execute(sql`update items set recognition_rule_id=${ruleId},standalone_selling_price='100',revenue_allocation='exclude'
          where org_id=${org.orgId} and id=${org.items.fifo}`);
      }
      if (scenario === 'dated fair value' || scenario === 'fractional quantities') {
        await db.execute(sql`update items set standalone_selling_price=null where org_id=${org.orgId} and id=${org.items.service}`);
        await db.execute(sql`insert into fair_value_prices (org_id,item_id,currency,unit_price,low_value,high_value,effective_from)
          values (${org.orgId},${org.items.service},'CAD','100','100','100',${org.date})`);
      }
      await db.execute(sql`insert into documents (id,org_id,kind,document_number,party_id,subsidiary_id,document_date,currency,status)
        values (${documentId},${org.orgId},'customer_invoice','REV-ALLOCATION',${org.customerId},${org.subsidiaryId},${org.date},'CAD','draft')`);
      const inputs = scenario === 'fractional quantities'
        ? [[1,'0.00000009','0.0009'],[2,'0.00000001','0.0001']] as const
        : scenario === 'partial legacy replay' ? [[1,'1','900'],[2,'1','100']] as const
        : [[1,'9','900'],[2,'1','100']] as const;
      for (const [index, quantity, amount] of inputs) {
        const itemId = scenario === 'mixed allocation' && index === 2 ? org.items.fifo : org.items.service;
        await db.execute(sql`insert into document_lines (id,org_id,document_id,line_number,item_id,description,quantity,unit_price,amount,tax_amount)
          values (${randomUUID()},${org.orgId},${documentId},${index},${itemId},${`Line ${index}`},${quantity},'100',${amount},'0')`);
      }
      if (scenario === 'zero selling price') {
        await assert.rejects(createObligationsFromInvoice(documentId,org.orgId,actorId), /selling price|allocation/i);
        assert.equal((await db.execute<{ n: number }>(sql`select count(*)::int as n from revenue_contracts where org_id=${org.orgId}`)).rows[0]!.n,0);
      } else {
        const first = await createObligationsFromInvoice(documentId,org.orgId,actorId);
        if (scenario === 'partial legacy replay') {
          // Reproduce a legacy partial commit: only the first allocation survived.
          const missing = (await db.execute<{ id: string }>(sql`select id from performance_obligations where org_id=${org.orgId} and description='Line 2'`)).rows[0]!.id;
          await db.transaction(async (tx) => {
            await tx.execute(sql`delete from recognition_schedule_lines where org_id=${org.orgId} and schedule_id in
              (select id from recognition_schedules where org_id=${org.orgId} and obligation_id=${missing})`);
            await tx.execute(sql`delete from recognition_schedules where org_id=${org.orgId} and obligation_id=${missing}`);
            await tx.execute(sql`delete from performance_obligations where org_id=${org.orgId} and id=${missing}`);
          });
          await db.execute(sql`update performance_obligations set allocated_price='600' where org_id=${org.orgId} and description='Line 1'`);
          await assert.rejects(createObligationsFromInvoice(documentId,org.orgId,actorId), /conflicts with existing obligations/i);
          assert.equal((await db.execute<{ n: number }>(sql`select count(*)::int as n from performance_obligations where org_id=${org.orgId}`)).rows[0]!.n,1);
          await db.execute(sql`update performance_obligations set allocated_price='500' where org_id=${org.orgId} and description='Line 1'`);
          await db.execute(sql`update revenue_contracts set total_transaction_price='900' where org_id=${org.orgId} and id=${first.contractId}`);
          await assert.rejects(createObligationsFromInvoice(documentId,org.orgId,actorId), /conflicts with the existing contract total/i);
          assert.equal((await db.execute<{ n: number }>(sql`select count(*)::int as n from performance_obligations where org_id=${org.orgId}`)).rows[0]!.n,1);
          await db.execute(sql`update revenue_contracts set total_transaction_price='1000' where org_id=${org.orgId} and id=${first.contractId}`);
          assert.equal((await createObligationsFromInvoice(documentId,org.orgId,actorId)).created,1);
        }
        const allocations = (await db.execute<{ allocated_price: string }>(sql`select allocated_price from performance_obligations where org_id=${org.orgId} and contract_id=${first.contractId} order by description`)).rows;
        assert.deepEqual(allocations.map(row=>row.allocated_price), scenario === 'fractional quantities' ? ['0.0009','0.0001'] : scenario === 'partial legacy replay' ? ['500.0000','500.0000'] : ['900.0000','100.0000']);
        const total = (await db.execute<{ total: string }>(sql`select total_transaction_price::text as total from revenue_contracts where org_id=${org.orgId} and id=${first.contractId}`)).rows[0]!.total;
        assert.equal(total, scenario === 'fractional quantities' ? '0.0010' : '1000.0000');
        assert.equal((await createObligationsFromInvoice(documentId,org.orgId,actorId)).created,0);
      }
    } finally { await dropScratchOrg(org.orgId); }
  });
}
