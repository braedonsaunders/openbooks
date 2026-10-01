import { z } from 'zod'
import { NextResponse } from 'next/server'
import { defineRoute } from '@/lib/api/route'
import { guardPermission } from '@/lib/authz'
import { guardFeaturePermission } from '@/lib/feature-gates'
import { notFound } from '@/lib/api/responses'
import { isUuid } from '@openbooks/engine/platform/identifiers'
import { LIST_DRAWER_ROUTES, listDrawerRoute, type ListDrawerSource } from '@/lib/list/drawer-routes'
import { readListDrawer } from '@/lib/list/drawer-reader'

export const runtime = 'nodejs'

export const GET = defineRoute({
  authorize: async ({ params }) => {
    const source = (params as { source?: string } | undefined)?.source ?? ''
    const route = listDrawerRoute(source)
    if (!route) return notFound('list')
    return 'feature' in route ? guardFeaturePermission(route.permission, route.feature) : guardPermission(route.permission)
  },
  feature: { none: 'Each registered drawer enforces its native page permission and feature before reading the record.' },
  params: z.object({ source: z.enum(Object.keys(LIST_DRAWER_ROUTES) as [ListDrawerSource, ...ListDrawerSource[]]) }),
  handler: async ({ request, params }) => {
    const route = LIST_DRAWER_ROUTES[params.source]
    const search = new URL(request.url).searchParams
    const id = search.get(route.param)
    const form = search.get('form')
    if (!id || !isUuid(id) || (form && !isUuid(form))) {
      return NextResponse.json({ error: 'Select a valid record and form before opening this drawer.' }, { status: 400 })
    }
    const drawer = await readListDrawer(params.source, { [route.param]: id, form: form ?? undefined })
    if (!drawer) return notFound('record')
    return NextResponse.json(drawer, { headers: { 'Cache-Control': 'private, no-store' } })
  },
})
