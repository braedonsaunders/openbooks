import type { Authz } from "@/lib/authz";
import { defineRoute } from "@/lib/api/route";
import { parseJsonBody } from '@/lib/api/json'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import {
  createRuleWithInitialDraft,
  listRuleHeads,
} from '../../../../../engine/src/allocations/index.ts'
import { businessToday } from '../../../../../engine/src/platform/business-date.ts'
import { guardUnrestrictedScope } from '../../../../lib/authz'
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
async function legacyGET(_req: Request, ctx: { params: Promise<unknown> }, injectedGate?: Authz | null) {
  const gate = injectedGate as Authz;
  try {
    return NextResponse.json({ rules: await listRuleHeads(gate.user.orgId, { allowedSubsidiaryIds: gate.allowedSubsidiaryIds }) })
  } catch (error) {
    return allocationErrorResponse(error)
  }
}

/**
 * Create a rule head with its initial blank draft (v1) in one call so the
 * drawer always has a version to edit. A1's createRule is head-only; the
 * draft comes from createDraftVersion with no source.
 */
async function legacyPOST(req: Request, ctx: { params: Promise<unknown> }, injectedGate?: Authz | null) {
  const gate = injectedGate as Authz;
  const parsed = await parseJsonBody(req, createRuleSchema)
  if (!parsed.ok) return parsed.response
  // The initial draft names no subsidiaries, so it is org-wide policy from
  // the first row: restricted callers get the named 403 with no write at all.
  const scope = guardUnrestrictedScope(gate)
  if (scope) return scope
  try {
    const { created, draft } = await createRuleWithInitialDraft(
      {
        orgId: gate.user.orgId,
        key: parsed.data.key,
        name: parsed.data.name,
        description: parsed.data.description,
        mode: parsed.data.mode,
        sortOrder: parsed.data.sortOrder,
        isActive: parsed.data.isActive,
        effectiveFrom: await businessToday(gate.user.orgId),
        allowedSubsidiaryIds: gate.allowedSubsidiaryIds,
      },
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

export const GET = defineRoute({
  permission: 'allocations.read', feature: "allocations",

  handler: ({ request, params, authz }) => legacyGET(request, { params: Promise.resolve(params) }, authz),
});

export const POST = defineRoute({
  permission: 'allocations.manage', feature: "allocations",

  handler: ({ request, params, authz }) => legacyPOST(request, { params: Promise.resolve(params) }, authz),
});
