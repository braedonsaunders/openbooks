import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { guardPermission } from '../../../../lib/authz'
import { inTypeAudience, loadRecordTypeByKey } from '../../../../lib/records'
import { clamp } from '../../../../lib/list-params'
import { pgTextArrayLiteral } from '../../../../lib/pg-array'
import { lintRecordFields } from '../../../../lib/record-schema'

export const runtime = 'nodejs'

/**
 * Records of one type: `?q=` searches the precomputed search text +
 * record number, `?status=` filters, `?page=/&perPage=` paginate.
 */
export async function GET(req: Request, { params }: { params: Promise<{ typeKey: string }> }) {
  const gate = await guardPermission('records.read')
  if (gate instanceof NextResponse) return gate
  const { user } = gate
  const { typeKey } = await params

  const type = await loadRecordTypeByKey(user.orgId, typeKey)
  if (!type || type.status !== 'published' || !inTypeAudience(user.roles.map(({ key }) => key), type.allowed_roles)) {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }
  const lint = lintRecordFields(type.fields, type.name)
  const hasSubsidiaryField = lint.success && lint.sections.some((section) =>
    section.fields.some((field) => field.id === 'subsidiary_id'),
  )

  const url = new URL(req.url)
  const q = url.searchParams.get('q')?.trim()
  const status = url.searchParams.get('status')
  const page = clamp(Number(url.searchParams.get('page') ?? '1'), 1, 10_000)
  const perPage = clamp(Number(url.searchParams.get('perPage') ?? '25'), 5, 100)

  const where = sql`r.org_id = ${user.orgId} and r.type_key = ${typeKey}
    ${!hasSubsidiaryField || gate.allowedSubsidiaryIds === null
      ? sql``
      : gate.allowedSubsidiaryIds.size === 0
        ? sql` and false`
        : sql` and r.data ->> ${'subsidiary_id'} = any(${pgTextArrayLiteral([...gate.allowedSubsidiaryIds])}::text[])`}
    ${status ? sql` and r.status = ${status}` : sql``}
    ${q ? sql` and (r.search_text ilike ${'%' + q.toLowerCase() + '%'} or r.record_number ilike ${'%' + q + '%'})` : sql``}`

  const [rows, count] = await Promise.all([
    (db.execute(sql`
      select r.id, r.record_number, r.data, r.status, r.created_at, r.updated_at
        from custom_records r
       where ${where}
       order by r.created_at desc
       limit ${perPage} offset ${(page - 1) * perPage}
    `)),
    db.execute<{ n: string }>(sql`select count(*) as n from custom_records r where ${where}`),
  ])

  return NextResponse.json({
    records: rows.rows,
    total: Number(count.rows[0]?.n ?? 0),
    page,
    perPage,
  })
}
