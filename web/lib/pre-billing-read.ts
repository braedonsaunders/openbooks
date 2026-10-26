import "server-only";
import { eligibleWipSourcesSql } from "@openbooks/engine/projects/wip-sources";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/platform/db";
import { businessToday } from "@openbooks/engine/platform/business-date/module";
import { add } from "@openbooks/engine/money/money";
import { documentRevisionCounterSql } from "@openbooks/engine/records/revision";
import {
  lockProjectForScope,
  ScopeNotFoundError,
  withScopeSnapshot,
} from "@openbooks/engine/organization/scope";
import { subsidiaryVisibleFilter } from "./subsidiaries";
import type { InvoicingProfile } from "@openbooks/schema";
import { sourceLinePrebillingReason } from "./pre-billing-policy";
import { prebillStage } from "./pre-billing-stages";
import {
  type PreBillingProjectOption,
  type PrebillDetail,
  type PrebillLineRow,
  type PrebillListRow,
  type SubsidiaryScope,
  assertPreBillingEnabled,
  requireDate,
} from "./pre-billing-core";

type PrebillListSqlRow = Omit<PrebillListRow, "stage" | "customerReviewRequired"> & {
  customerReview: string | null;
};

export async function listPrebills(
  orgId: string,
  projectId?: string,
  scope: SubsidiaryScope = null,
): Promise<PrebillListRow[]> {
  await assertPreBillingEnabled(orgId);
  const result = await db.execute<PrebillListSqlRow>(
    sql`
    select worksheet.id,
           worksheet.worksheet_number as "worksheetNumber",
           worksheet.project_id as "projectId",
           project.name as "projectName",
           customer.display_name as "customerName",
           type.name as "projectTypeName",
           worksheet.period_start::text as "periodStart",
           worksheet.period_end::text as "periodEnd",
           worksheet.status,
           worksheet.original_bill_amount::text as "originalBillAmount",
           worksheet.proposed_bill_amount::text as "proposedBillAmount",
           worksheet.cost_amount::text as "costAmount",
           worksheet.adjustment_amount::text as "adjustmentAmount",
           worksheet.billing_request_id as "billingRequestId",
           worksheet.invoice_document_id as "invoiceDocumentId",
           invoice.document_number as "invoiceNumber",
           invoice.status as "invoiceStatus",
           invoice.total::text as "invoiceTotal",
           invoice.open_balance::text as "invoiceOpenBalance",
           worksheet.created_at as "createdAt",
           coalesce(lines.bill_lines, 0) as "lineCount",
           coalesce(lines.held_lines, 0) as "heldLineCount",
           coalesce(lines.disputed_lines, 0) as "disputedLineCount",
           worksheet.custom #>> '{policy,customerReview}' as "customerReview",
           worksheet.customer_review_sent_at as "customerReviewSentAt",
           worksheet.customer_decision as "customerDecision",
           worksheet.customer_decided_at as "customerDecidedAt",
           worksheet.customer_signer_name as "customerSignerName",
           worksheet.customer_decision_note as "customerDecisionNote",
           worksheet.customer_po_number as "customerPoNumber",
           worksheet.customer_viewed_at as "customerViewedAt",
           worksheet.delivered_at as "deliveredAt"
      from prebills worksheet
      join projects project on project.org_id = worksheet.org_id and project.id = worksheet.project_id
      left join project_types type on type.org_id = project.org_id and type.id = project.project_type_id
      left join parties customer on customer.org_id = project.org_id and customer.id = project.customer_id
      left join documents invoice on invoice.org_id = worksheet.org_id and invoice.id = worksheet.invoice_document_id
      left join lateral (
        select count(*) filter (where line.disposition = 'bill')::int as bill_lines,
               count(*) filter (where line.disposition = 'hold')::int as held_lines,
               count(*) filter (where nullif(btrim(line.customer_dispute_note), '') is not null)::int as disputed_lines
          from prebill_lines line
         where line.org_id = worksheet.org_id and line.prebill_id = worksheet.id
      ) lines on true
     where worksheet.org_id = ${orgId}
       and (${projectId ?? null}::uuid is null or worksheet.project_id = ${projectId ?? null})
       ${subsidiaryVisibleFilter(sql`project.subsidiary_id`, scope)}
     order by worksheet.created_at desc
  `,
    "objects",
  );
  // Instants leave as ISO strings: the board and the portal-facing notices
  // render them client side, and node-pg hands timestamptz back as Date.
  const iso = (value: unknown): string | null =>
    value == null ? null : value instanceof Date ? value.toISOString() : String(value);
  return result.map(({ customerReview, ...row }) => ({
    ...row,
    createdAt: iso(row.createdAt)!,
    customerReviewSentAt: iso(row.customerReviewSentAt),
    customerDecidedAt: iso(row.customerDecidedAt),
    customerViewedAt: iso(row.customerViewedAt),
    deliveredAt: iso(row.deliveredAt),
    stage: prebillStage(row),
    customerReviewRequired: customerReview === "required",
  }));
}

export async function loadPrebill(
  orgId: string,
  id: string,
  scope: SubsidiaryScope = null,
): Promise<PrebillDetail | null> {
  await assertPreBillingEnabled(orgId);
  // One REPEATABLE READ snapshot for header + details, with the project
  // locked (share) and scope rechecked inside it: a concurrent A→B rehome
  // between the header read and the detail reads refuses as not-found
  // instead of disclosing B's lines, events and totals.
  return withScopeSnapshot(orgId, async () => {
    const headers = await listPrebills(orgId, undefined, scope);
    const header = headers.find((row) => row.id === id);
    if (!header) return null;
    try {
      await lockProjectForScope(db, orgId, header.projectId, scope, "share");
    } catch (error) {
      if (error instanceof ScopeNotFoundError) return null;
      throw error;
    }
    const [lineResult, eventResult, detailResult] = await Promise.all([
      db.execute<PrebillLineRow>(
        sql`
      select line.id, line.line_number as "lineNumber", line.source_type as "sourceType",
             line.time_entry_id as "timeEntryId", line.document_line_id as "documentLineId",
             line.source_document_id as "sourceDocumentId", line.source_date::text as "sourceDate",
             line.description, line.quantity::text, line.unit, line.cost_amount::text as "costAmount",
             line.original_bill_amount::text as "originalBillAmount",
             line.proposed_bill_amount::text as "proposedBillAmount",
             line.adjustment_amount::text as "adjustmentAmount",
             line.adjustment_reason as "adjustmentReason",
             line.adjustment_evidence as "adjustmentEvidence",
             line.pricing_snapshot as "pricingSnapshot", line.disposition,
             line.customer_dispute_note as "customerDisputeNote",
             ${documentRevisionCounterSql(sql`line.revision_seq`)} as "updatedAt",
             hold.id as "holdId", hold.reason as "holdReason"
        from prebill_lines line
        left join lateral (
          select id, reason from prebill_holds
           where org_id = line.org_id and source_type = line.source_type
             and source_id = coalesce(line.time_entry_id, line.document_line_id)
             and released_at is null
           order by held_at desc limit 1
        ) hold on true
       where line.org_id = ${orgId} and line.prebill_id = ${id}
       order by line.line_number
    `,
        "objects",
      ),
      db.execute<PrebillDetail["events"][number]>(
        sql`
      select event.id, event.event_type as "eventType", coalesce(actor.name, actor.email) as "actorName",
             event.occurred_at as "occurredAt", event.details
        from prebill_events event
        left join users actor on actor.id = event.actor_id
       where event.org_id = ${orgId} and event.prebill_id = ${id}
       order by event.occurred_at, event.id
    `,
        "objects",
      ),
      db.execute<
        Pick<
          PrebillDetail,
          "notes" | "submittedAt" | "approvedAt" | "convertedAt" | "voidedAt" | "voidReason"
        >
      >(
        sql`
      select notes, submitted_at as "submittedAt", approved_at as "approvedAt",
             converted_at as "convertedAt", voided_at as "voidedAt", void_reason as "voidReason"
        from prebills where org_id = ${orgId} and id = ${id}
    `,
        "objects",
      ),
    ]);
    return { ...header, ...detailResult[0]!, lines: lineResult, events: eventResult };
  });
}

export interface PreBillingAnalytics {
  aging: {
    current: string;
    days1to30: string;
    days31to60: string;
    days61to90: string;
    over90: string;
    held: string;
  };
  realization: { original: string; billed: string; adjustment: string; percent: number | null };
  leakage: { writeDowns: string; heldOver90: string; total: string };
}

/** Pre-billing analytics read the one engine valuation of unbilled project work. */
function eligiblePreBillingSources(orgId: string, scope: SubsidiaryScope) {
  return eligibleWipSourcesSql(orgId, scope);
}

export async function preBillingAnalytics(
  orgId: string,
  asOf?: string,
  scope: SubsidiaryScope = null,
): Promise<PreBillingAnalytics> {
  await assertPreBillingEnabled(orgId);
  const asOfDate = asOf ?? (await businessToday(orgId));
  requireDate(asOfDate, "As-of date");
  const [agingResult, realizationResult, leakageResult] = await Promise.all([
    db.execute<PreBillingAnalytics["aging"]>(
      sql`
      ${eligiblePreBillingSources(orgId, scope)}
      select coalesce(sum(capped_available_value) filter (where ${asOfDate}::date-source_date <= 0),0)::text as current,
             coalesce(sum(capped_available_value) filter (where ${asOfDate}::date-source_date between 1 and 30),0)::text as "days1to30",
             coalesce(sum(capped_available_value) filter (where ${asOfDate}::date-source_date between 31 and 60),0)::text as "days31to60",
             coalesce(sum(capped_available_value) filter (where ${asOfDate}::date-source_date between 61 and 90),0)::text as "days61to90",
             coalesce(sum(capped_available_value) filter (where ${asOfDate}::date-source_date > 90),0)::text as "over90",
             coalesce(sum(source_value) filter (where held),0)::text as held
        from eligible_sources
    `,
      "objects",
    ),
    db.execute<{ original: string; billed: string; adjustment: string }>(
      sql`
      select coalesce(sum(worksheet.original_bill_amount),0)::text as original,
             coalesce(sum(worksheet.proposed_bill_amount),0)::text as billed,
             coalesce(sum(worksheet.adjustment_amount),0)::text as adjustment
        from prebills worksheet
        join projects project on project.org_id=worksheet.org_id and project.id=worksheet.project_id
       where worksheet.org_id=${orgId} and worksheet.status='converted'
         ${subsidiaryVisibleFilter(sql`project.subsidiary_id`, scope)}
    `,
      "objects",
    ),
    db.execute<{ write_downs: string }>(
      sql`
      select coalesce(sum(-line.adjustment_amount) filter (where line.adjustment_amount < 0),0)::text as write_downs
        from prebill_lines line
        join prebills worksheet on worksheet.org_id=line.org_id and worksheet.id=line.prebill_id
        join projects project on project.org_id=worksheet.org_id and project.id=worksheet.project_id
       where line.org_id=${orgId} and worksheet.status in ('approved','converted')
         ${subsidiaryVisibleFilter(sql`project.subsidiary_id`, scope)}
    `,
      "objects",
    ),
  ]);
  const aging = agingResult[0] ?? {
    current: "0",
    days1to30: "0",
    days31to60: "0",
    days61to90: "0",
    over90: "0",
    held: "0",
  };
  const realization = realizationResult[0] ?? { original: "0", billed: "0", adjustment: "0" };
  const original = Number(realization.original);
  const percent = original === 0 ? null : Number(realization.billed) / original;
  const heldOver90Result = await db.execute<{ amount: string }>(
    sql`
    ${eligiblePreBillingSources(orgId, scope)}
    select coalesce(sum(source_value) filter (where held and ${asOfDate}::date-source_date > 90),0)::text as amount
      from eligible_sources
  `,
    "objects",
  );
  const writeDowns = leakageResult[0]?.write_downs ?? "0";
  const heldOver90 = heldOver90Result[0]?.amount ?? "0";
  return {
    aging,
    realization: { ...realization, percent },
    leakage: { writeDowns, heldOver90, total: add(writeDowns, heldOver90) },
  };
}

export async function listPreBillingProjects(
  orgId: string,
  scope: SubsidiaryScope = null,
): Promise<PreBillingProjectOption[]> {
  await assertPreBillingEnabled(orgId);
  const result = await db.execute<{
    id: string;
    name: string;
    customerName: string | null;
    projectTypeName: string;
    invoicingProfile: InvoicingProfile;
  }>(
    sql`
    select project.id, project.name, customer.display_name as "customerName",
           type.name as "projectTypeName", type.invoicing_profile as "invoicingProfile"
      from projects project
      left join parties customer on customer.org_id=project.org_id and customer.id=project.customer_id
      join project_types type on type.org_id=project.org_id and type.id=project.project_type_id and type.is_active
     where project.org_id=${orgId} and project.status not in ('closed','cancelled')
       ${subsidiaryVisibleFilter(sql`project.subsidiary_id`, scope)}
     order by project.name
  `,
    "objects",
  );
  return result.flatMap((row) =>
    sourceLinePrebillingReason(row.invoicingProfile) == null
      ? [
          {
            id: row.id,
            name: row.name,
            customerName: row.customerName,
            projectTypeName: row.projectTypeName,
            lineBuilder: row.invoicingProfile.lineBuilder,
          },
        ]
      : [],
  );
}

export type UnbilledProjectRow = {
  projectId: string;
  projectName: string;
  customerName: string | null;
  projectTypeName: string;
  unbilledAmount: string;
  sourceCount: number;
  oldestWorkDate: string;
};

/**
 * Read scoped project choices and unclaimed work together, so the workspace
 * uses the same eligible-project population for its board and bill-run form.
 */
export async function listPreBillingWorkspaceSources(
  orgId: string,
  scope: SubsidiaryScope = null,
): Promise<{
  projects: PreBillingProjectOption[];
  unbilled: UnbilledProjectRow[];
}> {
  await assertPreBillingEnabled(orgId);
  const [projects, result] = await Promise.all([
    listPreBillingProjects(orgId, scope),
    db.execute<UnbilledProjectRow>(
      sql`
    ${eligiblePreBillingSources(orgId, scope)}
    select source.project_id as "projectId", project.name as "projectName",
           customer.display_name as "customerName", coalesce(type.name, '') as "projectTypeName",
           sum(source.capped_available_value)::text as "unbilledAmount",
           count(*)::int as "sourceCount",
           min(source.source_date)::text as "oldestWorkDate"
      from eligible_sources source
      join projects project on project.org_id = ${orgId} and project.id = source.project_id
      left join project_types type on type.org_id = project.org_id and type.id = project.project_type_id
      left join parties customer on customer.org_id = project.org_id and customer.id = project.customer_id
     where source.capped_available_value > 0
     group by source.project_id, project.name, customer.display_name, type.name
     order by min(source.source_date), project.name
  `,
      "objects",
    ),
  ]);
  const eligible = new Set(projects.map((project) => project.id));
  return { projects, unbilled: result.filter((row) => eligible.has(row.projectId)) };
}

export async function listUnbilledProjects(
  orgId: string,
  scope: SubsidiaryScope = null,
): Promise<UnbilledProjectRow[]> {
  return (await listPreBillingWorkspaceSources(orgId, scope)).unbilled;
}
