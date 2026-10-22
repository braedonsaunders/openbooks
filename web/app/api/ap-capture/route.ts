import { defineRoute } from '@/lib/api/route'
import { apiErrorResponse } from '@/lib/api/error-response'
import { NextResponse } from 'next/server'
import '../../../lib/authz';
import { ingestCaptureFiles } from './ingest'

export const runtime = 'nodejs'

export const POST = defineRoute({
  permission: 'ap.create',
  feature: { none: 'No optional feature applies to this permission-governed endpoint.' },
  handler: async ({ request: request, authz: gate }) => {
    const form = await request.formData()
    const files = form.getAll('files').filter((value): value is File => value instanceof File)
    const intake = await ingestCaptureFiles({
      orgId: gate.user.orgId,
      actorId: gate.user.id,
      allowedSubsidiaryIds: gate.allowedSubsidiaryIds,
      source: 'upload',
      files: await Promise.all(files.map(async (file) => ({
        filename: file.name,
        contentType: file.type,
        bytes: Buffer.from(await file.arrayBuffer()),
      }))),
    })
    if (!intake.ok) {
      if ('thrown' in intake) {
        return intake.safeStatus ? apiErrorResponse(intake.thrown, { safeStatus: intake.safeStatus }) : apiErrorResponse(intake.thrown)
      }
      return NextResponse.json(intake.body, { status: intake.status })
    }
    const failed = intake.results.some((result) => result.status === 'failed')
    return NextResponse.json({ ids: intake.ids, results: intake.results }, { status: failed ? 207 : 201 })
  },
})
