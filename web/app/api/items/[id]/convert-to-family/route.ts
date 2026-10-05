import { NextResponse } from 'next/server'
import { z } from 'zod'
import { convertItemToFamily } from '@openbooks/engine/inventory'
import { defineRoute } from '@/lib/api/route'
import { notFound } from '@/lib/api/responses'
import { isUuid } from '@/lib/list-params'

const itemParams = z.object({ id: z.string() })

const convertSchema = z.object({
  code: z.string().nullable().optional(),
  name: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  category: z.string().nullable().optional(),
  options: z.array(z.object({ name: z.string(), value: z.string() })).min(1),
}).strict()

/** Create a family from a standalone item; the item becomes its first variant. */
export const POST = defineRoute({
  permission: 'items.manage',
  feature: 'itemVariants',
  scope: 'unrestricted',
  params: itemParams,
  body: convertSchema,
  handler: async ({ params: { id }, body, authz: gate }) => {
    if (!isUuid(id)) return notFound('record')
    const family = await convertItemToFamily(gate.user.orgId, gate.user.id, {
      itemId: id,
      code: body.code ?? null,
      name: body.name ?? null,
      description: body.description ?? null,
      category: body.category ?? null,
      options: body.options,
    })
    return NextResponse.json(family, { status: 201 })
  },
})
