import { z } from 'zod'
import { createHash } from 'node:crypto'
import { basename } from 'node:path'
import { NextResponse } from 'next/server'
import { defineRoute } from '@/lib/api/route'
import { apiErrorResponse } from '@/lib/api/error-response'
import { can } from '@/lib/authz'
import { db } from '@openbooks/engine/platform/db'
import { captureContentMatchesMime } from '@openbooks/engine/payables/ap-capture'
import { documentCaptureOperational, getDocumentCaptureRuntimeConfig, type DocumentCaptureRuntimeConfig } from '@openbooks/engine/payables/ap-capture-config'
import { isReceiptContentType } from '@openbooks/engine/payables/receipt-capture'
import {
  extractReceiptCapture,
  listReceiptCaptures,
  loadReceiptReport,
  ReceiptCaptureRefusal,
  registerReceiptCapture,
  requireEditableReceiptReport,
} from '@openbooks/engine/payables/receipt-capture-service'
import { uploadAndAttach } from '../../../../../lib/file-cabinet'
import { attachmentMutationRefusal, authorizeAttachmentTargetMutation } from '../../../file-cabinet/lib'
import { isUuid } from '../../../../../lib/list-params'

export const runtime = 'nodejs'

const MAX_FILES = 10
const MAX_BYTES = 20 * 1024 * 1024
const CONFIGURE_HREF = '/admin/ai'

const params = z.object({ id: z.string().refine(isUuid) })

function safeFilename(value: string): string {
  return basename(value).replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 240) || 'receipt'
}

/**
 * Receipts scanned onto one expense report, with whether document capture
 * can run and where an administrator configures it.
 */
export const GET = defineRoute({
  params,
  invalidParamsNotFound: 'record',
  permission: 'expenses.read',
  feature: 'expenses',
  handler: async ({ authz: gate, params: routeParams }) => {
    const { id } = routeParams as { id: string }
    try {
      const report = await loadReceiptReport(db, { orgId: gate.user.orgId, documentId: id, allowedSubsidiaryIds: gate.allowedSubsidiaryIds })
      const [captures, operational] = await Promise.all([
        listReceiptCaptures(gate.user.orgId, id),
        documentCaptureOperational(gate.user.orgId),
      ])
      return NextResponse.json({
        captures,
        reportCurrency: report.currency,
        canScan: report.status === 'draft' && can(gate, 'expenses.create'),
        captureOperational: operational,
        canConfigure: can(gate, 'admin.ai.manage'),
        configureHref: CONFIGURE_HREF,
      })
    } catch (error) {
      if (error instanceof ReceiptCaptureRefusal) return apiErrorResponse(error)
      throw error
    }
  },
})

/**
 * Scan receipts onto a draft expense report. Each file is attached to the
 * report as evidence and registered in one transaction, then read through
 * the organization's document capture provider. A file the provider cannot
 * read is kept as a failed capture with its reason and can be retried.
 */
export const POST = defineRoute({
  params,
  invalidParamsNotFound: 'record',
  permission: 'expenses.create',
  feature: 'expenses',
  handler: async ({ request, authz: gate, params: routeParams }) => {
    const { id } = routeParams as { id: string }
    const orgId = gate.user.orgId
    try {
      await requireEditableReceiptReport(db, { orgId, documentId: id, allowedSubsidiaryIds: gate.allowedSubsidiaryIds })
    } catch (error) {
      if (error instanceof ReceiptCaptureRefusal) return apiErrorResponse(error)
      throw error
    }
    let config: DocumentCaptureRuntimeConfig | null
    try {
      config = await getDocumentCaptureRuntimeConfig(orgId)
    } catch (error) {
      // A misconfigured endpoint is a typed 422 naming its remedy; anything
      // else is unexpected and answers through the shared mapping.
      return apiErrorResponse(error)
    }
    if (!config) {
      return NextResponse.json({
        error: 'Receipt scanning uses the document capture provider, which is disabled or not configured — an administrator enables it under Platform → AI',
        code: 'capture_not_configured',
        configureHref: CONFIGURE_HREF,
      }, { status: 409 })
    }

    const form = await request.formData().catch(() => null)
    if (!form) return NextResponse.json({ error: 'Send the receipts as multipart form data' }, { status: 400 })
    const files = form.getAll('files').filter((value): value is File => value instanceof File)
    if (files.length === 0) return NextResponse.json({ error: 'Choose at least one receipt to scan', code: 'no_files' }, { status: 400 })
    if (files.length > MAX_FILES) {
      return NextResponse.json({ error: `Scan at most ${MAX_FILES} receipts at a time`, code: 'too_many_files' }, { status: 422 })
    }
    const prepared: Array<{ filename: string; contentType: string; bytes: Buffer; hash: string }> = []
    for (const file of files) {
      const filename = safeFilename(file.name)
      const contentType = file.type.split(';')[0]!.trim().toLowerCase()
      if (!isReceiptContentType(contentType)) {
        return NextResponse.json({ error: `${filename} is not a PDF, JPEG, PNG or TIFF receipt`, code: 'unsupported_type', filename }, { status: 422 })
      }
      if (file.size <= 0 || file.size > MAX_BYTES) {
        return NextResponse.json({ error: `${filename} must be between 1 byte and 20 MB`, code: 'invalid_size', filename }, { status: 422 })
      }
      const bytes = Buffer.from(await file.arrayBuffer())
      if (!captureContentMatchesMime(bytes, contentType)) {
        return NextResponse.json({ error: `${filename} does not contain the ${contentType} content its type names`, code: 'content_type_mismatch', filename }, { status: 422 })
      }
      prepared.push({ filename, contentType, bytes, hash: createHash('sha256').update(bytes).digest('hex') })
    }

    const created: string[] = []
    const results: Array<{ filename: string; id?: string; status: 'scanned' | 'failed'; error?: string }> = []
    for (const upload of prepared) {
      let registered: { id: string; attempt: number }
      try {
        registered = await db.transaction(async (tx) => {
          // The report row lock keeps the draft from being submitted between
          // the status check and the evidence write.
          await requireEditableReceiptReport(tx, { orgId, documentId: id, allowedSubsidiaryIds: gate.allowedSubsidiaryIds, forUpdate: true })
          const attached = await uploadAndAttach({
            orgId,
            targetTable: 'documents',
            targetId: id,
            filename: upload.filename,
            contentType: upload.contentType,
            bytes: upload.bytes,
            createdBy: gate.user.id,
            executor: tx,
            authorizeTarget: (executor) => authorizeAttachmentTargetMutation(gate, 'documents', id, executor),
          })
          return registerReceiptCapture(tx, {
            orgId,
            documentId: id,
            fileId: attached.id,
            contentHash: upload.hash,
            originalFilename: upload.filename,
            actorId: gate.user.id,
          })
        })
      } catch (error) {
        const refusal = attachmentMutationRefusal(error)
        if (refusal) return refusal
        if (error instanceof ReceiptCaptureRefusal) return apiErrorResponse(error)
        throw error
      }
      created.push(registered.id)
      await extractReceiptCapture({ orgId, captureId: registered.id, attempt: registered.attempt, actorId: gate.user.id })
      results.push({ filename: upload.filename, id: registered.id, status: 'scanned' })
    }

    const captures = (await listReceiptCaptures(orgId, id)).filter((capture) => created.includes(capture.id))
    for (const result of results) {
      const capture = captures.find((entry) => entry.id === result.id)
      if (capture?.status === 'failed') {
        result.status = 'failed'
        result.error = capture.lastError ?? undefined
      }
    }
    const failed = results.some((result) => result.status === 'failed')
    return NextResponse.json({ captures, results }, { status: failed ? 207 : 201 })
  },
})
