import { NextResponse } from 'next/server'
import { z } from 'zod'
import { replaceFamilyOptions } from '@openbooks/engine/inventory'
import { defineRoute } from '@/lib/api/route'
import { notFound } from '@/lib/api/responses'
import { isUuid } from '@/lib/list-params'
import { familyOptionSchema } from '../../route'

const familyParams = z.object({ id: z.string() })

const optionsReplaceSchema = z.object({
  options: z.array(familyOptionSchema).min(1),
}).strict()

/**
 * Replace the family's ordered options. Renames propagate to variant names,
 * removals in use refuse naming the variants, and a new option backfills
 * existing variants through its default value.
 */
export const PUT = defineRoute({
  permission: 'items.manage',
  feature: 'itemVariants',
  scope: 'unrestricted',
  params: familyParams,
  body: optionsReplaceSchema,
  handler: async ({ params: { id }, body, authz: gate }) => {
    if (!isUuid(id)) return notFound('record')
    const family = await replaceFamilyOptions(gate.user.orgId, gate.user.id, id, body.options)
    return NextResponse.json(family)
  },
})
