import { sql } from "drizzle-orm";
import type { db } from "../../platform/db.ts";
import { PayrollError } from "../error.ts";

export type CaBonusIncomeReferenceScope = {
  orgId: string;
  documentId: string;
  employeePartyId: string;
  employmentId: string;
  subsidiaryId: string;
  filingAccountId: string;
  currency: string;
  payScheduleId: string;
  taxYear: number;
  payDate: string;
  periodEnd: string;
};

export type CaBonusIncomeReferenceSource = CaBonusIncomeReferenceScope & {
  referenceStubId: string;
  referenceRunId: string;
  referencePayDate: string;
  income: string;
  referenceMethod: "option1" | "option2";
  method: {
    key: "ca_t4127_method";
    option: "option1";
    origin: "statutory_default" | "certificate";
    certificateId: string | null;
    effectiveFrom: string | null;
    answers: Record<string, string>;
  };
};

/** Committed periodic income for CRA's separately paid Option 1 method.
 * Payment-date remuneration governs bonus tax; a retro earning window must
 * not exclude regular pay already received before the retro payment.
 */
export async function resolveCaBonusIncomeReference(
  tx: Pick<typeof db, "execute">,
  scope: CaBonusIncomeReferenceScope,
): Promise<CaBonusIncomeReferenceSource> {
  const {
    orgId,
    documentId,
    employeePartyId,
    employmentId,
    subsidiaryId,
    filingAccountId,
    currency,
    payScheduleId,
    taxYear,
    payDate,
  } = scope;
  const reference = (
    await tx.execute<{
      stub_id: string;
      document_id: string;
      income: string;
      pay_date: string;
      averaging: string | null;
      certificate_id: string | null;
      effective_from: string | null;
      answers: Record<string, string> | null;
    }>(
      sql`
    select s.id as stub_id,r.document_id,s.factors->>'I' as income,
           s.pay_date::text as pay_date,s.factors->>'S1_DEN' as averaging,
           method.id as certificate_id,method.effective_from::text,method.answers
      from pay_stubs s
      join pay_runs r on r.org_id=s.org_id and r.document_id=s.pay_run_document_id
      join documents d on d.org_id=r.org_id and d.id=r.document_id
      left join lateral (
        select c.id,c.effective_from,c.answers from employee_tax_certificates c
         where c.org_id=${orgId} and c.employee_party_id=${employeePartyId}
           and c.country='CA' and c.certificate_key='ca_t4127_method'
           and c.effective_from<=${payDate}::date
           and (c.superseded_on is null or c.superseded_on>${payDate}::date)
         order by c.effective_from desc,c.id desc limit 1
      ) method on true
     where s.org_id=${orgId} and s.employee_party_id=${employeePartyId}
       and s.employment_id=${employmentId} and s.filing_account_id=${filingAccountId}
       and s.country='CA' and s.tax_year=${taxYear}
       and d.subsidiary_id=${subsidiaryId} and d.currency=${currency}
       and r.pay_schedule_id=${payScheduleId} and r.run_status='committed'
       and d.status<>'voided' and r.document_id<>${documentId}
       and s.pay_date<=${payDate}::date and r.period_end<=${payDate}::date
       and (s.factors->>'I')::numeric>0
     order by s.pay_date desc,r.period_end desc,r.updated_at desc,r.document_id desc,s.id desc
     limit 1
  `,
      "objects",
    )
  )[0];
  if (!reference)
    throw new PayrollError(
      "A separately paid Canadian bonus has no committed regular income for this employment, employer, currency, schedule and filing account — calculate and commit its regular pay before the bonus",
    );
  if (reference.certificate_id && reference.answers?.method !== "option1") {
    throw new PayrollError(
      "The Canadian bonus reference requires the effective Option 1 withholding method — review the employee’s dated withholding method record and recalculate",
    );
  }
  return {
    ...scope,
    referenceStubId: reference.stub_id,
    referenceRunId: reference.document_id,
    referencePayDate: reference.pay_date,
    income: reference.income,
    referenceMethod: reference.averaging === null ? "option1" : "option2",
    method: {
      key: "ca_t4127_method",
      option: "option1",
      origin: reference.certificate_id ? "certificate" : "statutory_default",
      certificateId: reference.certificate_id,
      effectiveFrom: reference.effective_from,
      answers: reference.answers ?? {},
    },
  };
}
