import { sql, type SQL } from "drizzle-orm";
import type { db } from "../platform/db.ts";
import { isUuid } from "../platform/uuid.ts";
import { PayrollError } from "./error.ts";

type Executor = Pick<typeof db, "execute">;
export type StatutoryHistoryScope = {
  orgId: string;
  documentId: string;
  subsidiaryId: string;
  country: string;
  currency: string;
  taxYear: number;
};
export type StatutoryHistorySubject = {
  orgId: string;
  documentId: string;
  taxYear: number;
  employeePartyId?: string;
  employmentId?: string | null;
  subsidiaryId?: string | null;
  country: string;
};

/** The run's retained document identifies its payer; current employment/profile state cannot replace it. */
export async function resolveStatutoryHistoryScope(
  tx: Executor,
  input: StatutoryHistorySubject,
): Promise<StatutoryHistoryScope> {
  if (
    !isUuid(input.orgId) ||
    !isUuid(input.documentId) ||
    (input.employeePartyId !== undefined && !isUuid(input.employeePartyId)) ||
    (input.employmentId !== undefined &&
      (!isUuid(input.employmentId) || input.employeePartyId === undefined)) ||
    !Number.isInteger(input.taxYear) ||
    typeof input.country !== "string" ||
    !/^[A-Z]{2}$/.test(input.country)
  )
    throw new PayrollError(
      "Statutory history needs its native organization, pay run, tax year and country",
    );
  const rows = await tx.execute<{
    subsidiaryId: string | null;
    currency: string | null;
    taxYear: number;
  }>(
    sql`
    select d.subsidiary_id as "subsidiaryId",d.currency,r.tax_year as "taxYear" from pay_runs r
    join documents d on d.org_id=r.org_id and d.id=r.document_id
    where r.org_id=${input.orgId} and r.document_id=${input.documentId} and d.kind='pay_run' and d.status<>'voided'`,
    "objects",
  );
  if (
    rows.length !== 1 ||
    !isUuid(rows[0]!.subsidiaryId) ||
    typeof rows[0]!.currency !== "string" ||
    !rows[0]!.currency ||
    rows[0]!.taxYear !== input.taxYear ||
    (input.subsidiaryId !== undefined && input.subsidiaryId !== rows[0]!.subsidiaryId)
  )
    throw new PayrollError(
      "Statutory history requires the actual pay-run legal employer, tax year and currency",
    );
  const scope: StatutoryHistoryScope = {
    orgId: input.orgId,
    documentId: input.documentId,
    subsidiaryId: rows[0]!.subsidiaryId,
    country: input.country,
    currency: rows[0]!.currency,
    taxYear: input.taxYear,
  };
  if (input.employmentId !== undefined) {
    const employment = await tx.execute(
      sql`select id from worker_employments where org_id=${scope.orgId} and id=${input.employmentId}
      and worker_party_id=${input.employeePartyId} and employer_subsidiary_id=${scope.subsidiaryId}`,
      "objects",
    );
    if (employment.length !== 1)
      throw new PayrollError(
        "Statutory employment history needs this employee’s exact native employment and legal employer",
      );
  }
  const unknown = await tx.execute(
    sql`select s.id from pay_stubs s
    join pay_runs r on r.org_id=s.org_id and r.document_id=s.pay_run_document_id
    join documents d on d.org_id=r.org_id and d.id=r.document_id
    where s.org_id=${scope.orgId} and s.tax_year=${scope.taxYear} and s.pay_run_document_id<>${scope.documentId}
      ${input.employeePartyId === undefined ? sql`` : sql`and s.employee_party_id=${input.employeePartyId}`}
      and r.run_status='committed' and d.status<>'voided'
      and (d.subsidiary_id is null or d.subsidiary_id=${scope.subsidiaryId}
        and (s.country is null or s.country=${scope.country} and
          (s.currency_code is null or s.currency_code<>${scope.currency} or d.currency is null or d.currency<>${scope.currency}
            ${input.employmentId === undefined ? sql`` : sql`or s.employment_id is null`}))) limit 1`,
    "objects",
  );
  if (unknown.length)
    throw new PayrollError(
      "Committed statutory history has unknown legal payer, country or currency — qualify its original source before calculating",
    );
  return scope;
}

/** Pack readers select their own factors from one common committed, non-voided payer boundary. */
export function employerScopedStatutoryStubs(
  scope: StatutoryHistoryScope,
  input: {
    employeePartyId?: string;
    employmentId?: string;
    region?: string;
    includeCurrentDocument?: boolean;
  } = {},
): SQL {
  return sql`(select s.*,r.pay_date as history_run_pay_date from pay_stubs s
    join pay_runs r on r.org_id=s.org_id and r.document_id=s.pay_run_document_id
    join documents d on d.org_id=r.org_id and d.id=r.document_id
    where s.org_id=${scope.orgId} and s.tax_year=${scope.taxYear} and d.subsidiary_id=${scope.subsidiaryId}
      and s.country=${scope.country} and s.currency_code=${scope.currency} and d.currency=${scope.currency} and d.status<>'voided'
      ${input.employeePartyId === undefined ? sql`` : sql`and s.employee_party_id=${input.employeePartyId}`}
      ${input.employmentId === undefined ? sql`` : sql`and s.employment_id=${input.employmentId}`}
      ${input.region === undefined ? sql`` : sql`and s.province=${input.region}`}
      and ${
        input.includeCurrentDocument
          ? sql`(r.run_status='committed' or r.document_id=${scope.documentId})`
          : sql`r.run_status='committed' and r.document_id<>${scope.documentId}`
      })`;
}

/** Missing factors refuse unless original zero cash lines and retained applicability prove a zero Canadian basis. */
export async function requireStatutoryHistoryFactors(
  tx: Executor,
  scope: StatutoryHistoryScope,
  selection: { employeePartyId?: string; employmentId?: string; region?: string },
  keys: readonly string[],
): Promise<void> {
  if (!keys.length || keys.some((key) => !key))
    throw new PayrollError(
      "Declare the statutory history factor identities before reading prior amounts",
    );
  if (selection.region !== undefined) {
    const unknownRegion = await tx.execute(
      sql`select s.id from ${employerScopedStatutoryStubs(scope, {
        ...(selection.employeePartyId === undefined
          ? {}
          : { employeePartyId: selection.employeePartyId }),
        ...(selection.employmentId === undefined ? {} : { employmentId: selection.employmentId }),
      })} s where s.province is null limit 1`,
      "objects",
    );
    if (unknownRegion.length)
      throw new PayrollError(
        "Committed statutory history has no retained original province/board — qualify its original regional source before calculating",
      );
  }
  const unknown = await tx.execute(
    sql`select s.id from ${employerScopedStatutoryStubs(scope, selection)} s
    cross join lateral jsonb_array_elements_text(${JSON.stringify(keys)}::jsonb) required(key)
    where coalesce(jsonb_typeof(s.factors->required.key) not in ('number','string')
      or (s.factors->>required.key)!~'^[+-]?[0-9]{1,15}([.][0-9]{1,4})?$',true)
      and not (
        s.country='CA' and required.key in ('WCB_EARN','EHT_EARN')
        and not (s.factors ? required.key) and s.gross=0
        and exists (
          select 1 from pay_runs history_run
          where history_run.org_id=s.org_id and history_run.document_id=s.pay_run_document_id
            and jsonb_typeof(history_run.calculation_source_snapshot->'payComponentStatutoryTreatments')='array'
            and exists (select 1 from pay_stub_lines line where line.org_id=s.org_id and line.stub_id=s.id)
            and not exists (
              select 1 from pay_stub_lines line where line.org_id=s.org_id and line.stub_id=s.id
                and (line.kind is distinct from 'earning' or line.payment_kind is distinct from 'cash'
                  or line.derived_rule_code is not null or line.amount<>0 or line.component_id is null))
            and not exists (
              select 1 from pay_stub_lines line where line.org_id=s.org_id and line.stub_id=s.id
                and not exists (
                  select 1 from jsonb_array_elements(case
                    when jsonb_typeof(history_run.calculation_source_snapshot->'payComponentStatutoryTreatments')='array'
                    then history_run.calculation_source_snapshot->'payComponentStatutoryTreatments'
                    else '[]'::jsonb end) treatment
                  where treatment->>'componentId'=line.component_id::text
                    and jsonb_typeof(treatment->'programExclusions')='array'
                    and treatment->>'effectiveFrom'<=history_run.pay_date::text
                    and (treatment->>'effectiveTo' is null or treatment->>'effectiveTo'>=history_run.pay_date::text)))
            and not exists (
              select 1 from pay_stub_lines line
              cross join lateral jsonb_array_elements(case
                when jsonb_typeof(history_run.calculation_source_snapshot->'payComponentStatutoryTreatments')='array'
                then history_run.calculation_source_snapshot->'payComponentStatutoryTreatments'
                else '[]'::jsonb end) treatment
              where line.org_id=s.org_id and line.stub_id=s.id
                and treatment->>'componentId'=line.component_id::text
                and (jsonb_typeof(treatment->'programExclusions') is distinct from 'array'
                  or (treatment->'programExclusions') ? case when required.key='WCB_EARN' then 'wcb' else 'eht' end))
        )
      ) limit 1`,
    "objects",
  );
  if (unknown.length)
    throw new PayrollError(
      "Committed statutory history is missing a numeric factor required by this calculation — qualify its original retained source before calculating",
    );
}
