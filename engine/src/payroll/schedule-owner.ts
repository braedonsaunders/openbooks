import { sql, type SQL } from "drizzle-orm";

/** The native schedule owner; an organization-wide schedule pays from its active root. */
export function payScheduleOwnerSql(orgId: string, scheduleSubsidiaryId: SQL): SQL {
  return sql`select s.id,s.name,s.country,s.base_currency as currency_code
    from subsidiaries s
    where s.org_id=${orgId} and s.is_active
      and (s.id=${scheduleSubsidiaryId}::uuid
        or (${scheduleSubsidiaryId}::uuid is null and s.parent_id is null))
    order by s.created_at,s.id limit 1`;
}
