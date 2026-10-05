import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getItemFamily, updateItemFamily } from '@openbooks/engine/inventory'
import { defineRoute } from '@/lib/api/route'
import { notFound } from '@/lib/api/responses'
import { isUuid } from '@/lib/list-params'

const familyParams = z.object({ id: z.string() })

const familyPatchSchema = z.object({
  code: z.string().nullable().optional(),
  name: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  category: z.string().nullable().optional(),
  kind: z.string().nullable().optional(),
  defaultUnit: z.string().nullable().optional(),
  defaultRate: z.string().nullable().optional(),
  status: z.string().nullable().optional(),
}).strict().refine((body) => Object.keys(body).length > 0, { message: "At least one field must be provided." })

export const GET = defineRoute({
  permission: 'items.read',
  feature: 'itemVariants',
  params: familyParams,
  handler: async ({ authz: gate, params: { id } }) => {
    if (!isUuid(id)) return notFound('record')
    const family = await getItemFamily(gate.user.orgId, id)
    if (!family) return notFound('record')
    return NextResponse.json(family)
  },
})

/** Edit family defaults. Future generations inherit them; variants keep theirs. */
export const PATCH = defineRoute({
  permission: 'items.manage',
  feature: 'itemVariants',
  scope: 'unrestricted',
  params: familyParams,
  body: familyPatchSchema,
  handler: async ({ params: { id }, body, authz: gate }) => {
    if (!isUuid(id)) return notFound('record')
    const family = await updateItemFamily(gate.user.orgId, gate.user.id, id, {
      code: body.code,
      name: body.name,
      description: body.description,
      category: body.category,
      kind: body.kind,
      defaultUnit: body.defaultUnit,
      defaultRate: body.defaultRate,
      status: body.status,
    })
    return NextResponse.json(family)
  },
})
