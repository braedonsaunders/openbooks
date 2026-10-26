import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/platform/db";
import { cmp } from "@openbooks/engine/money/money";
import {
  capPreBillingSources,
  effectivePreBillingPolicy,
  pricePreBillingSource,
  sourceLinePrebillingReason,
} from "./pre-billing-policy";
import {
  type CreatePrebillInput,
  type OverheadRateRow,
  PreBillingError,
  type RawPreBillingSource,
  type SubsidiaryScope,
  appendEvent,
  assertPreBillingEnabledTx,
  audit,
  loadProjectPolicy,
  rateEngineOverhead,
  refreshTotals,
  remainingContractCapacity,
  requireDate,
} from "./pre-billing-core";

/**
 * Snapshot every eligible source through a cutoff. A project advisory lock plus
 * an active-worksheet exclusion prevents two reviewers from reserving the same
 * unbilled work concurrently.
 */
export async function createPrebill(
  orgId: string,
  actorId: string,
  input: CreatePrebillInput,
  scope: SubsidiaryScope = null,
) {
  const periodEnd = requireDate(input.periodEnd, "Period end");
  const periodStart = input.periodStart ? requireDate(input.periodStart, "Period start") : null;
  if (periodStart && periodStart > periodEnd)
    throw new PreBillingError("Period start must be on or before period end");

  return db.transaction(async (tx) => {
    await assertPreBillingEnabledTx(tx, orgId);
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`prebill:${orgId}:${input.projectId}`}, 0))`,
    );
    const policy = await loadProjectPolicy(tx, orgId, input.projectId, true, scope);
    const procedureReason = sourceLinePrebillingReason(policy.invoicingProfile);
    if (procedureReason) throw new PreBillingError(procedureReason);
    const cutoffPolicy = effectivePreBillingPolicy(
      policy.versions,
      policy.fallbackProfile,
      periodEnd,
    );
    const remainingCap = await remainingContractCapacity(tx, orgId, policy, periodEnd);
    if (remainingCap != null && cmp(remainingCap, "0") <= 0) {
      throw new PreBillingError("The project has reached its not-to-exceed contract cap");
    }

    // The project lock above serialises source reservation, but worksheet
    // numbers are unique per ORGANIZATION (prebills_org_number): two
    // creates for different projects would read the same max()+1 and the
    // loser would die on the unique index. This org-scoped lock serialises
    // the read below — the billing-request-number:{org} pattern. (The
    // feature-gate fence taken first also serialises org-wide today, but
    // numbering correctness must not depend on that coincidence.)
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`prebill-number:${orgId}`}, 0))`,
    );
    const numberRow = await tx.execute<{ n: string }>(
      sql`
      select coalesce(max((regexp_replace(worksheet_number, '\\D', '', 'g'))::bigint), 0) as n
        from prebills
       where org_id = ${orgId} and worksheet_number ~ '^PB-[0-9]+$'
    `,
      "objects",
    );
    const worksheetNumber = `PB-${(BigInt(numberRow[0]?.n ?? "0") + 1n).toString().padStart(5, "0")}`;
    const candidates = await tx.execute<RawPreBillingSource>(
      sql`
      with candidates as (
        select 'time_entry'::text as source_type,
               te.id as source_id,
               te.id as time_entry_id,
               null::uuid as document_line_id,
               null::uuid as source_document_id,
               te.worked_on as source_date,
               coalesce(te.memo, item.name, 'Time') as description,
               te.hours as quantity,
               'hours'::text as unit,
               te.item_id,
               item.income_account_id,
               item.tax_code_id,
               te.employee_party_id,
               te.time_type_id,
               te.department_id,
               te.costing_basis,
               null::text as document_kind,
               null::text as document_status,
               round(te.hours * coalesce(te.cost_rate, 0), 4)::text as direct_cost_amount,
               round(te.hours * coalesce(te.bill_rate, item.default_rate, 0), 4)::text as native_bill_amount
          from time_entries te
          left join items item on item.org_id = te.org_id and item.id = te.item_id
         where te.org_id = ${orgId}
           and te.project_id = ${input.projectId}
           and te.status = 'approved'
           and te.is_billable
           and te.billing_status = 'unbilled'
           and te.worked_on <= ${periodEnd}
           and (${periodStart}::date is null or te.worked_on >= ${periodStart})
        union all
        select 'document_line'::text as source_type,
               line.id as source_id,
               null::uuid as time_entry_id,
               line.id as document_line_id,
               doc.id as source_document_id,
               doc.document_date as source_date,
               coalesce(line.description, item.name, doc.document_number) as description,
               case when doc.kind = 'project_charge' then line.quantity else 1 end as quantity,
               line.unit,
               line.item_id,
               item.income_account_id,
               item.tax_code_id,
               null::uuid as employee_party_id,
               null::uuid as time_type_id,
               coalesce(line.department_id, doc.department_id) as department_id,
               null::text as costing_basis,
               doc.kind as document_kind,
               doc.status as document_status,
               (case
                 when doc.kind = 'project_charge' then coalesce(line.cost_amount, line.amount)
                 when doc.kind in ('vendor_credit', 'card_refund') then -line.amount
                 else line.amount
               end)::text as direct_cost_amount,
               case
                 when doc.kind = 'project_charge' then coalesce(line.bill_amount, 0)
                 when line.bill_amount is not null then case when doc.kind in ('vendor_credit', 'card_refund') then -line.bill_amount else line.bill_amount end
                 when line.markup_percent is not null then round((case when doc.kind in ('vendor_credit', 'card_refund') then -line.amount else line.amount end) * (1 + line.markup_percent / 100), 4)
                 else round((case when doc.kind in ('vendor_credit', 'card_refund') then -line.amount else line.amount end) * coalesce(nullif(line.cost_multiplier, 0), 1), 4)
               end::text as native_bill_amount
          from document_lines line
          join documents doc on doc.org_id = line.org_id and doc.id = line.document_id
          left join items item on item.org_id = line.org_id and item.id = line.item_id
         where line.org_id = ${orgId}
           and coalesce(line.project_id, doc.project_id) = ${input.projectId}
           and line.is_billable
           and line.billed_by_line_id is null
           and doc.document_date <= ${periodEnd}
           and (${periodStart}::date is null or doc.document_date >= ${periodStart})
      )
      select candidate.*
        from candidates candidate
       where not exists (
               select 1 from prebill_holds hold
                where hold.org_id = ${orgId}
                  and hold.source_type = candidate.source_type
                  and hold.source_id = candidate.source_id
                  and hold.released_at is null
             )
         and not exists (
               select 1
                 from prebill_lines reserved
                 join prebills worksheet
                   on worksheet.org_id = reserved.org_id and worksheet.id = reserved.prebill_id
                where reserved.org_id = ${orgId}
                  and reserved.source_type = candidate.source_type
                  and coalesce(reserved.time_entry_id, reserved.document_line_id) = candidate.source_id
                  and worksheet.status in ('draft', 'review', 'approved', 'customer_review')
             )
       order by candidate.source_date, candidate.source_type, candidate.source_id
    `,
      "objects",
    );

    const overheadRates = await tx.execute<OverheadRateRow>(
      sql`
      select department_id, rate_kind, rate_percent::text as rate,
             effective_from::text as effective_from, effective_to::text as effective_to
        from overhead_rates
       where org_id = ${orgId}
         and effective_from <= ${periodEnd}
         and (effective_to is null or ${periodStart ?? periodEnd}::date <= effective_to)
       order by effective_from, department_id nulls first, id
    `,
      "objects",
    );

    const priced = candidates.flatMap((source) => {
      const version = effectivePreBillingPolicy(
        policy.versions,
        policy.fallbackProfile,
        source.source_date,
      );
      const calculated = pricePreBillingSource(
        version.financialProfile,
        {
          sourceType: source.source_type,
          sourceDate: source.source_date,
          documentKind: source.document_kind,
          documentStatus: source.document_status,
          directCostAmount: source.direct_cost_amount,
          nativeBillAmount: source.native_bill_amount,
          quantity: source.quantity,
          costingBasis: source.costing_basis,
          rateEngineOverhead: rateEngineOverhead(source, version.financialProfile, overheadRates),
        },
        policy.markupPercent,
      );
      return calculated.eligible ? [{ ...source, ...calculated, policyVersion: version }] : [];
    });
    const billable = capPreBillingSources(priced, remainingCap);
    if (billable.length === 0)
      throw new PreBillingError("No eligible unbilled work matches this project type and cutoff");

    const policySnapshot = {
      projectTypeId: policy.projectTypeId,
      projectTypeKey: policy.projectTypeKey,
      projectTypeName: policy.projectTypeName,
      billingProcedure: policy.invoicingProfile.billingProcedure ?? "standard",
      lineBuilder: policy.invoicingProfile.lineBuilder,
      billingBasis: policy.invoicingProfile.allowedBases.includes("time_selection")
        ? "time_selection"
        : "date_range",
      cutoffProfileVersionId: cutoffPolicy.id,
      cutoffProfileEffectiveFrom: cutoffPolicy.effectiveFrom,
      totalPriceMethod: cutoffPolicy.financialProfile.totalPrice.method,
      contractCap: remainingCap == null ? null : policy.contractValue,
      remainingCapAtCreation: remainingCap,
      customerReview: policy.invoicingProfile.customerReview ?? "optional",
    };
    const created = await tx.execute<{ id: string; worksheetNumber: string }>(
      sql`
      insert into prebills (
        org_id, project_id, worksheet_number, period_start, period_end, notes,
        status, custom, created_by, updated_by
      ) values (
        ${orgId}, ${input.projectId}, ${worksheetNumber}, ${periodStart}, ${periodEnd},
        ${input.notes?.trim() || null}, 'draft', ${JSON.stringify({ policy: policySnapshot })}::jsonb,
        ${actorId}, ${actorId}
      ) returning id, worksheet_number as "worksheetNumber"
    `,
      "objects",
    );
    const prebill = created[0]!;

    let lineNumber = 1;
    for (const source of billable) {
      const pricingSnapshot = {
        projectFinancialProfileVersionId: source.policyVersion.id,
        projectFinancialProfileEffectiveFrom: source.policyVersion.effectiveFrom,
        pricingMode: source.pricingMode,
        markupPercent: source.markupPercent,
        nativeBillAmount: source.native_bill_amount,
        uncappedBillAmount: source.billAmount,
        directCostAmount: source.directCostAmount,
        overheadAmount: source.overheadAmount,
      };
      await tx.execute(sql`
        insert into prebill_lines (
          org_id, prebill_id, project_id, line_number, source_type, time_entry_id,
          document_line_id, source_document_id, source_date, description, quantity, unit,
          item_id, income_account_id, tax_code_id, employee_party_id, time_type_id,
          department_id, cost_amount, original_bill_amount, proposed_bill_amount,
          adjustment_amount, pricing_snapshot, disposition, created_by, updated_by
        ) values (
          ${orgId}, ${prebill.id}, ${input.projectId}, ${lineNumber++}, ${source.source_type},
          ${source.time_entry_id}, ${source.document_line_id}, ${source.source_document_id},
          ${source.source_date}, ${source.description}, ${source.quantity}, ${source.unit},
          ${source.item_id}, ${source.income_account_id}, ${source.tax_code_id},
          ${source.employee_party_id}, ${source.time_type_id}, ${source.department_id},
          ${source.loadedCostAmount}, ${source.cappedBillAmount}, ${source.cappedBillAmount}, '0',
          ${JSON.stringify(pricingSnapshot)}::jsonb, 'bill',
          ${actorId}, ${actorId}
        )
      `);
    }
    await refreshTotals(tx, orgId, prebill.id, actorId);
    await appendEvent(tx, orgId, prebill.id, actorId, "created", {
      sourceCount: billable.length,
      periodStart,
      periodEnd,
      policy: policySnapshot,
    });
    await audit(tx, orgId, "prebills", prebill.id, actorId, {
      after: { worksheetNumber, status: "draft", policy: policySnapshot },
    });
    return { ...prebill, sourceCount: billable.length };
  });
}
