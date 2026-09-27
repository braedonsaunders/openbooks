import { defineRoute } from "@/lib/api/route";
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

const legacyDELETE = createDeleteDocumentCaptureHandler()

export const DELETE = defineRoute({
  permission: 'admin.ai.manage',
  feature: { none: 'Document capture credentials are governed by the admin AI permission.' },
  scope: 'unrestricted',
  handler: async () => legacyDELETE(),
});
