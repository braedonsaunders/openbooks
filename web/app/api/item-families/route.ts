import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createItemFamily } from '@openbooks/engine/inventory'
import { defineRoute } from '@/lib/api/route'

const optionValueSchema = z.union([
  z.string(),
  z.object({ value: z.string(), previousValue: z.string().nullable().optional() }),
])

export const familyOptionSchema = z.object({
  id: z.string().nullable().optional(),
  name: z.string(),
  values: z.array(optionValueSchema).min(1),
  defaultValue: z.string().nullable().optional(),
})

const familyCreateSchema = z.object({
  code: z.string(),
  name: z.string(),
  description: z.string().nullable().optional(),
  category: z.string().nullable().optional(),
  kind: z.string(),
  defaultUnit: z.string().nullable().optional(),
  defaultRate: z.string().nullable().optional(),
  options: z.array(familyOptionSchema).min(1),
}).strict()

/** Create a product family with its ordered options. Variants come later through generate. */
export const POST = defineRoute({
  permission: 'items.manage',
  feature: 'itemVariants',
  scope: 'unrestricted',
  body: familyCreateSchema,
  handler: async ({ body, authz: gate }) => {
    const family = await createItemFamily(gate.user.orgId, gate.user.id, {
      code: body.code,
      name: body.name,
      description: body.description ?? null,
      category: body.category ?? null,
      kind: body.kind,
      defaultUnit: body.defaultUnit ?? null,
      defaultRate: body.defaultRate ?? null,
      options: body.options,
    })
    return NextResponse.json(family, { status: 201 })
  },
})
