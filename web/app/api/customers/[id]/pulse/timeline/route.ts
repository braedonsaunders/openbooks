import { NextResponse } from 'next/server'
import { z } from 'zod'
import { defineRoute } from '@/lib/api/route'
import { notFound } from '@/lib/api/responses'
import { can } from '@/lib/authz'
import { isUuid } from '@/lib/list-params'
import { pulseSectionsFor } from '@/lib/customer-pulse-sections'
import { loadCustomerPulseTimeline } from '@/lib/customer-pulse-timeline'

export const GET = defineRoute({
  public: 'session',
  params: z.object({ id: z.string() }),
  handler: async ({ authz, params, request }) => {
    const sections = pulseSectionsFor((permission) => can(authz, permission))
    if (!sections) return NextResponse.json(
      { error: 'missing permission: crm.accounts.read, ar.read or projects.read' }, { status: 403 },
    )
    if (!isUuid(params.id)) return notFound('record')
    const search = Object.fromEntries(new URL(request.url).searchParams)
    const page = await loadCustomerPulseTimeline(params.id, authz.user.orgId, authz.allowedSubsidiaryIds, sections, search)
    return page ? NextResponse.json(page) : notFound('record')
  },
})
