import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { BUILTIN_PROJECT_TYPES } from "@openbooks/schema";
import { db, withBypassContext, withOrgContext } from "../platform/db.ts";
import { assertDedicatedFixtureDatabase, createScratchOrg, createScratchUser, dropScratchOrg } from "../testing/fixtures.ts";
import { eligibleWipSourcesSql } from "./wip-sources.ts";

test("WIP ceilings preserve line project precedence, invoice fallback, credits and period cutoffs", {
  skip: !process.env.OPENBOOKS_DB_URL,
}, async () => {
  await assertDedicatedFixtureDatabase();
  await withBypassContext(async () => {
    const org = await createScratchOrg();
    try {
      const nte = BUILTIN_PROJECT_TYPES.find((type) => type.key === "not_to_exceed")!;
      const typeId = randomUUID(), employee = randomUUID();
      const projects = [randomUUID(), randomUUID()];
      const voidActor = await createScratchUser(org.orgId, "Invoice administrator", "invoice_admin");
      await db.execute(sql`insert into project_types
        (id,org_id,key,name,billing_method,invoicing_profile,backup_profile)
        values(${typeId},${org.orgId},'not_to_exceed','Capped work','time_and_materials',
          ${JSON.stringify(nte.invoicingProfile)}::jsonb,${JSON.stringify(nte.backupProfile)}::jsonb)`);
      await db.execute(sql`insert into project_financial_profile_versions
        (org_id,project_type_id,effective_from,financial_profile,reason)
        values(${org.orgId},${typeId},'2000-01-01',${JSON.stringify(nte.financialProfile)}::jsonb,'Reviewed billing policy')`);
      await db.execute(sql`insert into parties(id,org_id,kind,display_name,subsidiary_id)
        values(${employee},${org.orgId},'employee','Billable worker',${org.subsidiaryId})`);
      for (const [index, project] of projects.entries()) {
        await db.execute(sql`insert into projects
          (id,org_id,subsidiary_id,code,name,customer_id,project_type_id,contract_value,status,is_active,custom)
          values(${project},${org.orgId},${org.subsidiaryId},${`CAP-${index}`},'Capped work',
            ${org.customerId},${typeId},'1000.0000','active',true,'{}'::jsonb)`);
        await db.execute(sql`insert into time_entries
          (id,org_id,employee_party_id,worked_on,hours,project_id,item_id,is_billable,status,bill_rate,bill_rate_currency)
          values(${randomUUID()},${org.orgId},${employee},'2026-07-10','20.0000',${project},
            ${org.items.service},true,'approved','100.0000','CAD')`);
      }
      const invoice = async (project: string, kind: string, date: string, status: string,
        lines: readonly [string | null, string][]) => {
        const id = randomUUID();
        await db.execute(sql`insert into documents
          (id,org_id,subsidiary_id,kind,status,document_number,document_date,currency,project_id,party_id,void_reason,voided_at,voided_by)
          values(${id},${org.orgId},${org.subsidiaryId},${kind},${status},${`INV-${id}`},
            ${date},'CAD',${project},${org.customerId},${status === 'voided' ? 'Cancelled duplicate invoice' : null},
            ${status === 'voided' ? new Date('2026-07-15T12:00:00Z') : null},${status === 'voided' ? voidActor : null})`);
        for (const [index, [lineProject, amount]] of lines.entries()) {
          await db.execute(sql`insert into document_lines
            (id,org_id,document_id,line_number,account_id,amount,project_id)
            values(${randomUUID()},${org.orgId},${id},${index + 1},${org.accounts.revenue},${amount},${lineProject})`);
        }
      };
      // A nonnull line project takes precedence even when its invoice belongs
      // to another project; a null line project inherits the invoice project.
      await invoice(projects[0]!, "customer_invoice", "2026-07-12", "draft",
        [[null, "100.0000"], [projects[0]!, "200.0000"], [projects[1]!, "300.0000"]]);
      await invoice(projects[1]!, "customer_invoice", "2026-07-13", "draft",
        [[null, "400.0000"], [projects[0]!, "50.0000"]]);
      await invoice(projects[0]!, "customer_credit", "2026-07-14", "draft",
        [[null, "25.0000"], [projects[1]!, "10.0000"]]);
      await invoice(projects[0]!, "customer_invoice", "2026-08-01", "draft", [[null, "75.0000"]]);
      await invoice(projects[0]!, "customer_invoice", "2026-07-15", "voided", [[null, "999.0000"]]);

      const read = (asOf: boolean, scope: ReadonlySet<string> | null = null, orgId = org.orgId) =>
        withOrgContext(org.orgId, async () => (await db.execute<{ project_id: string; amount: string }>(sql`
          ${eligibleWipSourcesSql(orgId, scope, asOf ? { kind: "as_of", periodEnd: "2026-07-31" } : { kind: "open" })}
          select project_id, sum(capped_available_value)::text as amount
            from eligible_sources group by project_id`)).rows);
      const amounts = (rows: { project_id: string; amount: string }[]) => new Map(rows.map((row) => [row.project_id, row.amount]));
      assert.deepEqual(amounts(await read(false)), new Map([[projects[0], "600.0000"], [projects[1], "310.0000"]]));
      assert.deepEqual(amounts(await read(true)), new Map([[projects[0], "675.0000"], [projects[1], "310.0000"]]));
      assert.deepEqual(amounts(await read(false, new Set([org.subsidiaryId]))), amounts(await read(false)));
      assert.deepEqual(await read(false, new Set()), []);
      assert.deepEqual(await read(true, new Set([randomUUID()])), []);
      assert.deepEqual(await read(false, null, randomUUID()), []);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  });
});
