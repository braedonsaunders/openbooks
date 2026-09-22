import { parseJsonBody } from '@/lib/api/json'
import { NextResponse } from 'next/server'
import { upsertProcessTemplateStep } from '@openbooks/engine/src/hrm/processes.ts'
import { guardPermission } from '../../../../../../lib/authz'
import { isFeatureEnabled } from '../../../../../../lib/features'
import { isUuid } from '../../../../../../lib/list-params'
import { processErrorResponse } from '../../../processes/_lib'
import { saveProcessTemplateStepBody } from '../../bodies'

export const runtime = 'nodejs'

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const authz = await guardPermission('hrm.process.manage')
  if (authz instanceof NextResponse) return authz
  if (!(await isFeatureEnabled(authz.user.orgId, 'hrm'))) {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }
  const parsed = await parseJsonBody(req, saveProcessTemplateStepBody)
  if (!parsed.ok) return parsed.response
  const id = (await params).id
  if (!isUuid(id)) return NextResponse.json({ error: 'template id must be a uuid' }, { status: 400 })
  try {
    const step = await upsertProcessTemplateStep({
      orgId: authz.user.orgId,
      actorId: authz.user.id,
      templateId: id,
      ...parsed.data,
    })
    return NextResponse.json({ step }, { status: 201 })
  } catch (error) {
    return processErrorResponse(error)
  }
}
