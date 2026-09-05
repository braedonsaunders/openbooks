import { sql, type SQL } from 'drizzle-orm'

export function crmSharedScope(
  column: SQL,
  allowed?: ReadonlySet<string> | null,
): SQL {
  if (allowed == null) return sql``
  if (allowed.size === 0) return sql` and false`
  return sql` and (${column} is null or ${column}=any(${`{${[...allowed].join(',')}}`}::uuid[]))`
}

/** Match the opportunity's own legal entity and its related customer identity. */
export function crmOpportunityScope(allowed?: ReadonlySet<string> | null) {
  if (allowed == null) return sql``
  if (allowed.size === 0) return sql` and false`
  const ids = sql`${`{${[...allowed].join(',')}}`}::uuid[]`
  return sql` and (o.subsidiary_id is null or o.subsidiary_id=any(${ids}))
    and (o.party_id is null or exists (select 1 from parties scope_customer
      where scope_customer.id=o.party_id and scope_customer.org_id=o.org_id
        and (scope_customer.subsidiary_id is null or scope_customer.subsidiary_id=any(${ids}))))`
}

/** Every relationship must be visible: a shared activity cannot reveal a hidden document. */
export function crmSubjectVisible(
  org: SQL,
  kind: SQL,
  id: SQL,
  allowed?: ReadonlySet<string> | null,
): SQL {
  if (allowed?.size === 0) return sql`false`
  const strictScope = (column: SQL) =>
    allowed == null
      ? sql``
      : sql` and ${column}=any(${`{${[...allowed].join(',')}}`}::uuid[])`
  return sql`(
    (${kind}='account' and exists (select 1 from crm_account_profiles cp join parties p on p.id=cp.party_id and p.org_id=cp.org_id where cp.org_id=${org} and cp.party_id=${id}${crmSharedScope(sql`p.subsidiary_id`, allowed)}))
    or (${kind}='contact' and exists (select 1 from contacts c left join parties p on p.id=c.party_id and p.org_id=c.org_id where c.org_id=${org} and c.id=${id}${crmSharedScope(sql`p.subsidiary_id`, allowed)}))
    or (${kind}='opportunity' and exists (select 1 from crm_opportunities o where o.org_id=${org} and o.id=${id}${crmOpportunityScope(allowed)}))
    or (${kind}='document' and exists (select 1 from documents d where d.org_id=${org} and d.id=${id}${strictScope(sql`d.subsidiary_id`)}))
    or (${kind}='project' and exists (select 1 from projects p where p.org_id=${org} and p.id=${id}${strictScope(sql`p.subsidiary_id`)}))
  )`
}

/** Unlinked activities are shared; linked activities inherit all related-record restrictions. */
export function crmActivityScope(allowed?: ReadonlySet<string> | null): SQL {
  if (allowed == null) return sql``
  if (allowed.size === 0) return sql` and false`
  return sql` and not exists (select 1 from crm_activity_links scope_link
    where scope_link.org_id=a.org_id and scope_link.activity_id=a.id
      and not ${crmSubjectVisible(sql`a.org_id`, sql`scope_link.subject_kind`, sql`scope_link.subject_id`, allowed)})
    and not exists (select 1 from crm_activity_participants scope_participant
      where scope_participant.org_id=a.org_id and scope_participant.activity_id=a.id and scope_participant.contact_id is not null
        and not ${crmSubjectVisible(sql`a.org_id`, sql`'contact'`, sql`scope_participant.contact_id`, allowed)})`
}
