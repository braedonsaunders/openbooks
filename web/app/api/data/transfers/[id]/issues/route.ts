import { z } from 'zod'
import { sql } from 'drizzle-orm'
import { db, withOrgContext, withOrgTransaction } from '@openbooks/engine/platform/database'
import { guardCsvCell } from '@openbooks/office'
import { defineRoute } from '@/lib/api/route'
import { authorizeTransfers, transferFeature } from '@/lib/data-io/transfer-api'
import { loadTransfer, transferAuthority } from '@/lib/data-io/transfer-store'
export const runtime = 'nodejs'
export const GET = defineRoute({ authorize: authorizeTransfers, feature: transferFeature, params: z.object({ id: z.uuid() }),
  handler: async ({ authz, params, request }) => {
    const orgId = authz.user.orgId, phase = new URL(request.url).searchParams.get('phase') === 'commit' ? 'commit' : 'preview'
    await withOrgTransaction(orgId, async () => { await transferAuthority(await loadTransfer(orgId, params.id), authz) })
    let after = -1, header = false
    const cell = (value: unknown) => `"${String(guardCsvCell(String(value ?? ''))).replaceAll('"', '""')}"`
    const stream = new ReadableStream<Uint8Array>({ async pull(controller) {
      try {
        if (!header) { header = true; controller.enqueue(new TextEncoder().encode('Row,Severity,Field,Message\r\n')); return }
        const rows = await withOrgContext(orgId, () => withOrgTransaction(orgId, async () => {
          await transferAuthority(await loadTransfer(orgId, params.id))
          // A row may have several findings; page complete row-number groups.
          return (await db.execute<{ row: number; severity: string; field: string | null; message: string }>(sql`
            with page as (select distinct row_no from data_transfer_issues where org_id=${orgId} and job_id=${params.id} and phase=${phase} and row_no>${after} order by row_no limit 250)
            select i.row_no::float8 as row,i.severity,i.field,i.message from data_transfer_issues i join page on page.row_no=i.row_no
            where i.org_id=${orgId} and i.job_id=${params.id} and i.phase=${phase} order by i.row_no,i.severity,i.field,i.message`)).rows
        }))
        if (!rows.length) { controller.close(); return }
        after = rows[rows.length - 1]!.row
        controller.enqueue(new TextEncoder().encode(rows.map((row) => [row.row, row.severity, row.field, row.message].map(cell).join(',')).join('\r\n') + '\r\n'))
      } catch (error) { controller.error(error) }
    } })
    return new Response(stream, { headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="import-issues.csv"', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } })
  },
})
