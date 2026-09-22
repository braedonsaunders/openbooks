import { parseJsonBody } from '@/lib/api/json'
import { NextResponse } from 'next/server'
import { deleteProcessTemplateStep, upsertProcessTemplateStep } from '@openbooks/engine/src/hrm/processes.ts'
import { guardPermission } from '../../../../../../../lib/authz'
import { isFeatureEnabled } from '../../../../../../../lib/features'
import { isUuid } from '../../../../../../../lib/list-params'
import { processErrorResponse } from '../../../../processes/_lib'
import { saveProcessTemplateStepBody } from '../../../bodies'

export const runtime = 'nodejs'

async function gate() {
  const result = await guardPermission('hrm.process.manage')
  if (result instanceof NextResponse) return result
  if (!(await isFeatureEnabled(result.user.orgId, 'hrm'))) {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }
  return result
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string; stepId: string }> }) {
  const authz = await gate()
  if (authz instanceof NextResponse) return authz
  const parsed = await parseJsonBody(req, saveProcessTemplateStepBody)
  if (!parsed.ok) return parsed.response
  const ids = await params
  if (!isUuid(ids.id) || !isUuid(ids.stepId)) {
    return NextResponse.json({ error: 'template and step ids must be uuids' }, { status: 400 })
  }
  try {
    const step = await upsertProcessTemplateStep({
      orgId: authz.user.orgId,
      actorId: authz.user.id,
      templateId: ids.id,
      stepId: ids.stepId,
      ...parsed.data,
    })
    return NextResponse.json({ step })
  } catch (error) {
    return processErrorResponse(error)
  }
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string; stepId: string }> }) {
  const authz = await gate()
  if (authz instanceof NextResponse) return authz
  const ids = await params
  if (!isUuid(ids.id) || !isUuid(ids.stepId)) {
    return NextResponse.json({ error: 'template and step ids must be uuids' }, { status: 400 })
  }
  try {
    await deleteProcessTemplateStep({
      orgId: authz.user.orgId,
      actorId: authz.user.id,
      templateId: ids.id,
      stepId: ids.stepId,
    })
    return NextResponse.json({ ok: true })
  } catch (error) {
    return processErrorResponse(error)
  }
}
