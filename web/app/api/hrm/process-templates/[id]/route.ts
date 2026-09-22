import { parseJsonBody } from '@/lib/api/json'
import { NextResponse } from 'next/server'
import { getProcessTemplate, updateProcessTemplate } from '@openbooks/engine/src/hrm/processes.ts'
import { guardPermission } from '../../../../../lib/authz'
import { isFeatureEnabled } from '../../../../../lib/features'
import { isUuid } from '../../../../../lib/list-params'
import { processErrorResponse } from '../../processes/_lib'
import { updateProcessTemplateBody } from '../bodies'

export const runtime = 'nodejs'

async function gate() {
  const result = await guardPermission('hrm.process.manage')
  if (result instanceof NextResponse) return result
  if (!(await isFeatureEnabled(result.user.orgId, 'hrm'))) {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }
  return result
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const authz = await gate()
  if (authz instanceof NextResponse) return authz
  const id = (await params).id
  if (!isUuid(id)) return NextResponse.json({ error: 'template id must be a uuid' }, { status: 400 })
  try {
    const template = await getProcessTemplate({
      orgId: authz.user.orgId,
      actorId: authz.user.id,
      templateId: id,
    })
    return NextResponse.json({ template })
  } catch (error) {
    return processErrorResponse(error)
  }
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const authz = await gate()
  if (authz instanceof NextResponse) return authz
  const parsed = await parseJsonBody(req, updateProcessTemplateBody)
  if (!parsed.ok) return parsed.response
  const id = (await params).id
  if (!isUuid(id)) return NextResponse.json({ error: 'template id must be a uuid' }, { status: 400 })
  try {
    const template = await updateProcessTemplate({
      orgId: authz.user.orgId,
      actorId: authz.user.id,
      templateId: id,
      ...parsed.data,
    })
    return NextResponse.json({ template })
  } catch (error) {
    return processErrorResponse(error)
  }
}
