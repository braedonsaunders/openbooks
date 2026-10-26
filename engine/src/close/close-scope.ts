import { sql, type SQL } from "drizzle-orm";

/** Limit a close read to the closing entities; an org-wide close reads every entity. */
export function closeEntityScope(subsidiaryIds: string[], entity: SQL): SQL {
  return subsidiaryIds.length
    ? sql`${entity} in (${sql.join(
        subsidiaryIds.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})`
    : sql`true`;
}

export function closeBankStatementScope(orgId: string, subsidiaryIds: string[]): SQL {
  const inScope = (entity: SQL) => closeEntityScope(subsidiaryIds, entity);
  // Bank evidence is account-wide. For shared accounts its entity cannot be
  // inferred from a statement, so it remains relevant to every applicable close.
  return !subsidiaryIds.length
    ? sql`true`
    : sql`(
    a.subsidiary_id is null or ${inScope(sql`a.subsidiary_id`)} or
    (a.subsidiary_include_children and exists (
      with recursive ancestors as (
        select id, parent_id from subsidiaries where org_id=${orgId} and ${inScope(sql`id`)}
        union
        select s.id, s.parent_id from subsidiaries s join ancestors x on x.parent_id=s.id
          where s.org_id=${orgId}
      ) select 1 from ancestors where id=a.subsidiary_id
    )))`;
}
