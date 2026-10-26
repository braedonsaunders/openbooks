import { pgTextArrayLiteral } from "../../platform/pg-array.ts";
import { sql } from "drizzle-orm";
import type { PayrollCountryPack } from "../pack-types.ts";
import { CA_EMPLOYER_LEVY_PROGRAMS } from "./levy-programs.ts";
import { PayrollPackError } from "../payroll-error.ts";
import { businessTodayInTx } from "../../platform/business-date.ts";

/** Make existing Canadian setup defaults explicit without replacing operator choices. */
export const provisionCaPayrollDefaults: NonNullable<
  PayrollCountryPack["provisionDefaults"]
> = async ({ tx, orgId, actorId }) => {
  const excludedPrograms = CA_EMPLOYER_LEVY_PROGRAMS.filter(
    (program) => program.nonTaxableEarningsExcludedByDefault,
  ).map((program) => program.key);
  const today = await businessTodayInTx(tx, orgId);
  const keys = new Set(excludedPrograms);
  const rows = await tx.execute<{
    component_id: string;
    treatment_id: string;
    effective_from: string;
    effective_to: string | null;
    program_exclusions: string[];
    vacationable: boolean;
  }>(
    sql`
    select c.id::text as component_id, treatment.id::text as treatment_id,
           treatment.effective_from::text as effective_from,
           treatment.effective_to::text as effective_to,
           treatment.program_exclusions, treatment.vacationable
      from pay_components c
      join pay_component_statutory_treatments treatment
        on treatment.org_id = c.org_id and treatment.pay_component_id = c.id
       and treatment.worker_comp_group_id is null
       and treatment.effective_from <= ${today}::date
       and (treatment.effective_to is null or treatment.effective_to >= ${today}::date)
     where c.org_id = ${orgId} and c.kind = 'earning' and not c.taxable
       and (c.country is null or c.country = 'CA')
       and not exists (
         select 1 from audit_log a
          where a.org_id = c.org_id and a.table_name = 'pay_components' and a.row_id = c.id
            and a.changes->>'operation' in ('levy_exclusion_backfill_0483', 'canada_levy_exclusion_defaults')
       )
     order by c.id
     for update of c, treatment
  `,
    "objects",
  );
  for (const row of rows) {
    if (!row.treatment_id || !Array.isArray(row.program_exclusions))
      throw new PayrollPackError(
        `Pay component ${row.component_id} has invalid statutory treatment effective on ${today}; repair its Payroll Setup history.`,
      );
    const before = row.program_exclusions;
    const after = [...new Set([...before, ...keys])].sort();
    if (after.length === before.length && after.every((key, index) => key === before[index]))
      continue;

    let treatmentId = row.treatment_id;
    let splitFrom: { effectiveTo: string } | null = null;
    if (row.effective_from < today) {
      const closed = await tx.execute<{ id: string; effective_to: string }>(
        sql`
        update pay_component_statutory_treatments
           set effective_to = ${today}::date - 1, updated_at = now(), updated_by = ${actorId}
         where org_id = ${orgId} and id = ${row.treatment_id}::uuid
           and effective_from < ${today}::date
           and (effective_to is null or effective_to >= ${today}::date)
         returning id::text as id, effective_to::text as effective_to
      `,
        "objects",
      );
      if (closed.length !== 1)
        throw new PayrollPackError(
          "The statutory treatment changed while Canadian defaults were being provisioned; reload Payroll Setup and retry.",
        );
      splitFrom = { effectiveTo: closed[0]!.effective_to };
      const inserted = await tx.execute<{ id: string }>(
        sql`
        insert into pay_component_statutory_treatments
          (org_id, pay_component_id, effective_from, effective_to, program_exclusions, vacationable, created_by, updated_by)
        values (${orgId}, ${row.component_id}, ${today}::date, ${row.effective_to}::date, ${pgTextArrayLiteral(after)}::text[], ${row.vacationable}, ${actorId}, ${actorId})
        returning id::text as id
      `,
        "objects",
      );
      if (inserted.length !== 1)
        throw new PayrollPackError(
          "The dated Canadian statutory treatment was not created; retry the setup action.",
        );
      treatmentId = inserted[0]!.id;
    } else {
      const updated = await tx.execute(
        sql`
        update pay_component_statutory_treatments
           set program_exclusions = ${pgTextArrayLiteral(after)}::text[], updated_at = now(), updated_by = ${actorId}
         where org_id = ${orgId} and id = ${row.treatment_id}::uuid
           and effective_from = ${today}::date and program_exclusions = ${pgTextArrayLiteral(before)}::text[]
         returning id
      `,
        "objects",
      );
      if (updated.length !== 1)
        throw new PayrollPackError(
          "The statutory treatment changed while Canadian defaults were being provisioned; reload Payroll Setup and retry.",
        );
    }

    const reason =
      "Canadian non-taxable earnings default to excluded from applicable employer levies.";
    if (splitFrom) {
      await tx.execute(sql`
        insert into audit_log (org_id, table_name, row_id, action, actor_id, changes)
        values (${orgId}, 'pay_component_statutory_treatments', ${row.treatment_id}, 'update', ${actorId},
          ${JSON.stringify({
            before: {
              programExclusions: before,
              vacationable: row.vacationable,
              effectiveFrom: row.effective_from,
              effectiveTo: row.effective_to,
            },
            after: {
              programExclusions: before,
              vacationable: row.vacationable,
              effectiveFrom: row.effective_from,
              effectiveTo: splitFrom.effectiveTo,
            },
            reason,
          })}::jsonb)
      `);
      await tx.execute(sql`
        insert into audit_log (org_id, table_name, row_id, action, actor_id, changes)
        values (${orgId}, 'pay_component_statutory_treatments', ${treatmentId}, 'insert', ${actorId},
          ${JSON.stringify({
            before: null,
            after: {
              payComponentId: row.component_id,
              workerCompGroupId: null,
              programExclusions: after,
              vacationable: row.vacationable,
              effectiveFrom: today,
              effectiveTo: row.effective_to,
            },
            reason,
          })}::jsonb)
      `);
    } else {
      await tx.execute(sql`
        insert into audit_log (org_id, table_name, row_id, action, actor_id, changes)
        values (${orgId}, 'pay_component_statutory_treatments', ${treatmentId}, 'update', ${actorId},
          ${JSON.stringify({
            before: {
              programExclusions: before,
              vacationable: row.vacationable,
              effectiveFrom: row.effective_from,
              effectiveTo: row.effective_to,
            },
            after: {
              programExclusions: after,
              vacationable: row.vacationable,
              effectiveFrom: today,
              effectiveTo: row.effective_to,
            },
            reason,
          })}::jsonb)
      `);
    }
    await tx.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, actor_id, changes)
      values (${orgId}, 'pay_components', ${row.component_id}, 'update', ${actorId},
        ${JSON.stringify({
          operation: "canada_levy_exclusion_defaults",
          treatmentId,
          before: { program_exclusions: before },
          after: { program_exclusions: after },
          reason:
            "Canadian non-taxable earnings default to excluded from applicable employer levies.",
        })}::jsonb)
    `);
  }
  // Any existing history for the account wins, including an approval with a
  // future start or an expired rate. Seeding must never fill those gaps.
  await tx.execute(sql`
    with inserted as (
      insert into payroll_employer_facts
        (org_id, subsidiary_id, filing_account_id, country, fact_key, effective_from,
         value_kind, fact_value, value_scale, change_reason, created_by, updated_by)
      select fa.org_id, null, fa.id, 'CA', 'ei_employer_multiplier', fa.created_at::date,
             'decimal', '1.4000', 4,
             'Standard employer EI multiple for accounts created before reduced-rate tracking.',
             ${actorId}, ${actorId}
        from payroll_filing_accounts fa
       where fa.org_id = ${orgId} and fa.country = 'CA' and fa.program_type = 'ca_rp' and fa.is_active
         and not exists (
           select 1 from payroll_employer_facts existing
            where existing.org_id = fa.org_id and existing.filing_account_id = fa.id
              and existing.country = 'CA' and existing.fact_key = 'ei_employer_multiplier'
         )
      returning id, filing_account_id, effective_from, fact_value, change_reason
    )
    insert into audit_log (org_id, table_name, row_id, action, actor_id, changes)
    select ${orgId}, 'payroll_employer_facts', id, 'insert', ${actorId},
           jsonb_build_object('country', 'CA', 'factKey', 'ei_employer_multiplier',
             'filingAccountId', filing_account_id, 'effectiveFrom', effective_from,
             'before', null, 'after', fact_value, 'reason', change_reason)
      from inserted
  `);
};
