import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { businessToday } from '@openbooks/engine/src/platform/business-date.ts'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { guardPermission } from '../../../../../lib/authz'
import { isFeatureEnabled } from '../../../../../lib/features'

export const runtime = 'nodejs'

const SUBJECT_KINDS = ['project', 'equipment', 'position', 'classification'] as const
const PAGE_SIZE = 20

/** Search bounded authoring options through the same subsidiary fence as requirement writes. */
export async function GET(req: Request) {
  const gate = await guardPermission('hrm.certifications.manage')
  if (gate instanceof NextResponse) return gate
  if (!(await isFeatureEnabled(gate.user.orgId, 'hrmCertifications'))) {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }
  const params = new URL(req.url).searchParams
  const subjectKind = params.get('subjectKind')
  if (!SUBJECT_KINDS.includes(subjectKind as (typeof SUBJECT_KINDS)[number])) {
    return NextResponse.json({ error: 'subjectKind must be one of project, equipment, position, classification' }, { status: 400 })
  }
  const query = (params.get('q') ?? '').trim()
  if (query.length < 2) return NextResponse.json({ options: [], hasMore: false })
  const pattern = `%${query.replace(/[\\%_]/g, '\\$&')}%`
  const ids = gate.allowedSubsidiaryIds === null ? null : `{${[...gate.allowedSubsidiaryIds].join(',')}}`
  const orgId = gate.user.orgId
  let rows: { id: string; label: string }[]

  if (subjectKind === 'project') {
    rows = (await db.execute<{ id: string; label: string }>(sql`
      select id::text as id, name as label from projects
       where org_id = ${orgId}::uuid
         and (${ids}::uuid[] is null or subsidiary_id = any(${ids}::uuid[]))
         and name ilike ${pattern} escape '\\'
       order by name, id limit ${PAGE_SIZE + 1}
    `)).rows
  } else if (subjectKind === 'equipment') {
    rows = (await db.execute<{ id: string; label: string }>(sql`
      select id::text as id, coalesce(name, serial_number, unit_number) as label
        from equipment_units
       where org_id = ${orgId}::uuid
         and (${ids}::uuid[] is null or subsidiary_id = any(${ids}::uuid[]))
         and coalesce(name, serial_number, unit_number) ilike ${pattern} escape '\\'
       order by label, id limit ${PAGE_SIZE + 1}
    `)).rows
  } else if (subjectKind === 'position') {
    const today = await businessToday(orgId)
    rows = (await db.execute<{ id: string; label: string }>(sql`
      select p.id::text as id, p.position_code || ' · ' || v.title as label
        from positions p
        join position_versions v
          on v.org_id = p.org_id and v.position_id = p.id and v.recorded_until is null
         and v.effective_from <= ${today}::date
         and (v.effective_to is null or v.effective_to > ${today}::date)
       where p.org_id = ${orgId}::uuid and v.status <> 'closed'
         and (${ids}::uuid[] is null or v.employer_subsidiary_id = any(${ids}::uuid[]))
         and (p.position_code || ' ' || v.title) ilike ${pattern} escape '\\'
       order by p.position_code, p.id limit ${PAGE_SIZE + 1}
    `)).rows
  } else {
    rows = (await db.execute<{ id: string; label: string }>(sql`
      select id::text as id, code || ' · ' || name as label
        from hrm_work_classifications
       where org_id = ${orgId}::uuid and is_active
         and (code || ' ' || name || ' ' || trade) ilike ${pattern} escape '\\'
       order by code, id limit ${PAGE_SIZE + 1}
    `)).rows
  }

  return NextResponse.json({ options: rows.slice(0, PAGE_SIZE), hasMore: rows.length > PAGE_SIZE })
}
