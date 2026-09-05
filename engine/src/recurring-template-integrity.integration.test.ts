import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { runScheduleNow } from "./recurring.ts";
import { createScratchOrg, createScratchUser, dropScratchOrg } from "./test-fixtures.ts";

for (const scenario of ["customer_invoice", "tax code", "rate change", "inactive member", "journal", "restricted journal"] as const) {
  const kind = scenario.endsWith("journal") ? "journal" : "customer_invoice";
  const grouped = scenario === "customer_invoice" || scenario === "inactive member";
  test(`recurring ${scenario} preserves financial facts and execution scope`, { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
    const org = await createScratchOrg();
    try {
      const actor = await createScratchUser(org.orgId, "Template operator", "recurring_operator");
      await db.execute(sql`update app_roles set permissions='["documents.manage","gl.post"]'::jsonb where org_id=${org.orgId} and key='recurring_operator'`);
      const segment = randomUUID(), headerValue = randomUUID(), lineValue = randomUUID();
      const template = randomUUID(), schedule = randomUUID(), group = randomUUID(), taxCode = randomUUID(), child = randomUUID();
      await db.execute(sql`insert into subsidiaries (id,org_id,parent_id,name,base_currency,country)
        values (${child},${org.orgId},${org.subsidiaryId},'Recurring child','CAD','CA')`);
      await db.execute(sql`insert into tax_groups (id,org_id,code,name,price_includes_tax)
        values (${group},${org.orgId},'RECUR-TAX','Recurring tax profile',true)`);
      await db.execute(sql`insert into tax_codes (id,org_id,code,name,collected_account_id,paid_account_id)
        values (${taxCode},${org.orgId},'RECUR-13','Recurring 13%',${org.accounts.taxOutput},${org.accounts.taxInput})`);
      await db.execute(sql`insert into tax_rates (org_id,tax_code_id,rate_percent,effective_from)
        values (${org.orgId},${taxCode},'13','2026-01-01')`);
      await db.execute(sql`insert into tax_group_members (tax_group_id,tax_code_id,sequence) values (${group},${taxCode},1)`);
      await db.execute(sql`insert into segment_definitions (id,org_id,key,name,plural_name,source_kind)
        values (${segment},${org.orgId},'division','Division','Divisions','custom')`);
      await db.execute(sql`insert into segment_values (id,org_id,segment_id,code,name)
        values (${headerValue},${org.orgId},${segment},'HEADER','Header division'),(${lineValue},${org.orgId},${segment},'LINE','Line division')`);
      await db.execute(sql`insert into documents (id,org_id,kind,status,document_number,document_date,currency,party_id,subsidiary_id,extra_dims)
        values (${template},${org.orgId},${kind},'draft','TEMPLATE',${org.date},'CAD',${org.customerId},${org.subsidiaryId},${JSON.stringify({ division: headerValue })}::jsonb)`);
      await db.execute(sql`insert into document_lines (org_id,document_id,line_number,account_id,quantity,unit_price,amount,
          tax_code_id,tax_group_id,tax_input_amount,tax_amount,tax_overridden,subsidiary_id,extra_dims)
        values (${org.orgId},${template},1,${org.accounts.revenue},'1','100','100',
          ${kind === 'customer_invoice' && !grouped ? taxCode : null},${grouped ? group : null},${kind === 'customer_invoice' ? (grouped ? '113' : '100') : null},${kind === 'customer_invoice' ? '13' : '0'},${grouped},
          ${kind === "journal" ? child : null},${JSON.stringify({ division: lineValue })}::jsonb)`);
      if (kind === "journal") await db.execute(sql`insert into document_lines (org_id,document_id,line_number,account_id,quantity,unit_price,amount,subsidiary_id)
        values (${org.orgId},${template},2,${org.accounts.cogs},'1','-100','-100',${org.subsidiaryId})`);
      await db.execute(sql`insert into recurring_schedules (id,org_id,template_document_id,cadence,next_run_on,auto_post,created_by)
        values (${schedule},${org.orgId},${template},'monthly',${org.date},${kind === 'customer_invoice'},${actor})`);
      if (scenario === "restricted journal") {
        await db.execute(sql`update app_roles set subsidiary_restriction=${JSON.stringify({ mode: "list", subsidiaryIds: [org.subsidiaryId] })}::jsonb
          where org_id=${org.orgId} and key='recurring_operator'`);
        await assert.rejects(() => runScheduleNow(schedule, actor, org.date), { status: 404 });
        assert.equal((await db.execute<{ count: number }>(sql`select count(*)::int as count from documents where org_id=${org.orgId}`)).rows[0]!.count, 1);
        return;
      }
      if (scenario === "inactive member") {
        await db.execute(sql`update tax_codes set is_active=false where id=${taxCode}`);
        await assert.rejects(() => runScheduleNow(schedule, actor, org.date), /inactive or missing code/);
        assert.equal((await db.execute<{ count: number }>(sql`select count(*)::int as count from documents where org_id=${org.orgId}`)).rows[0]!.count, 1);
        return;
      }
      if (scenario === "rate change") {
        await db.execute(sql`update tax_rates set effective_to='2026-07-14' where tax_code_id=${taxCode}`);
        await db.execute(sql`insert into tax_rates (org_id,tax_code_id,rate_percent,effective_from) values (${org.orgId},${taxCode},'15',${org.date})`);
      }
      const generated = await runScheduleNow(schedule, actor, org.date);
      const source = (await db.execute(sql`select tax_code_id,tax_group_id,tax_input_amount,tax_amount,tax_overridden,subsidiary_id,extra_dims
        from document_lines where document_id=${template} and line_number=1`)).rows[0];
      const cloned = (await db.execute(sql`select tax_code_id,tax_group_id,tax_input_amount,tax_amount,tax_overridden,subsidiary_id,extra_dims
        from document_lines where document_id=${generated.documentId} and line_number=1`)).rows[0];
      assert.deepEqual(cloned, scenario === "rate change" ? { ...source, tax_amount: "15.0000" } : source);
      if (kind === "customer_invoice") {
        assert.equal(generated.posted, true);
        const ledger = (await db.execute<{ account: string; amount: string }>(sql`
          select l.account_id as account,l.amount from journal_lines l join documents d on d.posted_entry_id=l.entry_id
           where d.id=${generated.documentId} order by l.account_id
        `)).rows;
        assert.deepEqual(ledger, [
          { account: org.accounts.ar, amount: scenario === "rate change" ? "115.0000" : "113.0000" },
          { account: org.accounts.revenue, amount: "-100.0000" },
          { account: org.accounts.taxOutput, amount: scenario === "rate change" ? "-15.0000" : "-13.0000" },
        ].sort((a,b) => a.account.localeCompare(b.account)));
      }
      assert.deepEqual((await db.execute(sql`select extra_dims from documents where id=${generated.documentId}`)).rows[0], { extra_dims: { division: headerValue } });
    } finally { await dropScratchOrg(org.orgId); }
  });
}
