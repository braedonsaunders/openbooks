import { parseJsonBody } from '@/lib/api/json'
import { NextResponse } from 'next/server'
import {
  createProcessTemplate,
  listProcessTemplates,
  type ProcessKind,
} from '@openbooks/engine/src/hrm/processes.ts'
import { guardPermission } from '../../../../lib/authz'
import { isFeatureEnabled } from '../../../../lib/features'
import { isUuid } from '../../../../lib/list-params'
import { processErrorResponse } from '../processes/_lib'
import { createProcessTemplateBody } from './bodies'

export const runtime = 'nodejs'

async function gate() {
  const result = await guardPermission('hrm.process.manage')
  if (result instanceof NextResponse) return result
  if (!(await isFeatureEnabled(result.user.orgId, 'hrm'))) {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }
  return result
}

export async function GET(req: Request) {
  const authz = await gate()
  if (authz instanceof NextResponse) return authz
  const url = new URL(req.url)
  const kind = url.searchParams.get('kind')
  if (kind !== null && kind !== 'onboarding' && kind !== 'offboarding' && kind !== 'transfer') {
    return NextResponse.json({ error: 'kind must be onboarding, offboarding, or transfer' }, { status: 400 })
  }
  const employmentId = url.searchParams.get('employment')
  const effectiveDate = url.searchParams.get('effectiveDate')
  if (employmentId !== null && !isUuid(employmentId)) {
    return NextResponse.json({ error: 'employment must be a uuid' }, { status: 400 })
  }
  if ((employmentId === null) !== (effectiveDate === null)) {
    return NextResponse.json({ error: 'employment and effectiveDate must be supplied together' }, { status: 400 })
  }
  try {
    const templates = await listProcessTemplates({
      orgId: authz.user.orgId,
      actorId: authz.user.id,
      activeOnly: url.searchParams.get('active') === 'true',
      ...(kind === null ? {} : { kind: kind as ProcessKind }),
      ...(employmentId === null ? {} : { employmentId, effectiveDate: effectiveDate! }),
    })
    return NextResponse.json({ templates })
  } catch (error) {
    return processErrorResponse(error)
  }
}

export async function POST(req: Request) {
  const authz = await gate()
  if (authz instanceof NextResponse) return authz
  const parsed = await parseJsonBody(req, createProcessTemplateBody)
  if (!parsed.ok) return parsed.response
  try {
    const template = await createProcessTemplate({
      orgId: authz.user.orgId,
      actorId: authz.user.id,
      ...parsed.data,
    })
    return NextResponse.json({ template }, { status: 201 })
  } catch (error) {
    return processErrorResponse(error)
  }
}
