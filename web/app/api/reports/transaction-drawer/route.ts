import { defineRoute } from '@/lib/api/route';
import { NextResponse } from 'next/server'
import { getAuthz } from '../../../../lib/authz'
import { loadRelatedTransactionDrawerData } from '../../../../components/related-transaction-drawer'
import { notFound } from "@/lib/api/responses";
import { isUuid } from '@openbooks/engine/src/platform/uuid.ts'


export const runtime = 'nodejs'

const KIND = /^[a-z][a-z0-9_]{0,63}$/

export const GET = defineRoute({
  public: 'session',
  handler: async ({ request: request }) => {
    const gate = await getAuthz()
    if (!gate) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
    const url = new URL(request.url)
    const id = url.searchParams.get('id') ?? ''
    const kind = url.searchParams.get('kind') ?? ''
    const formLayoutId = url.searchParams.get('form') || undefined
    if (!isUuid(id) || !KIND.test(kind) || (formLayoutId && !isUuid(formLayoutId))) {
        return NextResponse.json({ error: 'invalid_request' }, { status: 400 })
      }
    const data = await loadRelatedTransactionDrawerData({ id, kind, authz: gate, formLayoutId })
    return data ? NextResponse.json(data) : notFound("record")
  },
});
