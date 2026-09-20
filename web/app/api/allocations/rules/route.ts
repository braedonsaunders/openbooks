import { parseJsonBody } from '@/lib/api/json'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import {
  createDraftVersion,
  createRule,
  listRuleHeads,
} from '../../../../../engine/src/allocations/index.ts'
import { businessToday } from '../../../../../engine/src/platform/business-date.ts'
import { guardAllocations } from '../../../../lib/allocations-gate'
import { allocationErrorResponse } from '../_lib.ts'

export const runtime = 'nodejs'

const createRuleSchema = z.object({
  key: z.string(),
  name: z.string(),
  description: z.string().nullable().optional(),
  mode: z.enum(['entry', 'post', 'period']),
  sortOrder: z.number().int().optional(),
  isActive: z.boolean().optional(),
})

/** Rules tab list + create. Read needs allocations.read; writes need allocations.manage. */
export async function GET() {
  const gate = await guardAllocations('allocations.read')
  if (gate instanceof NextResponse) return gate
  try {
    return NextResponse.json({ rules: await listRuleHeads(gate.user.orgId) })
  } catch (error) {
    return allocationErrorResponse(error)
  }
}

/**
 * Create a rule head with its initial blank draft (v1) in one call so the
 * drawer always has a version to edit. A1's createRule is head-only; the
 * draft comes from createDraftVersion with no source.
 */
export async function POST(req: Request) {
  const gate = await guardAllocations('allocations.manage')
  if (gate instanceof NextResponse) return gate
  const parsed = await parseJsonBody(req, createRuleSchema)
  if (!parsed.ok) return parsed.response
  try {
    const created = await createRule(
      {
        orgId: gate.user.orgId,
        key: parsed.data.key,
        name: parsed.data.name,
        description: parsed.data.description,
        mode: parsed.data.mode,
        sortOrder: parsed.data.sortOrder,
        isActive: parsed.data.isActive,
      },
      { actorId: gate.user.id },
    )
    // A1 requires an explicit effective window for every new version; the
    // initial draft starts today and the drawer adjusts it before publish.
    const draft = await createDraftVersion(
      created.rule.id,
      { orgId: gate.user.orgId, effectiveFrom: await businessToday(gate.user.orgId) },
      { actorId: gate.user.id },
    )
    return NextResponse.json(
      {
        rule: { ...created.rule, revision: created.revision },
        version: { ...draft.version, revision: draft.revision },
        targets: draft.targets,
      },
      { status: 201 },
    )
  } catch (error) {
    return allocationErrorResponse(error)
  }
}
