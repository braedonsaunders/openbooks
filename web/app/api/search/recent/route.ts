import { z } from 'zod'
import { NextResponse } from 'next/server'
import { defineRoute } from '@/lib/api/route'
import { resolveRecent } from '../../../../lib/search-all'
import { isOperationalRecentRef } from '../../../../lib/search-records'
import { RECENT_LIMIT, SEARCH_CATALOG_TYPES, SEARCH_RECORD_TYPES, type RecentRef } from '../../../../lib/search-types'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const CORE_TYPES = new Set(['transaction', 'contact', 'account', 'item', 'project'])

const bodySchema = z.strictObject({
  refs: z
    .array(
      z.strictObject({
        type: z.enum([...SEARCH_RECORD_TYPES, ...SEARCH_CATALOG_TYPES]),
        id: z.string().min(1).max(512),
      }),
    )
    .max(RECENT_LIMIT, `send at most ${RECENT_LIMIT} recent results`),
})

/** Whether a reference's id has the shape its source issues. */
function wellFormed(ref: RecentRef): boolean {
  if (CORE_TYPES.has(ref.type)) return UUID.test(ref.id)
  if (ref.type === 'report' || ref.type === 'setting') return ref.id.startsWith('/') && !ref.id.startsWith('//')
  if (ref.type === 'help') return /^[a-z0-9-]+$/.test(ref.id)
  return isOperationalRecentRef(ref)
}

/**
 * POST { refs: [{ type, id }] } → { hits } for the header search's Recent
 * group. The browser keeps only these references; every one is resolved
 * again here under the reader's current permissions, so the response never
 * includes a result the reader could not open.
 */
export const POST = defineRoute({
  public: 'session',
  body: bodySchema,
  handler: async ({ authz, body }) => {
    const malformed = body.refs.find((ref) => !wellFormed(ref))
    if (malformed) {
      return NextResponse.json(
        {
          error: 'invalid_recent_ref',
          field: 'refs',
          remedy: `the recent ${malformed.type} reference "${malformed.id.slice(0, 80)}" is not an id that search issues; send only references taken from search results`,
        },
        { status: 400 },
      )
    }
    const hits = await resolveRecent(authz, body.refs)
    return NextResponse.json({ hits }, { headers: { 'cache-control': 'no-store' } })
  },
})
