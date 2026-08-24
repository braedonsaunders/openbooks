import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { guardPermission, guardSubsidiaryScope } from '../../../../../lib/authz'
import { DOC_KIND_FEATURE } from '../../../../../lib/document-kinds'
import { isDocKindEnabled } from '../../../../../lib/documents'
import { isUuid } from '../../../../../lib/list-params'
import { subsidiaryVisibleFilter } from '../../../../../lib/subsidiaries'

export const runtime = 'nodejs'

const PAGE_SIZE = 15

/** Searchable, filtered activity sublist for a party flyout. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission('parties.read')
  if (gate instanceof NextResponse) return gate
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 })

  // The party is the record boundary (null-subsidiary parties are org-wide);
  // its transaction rows are additionally narrowed to the caller's visible
  // subsidiaries, mirroring the documents lists.
  const scope = (await db.execute<{ subsidiaryId: string | null }>(
    sql`select subsidiary_id as "subsidiaryId" from parties where id = ${id} and org_id = ${gate.user.orgId}`,
  ))
  if (!scope.rows[0]) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const scopeDenied = guardSubsidiaryScope(gate, scope.rows[0].subsidiaryId, { orgWideNull: true })
  if (scopeDenied) return scopeDenied
  const documentScope = subsidiaryVisibleFilter(sql`d.subsidiary_id`, gate.allowedSubsidiaryIds)

  const url = new URL(request.url)
  const q = url.searchParams.get('q')?.trim().slice(0, 100) ?? ''
  const kind = url.searchParams.get('kind')?.trim().slice(0, 50) ?? ''
  const status = url.searchParams.get('status')?.trim().slice(0, 50) ?? ''
  const requestedPage = Number(url.searchParams.get('page') ?? '1')
  const page = Number.isSafeInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1

  if (kind && !(await isDocKindEnabled(gate.user.orgId, kind))) {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }
  const hiddenKinds: string[] = []
  for (const optionalKind of Object.keys(DOC_KIND_FEATURE)) {
    if (!(await isDocKindEnabled(gate.user.orgId, optionalKind))) hiddenKinds.push(optionalKind)
  }
  const hiddenKindFilter = hiddenKinds.length
    ? sql`and d.kind not in (${sql.join(hiddenKinds.map((value) => sql`${value}`), sql`, `)})`
    : sql``

  const where = sql`d.org_id = ${gate.user.orgId} and d.party_id = ${id}
    ${q ? sql`and (d.document_number ilike ${`%${q}%`} or coalesce(d.reference_number, '') ilike ${`%${q}%`} or coalesce(d.memo, '') ilike ${`%${q}%`})` : sql``}
    ${kind ? sql`and d.kind = ${kind}` : sql``}
    ${status ? sql`and d.status = ${status}` : sql``}
    ${hiddenKindFilter}
    ${documentScope}`

  const [rows, total, filters] = (await Promise.all([
    db.execute<Record<string, unknown>>(sql`
      select d.id, d.kind, d.document_number, d.reference_number, d.document_date,
             d.due_date, d.status, d.currency, d.total, d.open_balance, d.memo
        from documents d where ${where}
       order by d.document_date desc, d.created_at desc
       limit ${PAGE_SIZE} offset ${(page - 1) * PAGE_SIZE}`),
    db.execute<Record<string, unknown>>(sql`select count(*)::int as count from documents d where ${where}`),
    db.execute<Record<string, unknown>>(sql`
      select array_remove(array_agg(distinct d.kind order by d.kind), null) as kinds,
             array_remove(array_agg(distinct d.status order by d.status), null) as statuses
        from documents d
       where d.org_id = ${gate.user.orgId} and d.party_id = ${id} ${hiddenKindFilter}`),
  ]))

  return NextResponse.json({
    rows: rows.rows,
    total: Number(total.rows[0]?.count ?? 0),
    page,
    perPage: PAGE_SIZE,
    kinds: filters.rows[0]?.kinds ?? [],
    statuses: filters.rows[0]?.statuses ?? [],
  })
}
