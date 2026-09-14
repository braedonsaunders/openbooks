import { NextResponse } from 'next/server'
import { guardFeaturePermission } from '@/lib/feature-gates'
import { applicationContextFromSession } from '@/lib/application/context'
import { runExtensionAction } from '@/lib/application/extension-actions'
import { ApplicationError } from '@/lib/application/errors'
import { jsonObject, parseJsonBody } from '@/lib/api/json'

export const runtime = 'nodejs'
export async function POST(
  request: Request,
  { params }: { params: Promise<{ key: string }> },
) {
  const gate = await guardFeaturePermission('apps.use', 'apps')
  if (gate instanceof NextResponse) return gate
  const parsed = await parseJsonBody(request, jsonObject)
  if (!parsed.ok) return parsed.response
  const { key } = await params
  try {
    const result = await runExtensionAction(
      applicationContextFromSession(gate, 'api', crypto.randomUUID()),
      key,
      parsed.data,
    )
    return NextResponse.json(result, {
      status: result.ok ? 200 : result.status,
    })
  } catch (error) {
    if (error instanceof ApplicationError)
      return NextResponse.json(
        { ok: false, error: error.message },
        { status: error.status },
      )
    throw error
  }
}
