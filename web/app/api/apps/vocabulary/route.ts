import { NextResponse } from 'next/server'
import { guardFeaturePermission } from '@/lib/feature-gates'
import { applicationContextFromSession } from '@/lib/application/context'
import { requireExtensionAuthor } from '@/lib/application/extensions'
import { ApplicationError } from '@/lib/application/errors'
import { PAGE_REGISTRY } from '@/lib/page-registry'

export async function GET() {
  const gate = await guardFeaturePermission('apps.manage', 'apps')
  if (gate instanceof NextResponse) return gate
  try {
    await requireExtensionAuthor(
      applicationContextFromSession(gate, 'api', crypto.randomUUID()),
    )
    return NextResponse.json(
      { routes: Object.keys(PAGE_REGISTRY).sort() },
      { headers: { 'Cache-Control': 'no-store' } },
    )
  } catch (error) {
    if (error instanceof ApplicationError)
      return NextResponse.json(
        { error: error.message },
        { status: error.status },
      )
    throw error
  }
}
