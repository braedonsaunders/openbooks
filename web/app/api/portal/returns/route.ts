import { z } from 'zod'
import { NextResponse } from 'next/server'
import { defineRoute } from '@/lib/api/route'
import { portalReturnableSources, requestPortalReturn } from '@/lib/portal/returns'

export const runtime = 'nodejs'

const lineSchema = z.object({ sourceIssueMovementId: z.string().uuid(), quantity: z.unknown() })

/** Public: returnable shipments for one customer source document. */
export const GET = defineRoute({
  public: 'token',
  handler: async ({ request }) => {
    const url = new URL(request.url)
    const sources = await portalReturnableSources(url.searchParams.get('sessionToken') ?? '', url.searchParams.get('sourceDocumentId') ?? '')
    return NextResponse.json({ sources })
  },
})

const postSchema = z.object({
  sessionToken: z.string().min(16).max(256),
  sourceDocumentId: z.string().uuid(),
  reasonCode: z.string().min(1).max(40),
  resolution: z.enum(['refund', 'exchange', 'store_credit']),
  lines: z.array(lineSchema).min(1).max(50),
})

/** Public: file a self-service return request within the org's portal rules. */
export const POST = defineRoute({
  public: 'token',
  body: postSchema,
  handler: async ({ body }) => {
    const authorization = await requestPortalReturn(body)
    return NextResponse.json({
      id: authorization.id,
      documentNumber: authorization.documentNumber,
      stage: authorization.stage,
    })
  },
})
