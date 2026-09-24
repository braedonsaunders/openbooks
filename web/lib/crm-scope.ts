import { sql, type SQL } from 'drizzle-orm'
import type { SqlExecutor } from '@openbooks/engine/src/platform/db.ts'

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

/**
 * Subject kinds an activity link may anchor to. Anything else matches no
 * visibility branch, so it can never authorize a link.
 */
export const CRM_LINKABLE_SUBJECT_KINDS = new Set([
  'account',
  'contact',
  'opportunity',
  'document',
  'project',
])

/**
 * Lock a link target inside the link-write transaction so the visibility
 * recheck that follows sees the latest committed subsidiary: a concurrent
 * rehome (subsidiary UPDATE) of the subject — or of the party its
 * visibility inherits — blocks on this lock until the link commits, so no
 * rehome can slip between the check and the link insert. FOR SHARE is the
 * read-side lock (the link writer never mutates the subject itself).
 * Returns false when the subject row itself is missing; callers keep their
 * existing not-found/invalid-record refusal either way.
 */
export async function lockCrmLinkSubject(
  tx: SqlExecutor,
  orgId: string,
  kind: string,
  id: string,
): Promise<boolean> {
  if (!CRM_LINKABLE_SUBJECT_KINDS.has(kind)) return false
  if (kind === 'account') {
    const profile = (
      await tx.execute<{ party_id: string }>(sql`
        select party_id from crm_account_profiles
         where org_id = ${orgId} and party_id = ${id}
         for share`)
    ).rows[0]
    if (!profile) return false
    await tx.execute(sql`
      select 1 from parties where org_id = ${orgId} and id = ${id} for share`)
    return true
  }
  if (kind === 'contact') {
    const contact = (
      await tx.execute<{ party_id: string | null }>(sql`
        select party_id from contacts
         where org_id = ${orgId} and id = ${id}
         for share`)
    ).rows[0]
    if (!contact) return false
    if (contact.party_id) {
      await tx.execute(sql`
        select 1 from parties where org_id = ${orgId} and id = ${contact.party_id} for share`)
    }
    return true
  }
  if (kind === 'opportunity') {
    const opportunity = (
      await tx.execute<{ party_id: string | null }>(sql`
        select party_id from crm_opportunities
         where org_id = ${orgId} and id = ${id}
         for share`)
    ).rows[0]
    if (!opportunity) return false
    if (opportunity.party_id) {
      await tx.execute(sql`
        select 1 from parties where org_id = ${orgId} and id = ${opportunity.party_id} for share`)
    }
    return true
  }
  if (kind === 'document') {
    const row = (
      await tx.execute(sql`
        select 1 from documents where org_id = ${orgId} and id = ${id} for share`)
    ).rows[0]
    return !!row
  }
  const project = (
    await tx.execute(sql`
      select 1 from projects where org_id = ${orgId} and id = ${id} for share`)
  ).rows[0]
  return !!project
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
