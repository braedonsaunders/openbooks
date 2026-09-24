import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from 'next/server'
import { isContinuousCloseAgentKey } from '@openbooks/engine/src/continuous-close/continuous-close.ts'
import { guardPermission, guardUnrestrictedScope } from '../../../../../../lib/authz'
import { CONTINUOUS_CLOSE_DISABLED_REMEDY, saveOrgAiAgentSettings } from '../../../../../../lib/assistant/ai-config'

export const runtime = 'nodejs'

/** Persist one agent's schedule and detector controls without touching provider secrets. */
export async function PUT(request: Request, { params }: { params: Promise<{ agentKey: string }> }) {
  const gate = await guardPermission('admin.ai.manage')
  if (gate instanceof NextResponse) return gate
  const scopeDenied = guardUnrestrictedScope(gate)
  if (scopeDenied) return scopeDenied
  const { agentKey } = await params
  if (!isContinuousCloseAgentKey(agentKey)) {
    return NextResponse.json({ error: 'invalid_agent' }, { status: 404 })
  }
  let body: Record<string, unknown>
  try {
    const parsedBody = await parseJsonBody(request, jsonObject);
    if (!parsedBody.ok) return parsedBody.response;
    body = parsedBody.data
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
    // Same refusal as the bulk form: 409 with the remedy, not a bare code.
    if ((error as Error).message === 'feature_disabled') {
      return NextResponse.json({ error: CONTINUOUS_CLOSE_DISABLED_REMEDY }, { status: 409 })
    }
    return NextResponse.json({ error: (error as Error).message }, { status: 422 })
  }
}
