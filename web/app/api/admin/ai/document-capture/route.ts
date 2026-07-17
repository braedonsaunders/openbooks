import { NextResponse } from 'next/server'
import { clearOrgDocumentCaptureKey } from '../../../../../lib/assistant/ai-config'
import { guardPermission } from '../../../../../lib/authz'

export async function DELETE() {
  const gate = await guardPermission('admin.ai.manage')
  if (gate instanceof NextResponse) return gate
  await clearOrgDocumentCaptureKey(gate.user.orgId, gate.user.id)
  return NextResponse.json({ ok: true })
}
