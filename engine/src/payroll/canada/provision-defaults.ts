import { sql } from "drizzle-orm";
import type { PayrollCountryPack } from "../pack-types.ts";
import { CA_EMPLOYER_LEVY_PROGRAMS } from "./levy-programs.ts";

/** Make existing Canadian setup defaults explicit without replacing operator choices. */
export const provisionCaPayrollDefaults: NonNullable<PayrollCountryPack["provisionDefaults"]> = async ({ tx, orgId, actorId }) => {
  const excludedPrograms = CA_EMPLOYER_LEVY_PROGRAMS.filter(program => program.nonTaxableEarningsExcludedByDefault).map(program => program.key);
  const keys = sql`array[${sql.join(excludedPrograms.map(key => sql`${key}`), sql`, `)}]::text[]`;
  // An audit marker makes this a one-time upgrade for each component. Later
  // edits, including an explicitly empty exclusion list, remain authoritative.
  await tx.execute(sql`
    with candidates as (
      select c.id, c.program_exclusions as before,
             array(select distinct key from unnest(c.program_exclusions || ${keys}) key order by key) as after
        from pay_components c
       where c.org_id = ${orgId} and c.kind = 'earning' and not c.taxable
         and (c.country is null or c.country = 'CA')
         and not c.program_exclusions @> ${keys}
         and not exists (
           select 1 from audit_log a
            where a.org_id = c.org_id and a.table_name = 'pay_components' and a.row_id = c.id
              and a.changes->>'operation' in ('levy_exclusion_backfill_0483', 'canada_levy_exclusion_defaults')
         )
       for update of c
    ), changed as (
      update pay_components c set program_exclusions = candidates.after,
             updated_at = now(), updated_by = ${actorId}
        from candidates where c.org_id = ${orgId} and c.id = candidates.id
      returning c.id, candidates.before, candidates.after
    )
    insert into audit_log (org_id, table_name, row_id, action, actor_id, changes)
    select ${orgId}, 'pay_components', id, 'update', ${actorId},
           jsonb_build_object('operation', 'canada_levy_exclusion_defaults',
             'before', jsonb_build_object('program_exclusions', before),
             'after', jsonb_build_object('program_exclusions', after),
             'reason', 'Canadian non-taxable earnings default to excluded from employer levies.')
      from changed
  `);
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
