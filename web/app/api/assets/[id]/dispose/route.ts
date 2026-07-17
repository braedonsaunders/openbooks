import { NextResponse } from 'next/server'
import { disposeAsset } from '@openbooks/engine/src/asset-lifecycle.ts'
import { guardPermission } from '../../../../../lib/authz'
import { isUuid } from '../../../../../lib/list-params'

export const runtime = 'nodejs'

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const AMOUNT_RE = /^\d+(\.\d+)?$/

interface Body {
  date?: string
  proceeds?: string
  proceedsAccountId?: string
  writeOff?: boolean
}

/**
 * Dispose an asset by sale (or write it off): posts the disposal journal
 * (clear cost + accumulated, recognize proceeds, book gain/loss) and flips the
 * asset's status. Idempotency is enforced by the engine (an already-disposed
 * asset is rejected).
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission('assets.manage')
  if (gate instanceof NextResponse) return gate
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'invalid asset' }, { status: 422 })

  const body = (await req.json().catch(() => ({}))) as Body
  const date = body.date && DATE_RE.test(body.date) ? body.date : new Date().toISOString().slice(0, 10)
  const writeOff = body.writeOff === true
  const proceeds = writeOff ? '0' : (body.proceeds ?? '0')
  if (!AMOUNT_RE.test(proceeds)) {
    return NextResponse.json({ error: 'proceeds must be a non-negative amount' }, { status: 422 })
  }
  if (!writeOff && proceeds !== '0' && (!body.proceedsAccountId || !isUuid(body.proceedsAccountId))) {
    return NextResponse.json({ error: 'select the account the proceeds are deposited to' }, { status: 422 })
  }

  try {
    const result = await disposeAsset(gate.user.orgId, id, {
      proceeds,
      proceedsAccountId: body.proceedsAccountId ?? null,
      date,
      actorId: gate.user.id,
      writeOff,
    })
    return NextResponse.json(result)
  } catch (e: unknown) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'disposal failed' }, { status: 422 })
  }
}
