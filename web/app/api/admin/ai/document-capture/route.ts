import { NextResponse } from 'next/server'
import { guardPermission, guardUnrestrictedScope } from '../../../../../lib/authz'

export function createDeleteDocumentCaptureHandler(
  checkPermission: typeof guardPermission = guardPermission,
  clearOrgDocumentCaptureKey: (orgId: string, userId: string) => Promise<void> = async (orgId, userId) => {
    const { clearOrgDocumentCaptureKey } = await import('../../../../../lib/assistant/ai-config')
    await clearOrgDocumentCaptureKey(orgId, userId)
  },
) {
  return async function DELETE() {
    const gate = await checkPermission('admin.ai.manage')
    if (gate instanceof NextResponse) return gate
    const scopeDenied = guardUnrestrictedScope(gate)
    if (scopeDenied) return scopeDenied
    await clearOrgDocumentCaptureKey(gate.user.orgId, gate.user.id)
    return NextResponse.json({ ok: true })
  }
}

export const DELETE = createDeleteDocumentCaptureHandler()
