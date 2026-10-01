import { z } from 'zod'
import { sql } from 'drizzle-orm'
import { db, withOrgContext, withOrgTransaction } from '@openbooks/engine/platform/database'
import { defineRoute } from '@/lib/api/route'
import { apiErrorResponse } from '@/lib/api/error-response'
import { authorizeTransfers, transferFeature } from '@/lib/data-io/transfer-api'
import { digest, loadTransfer, recordTransferEvent, transferAuthority } from '@/lib/data-io/transfer-store'
import { TRANSFER_CHUNK_BYTES, TransferRefusal } from '@/lib/data-io/transfer-contract'
import { transferDownloadRange } from '@/lib/data-io/download-range'
export const runtime = 'nodejs'
export const GET = defineRoute({ authorize: authorizeTransfers, feature: transferFeature, params: z.object({ id: z.uuid() }),
  handler: async ({ authz, params, request }) => {
    const orgId = authz.user.orgId
    const job = await withOrgTransaction(orgId, async () => {
      const job = await loadTransfer(orgId, params.id)
      await transferAuthority(job, authz)
      if (job.kind !== 'export' || job.state !== 'completed') throw new TransferRefusal('This export is not complete — wait for the worker to finish before downloading.')
      await recordTransferEvent(job, 'download-started', job.state, { checksum: job.sourceHash, bytes: job.bytes })
      return job
    })
    const etag = `"${job.sourceHash}"`
    let range: ReturnType<typeof transferDownloadRange>
    try { range = transferDownloadRange(!request.headers.has('if-range') || request.headers.get('if-range') === etag ? request.headers.get('range') : null, job.bytes) }
    catch (error) {
      if (!(error instanceof TransferRefusal) || error.status !== 416) throw error
      const response = await apiErrorResponse(error, { request })
      response.headers.set('Content-Range', `bytes */${job.bytes}`)
      response.headers.set('Cache-Control', 'private, no-store')
      return response
    }
    const start = range?.start ?? 0, end = range?.end ?? job.bytes - 1, length = end - start + 1
    let part = Math.floor(start / TRANSFER_CHUNK_BYTES), sent = 0, cancelled = false
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          if (sent === length) { controller.close(); return }
          const chunk = await withOrgContext(orgId, () => withOrgTransaction(orgId, async () => {
            const live = await loadTransfer(orgId, job.id)
            // Resolve the actor again during a long download, including deactivation.
            await transferAuthority(live)
            return (await db.execute<{ data: Buffer; sha256: string }>(sql`select data,sha256 from data_transfer_chunks where org_id=${orgId} and job_id=${job.id} and direction='output' and part_no=${part}`)).rows[0]
          }))
          if (cancelled) return
          if (!chunk) {
            if (sent !== length) throw new TransferRefusal('The export artifact is incomplete — create a new export.', 422)
            controller.close(); return
          }
          if (digest(chunk.data) !== chunk.sha256) throw new TransferRefusal('The export artifact failed its checksum — create a new export.', 422)
          const offset = sent === 0 ? start % TRANSFER_CHUNK_BYTES : 0
          const data = chunk.data.subarray(offset, Math.min(chunk.data.length, offset + length - sent))
          if (!data.length) throw new TransferRefusal('The export artifact is incomplete — create a new export.', 422)
          sent += data.length; part++; controller.enqueue(data)
        } catch (error) { if (!cancelled) controller.error(error) }
      },
      cancel() { cancelled = true },
    })
    return new Response(stream, { status: range ? 206 : 200, headers: {
      'Content-Type': job.format === 'csv' ? 'text/csv; charset=utf-8' : job.format === 'json' ? 'application/json' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${job.filename.replace(/[^a-zA-Z0-9._ -]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(job.filename)}`,
      'Content-Length': String(length), 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff',
      'Accept-Ranges': 'bytes', ...(range ? { 'Content-Range': `bytes ${start}-${end}/${job.bytes}` } : {}), ETag: etag,
    } })
  },
})
