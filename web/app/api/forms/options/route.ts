import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { PARTY_PICKER_KINDS, type PartyPickerKind } from '@openbooks/forms-core'
import { getAuthz } from '../../../../lib/authz'
import { subsidiaryVisibleFilter } from '../../../../lib/subsidiaries'
import { guardProjectsFeature } from '../../../../lib/projects-gate'

export const runtime = 'nodejs'

/** Shared form/master-data pickers. Authentication does not grant visibility
 * into another legal entity: match native record scope and the Projects gate.
 * Null-subsidiary parties/accounts remain shared for callers with entity access;
 * an empty entity scope discloses none of these subsidiary-aware records.
 * Items are organization-wide and do not have a subsidiary assignment.
 */
export async function GET(req: Request) {
  const authz = await getAuthz()
  if (!authz) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const orgId = authz.user.orgId
  const url = new URL(req.url)
  const source = url.searchParams.get('source')
  const table = source === 'reference' ? url.searchParams.get('table') : null
  if (source === 'reference' && (!table || !['parties', 'projects', 'accounts', 'items'].includes(table))) {
    return NextResponse.json({ error: 'invalid reference table' }, { status: 400 })
  }
  if (table === 'projects') {
    const denied = await guardProjectsFeature(orgId)
    if (denied) return denied
  }
  if (authz.allowedSubsidiaryIds?.size === 0 &&
      (source === 'parties' || source === 'gl_accounts' || (source === 'reference' && table !== 'items'))) {
    return NextResponse.json({ options: [] })
  }

  // Both account transports use the same scope and null-safe display label.
  if (source === 'gl_accounts' || table === 'accounts') {
    const r = await db.execute<{ value: string; label: string }>(sql`
      select a.id as value, concat_ws(' ', nullif(a.number, ''), a.name) as label
        from accounts a
       where a.org_id = ${orgId} and a.is_active and not a.is_summary
         ${subsidiaryVisibleFilter(sql`a.subsidiary_id`, authz.allowedSubsidiaryIds, { orgWideNull: true })}
       order by a.number nulls last, a.name limit 5000
    `)
    return NextResponse.json({ options: r.rows })
  }

  if (source === 'parties' || table === 'parties') {
    const rawKind = source === 'parties' ? url.searchParams.get('partyKind') ?? 'any' : 'any'
    const kind = (PARTY_PICKER_KINDS as readonly string[]).includes(rawKind)
      ? (rawKind as PartyPickerKind)
      : 'any'
    // Role membership comes exclusively from the canonical role tables.
    const roleFilter =
      kind === 'vendor'
        ? sql` and exists (select 1 from vendor_roles vr where vr.org_id = p.org_id and vr.party_id = p.id and vr.is_active)`
        : kind === 'customer'
          ? sql` and exists (select 1 from customer_roles cr where cr.org_id = p.org_id and cr.party_id = p.id and cr.is_active)`
          : kind === 'employee'
            ? sql` and exists (select 1 from employee_roles er where er.org_id = p.org_id and er.party_id = p.id and er.is_active)`
            : sql``
    const r = await db.execute<{ value: string; label: string; hint: string | null }>(sql`
      select p.id as value, p.display_name as label, p.short_code as hint from parties p
       where p.org_id = ${orgId} and p.is_active ${roleFilter}
         ${subsidiaryVisibleFilter(sql`p.subsidiary_id`, authz.allowedSubsidiaryIds, { orgWideNull: true })}
       order by p.display_name limit 5000
    `)
    return NextResponse.json({ options: r.rows.map(row => ({ ...row, hint: row.hint ?? undefined })) })
  }

  if (table === 'projects') {
    const r = await db.execute<{ value: string; label: string }>(sql`
      select p.id as value, p.name as label from projects p
       where p.org_id = ${orgId} and p.is_active
         ${subsidiaryVisibleFilter(sql`p.subsidiary_id`, authz.allowedSubsidiaryIds)}
       order by p.name limit 5000
    `)
    return NextResponse.json({ options: r.rows })
  }
  if (table === 'items') {
    const r = await db.execute<{ value: string; label: string }>(sql`
      select id as value, name as label from items
       where org_id = ${orgId} and is_active order by name limit 5000
    `)
    return NextResponse.json({ options: r.rows })
  }
  return NextResponse.json({ error: 'unknown source' }, { status: 400 })
}
