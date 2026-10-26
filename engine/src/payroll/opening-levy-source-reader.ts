import { sql } from "drizzle-orm";
import type { db } from "../platform/db.ts";
import {
  validateOpeningLevySourceFacts,
  type OpeningLevySourceFacts,
} from "./opening-levy-source-facts.ts";
import { PayrollError } from "./error.ts";
import { currentOpeningLevySourceSql } from "./opening-levy-source-correction-authority.ts";
import type {
  OpeningLevyProgram,
  OpeningLevySourceAllocation,
} from "./opening-levy-source-authority.ts";

type Executor = Pick<typeof db, "execute">;

export type OriginalOpeningSourceChildren = {
  components: { component_id: string; ytd_amount: string }[];
  programBases: { program_key: string; insurable_ytd: string }[];
  accountBases: {
    program_key: string;
    filing_account_id: string;
    region: string | null;
    insurable_ytd: string;
  }[];
  suiStates: { state: string; insurable_ytd: string }[];
};

export type OriginalOpeningSourceIdentity = {
  openingBalanceId: string;
  subsidiaryId: string;
  authorityId: string;
  employerAuthorityId: string;
  sourceFileId: string;
  sourceVersionId: string;
  sourceSha256: string;
  sourceReference: string;
  openingSha256: string;
};

const SOURCE_REFUSAL =
  "Review the exact original opening source and qualify or correct its programme/jurisdiction certificate in Payroll → Opening balances → Levy source before calculating";

/** One material-history predicate covers native annual columns and every retained opening child family. */
export async function openingHasMaterialHistorySql(alias: string) {
  if (!/^[a-z_][a-z0-9_]*$/i.test(alias))
    throw new PayrollError("Opening source predicates require a native SQL alias");
  const { OPENING_BALANCE_FIELDS } = await import("./opening-balances.ts");
  const columns = [...new Set(OPENING_BALANCE_FIELDS.map((field) => field.column))];
  const column = (name: string) => sql`${sql.identifier(alias)}.${sql.identifier(name)}`;
  return sql`(${sql.join(
    columns.map((name) => sql`${column(name)} is distinct from 0`),
    sql` or `,
  )}
    or exists (select 1 from payroll_opening_balance_components c
      where c.org_id=${column("org_id")} and c.opening_balance_id=${column("id")} and c.ytd_amount<>0)
    or exists (select 1 from payroll_opening_program_bases p
      where p.org_id=${column("org_id")} and p.employee_party_id=${column("employee_party_id")}
        and p.tax_year=${column("tax_year")} and p.insurable_ytd<>0)
    or exists (select 1 from payroll_opening_account_bases a
      where a.org_id=${column("org_id")} and a.employee_party_id=${column("employee_party_id")}
        and a.tax_year=${column("tax_year")} and a.insurable_ytd<>0)
    or exists (select 1 from payroll_opening_sui_wages sw
      where sw.org_id=${column("org_id")} and sw.opening_balance_id=${column("id")} and sw.insurable_ytd<>0)
    or exists (select 1 from payroll_opening_levy_source_authorities certified
      join payroll_opening_levy_source_allocations allocation on allocation.org_id=certified.org_id and allocation.authority_id=certified.id
      where certified.org_id=${column("org_id")} and certified.opening_balance_id=${column("id")}
        and certified.sealed and ${currentOpeningLevySourceSql("certified")} and allocation.amount<>0))`;
}

export async function readEmployeeOpeningLevySources(
  tx: Executor,
  input: {
    orgId: string;
    employeePartyId: string;
    taxYear: number;
    subsidiaryId?: string;
    beforeDate?: string;
  },
): Promise<{
  hasOpening: boolean;
  hasMaterialHistory: boolean;
  hasWageHistory: boolean;
  hasFutaWageHistory: boolean;
  hasSuiWageHistory: boolean;
  facts: OpeningLevySourceFacts | null;
  openingSnapshot: Record<string, unknown> | null;
  openingChildren: OriginalOpeningSourceChildren | null;
  authority: OriginalOpeningSourceIdentity | null;
  allocations: OpeningLevySourceAllocation[];
}> {
  const { OPENING_BALANCE_FIELDS } = await import("./opening-balances.ts");
  const amountColumns = [...new Set(OPENING_BALANCE_FIELDS.map((field) => field.column))];
  const materialHistory = await openingHasMaterialHistorySql("b");
  const exactAnnualAmounts = sql`(select jsonb_object_agg(v.key,v.amount) from (values
    ${sql.join(
      amountColumns.map((column) => sql`(${column}::text,${sql.raw("b." + column)}::text)`),
      sql`,`,
    )}
  ) as v(key,amount))`;
  const rows = await tx.execute<{
    openingChildren: OriginalOpeningSourceChildren;
    hasMaterialHistory: boolean;
    openingSnapshot: Record<string, unknown>;
    employerAuthorityId: string;
    sourceFileId: string;
    sourceVersionId: string;
    sourceSha256: string;
    sourceReference: string;
    openingSha256: string;
    id: string;
    subsidiaryId: string | null;
    sourceAuthorityId: string | null;
    sealed: boolean | null;
    originalCountry: OpeningLevySourceFacts["originalCountry"];
    originalCurrency: OpeningLevySourceFacts["originalCurrency"];
    coverageStart: string;
    coverageEnd: string;
    coverageComplete: true;
    sourceMatches: boolean | null;
    hasWageHistory: boolean;
    hasFutaWageHistory: boolean;
    hasSuiWageHistory: boolean;
  }>(
    sql`
    select b.id,(to_jsonb(b) || ${exactAnnualAmounts}) as "openingSnapshot",h.opening_children_snapshot as "openingChildren",h.employer_authority_id as "employerAuthorityId",
      h.source_file_id as "sourceFileId",h.source_version_id as "sourceVersionId",h.source_sha256 as "sourceSha256",
      h.source_reference as "sourceReference",h.opening_sha256 as "openingSha256",a.subsidiary_id as "subsidiaryId",h.id as "sourceAuthorityId",h.sealed,
      h.original_country as "originalCountry",h.original_currency as "originalCurrency",
      h.coverage_start::text as "coverageStart",h.coverage_end::text as "coverageEnd",h.coverage_complete as "coverageComplete",
      (h.opening_sha256=encode(public.digest(to_jsonb(b)::text,'sha256'),'hex')
        and h.employer_authority_id=a.id and h.subsidiary_id=a.subsidiary_id
        and h.employee_party_id=b.employee_party_id and h.tax_year=b.tax_year
        and a.opening_snapshot=to_jsonb(b) and a.opening_sha256=encode(public.digest(to_jsonb(b)::text,'sha256'),'hex')
        and h.sealed and h.allocation_snapshot=(select coalesce(jsonb_agg(jsonb_build_object(
          'programKey',x.program_key,'region',x.region,'subRegion',x.sub_region,
          'filingAccountId',x.filing_account_id,'federalAccountId',x.federal_account_id,'amount',x.amount::text
        ) order by x.program_key,x.region,x.sub_region,x.filing_account_id nulls first,x.federal_account_id nulls first),'[]'::jsonb)
          from payroll_opening_levy_source_allocations x where x.org_id=h.org_id and x.authority_id=h.id)
        and exists (select 1 from files f join file_versions v on v.file_id=f.id
          where f.org_id=h.org_id and f.id=h.source_file_id and v.id=h.source_version_id and v.content_hash=h.source_sha256)
        and h.opening_children_snapshot=public.payroll_opening_source_children(h.org_id,h.opening_balance_id,h.employee_party_id,h.tax_year)
        and h.opening_children_sha256=encode(public.digest(h.opening_children_snapshot::text,'sha256'),'hex')
        and h.allocation_sha256=encode(public.digest(h.allocation_snapshot::text,'sha256'),'hex')) as "sourceMatches",
      ${materialHistory} as "hasMaterialHistory",
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
        and ${currentOpeningLevySourceSql("h")}
     where b.org_id=${input.orgId} and b.employee_party_id=${input.employeePartyId} and b.tax_year=${input.taxYear}
  `,
    "objects",
  );
  if (!rows.length)
    return {
      hasOpening: false,
      hasMaterialHistory: false,
      hasWageHistory: false,
      hasFutaWageHistory: false,
      hasSuiWageHistory: false,
      facts: null,
      openingSnapshot: null,
      openingChildren: null,
      authority: null,
      allocations: [],
    };
  if (rows.length !== 1)
    throw new PayrollError("The employee/year statutory opening identity is ambiguous");
  const opening = rows[0]!;
  if (!opening.subsidiaryId) {
    if (opening.hasMaterialHistory)
      throw new PayrollError(`The opening payer is not source-qualified. ${SOURCE_REFUSAL}`);
    return {
      hasOpening: true,
      hasMaterialHistory: false,
      hasWageHistory: false,
      hasFutaWageHistory: false,
      hasSuiWageHistory: false,
      facts: null,
      openingSnapshot: null,
      openingChildren: null,
      authority: null,
      allocations: [],
    };
  }
  if (input.subsidiaryId !== undefined && opening.subsidiaryId !== input.subsidiaryId)
    return {
      hasOpening: false,
      hasMaterialHistory: false,
      hasWageHistory: false,
      hasFutaWageHistory: false,
      hasSuiWageHistory: false,
      facts: null,
      openingSnapshot: null,
      openingChildren: null,
      authority: null,
      allocations: [],
    };
  if (!opening.sourceAuthorityId || !opening.sealed) {
    if (opening.hasMaterialHistory)
      throw new PayrollError(
        `The opening has no complete statutory levy source allocation. ${SOURCE_REFUSAL}`,
      );
    return {
      hasOpening: true,
      hasMaterialHistory: false,
      hasWageHistory: false,
      hasFutaWageHistory: false,
      hasSuiWageHistory: false,
      facts: null,
      openingSnapshot: null,
      openingChildren: null,
      authority: null,
      allocations: [],
    };
  }
  if (!opening.sourceMatches)
    throw new PayrollError(
      `The statutory levy opening source no longer matches its immutable legal-employer source. ${SOURCE_REFUSAL}`,
    );
  // Pack composition imports this reader through the statutory engines.
  // Resolve the declaration at read time; pure fact validation depends only
  // on the explicit pack contract and cannot re-enter pack initialization.
  const { PAYROLL_COUNTRY_PACKS } = await import("./pack-registry.ts");
  validateOpeningLevySourceFacts(
    opening,
    input.taxYear,
    PAYROLL_COUNTRY_PACKS[opening.originalCountry],
  );
  if (input.beforeDate !== undefined && opening.coverageEnd >= input.beforeDate) {
    throw new PayrollError(
      "The original opening report covers this payroll date or a later date; use a pay run after the certified opening coverage ends",
    );
  }
  const allocations = await tx.execute<OpeningLevySourceAllocation>(
    sql`
    select a.program_key as "programKey",a.region,a.sub_region as "subRegion",
      a.filing_account_id as "filingAccountId",a.federal_account_id as "federalAccountId",a.amount::text as amount
      from payroll_opening_levy_source_allocations a
     where a.org_id=${input.orgId} and a.authority_id=${opening.sourceAuthorityId}
     order by a.program_key,a.region,a.sub_region,a.filing_account_id nulls first,a.federal_account_id nulls first
  `,
    "objects",
  );
  return {
    hasOpening: true,
    hasMaterialHistory: opening.hasMaterialHistory,
    hasWageHistory: opening.hasWageHistory,
    hasFutaWageHistory: opening.hasFutaWageHistory,
    hasSuiWageHistory: opening.hasSuiWageHistory,
    facts: {
      originalCountry: opening.originalCountry,
      originalCurrency: opening.originalCurrency,
      coverageStart: opening.coverageStart,
      coverageEnd: opening.coverageEnd,
      coverageComplete: opening.coverageComplete,
    },
    openingSnapshot: opening.openingSnapshot,
    openingChildren: opening.openingChildren,
    authority: {
      openingBalanceId: opening.id,
      subsidiaryId: opening.subsidiaryId,
      authorityId: opening.sourceAuthorityId,
      employerAuthorityId: opening.employerAuthorityId,
      sourceFileId: opening.sourceFileId,
      sourceVersionId: opening.sourceVersionId,
      sourceSha256: opening.sourceSha256,
      sourceReference: opening.sourceReference,
      openingSha256: opening.openingSha256,
    },
    allocations,
  };
}

export function employeeOpeningLevyAmount(
  source: {
    hasOpening: boolean;
    hasWageHistory: boolean;
    hasMaterialHistory: boolean;
    facts: OpeningLevySourceFacts | null;
    allocations: readonly OpeningLevySourceAllocation[];
  },
  input: {
    programKey: OpeningLevyProgram;
    region: string;
    filingAccountId?: string | null;
    subRegion?: string;
    federalAccountId?: string | null;
  },
): string {
  if (
    !["ca_wcb", "ca_eht", "ca_cnt", "us_futa", "us_sui", "us_pa_lst"].includes(input.programKey)
  ) {
    throw new PayrollError(
      "Choose a declared statutory opening programme before reading its source allocation",
    );
  }
  if (typeof source.hasMaterialHistory !== "boolean") {
    throw new PayrollError(
      "Resolve the exact original opening history before reading its statutory allocation",
    );
  }
  if (!source.hasOpening || source.hasMaterialHistory === false) return "0";
  const requiredCountry = input.programKey.startsWith("ca_") ? "CA" : "US";
  if (!source.facts) {
    throw new PayrollError(
      `The opening source does not certify ${requiredCountry} statutory history. ${SOURCE_REFUSAL}`,
    );
  }
  // A certified opening of another statutory pack is not a prior for this programme.
  if (source.facts.originalCountry !== requiredCountry) return "0";
  const row = source.allocations.find(
    (allocation) =>
      allocation.programKey === input.programKey &&
      allocation.region === input.region &&
      allocation.subRegion === (input.subRegion ?? "") &&
      allocation.filingAccountId === (input.filingAccountId ?? null) &&
      allocation.federalAccountId ===
        (input.federalAccountId ??
          (input.programKey === "us_futa" ? input.filingAccountId : null) ??
          null),
  );
  if (!row)
    throw new PayrollError(
      `The original opening has no explicit ${input.programKey}/${input.region}/${input.subRegion ?? ""}/${input.filingAccountId ?? ""} allocation, including zero. ${SOURCE_REFUSAL}`,
    );
  return row.amount;
}

export async function requireEmployerOpeningLevySources(
  tx: Executor,
  input: {
    orgId: string;
    subsidiaryId: string;
    taxYear: number;
    beforeDate?: string;
    programKey: OpeningLevyProgram;
    region: string;
  },
): Promise<string> {
  const materialHistory = await openingHasMaterialHistorySql("b");
  const unknown = await tx.execute(
    sql`
    select b.id from payroll_opening_balances b
      left join payroll_opening_employer_authorities e on e.org_id=b.org_id and e.opening_balance_id=b.id
      left join payroll_opening_levy_source_authorities h on h.org_id=b.org_id and h.opening_balance_id=b.id
        and ${currentOpeningLevySourceSql("h")}
     where b.org_id=${input.orgId} and b.tax_year=${input.taxYear}
       and (e.id is null or e.subsidiary_id=${input.subsidiaryId})
       and ${materialHistory}
       and (e.id is null or h.id is null or not h.sealed or h.employer_authority_id<>e.id
         or h.employee_party_id<>b.employee_party_id or h.tax_year<>b.tax_year
         or h.subsidiary_id<>e.subsidiary_id or h.opening_sha256<>encode(public.digest(to_jsonb(b)::text,'sha256'),'hex')
         or e.opening_snapshot<>to_jsonb(b) or e.opening_sha256<>encode(public.digest(to_jsonb(b)::text,'sha256'),'hex')
         or h.allocation_snapshot<>(select coalesce(jsonb_agg(jsonb_build_object(
           'programKey',x.program_key,'region',x.region,'subRegion',x.sub_region,
           'filingAccountId',x.filing_account_id,'federalAccountId',x.federal_account_id,'amount',x.amount::text
         ) order by x.program_key,x.region,x.sub_region,x.filing_account_id nulls first,x.federal_account_id nulls first),'[]'::jsonb)
           from payroll_opening_levy_source_allocations x where x.org_id=h.org_id and x.authority_id=h.id)
         or not exists (select 1 from files f join file_versions v on v.file_id=f.id
           where f.org_id=h.org_id and f.id=h.source_file_id and v.id=h.source_version_id and v.content_hash=h.source_sha256)
         or h.opening_children_snapshot<>public.payroll_opening_source_children(h.org_id,h.opening_balance_id,h.employee_party_id,h.tax_year)
         or h.opening_children_sha256<>encode(public.digest(h.opening_children_snapshot::text,'sha256'),'hex')
         or h.allocation_sha256<>encode(public.digest(h.allocation_snapshot::text,'sha256'),'hex'))
     limit 1
  `,
    "objects",
  );
  if (unknown.length)
    throw new PayrollError(
      `Employer health tax history contains an opening with unknown legal payer or levy allocation. ${SOURCE_REFUSAL}`,
    );
  const missing = await tx.execute(
    sql`
    select b.id from payroll_opening_balances b
      join payroll_opening_employer_authorities e on e.org_id=b.org_id and e.opening_balance_id=b.id
      left join payroll_opening_levy_source_authorities h on h.org_id=b.org_id and h.opening_balance_id=b.id
        and ${currentOpeningLevySourceSql("h")}
     where b.org_id=${input.orgId} and b.tax_year=${input.taxYear} and e.subsidiary_id=${input.subsidiaryId}
       and ${materialHistory}
       and (h.id is null or h.original_country='CA')
       and (h.id is null or not h.sealed or h.original_currency<>'CAD'
         or not h.coverage_complete
         ${input.beforeDate ? sql`or h.coverage_end>=${input.beforeDate}::date` : sql``}
         or h.employer_authority_id<>e.id
         or h.employee_party_id<>b.employee_party_id or h.tax_year<>b.tax_year
         or h.opening_sha256<>encode(public.digest(to_jsonb(b)::text,'sha256'),'hex')
         or e.opening_snapshot<>to_jsonb(b) or e.opening_sha256<>encode(public.digest(to_jsonb(b)::text,'sha256'),'hex')
         or h.allocation_snapshot<>(select coalesce(jsonb_agg(jsonb_build_object(
           'programKey',x.program_key,'region',x.region,'subRegion',x.sub_region,
           'filingAccountId',x.filing_account_id,'federalAccountId',x.federal_account_id,'amount',x.amount::text
         ) order by x.program_key,x.region,x.sub_region,x.filing_account_id nulls first,x.federal_account_id nulls first),'[]'::jsonb)
           from payroll_opening_levy_source_allocations x where x.org_id=h.org_id and x.authority_id=h.id)
         or not exists (select 1 from files f join file_versions v on v.file_id=f.id
           where f.org_id=h.org_id and f.id=h.source_file_id and v.id=h.source_version_id and v.content_hash=h.source_sha256)
         or h.opening_children_snapshot<>public.payroll_opening_source_children(h.org_id,h.opening_balance_id,h.employee_party_id,h.tax_year)
         or h.opening_children_sha256<>encode(public.digest(h.opening_children_snapshot::text,'sha256'),'hex')
         or h.allocation_sha256<>encode(public.digest(h.allocation_snapshot::text,'sha256'),'hex')
         or not exists (
         select 1 from payroll_opening_levy_source_allocations a
          where a.org_id=h.org_id and a.authority_id=h.id and a.program_key=${input.programKey}
            and a.region=${input.region}
       )) limit 1
  `,
    "objects",
  );
  if (missing.length)
    throw new PayrollError(
      `Employer health tax opening history lacks an explicit ${input.region} source allocation. ${SOURCE_REFUSAL}`,
    );
  const total = (
    await tx.execute<{ amount: string }>(
      sql`
    select coalesce(sum(a.amount),0)::text as amount
      from payroll_opening_levy_source_allocations a
      join payroll_opening_levy_source_authorities h on h.org_id=a.org_id and h.id=a.authority_id and h.sealed
     where a.org_id=${input.orgId} and h.subsidiary_id=${input.subsidiaryId} and h.tax_year=${input.taxYear}
       and ${currentOpeningLevySourceSql("h")}
       and h.original_country='CA' and h.original_currency='CAD'
       and a.program_key=${input.programKey} and a.region=${input.region}
  `,
      "objects",
    )
  )[0]!.amount;
  return total;
}
