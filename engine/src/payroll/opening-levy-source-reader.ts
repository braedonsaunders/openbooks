import { sql } from 'drizzle-orm';
import type { db } from '../platform/db.ts';
import { PayrollError } from './error.ts';
import type { OpeningLevyProgram, OpeningLevySourceAllocation } from './opening-levy-source-authority.ts';

type Executor = Pick<typeof db, 'execute'>;

const SOURCE_REFUSAL = 'Qualify the exact original opening source and its programme/jurisdiction allocations in Payroll → Opening balances → Levy source before calculating';

export async function readEmployeeOpeningLevySources(tx: Executor, input: {
  orgId: string; employeePartyId: string; taxYear: number; subsidiaryId: string;
}): Promise<{ hasOpening: boolean; hasWageHistory: boolean; hasFutaWageHistory: boolean; hasSuiWageHistory: boolean; allocations: OpeningLevySourceAllocation[] }> {
  const rows = (await tx.execute<{
    id: string; subsidiaryId: string | null; sourceAuthorityId: string | null; sealed: boolean | null;
    sourceMatches: boolean | null; hasWageHistory: boolean; hasFutaWageHistory: boolean; hasSuiWageHistory: boolean;
  }>(sql`
    select b.id,a.subsidiary_id as "subsidiaryId",h.id as "sourceAuthorityId",h.sealed,
      (h.opening_sha256=encode(public.digest(to_jsonb(b)::text,'sha256'),'hex')
        and h.employer_authority_id=a.id and h.subsidiary_id=a.subsidiary_id
        and h.employee_party_id=b.employee_party_id and h.tax_year=b.tax_year
        and a.opening_snapshot=to_jsonb(b) and a.opening_sha256=encode(public.digest(to_jsonb(b)::text,'sha256'),'hex')
        and h.source_file_id=a.source_file_id and h.source_version_id=a.source_version_id
        and h.source_sha256=a.source_sha256 and h.source_reference=a.source_reference
        and h.sealed and h.allocation_snapshot=(select coalesce(jsonb_agg(jsonb_build_object(
          'programKey',x.program_key,'region',x.region,'subRegion',x.sub_region,
          'filingAccountId',x.filing_account_id,'amount',x.amount::text
        ) order by x.program_key,x.region,x.sub_region,x.filing_account_id nulls first),'[]'::jsonb)
          from payroll_opening_levy_source_allocations x where x.org_id=h.org_id and x.authority_id=h.id)
        and h.allocation_sha256=encode(public.digest(h.allocation_snapshot::text,'sha256'),'hex')) as "sourceMatches",
      (coalesce(b.pensionable_ytd,0)>0 or coalesce(b.insurable_ytd,0)>0 or coalesce(b.taxable_ytd,0)>0
        or coalesce(b.wcb_assessable_ytd,0)>0 or coalesce(b.eht_remuneration_ytd,0)>0
        or exists (select 1 from payroll_opening_sui_wages sw where sw.org_id=b.org_id
          and sw.opening_balance_id=b.id and sw.insurable_ytd>0)
        or exists (select 1 from payroll_opening_account_bases ab where ab.org_id=b.org_id
          and ab.employee_party_id=b.employee_party_id and ab.tax_year=b.tax_year
          and ab.program_key in ('us_futa','us_sui') and ab.insurable_ytd>0)) as "hasWageHistory",
      (coalesce(b.insurable_ytd,0)>0 or exists (select 1 from payroll_opening_account_bases ab
          where ab.org_id=b.org_id and ab.employee_party_id=b.employee_party_id and ab.tax_year=b.tax_year
            and ab.program_key='us_futa' and ab.insurable_ytd>0)) as "hasFutaWageHistory",
      (coalesce(b.insurable_ytd,0)>0
        or exists (select 1 from payroll_opening_sui_wages sw where sw.org_id=b.org_id
          and sw.opening_balance_id=b.id and sw.insurable_ytd>0)
        or exists (select 1 from payroll_opening_account_bases ab where ab.org_id=b.org_id
          and ab.employee_party_id=b.employee_party_id and ab.tax_year=b.tax_year
          and ab.program_key='us_sui' and ab.insurable_ytd>0)) as "hasSuiWageHistory"
      from payroll_opening_balances b
      left join payroll_opening_employer_authorities a on a.org_id=b.org_id and a.opening_balance_id=b.id
      left join payroll_opening_levy_source_authorities h on h.org_id=b.org_id and h.opening_balance_id=b.id
     where b.org_id=${input.orgId} and b.employee_party_id=${input.employeePartyId} and b.tax_year=${input.taxYear}
  `)).rows;
  if (!rows.length) return { hasOpening: false, hasWageHistory: false, hasFutaWageHistory: false, hasSuiWageHistory: false, allocations: [] };
  if (rows.length !== 1) throw new PayrollError('The employee/year statutory opening identity is ambiguous');
  const opening = rows[0]!;
  if (!opening.subsidiaryId) {
    if (opening.hasWageHistory) throw new PayrollError(`The opening payer is not source-qualified. ${SOURCE_REFUSAL}`);
    return { hasOpening: true, hasWageHistory: false, hasFutaWageHistory: false, hasSuiWageHistory: false, allocations: [] };
  }
  if (opening.subsidiaryId !== input.subsidiaryId) return { hasOpening: false, hasWageHistory: false, hasFutaWageHistory: false, hasSuiWageHistory: false, allocations: [] };
  if (!opening.sourceAuthorityId || !opening.sealed) {
    if (opening.hasWageHistory) throw new PayrollError(`The opening has no complete statutory levy source allocation. ${SOURCE_REFUSAL}`);
    return { hasOpening: true, hasWageHistory: false, hasFutaWageHistory: false, hasSuiWageHistory: false, allocations: [] };
  }
  if (!opening.sourceMatches) throw new PayrollError(`The statutory levy opening source no longer matches its immutable legal-employer source. ${SOURCE_REFUSAL}`);
  const allocations = (await tx.execute<OpeningLevySourceAllocation>(sql`
    select a.program_key as "programKey",a.region,a.sub_region as "subRegion",
      a.filing_account_id as "filingAccountId",a.amount::text as amount
      from payroll_opening_levy_source_allocations a
     where a.org_id=${input.orgId} and a.authority_id=${opening.sourceAuthorityId}
     order by a.program_key,a.region,a.sub_region,a.filing_account_id nulls first
  `)).rows;
  return { hasOpening: true, hasWageHistory: opening.hasWageHistory,
    hasFutaWageHistory: opening.hasFutaWageHistory, hasSuiWageHistory: opening.hasSuiWageHistory, allocations };
}

export function employeeOpeningLevyAmount(
  source: { hasOpening: boolean; hasWageHistory: boolean; allocations: readonly OpeningLevySourceAllocation[] },
  input: { programKey: OpeningLevyProgram; region: string; filingAccountId?: string | null; subRegion?: string },
): string {
  if (!source.hasOpening) return '0';
  const row = source.allocations.find((allocation) => allocation.programKey === input.programKey
    && allocation.region === input.region
    && allocation.subRegion === (input.subRegion ?? '')
    && allocation.filingAccountId === (input.filingAccountId ?? null));
  if (!row) throw new PayrollError(`The original opening has no explicit ${input.programKey}/${input.region}/${input.subRegion ?? ''}/${input.filingAccountId ?? ''} allocation, including zero. ${SOURCE_REFUSAL}`);
  return row.amount;
}

export async function requireEmployerOpeningLevySources(tx: Executor, input: {
  orgId: string; subsidiaryId: string; taxYear: number; programKey: OpeningLevyProgram; region: string;
}): Promise<string> {
  const unknown = (await tx.execute(sql`
    select b.id from payroll_opening_balances b
      left join payroll_opening_employer_authorities e on e.org_id=b.org_id and e.opening_balance_id=b.id
      left join payroll_opening_levy_source_authorities h on h.org_id=b.org_id and h.opening_balance_id=b.id
     where b.org_id=${input.orgId} and b.tax_year=${input.taxYear}
       and (e.id is null or e.subsidiary_id=${input.subsidiaryId})
       and (coalesce(b.pensionable_ytd,0)>0 or coalesce(b.insurable_ytd,0)>0 or coalesce(b.taxable_ytd,0)>0
         or coalesce(b.wcb_assessable_ytd,0)>0 or coalesce(b.eht_remuneration_ytd,0)>0 or exists (
           select 1 from payroll_opening_sui_wages sw where sw.org_id=b.org_id and sw.opening_balance_id=b.id and sw.insurable_ytd>0)
         or exists (select 1 from payroll_opening_account_bases ab where ab.org_id=b.org_id
           and ab.employee_party_id=b.employee_party_id and ab.tax_year=b.tax_year
           and ab.program_key in ('us_futa','us_sui') and ab.insurable_ytd>0))
       and (e.id is null or h.id is null or not h.sealed or h.employer_authority_id<>e.id
         or h.employee_party_id<>b.employee_party_id or h.tax_year<>b.tax_year
         or h.subsidiary_id<>e.subsidiary_id or h.opening_sha256<>encode(public.digest(to_jsonb(b)::text,'sha256'),'hex')
         or e.opening_snapshot<>to_jsonb(b) or e.opening_sha256<>encode(public.digest(to_jsonb(b)::text,'sha256'),'hex')
         or h.source_file_id<>e.source_file_id or h.source_version_id<>e.source_version_id
         or h.source_sha256<>e.source_sha256 or h.source_reference<>e.source_reference
         or h.allocation_snapshot<>(select coalesce(jsonb_agg(jsonb_build_object(
           'programKey',x.program_key,'region',x.region,'subRegion',x.sub_region,
           'filingAccountId',x.filing_account_id,'amount',x.amount::text
         ) order by x.program_key,x.region,x.sub_region,x.filing_account_id nulls first),'[]'::jsonb)
           from payroll_opening_levy_source_allocations x where x.org_id=h.org_id and x.authority_id=h.id)
         or h.allocation_sha256<>encode(public.digest(h.allocation_snapshot::text,'sha256'),'hex'))
     limit 1
  `)).rows;
  if (unknown.length) throw new PayrollError(`Employer health tax history contains an opening with unknown legal payer or levy allocation. ${SOURCE_REFUSAL}`);
  const missing = (await tx.execute(sql`
    select b.id from payroll_opening_balances b
      join payroll_opening_employer_authorities e on e.org_id=b.org_id and e.opening_balance_id=b.id
      left join payroll_opening_levy_source_authorities h on h.org_id=b.org_id and h.opening_balance_id=b.id
     where b.org_id=${input.orgId} and b.tax_year=${input.taxYear} and e.subsidiary_id=${input.subsidiaryId}
       and (h.id is null or not h.sealed or h.employer_authority_id<>e.id
         or h.employee_party_id<>b.employee_party_id or h.tax_year<>b.tax_year
         or h.opening_sha256<>encode(public.digest(to_jsonb(b)::text,'sha256'),'hex')
         or e.opening_snapshot<>to_jsonb(b) or e.opening_sha256<>encode(public.digest(to_jsonb(b)::text,'sha256'),'hex')
         or h.source_file_id<>e.source_file_id or h.source_version_id<>e.source_version_id
         or h.source_sha256<>e.source_sha256 or h.source_reference<>e.source_reference
         or h.allocation_snapshot<>(select coalesce(jsonb_agg(jsonb_build_object(
           'programKey',x.program_key,'region',x.region,'subRegion',x.sub_region,
           'filingAccountId',x.filing_account_id,'amount',x.amount::text
         ) order by x.program_key,x.region,x.sub_region,x.filing_account_id nulls first),'[]'::jsonb)
           from payroll_opening_levy_source_allocations x where x.org_id=h.org_id and x.authority_id=h.id)
         or h.allocation_sha256<>encode(public.digest(h.allocation_snapshot::text,'sha256'),'hex')
         or not exists (
         select 1 from payroll_opening_levy_source_allocations a
          where a.org_id=h.org_id and a.authority_id=h.id and a.program_key=${input.programKey}
            and a.region=${input.region}
       )) limit 1
  `)).rows;
  if (missing.length) throw new PayrollError(`Employer health tax opening history lacks an explicit ${input.region} source allocation. ${SOURCE_REFUSAL}`);
  const total = (await tx.execute<{ amount: string }>(sql`
    select coalesce(sum(a.amount),0)::text as amount
      from payroll_opening_levy_source_allocations a
      join payroll_opening_levy_source_authorities h on h.org_id=a.org_id and h.id=a.authority_id and h.sealed
     where a.org_id=${input.orgId} and h.subsidiary_id=${input.subsidiaryId} and h.tax_year=${input.taxYear}
       and a.program_key=${input.programKey} and a.region=${input.region}
  `)).rows[0]!.amount;
  return total;
}
