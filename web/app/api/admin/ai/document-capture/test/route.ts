import { NextResponse } from 'next/server'
import { getDocumentCaptureTestConfig } from '@openbooks/engine/src/ap-capture-config.ts'
import { testAzureDocumentProvider } from '@openbooks/engine/src/ap-capture.ts'
import { guardPermission } from '../../../../../../lib/authz'

export const runtime = 'nodejs'

export async function POST(request: Request) {
  const gate = await guardPermission('admin.ai.manage')
  if (gate instanceof NextResponse) return gate
  const body = (await request.json().catch(() => ({}))) as {
    endpoint?: string
    model?: string
    apiKey?: string
  }
  const config = await getDocumentCaptureTestConfig(gate.user.orgId, body)
  if (!config) return NextResponse.json({ ok: false, code: 'missing' })
  const result = await testAzureDocumentProvider(config)
  return NextResponse.json({ ok: result.ok, code: result.ok ? 'connected' : 'failed' })
}
