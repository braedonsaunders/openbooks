import { sql, type SQL } from "drizzle-orm";
import { subsidiaryVisibleFilter } from "../organization/subsidiary-scope.ts";

/**
 * The single valuation of unbilled project work (approved billable time and
 * billable cost lines) at the price its project-type policy will bill it.
 * WIP analytics and the period-end unbilled revenue accrual both read this
 * one definition, so the amount a reviewer sees as unbilled work and the
 * amount the ledger accrues can never disagree on pricing.
 *
 * Two populations share the pricing:
 *
 * - `open` is today's WIP: sources not yet billed. A source held or reserved
 *   on an open prebill worksheet contributes nothing to `available_value`
 *   (the worksheet's own proposal already claims it), and a not-to-exceed
 *   ceiling nets every non-voided invoice and every open worksheet.
 *
 * - `as_of` is the work performed by a period end that had not been invoiced
 *   by that date: a source dated on or before the period end that is either
 *   unbilled now, or was billed by a non-voided invoice dated after the period
 *   end. Worksheet reservation does not change that fact, so reserved sources
 *   count. Held sources are excluded exactly as WIP aging excludes them — a
 *   hold records that the work is not expected to bill as captured. Credits
 *   (non-positive values) are excluded the way prebilling excludes them; they
 *   bill through credit documents. Only projects whose effective invoicing
 *   profile bills source lines and recognizes revenue as invoiced are in
 *   scope; percent-complete and milestone recognition already carry their own
 *   contract asset. The ceiling nets only invoices dated on or before the
 *   period end, and a ceiling that was never entered is no ceiling.
 *
 * The fragment ends with the `eligible_sources` CTE; callers append their
 * own `select ... from eligible_sources`. `capped_available_value` is the
 * unbilled value after the ceiling.
 */
export type WipSourcePopulation =
  | { kind: "open" }
  | { kind: "as_of"; periodEnd: string };

/** Effective invoicing-profile attribute: project overrides customer overrides
 *  project type, an absent or null override defers (resolveInvoicingProfile). */
function effectiveInvoicing(key: "billingProcedure" | "lineBuilder" | "recognition" | "revenueAccount" | "notToExceed"): SQL {
  const field = sql`${key}::text`;
  return sql`(coalesce(
    nullif(project.invoicing_profile->${field}, 'null'::jsonb),
    nullif(customer.invoicing_profile->${field}, 'null'::jsonb),
    type.invoicing_profile->${field}) #>> '{}')`;
}

export function eligibleWipSourcesSql(
  orgId: string,
  scope: ReadonlySet<string> | null,
  population: WipSourcePopulation = { kind: "open" },
): SQL {
  const asOf = population.kind === "as_of" ? population.periodEnd : null;
  // A billed source still counts as unbilled at the period end when the
  // invoice that billed it is live and dated after that period end.
  const billedAfterPeriodEnd = (billingLine: SQL) => sql`exists (
    select 1 from document_lines billing_line
      join documents billing_invoice
        on billing_invoice.org_id = billing_line.org_id and billing_invoice.id = billing_line.document_id
     where billing_line.org_id = ${orgId} and billing_line.id = ${billingLine}
       and billing_invoice.status <> 'voided'
       and billing_invoice.document_date > ${asOf}::date)`;
  const timeUnbilled = asOf === null
    ? sql`te.billing_status = 'unbilled'`
    : sql`te.worked_on <= ${asOf}::date
         and (te.billing_status = 'unbilled' or ${billedAfterPeriodEnd(sql`te.invoiced_by_line_id`)})`;
  const lineUnbilled = asOf === null
    ? sql`line.billed_by_line_id is null`
    : sql`document.document_date <= ${asOf}::date
         and (line.billed_by_line_id is null or ${billedAfterPeriodEnd(sql`line.billed_by_line_id`)})`;
  const projectScope = asOf === null
    ? sql`coalesce(type.invoicing_profile->>'billingProcedure', 'standard') = 'standard'
         and type.invoicing_profile->>'lineBuilder' in ('tm_actual', 'cost_plus')
         and (type.invoicing_profile->'allowedBases' ? 'time_selection'
           or type.invoicing_profile->'allowedBases' ? 'date_range')`
    : sql`coalesce(${effectiveInvoicing("billingProcedure")}, 'standard') = 'standard'
         and ${effectiveInvoicing("lineBuilder")} in ('tm_actual', 'cost_plus')
         and ${effectiveInvoicing("recognition")} = 'as_invoiced'
         and coalesce(${effectiveInvoicing("revenueAccount")}, 'item_income') <> 'unbilled_receivable'`;
  const reserved = asOf === null
    ? sql`exists(select 1 from prebill_lines reserved
                      join prebills worksheet on worksheet.org_id=reserved.org_id and worksheet.id=reserved.prebill_id
                     where reserved.org_id=${orgId} and reserved.source_type=source.source_type
                       and coalesce(reserved.time_entry_id,reserved.document_line_id)=source.source_id
                       and worksheet.status in ('draft','review','approved','customer_review'))`
    : sql`false`;
  const availableValue = asOf === null
    ? sql`case when source.held or source.reserved then 0 else source.source_value end`
    : sql`case when source.held or source.source_value <= 0 then 0 else source.source_value end`;
  const invoicePopulation = sql`line.org_id=${orgId}
    and invoice.status<>'voided'
    ${asOf === null ? sql`` : sql`and invoice.document_date <= ${asOf}::date`}
    and invoice.kind = any(array(select jsonb_array_elements_text(
      coalesce(source.profile#>'{invoicedToDate,docKinds}','["customer_invoice"]'::jsonb)
      || coalesce(source.profile#>'{invoicedToDate,creditKinds}','["customer_credit"]'::jsonb))))`;
  // Disjoint branches preserve line-level project precedence while allowing
  // both project and document indexes to bound the ceiling's billed population.
  const invoicedToDate = sql`coalesce((
    select sum(case when billed.kind = any(array(select jsonb_array_elements_text(
      coalesce(source.profile#>'{invoicedToDate,creditKinds}','["customer_credit"]'::jsonb))))
      then -billed.amount else billed.amount end)
    from (
      select line.amount, invoice.kind
        from document_lines line
        join documents invoice on invoice.org_id=line.org_id and invoice.id=line.document_id
       where ${invoicePopulation} and line.project_id=source.project_id
      union all
      select line.amount, invoice.kind
        from document_lines line
        join documents invoice on invoice.org_id=line.org_id and invoice.id=line.document_id
       where ${invoicePopulation} and line.project_id is null and invoice.project_id=source.project_id
    ) billed
  ),0)`;
  const remainingCap = asOf === null
    ? sql`case when source.profile#>>'{totalPrice,method}' = 'not_to_exceed' then greatest(
               coalesce(source.contract_value,0)
               - ${invoicedToDate}
               - coalesce((select sum(worksheet.proposed_bill_amount) from prebills worksheet
                            where worksheet.org_id=${orgId} and worksheet.project_id=source.project_id
                              and worksheet.status in ('draft','review','approved','customer_review')),0),
               0
             ) else null end`
    : sql`case when (source.profile#>>'{totalPrice,method}' = 'not_to_exceed' or source.invoicing_not_to_exceed)
                    and coalesce(source.contract_value, 0) > 0
               then greatest(source.contract_value - ${invoicedToDate}, 0)
               else null end`;

  return sql`
    with raw_sources as (
      select 'time_entry'::text as source_type, te.id as source_id, te.project_id,
             te.worked_on as source_date, te.hours::numeric as quantity,
             round(te.hours * coalesce(te.cost_rate, 0), 4) as direct_cost,
             round(te.hours * coalesce(te.bill_rate, item.default_rate, 0), 4) as native_bill,
             null::text as document_kind, null::text as document_status,
             te.item_id, item.name as item_name, item.income_account_id,
             te.bill_rate_currency as source_currency
        from time_entries te
        left join items item on item.org_id = te.org_id and item.id = te.item_id
       where te.org_id = ${orgId} and te.status = 'approved' and te.is_billable
         and ${timeUnbilled}
      union all
      select 'document_line'::text, line.id, coalesce(line.project_id, document.project_id),
             document.document_date, case when document.kind = 'project_charge' then line.quantity else 1 end,
             case when document.kind = 'project_charge' then coalesce(line.cost_amount, line.amount)
                  when document.kind in ('vendor_credit', 'card_refund') then -line.amount else line.amount end,
             case when document.kind = 'project_charge' then coalesce(line.bill_amount, 0)
                  when line.bill_amount is not null then case when document.kind in ('vendor_credit', 'card_refund') then -line.bill_amount else line.bill_amount end
                  when line.markup_percent is not null then round((case when document.kind in ('vendor_credit', 'card_refund') then -line.amount else line.amount end) * (1 + line.markup_percent / 100), 4)
                  else round((case when document.kind in ('vendor_credit', 'card_refund') then -line.amount else line.amount end) * coalesce(nullif(line.cost_multiplier, 0), 1), 4) end,
             document.kind, document.status,
             line.item_id, item.name, item.income_account_id,
             document.currency
        from document_lines line
        join documents document on document.org_id = line.org_id and document.id = line.document_id
        left join items item on item.org_id = line.org_id and item.id = line.item_id
       where line.org_id = ${orgId} and line.is_billable and ${lineUnbilled}
         and coalesce(line.project_id, document.project_id) is not null
    ), policy_sources as (
      select source.*, project.contract_value,
             coalesce((project.custom->>'markupPercent')::numeric, 0) as project_markup,
             type.invoicing_profile,
             coalesce(version.financial_profile, latest.financial_profile) as profile,
             project.subsidiary_id as project_subsidiary_id,
             coalesce(${effectiveInvoicing("revenueAccount")}, 'item_income') as invoicing_revenue_account,
             coalesce(${effectiveInvoicing("notToExceed")} = 'true', false) as invoicing_not_to_exceed
        from raw_sources source
        join projects project on project.org_id = ${orgId} and project.id = source.project_id
          and project.status not in ('closed', 'cancelled')
          ${subsidiaryVisibleFilter(sql`project.subsidiary_id`, scope)}
        join project_types type on type.org_id = ${orgId} and type.id = project.project_type_id and type.is_active
        left join parties customer on customer.org_id = project.org_id and customer.id = project.customer_id
        left join lateral (
          select policy.financial_profile
            from project_financial_profile_versions policy
           where policy.org_id = ${orgId} and policy.project_type_id = type.id
             and policy.effective_from <= source.source_date
             and (policy.effective_to is null or policy.effective_to >= source.source_date)
           order by policy.effective_from desc limit 1
        ) version on true
        left join lateral (
          select policy.financial_profile
            from project_financial_profile_versions policy
           where policy.org_id = ${orgId} and policy.project_type_id = type.id
           order by policy.effective_from desc limit 1
        ) latest on true
       where latest.financial_profile is not null
         and ${projectScope}
    ), valued_sources as (
      select source.*,
             case when source.profile#>>'{billableValue,timeRate}' = 'cost_times_markup'
                  then round(source.direct_cost * (1 + coalesce(nullif(source.project_markup, 0), nullif(source.profile#>>'{totalPrice,defaultMarkupPercent}', '')::numeric, 0) / 100), 4)
                  else source.native_bill end as source_value,
             exists(select 1 from prebill_holds hold where hold.org_id=${orgId}
                      and hold.source_type=source.source_type and hold.source_id=source.source_id
                      and hold.released_at is null) as held,
             ${reserved} as reserved
        from policy_sources source
       where (source.source_type='time_entry'
              and coalesce((source.profile#>>'{billableValue,includeUnbilledTime}')::boolean, true))
          or (source.source_type='document_line'
              and coalesce((source.profile#>>'{billableValue,includeUnbilledCostLines}')::boolean, true)
              and (source.document_kind='project_charge'
                   or coalesce(source.profile#>'{billableValue,costSourceKinds}', '["vendor_bill","expense_report","card_charge","check"]'::jsonb) ? source.document_kind)
              and coalesce(source.profile#>'{billableValue,costSourceStatuses}', '["approved","posted"]'::jsonb) ? source.document_status)
    ), available_sources as (
      select source.*,
             ${availableValue} as available_value,
             ${remainingCap} as remaining_cap
        from valued_sources source
    ), ordered_sources as (
      select source.*,
             coalesce(sum(source.available_value) over (
               partition by source.project_id order by source.source_date, source.source_type, source.source_id
               rows between unbounded preceding and 1 preceding
             ),0) as prior_available
        from available_sources source
    ), eligible_sources as (
      select source.*,
             case when source.remaining_cap is null then source.available_value
                  when source.available_value < 0 then source.available_value
                  else greatest(least(source.available_value, source.remaining_cap-source.prior_available),0) end as capped_available_value
        from ordered_sources source
    )
  `;
}
