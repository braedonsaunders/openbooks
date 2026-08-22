import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { PayrollError } from "./payroll-error.ts";

/**
 * Union construction payroll: fringes and dues under a collective agreement.
 *
 * Every fringe owns a linked pay_component (auto-provisioned here) carrying
 * its GL accounts and remittance party, so stub lines and the commit path
 * treat fringe amounts exactly like any other component. Employee-paid dues
 * get tax_treatment 'union_dues' — T4127 factor U1 flows automatically.
 */

export interface UnionFringeInput {
  agreementId: string;
  classificationId?: string | null;
  code: string;
  name: string;
  calc: "per_hour_worked" | "percent_of_gross";
  value: string;
  paidBy: "employer" | "employee";
  jobCosted?: boolean;
  expenseAccountId?: string | null;   // employer-paid
  liabilityAccountId: string;         // both: where the withheld/accrued amount sits
  sequence?: number;
}

export async function upsertUnionFringe(
  orgId: string, actorId: string, input: UnionFringeInput,
): Promise<{ fringeId: string; componentId: string }> {
  return await db.transaction(async (tx) => {
    const agreement = (await tx.execute<{ id: string; name: string; remittance_party_id: string | null }>(sql`
      select id, name, remittance_party_id from union_agreements
       where org_id = ${orgId} and id = ${input.agreementId}
    `));
    if (!agreement.rows[0]) throw new PayrollError("union agreement not found");
    if (!input.liabilityAccountId) {
      throw new PayrollError("a union fringe needs a liability account");
    }

    const componentCode = `UNION-${input.code}`.toUpperCase();
    const kind = input.paidBy === "employer" ? "employer_contribution" : "deduction";
    const taxTreatment = input.paidBy === "employee" ? "union_dues" : "none";
    const component = (await tx.execute<{ id: string }>(sql`
      insert into pay_components (org_id, code, name, kind, basis, taxable, pensionable, insurable,
                                  vacationable, tax_treatment, expense_account_id,
                                  liability_account_id, remittance_party_id, sequence,
                                  created_by, updated_by)
      values (${orgId}, ${componentCode}, ${input.name}, ${kind}, 'fixed_amount', false, false, false,
              false, ${taxTreatment}, ${input.expenseAccountId ?? null},
              ${input.liabilityAccountId}, ${agreement.rows[0].remittance_party_id},
              ${input.sequence ?? 300}, ${actorId}, ${actorId})
      on conflict (org_id, code) do update
        set name = excluded.name, tax_treatment = excluded.tax_treatment,
            expense_account_id = excluded.expense_account_id,
            liability_account_id = excluded.liability_account_id,
            remittance_party_id = excluded.remittance_party_id,
            updated_by = ${actorId}, updated_at = now()
      returning id
    `));
    const componentId = component.rows[0]!.id;

    const fringe = (await tx.execute<{ id: string }>(sql`
      insert into union_fringes (org_id, agreement_id, classification_id, code, name, calc, value,
                                 paid_by, job_costed, component_id, sequence, created_by, updated_by)
      values (${orgId}, ${input.agreementId}, ${input.classificationId ?? null}, ${input.code},
              ${input.name}, ${input.calc}, ${input.value}, ${input.paidBy},
              ${input.jobCosted ?? true}, ${componentId}, ${input.sequence ?? 100},
              ${actorId}, ${actorId})
      on conflict (agreement_id, code) do update
        set name = excluded.name, calc = excluded.calc, value = excluded.value,
            paid_by = excluded.paid_by, job_costed = excluded.job_costed,
            classification_id = excluded.classification_id, component_id = excluded.component_id,
            sequence = excluded.sequence, updated_by = ${actorId}, updated_at = now()
      returning id
    `));
    return { fringeId: fringe.rows[0]!.id, componentId };
  });
}

export type UnionFringeRow = {
  id: string; code: string; name: string;
  calc: "per_hour_worked" | "percent_of_gross";
  value: string; paid_by: "employer" | "employee";
  job_costed: boolean; component_id: string | null; sequence: number;
};

/** Active fringes applying to an employee's agreement + classification. */
export async function fringesForEmployee(
  tx: Pick<typeof db, "execute">, orgId: string,
  agreementId: string, classificationId: string | null,
): Promise<UnionFringeRow[]> {
  const r = (await tx.execute<UnionFringeRow>(sql`
    select f.id, f.code, f.name, f.calc, f.value, f.paid_by, f.job_costed,
           f.component_id, f.sequence
      from union_fringes f
      join union_agreements a on a.id = f.agreement_id and a.is_active
     where f.org_id = ${orgId} and f.agreement_id = ${agreementId} and f.is_active
       and (f.classification_id is null or f.classification_id = ${classificationId})
     order by f.sequence, f.code
  `));
  return r.rows;
}

export interface RemittanceReportRow {
  fringeCode: string; fringeName: string; paidBy: string;
  employees: number; hours: string | null; amount: string;
}

/**
 * Monthly union remittance report: per fringe/dues component, the hours and
 * amounts accumulated in committed pay runs whose pay date falls in range.
 */
export async function unionRemittanceReport(
  orgId: string, agreementId: string, from: string, to: string,
): Promise<RemittanceReportRow[]> {
  const r = (await db.execute<{
      fringe_code: string; fringe_name: string; paid_by: string;
      employees: number; hours: string | null; amount: string;
    }>(sql`
    select f.code as fringe_code, f.name as fringe_name, f.paid_by,
           count(distinct s.employee_party_id)::int as employees,
           sum(l.hours) as hours, coalesce(sum(l.amount), 0) as amount
      from union_fringes f
      join pay_components c on c.id = f.component_id and c.org_id = f.org_id
      join pay_stub_lines l on l.component_id = c.id and l.org_id = f.org_id
      join pay_stubs s on s.id = l.stub_id and s.org_id = l.org_id
      join pay_runs r on r.document_id = s.pay_run_document_id and r.org_id = s.org_id and r.run_status = 'committed'
     where f.org_id = ${orgId} and f.agreement_id = ${agreementId}
       and s.pay_date between ${from} and ${to}
     group by f.code, f.name, f.paid_by, f.sequence
     order by f.sequence, f.code
  `));
  return r.rows.map((row) => ({
    fringeCode: row.fringe_code, fringeName: row.fringe_name, paidBy: row.paid_by,
    employees: row.employees, hours: row.hours, amount: row.amount,
  }));
}
