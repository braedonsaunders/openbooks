import { NextResponse } from 'next/server'
import { z } from 'zod'
import { receiveTrackerDelivery } from '@openbooks/engine/sales/shipping-labels'
import { readBoundedBodyText } from '@/lib/bounded-body'
import { defineRoute } from '@/lib/api/route'

export const runtime = 'nodejs'
/** Tracker deliveries stay small: a status ping, never a document. */
const MAX_BODY_BYTES = 256_000

const providerParams = z.object({ provider: z.enum(['easypost', 'shippo']) })

/**
 * Inbound tracker deliveries from the carrier aggregators. Sessionless by
 * design — providers hold no session — so the engine resolves the owning
 * org from the delivery's own refs, checks the account's relay signature
 * when one is configured, and ALWAYS re-reads the tracker over the sealed
 * API key before any state changes. A bad signature answers 401 with no
 * side effects; an unknown delivery is ignored, never a 500.
 */
export const POST = defineRoute({
  public: 'token',
  params: providerParams,
  handler: async ({ request, params: { provider } }) => {
    const bounded = await readBoundedBodyText(request, MAX_BODY_BYTES)
    if (!bounded.ok) {
      return NextResponse.json(
        { error: bounded.reason === 'too_large' ? 'webhook delivery exceeds the size limit' : 'malformed webhook delivery' },
        { status: bounded.reason === 'too_large' ? 413 : 400 },
      )
    }
    const headers: Record<string, string> = {}
    request.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value
    })
    try {
      const delivered = await receiveTrackerDelivery(provider, headers, bounded.text)
      return NextResponse.json(delivered)
    } catch (error) {
      if (error instanceof Error && (error as { code?: unknown }).code === 'signature_invalid') {
        return NextResponse.json({ error: 'invalid signature' }, { status: 401 })
      }
      if (error instanceof Error && (error as { code?: unknown }).code === 'feature_disabled') {
        return NextResponse.json({ status: 'ignored' })
      }
      throw error
    }
  },
})
