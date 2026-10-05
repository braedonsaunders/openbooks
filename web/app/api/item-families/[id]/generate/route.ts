import { NextResponse } from 'next/server'
import { z } from 'zod'
import { generateFamilyVariants, previewGenerateVariants } from '@openbooks/engine/inventory'
import { defineRoute } from '@/lib/api/route'
import { notFound } from '@/lib/api/responses'
import { isUuid } from '@/lib/list-params'

const familyParams = z.object({ id: z.string() })

const generateSchema = z.object({
  only: z.array(z.record(z.string(), z.string())).nullable().optional(),
  codePattern: z.string().nullable().optional(),
}).strict()

/** Preview the missing combinations with their exact codes before committing. */
export const GET = defineRoute({
  permission: 'items.read',
  feature: 'itemVariants',
  params: familyParams,
  handler: async ({ authz: gate, params: { id } }) => {
    if (!isUuid(id)) return notFound('record')
    const preview = await previewGenerateVariants(gate.user.orgId, id)
    return NextResponse.json(preview)
  },
})

/** Create variant items for the cartesian product or a chosen subset. Idempotent. */
export const POST = defineRoute({
  permission: 'items.manage',
  feature: 'itemVariants',
  scope: 'unrestricted',
  params: familyParams,
  body: generateSchema,
  opaque: {
    only: "each chosen combination is matched against the family's declared options in generateFamilyVariants, refusing unknown options",
    codePattern: "a blank pattern is refused in generateFamilyVariants; the default pattern applies when omitted",
  },
  handler: async ({ params: { id }, body, authz: gate }) => {
    if (!isUuid(id)) return notFound('record')
    const result = await generateFamilyVariants(gate.user.orgId, gate.user.id, id, {
      only: body.only ?? null,
      codePattern: body.codePattern ?? null,
    })
    return NextResponse.json(result, { status: 201 })
  },
})
