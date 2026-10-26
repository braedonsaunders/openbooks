import { loadStoredHolidayFacts } from "./holiday-facts-store.ts";

import {
  statutoryHolidayEmploymentSource,
  type StatutoryHolidayEmploymentSource,
} from "./holidays.ts";

import { currentOpeningLevySourceSql } from "./opening-levy-source-correction-authority.ts";

import {
  resolveCaBonusIncomeReference,
  type CaBonusIncomeReferenceScope,
  type CaBonusIncomeReferenceSource,
} from "./canada/bonus-income-reference.ts";

import { PayrollError } from "./error.ts";

import { historicalEmploymentRosterSource } from "./employment-roster.ts";

import { employeeEmployerAssignmentHistory } from "./employer-assignment-history.ts";

import { compensationPackageRunSource } from "./compensation-package-source.ts";

import { holidayObligationRunSource } from "./holiday-obligation-source.ts";

import { type PayrollSubsidiaryScope } from "./scope.ts";

import { sql } from "drizzle-orm";

import { db } from "../platform/db.ts";

import {
  type OpeningEmployerAuthoritySource,
  type OpeningLevySourceAuthoritySource,
  type OpeningBalanceSourceState,
  isOpeningEmployerAuthoritySource,
  isOpeningLevySourceAuthoritySource,
  type PayRunCalculationSourceSnapshot,
  type EntitlementSettlementPlanSource,
  isEntitlementSettlementPlanSource,
  type UsFilingAccountLineageSource,
  isUsFilingAccountLineageSource,
  type CalculationSourceRow,
} from "./run-calculation-source-shape.ts";

export {
  canonicalJson,
  payRunCalculationSourceDigest,
  parsePayRunCalculationSource,
} from "./run-calculation-source-shape.ts";
export type {
  OpeningEmployerAuthoritySource,
  IncomeTaxOverrideSource,
  EmployerLevyAdjustmentSource,
  BankCashInputSource,
  DeclaredVacationAccrualSource,
  OpeningLevySourceAuthoritySource,
  OpeningBalanceSourceState,
  PayRunCalculationSourceSnapshot,
} from "./run-calculation-source-shape.ts";
export {
  payRunCalculationSourceChanges,
  payRunCalculationRefusals,
  payRunRefusalDigest,
  parsePayRunCalculationErrors,
  parsePayRunRefusalAcknowledgement,
} from "./run-calculation-refusals.ts";
export type {
  PayRunCalculationError,
  PayRunRefusalAcknowledgement,
} from "./run-calculation-refusals.ts";

/**
 * Re-derive the exact calculation population. The locked form is the commit
 * fence: every existing source row is held through the exact-ID claim and the
 * terminal transition. A new row that becomes visible after this statement's
 * PostgreSQL snapshot is later than the fence and is never claimed by this
 * run; every row visible at the fence must match the stored calculation.
 *
 * The three source CTEs deliberately share ONE SQL statement so their reads
 * cannot be torn across READ COMMITTED snapshots. Calculation runs under
 * REPEATABLE READ as an additional guarantee that these final evidence rows
 * are the same versions its earlier per-stub reads consumed.
 */

/**
 * The tail of calculation-source assembly: opening balances, rosters, and the snapshot.
 *
 * Split from payRunCalculationSource so each operation stays within the line bound.
 */
export async function assemblePayRunCalculationSource(args: {
  orgId: string;
  documentId: string;
  executor: Pick<typeof db, "execute">;
  lockSources: boolean;
  allowedSubsidiaryIds?: PayrollSubsidiaryScope;
  calculatedBonusReferences?: readonly CaBonusIncomeReferenceSource[];
  row: CalculationSourceRow;
  incomeTaxOverrides: PayRunCalculationSourceSnapshot["incomeTaxOverrides"];
  employerLevyAdjustments: PayRunCalculationSourceSnapshot["employerLevyAdjustments"];
  bankCashInputs: PayRunCalculationSourceSnapshot["bankCashInputs"];
  declaredVacationAccruals: PayRunCalculationSourceSnapshot["declaredVacationAccruals"];
  assignmentRunPolicies: PayRunCalculationSourceSnapshot["assignmentRunPolicies"];
  payComponentStatutoryTreatments: PayRunCalculationSourceSnapshot["payComponentStatutoryTreatments"];
}): Promise<PayRunCalculationSourceSnapshot> {
  const {
    orgId,
    documentId,
    executor,
    lockSources,
    allowedSubsidiaryIds,
    calculatedBonusReferences,
    row,
    incomeTaxOverrides,
    employerLevyAdjustments,
    bankCashInputs,
    declaredVacationAccruals,
    assignmentRunPolicies,
    payComponentStatutoryTreatments,
  } = args;
  const openingRows = await executor.execute<OpeningEmployerAuthoritySource & { matches: boolean }>(
    sql`
    select a.id::text,a.opening_balance_id::text as "openingBalanceId",a.employee_party_id::text as "employeePartyId",
      a.tax_year as "taxYear",a.subsidiary_id::text as "subsidiaryId",a.source_file_id::text as "sourceFileId",
      a.source_version_id::text as "sourceVersionId",a.source_sha256 as "sourceSha256",a.opening_sha256 as "openingSha256",
      (a.opening_snapshot=to_jsonb(b)
        and a.opening_sha256=encode(public.digest(to_jsonb(b)::text,'sha256'),'hex')) as matches
    from payroll_opening_employer_authorities a
      join payroll_opening_balances b on b.org_id=a.org_id and b.id=a.opening_balance_id
      join pay_runs r on r.org_id=a.org_id and r.document_id=${documentId}
      join documents d on d.org_id=r.org_id and d.id=r.document_id
    where a.org_id=${orgId} and a.tax_year=r.tax_year and a.subsidiary_id=d.subsidiary_id
      and a.employee_party_id in (select jsonb_array_elements_text(${JSON.stringify(row.employee_party_ids ?? [])}::jsonb)::uuid)
    order by a.employee_party_id,a.id
    ${lockSources ? sql`for share of a,b` : sql``}
  `,
    "objects",
  );
  const openingEmployerAuthorities: OpeningEmployerAuthoritySource[] = openingRows.map(
    ({ matches, ...source }) => {
      if (!matches || !isOpeningEmployerAuthoritySource(source)) {
        throw new PayrollError(
          "The original opening employer source no longer matches its retained amounts — preserve its evidence and review the native opening qualification before calculating or committing",
        );
      }
      return source;
    },
  );
  const openingLevyRows = await executor.execute<
    OpeningLevySourceAuthoritySource & { matches: boolean }
  >(
    sql`
    select h.id::text,h.opening_balance_id::text as "openingBalanceId",h.employee_party_id::text as "employeePartyId",
      h.tax_year as "taxYear",h.subsidiary_id::text as "subsidiaryId",h.source_file_id::text as "sourceFileId",
      h.source_version_id::text as "sourceVersionId",h.source_sha256 as "sourceSha256",h.opening_sha256 as "openingSha256",
      h.employer_authority_id::text as "employerAuthorityId",h.allocation_sha256 as "allocationSha256",
      h.allocation_snapshot as allocations,h.opening_children_sha256 as "openingChildrenSha256",
      h.original_country as "originalCountry",h.original_currency as "originalCurrency",
      h.coverage_start::text as "coverageStart",h.coverage_end::text as "coverageEnd",h.coverage_complete as "coverageComplete",
      (h.sealed and h.employer_authority_id=a.id and h.opening_sha256=a.opening_sha256
                and a.opening_snapshot=to_jsonb(b) and a.opening_sha256=encode(public.digest(to_jsonb(b)::text,'sha256'),'hex')
        and h.employee_party_id=b.employee_party_id and h.tax_year=b.tax_year and h.subsidiary_id=a.subsidiary_id
        and h.allocation_snapshot=(select coalesce(jsonb_agg(jsonb_build_object(
          'programKey',x.program_key,'region',x.region,'subRegion',x.sub_region,
          'filingAccountId',x.filing_account_id,'federalAccountId',x.federal_account_id,'amount',x.amount::text
        ) order by x.program_key,x.region,x.sub_region,x.filing_account_id nulls first,x.federal_account_id nulls first),'[]'::jsonb)
          from payroll_opening_levy_source_allocations x where x.org_id=h.org_id and x.authority_id=h.id)
        and exists (select 1 from files f join file_versions v on v.file_id=f.id
          where f.org_id=h.org_id and f.id=h.source_file_id and v.id=h.source_version_id and v.content_hash=h.source_sha256)
        and h.opening_children_snapshot=public.payroll_opening_source_children(h.org_id,h.opening_balance_id,h.employee_party_id,h.tax_year)
        and h.opening_children_sha256=encode(public.digest(h.opening_children_snapshot::text,'sha256'),'hex')
        and h.allocation_sha256=encode(public.digest(h.allocation_snapshot::text,'sha256'),'hex')) as matches
      from payroll_opening_levy_source_authorities h
      join payroll_opening_balances b on b.org_id=h.org_id and b.id=h.opening_balance_id and ${currentOpeningLevySourceSql("h")}
      join payroll_opening_employer_authorities a on a.org_id=h.org_id and a.opening_balance_id=b.id
      join pay_runs r on r.org_id=h.org_id and r.document_id=${documentId}
      join documents d on d.org_id=r.org_id and d.id=r.document_id
     where h.org_id=${orgId} and h.tax_year=r.tax_year and h.subsidiary_id=d.subsidiary_id
     order by h.employee_party_id,h.id
     ${lockSources ? sql`for share of h,b,a` : sql``}
  `,
    "objects",
  );
  const openingLevySourceAuthorities: OpeningLevySourceAuthoritySource[] = openingLevyRows.map(
    ({ matches, ...source }) => {
      if (!matches || !isOpeningLevySourceAuthoritySource(source)) {
        throw new PayrollError(
          "The original statutory levy opening allocations no longer match their retained legal employer, source version and exact allocation — preserve the evidence and review Payroll → Opening balances → Levy source",
        );
      }
      return source;
    },
  );
  const openingBalanceSources = await executor.execute<OpeningBalanceSourceState>(
    sql`
    select b.id::text as "openingBalanceId",
      encode(public.digest(jsonb_build_object(
        'opening',to_jsonb(b),
        'periodOpenings',(select coalesce(jsonb_agg(to_jsonb(period_opening) order by period_opening.id),'[]'::jsonb)
          from payroll_period_openings period_opening where period_opening.org_id=b.org_id
            and period_opening.annual_opening_balance_id=b.id),
        'employerAuthority',to_jsonb(a),
        'levyAuthority',to_jsonb(h),
        'allocations',(select coalesce(jsonb_agg(jsonb_build_object(
          'programKey',x.program_key,'region',x.region,'subRegion',x.sub_region,
          'filingAccountId',x.filing_account_id,'federalAccountId',x.federal_account_id,'amount',x.amount::text
        ) order by x.program_key,x.region,x.sub_region,x.filing_account_id nulls first,x.federal_account_id nulls first),'[]'::jsonb)
          from payroll_opening_levy_source_allocations x where x.org_id=b.org_id and x.authority_id=h.id)
      )::text,'sha256'),'hex') as "sourceDigest"
      from payroll_opening_balances b
      join pay_runs r on r.org_id=b.org_id and r.document_id=${documentId}
      join documents d on d.org_id=r.org_id and d.id=r.document_id
      left join payroll_opening_employer_authorities a on a.org_id=b.org_id and a.opening_balance_id=b.id
      left join payroll_opening_levy_source_authorities h on h.org_id=b.org_id and h.opening_balance_id=b.id and ${currentOpeningLevySourceSql("h")}
     where b.org_id=${orgId} and b.tax_year=r.tax_year
       and (a.id is null or a.subsidiary_id=d.subsidiary_id)
     order by b.id
     ${lockSources ? sql`for share of b` : sql``}
  `,
    "objects",
  );
  const historicalEmploymentRoster = await historicalEmploymentRosterSource(
    executor,
    orgId,
    documentId,
    allowedSubsidiaryIds,
  );
  const holidaySubjects = await executor.execute<{
    orgId: string;
    employeePartyId: string;
    employmentId: string;
    subsidiaryId: string;
    employeeName: string;
  }>(
    sql`
    select s.org_id as "orgId",s.employee_party_id as "employeePartyId",s.employment_id as "employmentId",
      d.subsidiary_id as "subsidiaryId",p.display_name as "employeeName"
    from pay_stubs s join pay_runs r on r.org_id=s.org_id and r.document_id=s.pay_run_document_id
    join documents d on d.org_id=r.org_id and d.id=r.document_id
    join orgs o on o.id=s.org_id join parties p on p.org_id=s.org_id and p.id=s.employee_party_id
    where s.org_id=${orgId} and r.document_id=${documentId} and s.country='CA' and r.run_type not in ('bonus','retro')
      and o.settings#>>'{payroll,statutoryHolidayPay}'='true'
      and s.employee_party_id in (select jsonb_array_elements_text(${JSON.stringify(row.employee_party_ids ?? [])}::jsonb)::uuid)
    order by s.employee_party_id,s.employment_id
  `,
    "objects",
  );
  const holidayEmployments: StatutoryHolidayEmploymentSource[] = [];
  for (const subject of holidaySubjects) {
    if (lockSources)
      await executor.execute(
        sql`select id from worker_employments where org_id=${orgId} and id=${subject.employmentId} for share`,
      );
    holidayEmployments.push(...(await statutoryHolidayEmploymentSource(executor, subject)));
  }

  const employerAssignments = await employeeEmployerAssignmentHistory(executor, {
    orgId,
    payDate: row.pay_date,
    employeePartyIds: row.employee_party_ids ?? [],
  });
  const compensationPackages = await compensationPackageRunSource(
    executor,
    orgId,
    documentId,
    allowedSubsidiaryIds,
    lockSources,
  );
  const holidayObligations = await holidayObligationRunSource(
    executor,
    orgId,
    documentId,
    allowedSubsidiaryIds,
  );
  // Calculate supplies the exact identities used by its successful statutory
  // passes. Commit/readiness re-resolve them through the same authoritative
  // service so a different selected history row changes the protected digest.
  const bonusSubjects = await executor.execute<CaBonusIncomeReferenceScope & { income: string }>(
    sql`
    select s.org_id as "orgId",r.document_id as "documentId",
      s.employee_party_id as "employeePartyId",s.employment_id as "employmentId",
      d.subsidiary_id as "subsidiaryId",s.filing_account_id as "filingAccountId",
      d.currency,r.pay_schedule_id as "payScheduleId",s.tax_year as "taxYear",
      r.pay_date::text as "payDate",r.period_end::text as "periodEnd",
      s.factors->>'CA_BONUS_I_REFERENCE' as income
    from pay_stubs s join pay_runs r on r.org_id=s.org_id and r.document_id=s.pay_run_document_id
      join documents d on d.org_id=r.org_id and d.id=r.document_id
    where s.org_id=${orgId} and r.document_id=${documentId} and s.country='CA'
      and s.factors ? 'CA_BONUS_I_REFERENCE'
      and s.employee_party_id in (select jsonb_array_elements_text(${JSON.stringify(row.employee_party_ids ?? [])}::jsonb)::uuid)
    order by s.employee_party_id
  `,
    "objects",
  );
  const bonusIncomeReferences: CaBonusIncomeReferenceSource[] = [];
  if (calculatedBonusReferences && calculatedBonusReferences.length !== bonusSubjects.length) {
    throw new PayrollError(
      "Canadian bonus calculation source identities do not cover the calculated employee population — recalculate the pay run",
    );
  }
  for (const subject of bonusSubjects) {
    const { income, ...scope } = subject;
    const source = calculatedBonusReferences
      ? calculatedBonusReferences.find(
          (source) => source.employeePartyId === subject.employeePartyId,
        )
      : await resolveCaBonusIncomeReference(executor, scope);
    if (
      !source ||
      (calculatedBonusReferences &&
        (Object.entries(scope).some(
          ([key, value]) => source[key as keyof CaBonusIncomeReferenceScope] !== value,
        ) ||
          source.income !== income))
    ) {
      throw new PayrollError(
        "Canadian bonus calculation source identity differs from the income actually used — recalculate the pay run",
      );
    }
    bonusIncomeReferences.push(source);
  }
  const usFilingAccountLineages = await executor.execute<UsFilingAccountLineageSource>(
    sql`
    select affiliation.id::text as id, affiliation.filing_account_id::text as "filingAccountId",
      affiliation.federal_account_id::text as "federalAccountId", affiliation.subsidiary_id::text as "subsidiaryId",
      affiliation.effective_from::text as "effectiveFrom", affiliation.effective_to::text as "effectiveTo",
      affiliation.source_reference as "sourceReference", affiliation.updated_at::text as "updatedAt"
    from payroll_us_filing_account_employer_lineage affiliation
    join pay_runs run on run.org_id=affiliation.org_id and run.document_id=${documentId}::uuid
    join documents owner on owner.org_id=run.org_id and owner.id=run.document_id
      and owner.subsidiary_id=affiliation.subsidiary_id
    where affiliation.org_id=${orgId}::uuid
      and exists (select 1 from pay_stubs current_stub
        where current_stub.org_id=run.org_id and current_stub.pay_run_document_id=run.document_id
          and current_stub.country='US')
      and (run.pay_date between affiliation.effective_from and coalesce(affiliation.effective_to,'infinity'::date)
        or exists (select 1 from pay_stubs prior_stub
          join pay_runs prior_run on prior_run.org_id=prior_stub.org_id and prior_run.document_id=prior_stub.pay_run_document_id
          join documents prior_owner on prior_owner.org_id=prior_run.org_id and prior_owner.id=prior_run.document_id
          where prior_stub.org_id=run.org_id and prior_stub.tax_year=run.tax_year and prior_stub.country='US'
            and prior_stub.employee_party_id in (select jsonb_array_elements_text(${JSON.stringify(row.employee_party_ids ?? [])}::jsonb)::uuid)
            and prior_stub.filing_account_id=affiliation.filing_account_id
            and prior_owner.subsidiary_id=owner.subsidiary_id and prior_owner.status<>'voided'
            and prior_run.run_status='committed' and prior_run.document_id<>run.document_id
            and prior_stub.pay_date between affiliation.effective_from and coalesce(affiliation.effective_to,'infinity'::date)))
    order by affiliation.id for share of affiliation
  `,
    "objects",
  );
  if (usFilingAccountLineages.some((source) => !isUsFilingAccountLineageSource(source))) {
    throw new PayrollError(
      "US filing-account affiliation evidence is malformed — qualify the original employer registration before calculating",
    );
  }
  // Mirrors the settlement stamp's reads: the plan's activity and liability,
  // and its accrual component's credited liability while that component is
  // active. Only plans this run's in-scope employees actually settle appear.
  const entitlementSettlementPlans = await executor.execute<EntitlementSettlementPlanSource>(
    sql`
    select plan.id::text as "planId", plan.is_active as "planActive",
           plan.liability_account_id::text as "liabilityAccountId",
           plan.accrual_component_id::text as "accrualComponentId",
           case when accrual.is_active then accrual.liability_account_id::text end as "accrualLiabilityAccountId"
      from entitlement_plans plan
      left join pay_components accrual on accrual.org_id=plan.org_id and accrual.id=plan.accrual_component_id
     where plan.org_id=${orgId}::uuid
       and exists (select 1 from entitlement_ledger movement
         where movement.org_id=plan.org_id and movement.plan_id=plan.id
           and movement.pay_run_document_id=${documentId}::uuid and movement.kind in ('payout', 'bank_in')
           and movement.employee_party_id in (select jsonb_array_elements_text(${JSON.stringify(row.employee_party_ids ?? [])}::jsonb)::uuid))
     order by plan.id
     ${lockSources ? sql`for share of plan` : sql``}
  `,
    "objects",
  );
  if (entitlementSettlementPlans.some((source) => !isEntitlementSettlementPlanSource(source))) {
    throw new PayrollError(
      "Entitlement settlement evidence is malformed — review the plan configuration and recalculate",
    );
  }
  const holidayFacts = (
    await loadStoredHolidayFacts(executor, {
      orgId,
      documentId,
      employeePartyIds: holidaySubjects.map((subject) => subject.employeePartyId),
      lockSources,
    })
  ).source;
  return {
    version: 2,
    holidayFacts,
    timeEntries: row.time_entries,
    timeTypes: row.time_types,
    payRates: row.pay_rates,
    itemAccounts: row.item_accounts,
    compensationPackages,
    employerAssignments,
    assignmentRunPolicies,
    payComponentStatutoryTreatments,
    historicalEmploymentRoster,
    holidayObligations,
    holidayEmployments,
    bonusIncomeReferences,
    openingEmployerAuthorities,
    incomeTaxOverrides,
    bankCashInputs,
    employerLevyAdjustments,
    declaredVacationAccruals,
    openingLevySourceAuthorities,
    openingBalanceSources,
    usFilingAccountLineages,
    entitlementSettlementPlans,
    claimEntryIds: row.claim_entry_ids,
  };
}
