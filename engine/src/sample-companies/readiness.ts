import { sampleOperatingPolicy } from "./policy.ts";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { scenarioRecordId, type DemoContext } from "./scenarios.ts";
import { sampleCompanyFeatures } from "./features.ts";

/** Versioned evidence checks count authored workflows, not unrelated rows in a table. */
export async function verifyNativeOperatingEvidence(c: DemoContext): Promise<string[]> {
  const missing: string[] = [];
  const features = sampleCompanyFeatures(c.industryKey);
  const banks = ["operations-bank", "reserve-bank", "payroll-bank", "settlement-bank"].map(key => scenarioRecordId(c, "accounts", key));
  const bankEvidence = (await db.execute<{ accountId: string; lines: number; signed: boolean }>(sql`
    select a.id as "accountId",count(distinct s.id)::int as lines,
      bool_or(r.status='signed_off') as signed from accounts a
    left join bank_statement_lines s on s.org_id=a.org_id and s.account_id=a.id
    left join reconciliations r on r.org_id=a.org_id and r.account_id=a.id
    where a.org_id=${c.orgId} and a.id in (${sql.join(banks.map(id => sql`${id}::uuid`), sql`, `)}) group by a.id
  `)).rows;
  for (const [index, bank] of banks.entries()) {
    const row = bankEvidence.find(row => row.accountId === bank);
    if (!row || row.lines < (index === 0 ? 6 : index === 3 ? 9 : 3) || (!c.memberSample && !row.signed)) missing.push(`native bank statement and reconciliation: ${["operating", "reserve", "payroll", "settlements"][index]}`);
  }
  for (const kind of ["vendor_payment", "customer_payment"]) {
    const payments = (await db.execute<{ count: number }>(sql`
      select count(*)::int as count from documents d where org_id=${c.orgId} and kind=${kind}
      and memo in (${sql.join([1,2,3].map(n => sql`${`Demonstration operating ${kind === "vendor_payment" ? "supplier settlement" : "customer receipt"} ${n}`}`), sql`, `)})
      and (${c.memberSample} or (status='posted' and posted_entry_id is not null
        and exists(select 1 from applications a join journal_lines l on l.org_id=a.org_id and l.id=a.from_line_id
          where a.org_id=d.org_id and l.entry_id=d.posted_entry_id and a.unapplied_at is null)))
    `)).rows[0];
    if (payments?.count !== 3) missing.push(`three native ${kind} settlements`);
  }
  const requirements: Array<{ table: string; keys: string[] }> = [];
  if (features.hrmTraining) requirements.push({ table: "hrm_training_courses", keys: ["course-0", "course-1", "course-2"] });
  if (features.hrmShiftPlanning) requirements.push({ table: "hrm_shift_templates", keys: ["main"] });
  if (features.hrmAttendance) requirements.push({ table: "hrm_attendance_devices", keys: ["main"] });
  if (features.compensationPackages) requirements.push({ table: "payroll_compensation_packages", keys: ["package-0", "package-1", "package-2"] });
  if (features.outboundWebhooks) requirements.push({ table: "webhook_endpoints", keys: ["main"] });
  for (const requirement of requirements) {
    const result = await db.execute<{ count: number }>(sql`select count(*)::int as count from ${sql.identifier(requirement.table)} where org_id=${c.orgId}
      and id in (${sql.join(requirement.keys.map(key => sql`${scenarioRecordId(c, requirement.table, key)}::uuid`), sql`, `)})`);
    if (result.rows[0]?.count !== requirement.keys.length) missing.push(`authored native ${requirement.table} identities`);
  }
  if (features.fieldTickets) {
    const tickets = (await db.execute<{ count: number }>(sql`select count(*)::int as count from field_ticket_labor_snapshots s where s.org_id=${c.orgId}
      and s.field_ticket_id in (${sql.join([1,2,3].map(n => sql`${scenarioRecordId(c,"documents",`operating-detail-${n}`)}::uuid`), sql`, `)})
      and s.superseded_at is null and (select count(*) from field_ticket_labor_lines l join time_entries t on t.org_id=l.org_id and t.id=l.time_entry_id and t.field_ticket_id=l.field_ticket_id
        where l.org_id=s.org_id and l.snapshot_id=s.id)>=3`)).rows[0];
    if (tickets?.count !== 3) missing.push("three site tickets with native labor snapshots linked to project time entries");
  }
  if (features.returnAuthorizations) {
    const returns = (await db.execute<{ count: number; stages: number }>(sql`select count(distinct r.document_id)::int as count,count(distinct r.stage)::int as stages
      from rma_documents r join rma_lines l on l.org_id=r.org_id and l.document_id=r.document_id
      join inventory_movements m on m.org_id=l.org_id and m.id=l.source_issue_movement_id and m.kind='issue' and m.status='posted'
      where r.org_id=${c.orgId} and r.document_id in (${sql.join([1,2,3].map(n => sql`${scenarioRecordId(c,"documents",`operations-return-${n}`)}::uuid`), sql`, `)})`)).rows[0];
    if (returns?.count !== 3 || (!c.memberSample && returns.stages !== 3)) missing.push("three shipment-linked returns with requested, received and rejected native histories");
  }
  if (features.quoteToCash) {
    const terms = (await db.execute<{ count: number }>(sql`select count(*)::int as count from quote_subscription_terms t
      join documents d on d.org_id=t.org_id and d.id=t.quote_id
      join quote_ramp_steps r on r.org_id=t.org_id and r.term_id=t.id
      where t.org_id=${c.orgId} and d.external_source='industry_demo' and d.external_ref in ('operations-quote-1','operations-quote-2','operations-quote-3')`)).rows[0];
    if ((terms?.count ?? 0) < 3) missing.push("three valued subscription quotes with native term schedules");
  }
  if (features.consignment) {
    const custody = (await db.execute<{ count: number }>(sql`select count(*)::int as count from consignment_stock s where org_id=${c.orgId}
      and stock_location_id=${scenarioRecordId(c,"stock_locations","consignment")}
      and exists(select 1 from consignment_events e where e.org_id=s.org_id and e.stock_id=s.id)`)).rows[0];
    if ((custody?.count ?? 0) < 3) missing.push("three supplier custody receipts with native movement evidence");
  }
  if (features.projectProgress) {
    const progress = (await db.execute<{ projects: number; corrected: number }>(sql`select count(distinct p.project_id)::int as projects,
      count(*) filter(where p.reverses_entry_id is not null)::int as corrected
      from project_progress_entries p join project_tasks t on t.org_id=p.org_id and t.id=p.project_task_id and t.project_id=p.project_id
      where p.org_id=${c.orgId} and t.budget_quantity>0 and p.unit=t.budget_unit
      and p.project_id in (${sql.join([1,2,3].map(n => sql`${scenarioRecordId(c,"projects",`operations-project-${n}`)}::uuid`), sql`, `)})`)).rows[0];
    if (progress?.projects !== 3 || !progress.corrected) missing.push("three task-budgeted project progress examples including a native correction");
  }
  if (features.crossBorderTax) {
    const evidence = (await db.execute<{ count: number }>(sql`select count(distinct document_id)::int as count from document_supply_evidence where org_id=${c.orgId}
      and document_id in (${sql.join([1,2,3].map(offset => sampleOperatingPolicy(c.industryKey).postedCustomerInvoices + offset).map(n => sql`${scenarioRecordId(c,"documents",`operations-customer_invoice-${n}`)}::uuid`), sql`, `)})`)).rows[0];
    if (evidence?.count !== 3) missing.push("three draft invoices with native location evidence");
  }
  return missing;
}

/** Financial qualification requires volume, counterparties, periods and settlement diversity. */
export async function verifySampleOperatingHistory(orgId: string, industryKey: string): Promise<string[]> {
  const policy = sampleOperatingPolicy(industryKey);
  const missing: string[] = [];
  for (const [kind, minimum, counterparties] of [["vendor_bill", policy.postedVendorBills, policy.vendors], ["customer_invoice", policy.postedCustomerInvoices, policy.customers]] as const) {
    const row = (await db.execute<{ documents: number; parties: number; months: number; paid: number; partial: number; open: number }>(sql`
      with balances as (
        select d.id,d.party_id,d.document_date,abs(l.txn_amount) as amount,
          coalesce((select sum(a.target_transaction_amount) from applications a where a.org_id=l.org_id and a.to_line_id=l.id and a.unapplied_at is null),0) as applied
        from documents d join journal_entries e on e.org_id=d.org_id and e.id=d.posted_entry_id and e.status='posted'
        join journal_lines l on l.org_id=e.org_id and l.entry_id=e.id and l.is_open_item
        where d.org_id=${orgId} and d.kind=${kind} and d.status='posted'
      ) select count(distinct id)::int as documents,count(distinct party_id)::int as parties,
        count(distinct date_trunc('month',document_date::timestamp))::int as months,
        count(*) filter(where amount=applied)::int as paid,
        count(*) filter(where applied>0 and applied<amount)::int as partial,
        count(*) filter(where applied=0)::int as open from balances
    `)).rows[0];
    if (!row || row.documents < minimum || row.parties < counterparties || row.months < policy.historyMonths || !row.paid || !row.partial || !row.open) {
      missing.push(`${kind}: requires ${minimum} posted records, ${counterparties} counterparties, ${policy.historyMonths} accounting months, and paid, part-paid and open examples`);
    }
  }
  return missing;
}
