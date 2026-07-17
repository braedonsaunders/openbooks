import { NextResponse } from 'next/server'
import { isContinuousCloseAgentKey } from '@openbooks/engine/src/continuous-close.ts'
import { guardPermission } from '../../../../../../lib/authz'
import { saveOrgAiAgentSettings } from '../../../../../../lib/assistant/ai-config'

export const runtime = 'nodejs'

/** Persist one agent's schedule and detector controls without touching provider secrets. */
export async function PUT(request: Request, { params }: { params: Promise<{ agentKey: string }> }) {
  const gate = await guardPermission('admin.ai.manage')
  if (gate instanceof NextResponse) return gate
  const { agentKey } = await params
  if (!isContinuousCloseAgentKey(agentKey)) {
    return NextResponse.json({ error: 'invalid_agent' }, { status: 404 })
  }
  let body: Record<string, unknown>
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'bad_request' }, { status: 400 })
  }
  try {
    const policy = await saveOrgAiAgentSettings(gate.user.orgId, gate.user.id, {
      ...body,
      agentKey,
    })
    return NextResponse.json(policy)
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 422 })
  }
}
