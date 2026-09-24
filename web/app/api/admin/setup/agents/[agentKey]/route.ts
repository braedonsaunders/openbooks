import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from 'next/server'
import { guardPermission, guardUnrestrictedScope } from '../../../../../../lib/authz'
import { saveSetupAgentPolicy } from '../../../../../../lib/setup/agents'

export const dynamic = 'force-dynamic'

/**
 * PUT /api/admin/setup/agents/[agentKey] — persist one pack's schedule and
 * detector controls. Thin adapter over the shared setup policy command (the
 * provider page's per-agent PUT calls the same command behind its own key);
 * the audit row is written there, not here.
 */
export async function PUT(request: Request, { params }: { params: Promise<{ agentKey: string }> }) {
  const gate = await guardPermission('admin.setup.manage')
  if (gate instanceof NextResponse) return gate
  const scopeDenied = guardUnrestrictedScope(gate)
  if (scopeDenied) return scopeDenied
  const { agentKey } = await params
  const parsedBody = await parseJsonBody(request, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  try {
    const policy = await saveSetupAgentPolicy(gate.user.orgId, gate.user.id, agentKey, parsedBody.data)
    return NextResponse.json(policy)
  } catch (error) {
    const message = (error as Error).message
    if (message === 'invalid_agent') return NextResponse.json({ error: 'invalid_agent' }, { status: 404 })
    if (message === 'feature_disabled') return NextResponse.json({ error: 'feature_disabled' }, { status: 409 })
    return NextResponse.json({ error: message }, { status: 422 })
  }
}
