import { defineRoute } from '@/lib/api/route';
import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { isUuid } from '../../../../../../lib/list-params'
import { reportArtifactAccessDetail } from '../../../../../../lib/report-execution-context'
import { blobResponse } from '../../../../../../lib/blob-response'
import { notFound } from "@/lib/api/responses";


export const runtime = 'nodejs'

/** Serve the immutable rendered artifact retained for a scheduled run. */
export const GET = defineRoute({
  permission: 'reports.read',
  feature: { none: "This always-on route is governed by reports.read; the existing route has no separate feature gate." },
  handler: async ({ request: req, authz: routeAuthz, params: routeParams }) => {
    const params = Promise.resolve(routeParams as { id: string });
    const gate = routeAuthz;
    const { id } = await params
    if (!isUuid(id)) return notFound("record")
    const result = (await db.execute<{ filename: string; content_type: string; bytes: Buffer; content_hash: string; authorization_snapshot: unknown }>(sql`
        select a.filename, a.content_type, a.bytes, a.content_hash, r.authorization_snapshot
          from report_run_artifacts a
          join report_runs r on r.id=a.run_id and r.org_id=a.org_id
          join report_definitions def on def.id = r.definition_id and def.org_id = r.org_id
         where r.id=${id} and r.org_id=${gate.user.orgId}
      `))
    const row = result.rows[0]
    if (!row) return notFound("record")
    const access = await reportArtifactAccessDetail(gate, row.authorization_snapshot)
    if (!access.ok) {
        return NextResponse.json({ error: access.missingPermissions.length > 0
          ? `report artifact requires ${access.missingPermissions.join(', ')}`
          : 'report artifact access denied or original scope unavailable' }, { status: 403 })
      }
    return blobResponse(req, {
        filename: row.filename,
        contentType: row.content_type,
        bytes: Buffer.from(row.bytes),
        versionId: row.content_hash,
      }, { immutable: true, fallbackName: 'scheduled-report.pdf' })
  },
});
