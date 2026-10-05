import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createFamilyWithVariants } from '@openbooks/engine/inventory'
import { defineRoute } from '@/lib/api/route'
import { familyOptionSchema } from '../route'

const variantChoiceSchema = z.object({
  optionValues: z.record(z.string(), z.string()),
  include: z.boolean().nullable().optional(),
  code: z.string().nullable().optional(),
  price: z.string().nullable().optional(),
  barcode: z.object({
    value: z.string(),
    kind: z.enum(['gtin', 'upc', 'ean', 'internal']),
  }).nullable().optional(),
}).strict()

const withVariantsSchema = z.object({
  code: z.string(),
  name: z.string(),
  description: z.string().nullable().optional(),
  category: z.string().nullable().optional(),
  kind: z.string(),
  defaultUnit: z.string().nullable().optional(),
  defaultRate: z.string().nullable().optional(),
  codePattern: z.string().nullable().optional(),
  options: z.array(familyOptionSchema).min(1),
  variants: z.array(variantChoiceSchema).min(1).nullable().optional(),
}).strict()

/**
 * Create a family with its ordered options and chosen variants in one
 * audited transaction. Retries are safe without an idempotency key: the
 * family code is unique per organization, so a repeated submit is refused
 * naming the code instead of creating a second family.
 */
export const POST = defineRoute({
  permission: 'items.manage',
  feature: 'itemVariants',
  scope: 'unrestricted',
  body: withVariantsSchema,
  handler: async ({ body, authz: gate }) => {
    const created = await createFamilyWithVariants(gate.user.orgId, gate.user.id, {
      code: body.code,
      name: body.name,
      description: body.description ?? null,
      category: body.category ?? null,
      kind: body.kind,
      defaultUnit: body.defaultUnit ?? null,
      defaultRate: body.defaultRate ?? null,
      options: body.options ?? [],
      codePattern: body.codePattern ?? null,
      variants: body.variants ?? null,
    })
    return NextResponse.json({ family: created.family, variants: created.variants }, { status: 201 })
  },
})
