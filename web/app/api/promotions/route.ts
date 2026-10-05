import { NextResponse } from 'next/server'
import { defineRoute } from '@/lib/api/route'
import { listActivePromotions } from '@/lib/promotions'

export const GET = defineRoute({
  permission: 'ar.create',
  feature: 'promotions',
  handler: async ({ authz }) => {
    const promotions = await listActivePromotions(authz.user.orgId)
    return NextResponse.json({
      promotions: promotions.map((promotion) => ({
        id: promotion.id,
        code: promotion.code,
        name: promotion.name,
        kind: promotion.kind,
      })),
    })
  },
})
