import { defineRoute } from '@/lib/api/route';
import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { isUuid } from '../../../../../../lib/list-params'
import { reportArtifactAccessDetail } from '../../../../../../lib/report-execution-context'
import { businessToday } from '@openbooks/engine/src/platform/business-date.ts'
import { notFound } from "@/lib/api/responses";


export const runtime = 'nodejs'

/** Download the stored CSV artifact of a recorded run, scoped to the org. */
export const GET = defineRoute({
  permission: 'reports.read',
  feature: { none: "This always-on route is governed by reports.read; the existing route has no separate feature gate." },
  handler: async ({ request: _req, authz: routeAuthz, params: routeParams }) => {
    const params = Promise.resolve(routeParams as { id: string });
    const gate = routeAuthz;
    const { user } = gate
    const { id } = await params
    if (!isUuid(id)) return notFound("record")
    const r = (await db.execute<{ result_csv: string | null; status: string; slug: string; authorization_snapshot: unknown }>(sql`
        select run.result_csv, run.status, def.slug, run.authorization_snapshot
          from report_runs run
          join report_definitions def on def.id = run.definition_id and def.org_id = run.org_id
         where run.id = ${id} and run.org_id = ${user.orgId}
      `))
    const row = r.rows[0]
    if (!row) return notFound("record")
    const access = await reportArtifactAccessDetail(gate, row.authorization_snapshot)
    if (!access.ok) {
        return NextResponse.json({ error: access.missingPermissions.length > 0
          ? `report artifact requires ${access.missingPermissions.join(', ')}`
          : 'report artifact access denied or original scope unavailable' }, { status: 403 })
      }
    if (row.status !== 'succeeded' || row.result_csv == null) {
        return NextResponse.json({ error: 'no result available for this run' }, { status: 409 })
      }
    const stamp = await businessToday(user.orgId)
    return new NextResponse(row.result_csv, {
        status: 200,
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="${row.slug}-${stamp}.csv"`,
        },
      })
  },
});
