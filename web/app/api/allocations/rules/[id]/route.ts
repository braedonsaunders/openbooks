import type { Authz } from "@/lib/authz";
import { defineRoute } from "@/lib/api/route";
import { z } from "zod";
import { parseJsonBody } from '@/lib/api/json';
import { NextResponse } from 'next/server'
import { getRuleDetail, updateRule } from '../../../../../../engine/src/allocations/index.ts'
import { allocationWriteErrorResponse, requireRevision, requireRuleId } from '../../_lib.ts'

export const runtime = 'nodejs'

const bodyObjectSchema = z.object({
  name: z.string().optional(),
  description: z.string().nullable().optional(),
  sortOrder: z.number().optional(),
  isActive: z.boolean().optional(),
  expectedRevision: z.string().min(1),
}).strict();

/** One rule head (identity/ordering) with its version timeline. */
async function legacyGET(_req: Request, { params }: { params: Promise<{ id: string }> }, injectedGate?: Authz | null) {
  const gate = injectedGate as Authz;
  const id = requireRuleId((await params).id)
  if (id instanceof NextResponse) return id
  try {
    return NextResponse.json(await getRuleDetail(gate.user.orgId, id, gate.allowedSubsidiaryIds))
  } catch (error) {
    return allocationWriteErrorResponse(error)
  }
}

/** Update the head (name/description/order/active). `expectedRevision` is required. */
async function legacyPATCH(req: Request, { params }: { params: Promise<{ id: string }> }, injectedGate?: Authz | null) {
  const gate = injectedGate as Authz;
  const id = requireRuleId((await params).id)
  if (id instanceof NextResponse) return id
  const parsed = await parseJsonBody(req, bodyObjectSchema)
  if (!parsed.ok) return parsed.response
  const body = parsed.data as {
    name?: unknown
    description?: unknown
    sortOrder?: unknown
    isActive?: unknown
    expectedRevision?: unknown
  }
  const revision = requireRevision(body)
  if (revision instanceof NextResponse) return revision
  if (
    (body.name !== undefined && typeof body.name !== 'string')
    || (body.description !== undefined && body.description !== null && typeof body.description !== 'string')
    || (body.sortOrder !== undefined && typeof body.sortOrder !== 'number')
    || (body.isActive !== undefined && typeof body.isActive !== 'boolean')
  ) {
    return NextResponse.json({ error: 'Invalid rule head fields.' }, { status: 400 })
  }
  try {
    const updated = await updateRule(
      id,
      {
        orgId: gate.user.orgId,
        expectedRevision: revision,
        name: body.name as string | undefined,
        description: body.description as string | null | undefined,
        sortOrder: body.sortOrder as number | undefined,
        isActive: body.isActive as boolean | undefined,
        allowedSubsidiaryIds: gate.allowedSubsidiaryIds,
      },
      { actorId: gate.user.id },
    )
    return NextResponse.json({ rule: { ...updated.rule, revision: updated.revision } })
  } catch (error) {
    return allocationWriteErrorResponse(error)
  }
}

export const GET = defineRoute({
  permission: 'allocations.read', feature: "allocations",
  params: z.object({ "id": z.string() }),
  handler: ({ request, params, authz }) => legacyGET(request, { params: Promise.resolve(params) }, authz),
});

export const PATCH = defineRoute({
  permission: 'allocations.manage', feature: "allocations",
  params: z.object({ "id": z.string() }),
  handler: ({ request, params, authz }) => legacyPATCH(request, { params: Promise.resolve(params) }, authz),
});
