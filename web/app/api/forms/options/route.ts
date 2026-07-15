import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { PARTY_PICKER_KINDS, type PartyPickerKind } from '@openbooks/forms-core'
import { getAuthz } from '../../../../lib/authz'

export const runtime = 'nodejs'

/**
 * Options feed for the data-bound pickers in the forms-core field registry
 * (FIELD_TYPES[*].optionsSource documents this exact contract):
 *
 *   GET /api/forms/options?source=gl_accounts
 *     → active, non-summary accounts as { value, label, hint }
 *   GET /api/forms/options?source=parties[&partyKind=vendor|customer|employee|any]
 *     → active parties, optionally narrowed to a role
 *
 * Auth: any signed-in org user — pickers back both record editors and form
 * fillers, whose module permissions vary; account numbers/names and party
 * display names are org-internal master data, not privileged detail.
 */
export async function GET(req: Request) {
  const authz = await getAuthz()
  if (!authz) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const orgId = authz.user.orgId

  const url = new URL(req.url)
  const source = url.searchParams.get('source')

  if (source === 'gl_accounts') {
    const r = (await db.execute(sql`
      select id, number, name from accounts
       where org_id = ${orgId} and is_active and not is_summary
       order by number nulls last, name
       limit 5000
    `)) as unknown as { rows: { id: string; number: string | null; name: string }[] }
    return NextResponse.json({
      options: r.rows.map((a) => ({
        value: a.id,
        label: `${a.number ?? ''} ${a.name}`.trim(),
      })),
    })
  }

  if (source === 'parties') {
    const rawKind = url.searchParams.get('partyKind') ?? 'any'
    const kind = (PARTY_PICKER_KINDS as readonly string[]).includes(rawKind)
      ? (rawKind as PartyPickerKind)
      : 'any'
    // Role membership comes from the role tables; parties imported by the
    // sync bridge carry their source role in custom->>'nsKind' until role
    // rows exist, so accept either signal.
    const roleFilter =
      kind === 'vendor'
        ? sql` and (exists (select 1 from vendor_roles vr where vr.party_id = p.id) or p.custom->>'nsKind' = 'vendor')`
        : kind === 'customer'
          ? sql` and (exists (select 1 from customer_roles cr where cr.party_id = p.id) or p.custom->>'nsKind' = 'customer')`
          : kind === 'employee'
            ? sql` and (exists (select 1 from employee_roles er where er.party_id = p.id) or p.custom->>'nsKind' = 'employee')`
            : sql``
    const r = (await db.execute(sql`
      select p.id, p.display_name, p.short_code from parties p
       where p.org_id = ${orgId} and p.is_active${roleFilter}
       order by p.display_name
       limit 5000
    `)) as unknown as { rows: { id: string; display_name: string; short_code: string | null }[] }
    return NextResponse.json({
      options: r.rows.map((p) => ({
        value: p.id,
        label: p.display_name,
        hint: p.short_code ?? undefined,
      })),
    })
  }

  if (source === 'reference') {
    const table = url.searchParams.get('table')
    const allowed = ['parties', 'projects', 'accounts', 'items']
    if (!table || !allowed.includes(table)) {
      return NextResponse.json({ error: 'invalid reference table' }, { status: 400 })
    }
    let queryText: string
    if (table === 'parties') {
      queryText = `select id as value, display_name as label, short_code as hint from parties where org_id = $1 and is_active order by display_name limit 5000`
    } else if (table === 'projects') {
      queryText = `select id as value, name as label from projects where org_id = $1 and is_active order by name limit 5000`
    } else if (table === 'accounts') {
      queryText = `select id as value, (number || ' ' || name) as label from accounts where org_id = $1 and is_active and not is_summary order by number nulls last, name limit 5000`
    } else {
      queryText = `select id as value, name as label from items where org_id = $1 and is_active order by name limit 5000`
    }
    const pool = (await import('@openbooks/engine/src/db.ts')).pool
    const client = await pool.connect()
    try {
      const res = await client.query(queryText, [orgId])
      return NextResponse.json({ options: res.rows })
    } finally {
      client.release()
    }
  }

  return NextResponse.json({ error: 'unknown source' }, { status: 400 })
}
