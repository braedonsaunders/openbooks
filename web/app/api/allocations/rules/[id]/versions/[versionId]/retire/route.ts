import type { Authz } from "@/lib/authz";
import { defineRoute } from "@/lib/api/route";
import { z } from "zod";
import { parseJsonBody } from '@/lib/api/json';
import { NextResponse } from 'next/server'
import { retireVersion } from '../../../../../../../../../engine/src/allocations/index.ts'
import { allocationWriteErrorResponse, requireRuleId } from '../../../../../_lib.ts'
import { notFound } from "@/lib/api/responses";


export const runtime = 'nodejs'

const bodyObjectSchema = z.object({ reason: z.string().trim().min(1) }).strict();

/** Retire a published version. `{ reason }` is required (the drawer prompts). */
async function legacyPOST(
  req: Request,
  { params }: { params: Promise<{ id: string; versionId: string }> }, injectedGate?: Authz | null,
) {
  const gate = injectedGate as Authz;
  const { id, versionId } = await params
  const ruleId = requireRuleId(id)
  if (ruleId instanceof NextResponse) return ruleId
  const versionParam = requireRuleId(versionId)
  if (versionParam instanceof NextResponse) return versionParam
  const parsed = await parseJsonBody(req, bodyObjectSchema)
  if (!parsed.ok) return parsed.response
  const body = parsed.data
  try {
    const retired = await retireVersion(
      versionParam,
      { orgId: gate.user.orgId, expectedRuleId: ruleId, actorId: gate.user.id, reason: body.reason.trim(), allowedSubsidiaryIds: gate.allowedSubsidiaryIds },
    )
    if (retired.version.ruleId !== ruleId) {
      return notFound("record")
    }
    return NextResponse.json({ version: { ...retired.version, revision: retired.revision } })
  } catch (error) {
    return allocationWriteErrorResponse(error)
  }
}

export const POST = defineRoute({
  permission: 'allocations.manage', feature: "allocations",
  params: z.object({ "id": z.string(), "versionId": z.string() }),
  handler: ({ request, params, authz }) => legacyPOST(request, { params: Promise.resolve(params) }, authz),
});
