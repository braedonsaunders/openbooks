import type { Authz } from "@/lib/authz";
import { defineRoute } from "@/lib/api/route";
import { z } from "zod";
import { parseJsonBody } from '@/lib/api/json';
import { NextResponse } from 'next/server'
import {
  getRuleVersion,
  replaceTargets,
  type AllocationTargetInput,
} from '../../../../../../../../../engine/src/allocations/index.ts'
import { allocationWriteErrorResponse, requireRevision, requireRuleId } from '../../../../../_lib.ts'
import { notFound } from "@/lib/api/responses";


export const runtime = 'nodejs'

const bodyObjectSchema = z.object({
  expectedRevision: z.string().min(1),
  targets: z.array(z.object({
    sequence: z.number().int().nonnegative().optional(),
    targetAccountId: z.string().uuid().nullable().optional(),
    departmentId: z.string().uuid().nullable().optional(),
    locationId: z.string().uuid().nullable().optional(),
    classId: z.string().uuid().nullable().optional(),
    projectId: z.string().uuid().nullable().optional(),
    subsidiaryId: z.string().uuid().nullable().optional(),
    extraDims: z.record(z.string(), z.string()).optional(),
    fixedPercent: z.string().nullable().optional(),
    weight: z.string().nullable().optional(),
    isRemainder: z.boolean().optional(),
    label: z.string().nullable().optional(),
  }).strict()).min(1),
}).strict();

/** Replace a draft version's explicit targets (ordered by array position). */
async function legacyPUT(
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
  const revision = requireRevision(body)
  if (revision instanceof NextResponse) return revision
  const targets = body.targets as AllocationTargetInput[]
  try {
    const current = await getRuleVersion(gate.user.orgId, versionParam, gate.allowedSubsidiaryIds)
    if (current.version.ruleId !== ruleId) {
      return notFound("record")
    }
    const saved = await replaceTargets(
      versionParam,
      { orgId: gate.user.orgId, expectedRevision: revision, targets, allowedSubsidiaryIds: gate.allowedSubsidiaryIds },
      { actorId: gate.user.id },
    )
    return NextResponse.json({ targets: saved.targets, revision: saved.revision })
  } catch (error) {
    return allocationWriteErrorResponse(error)
  }
}

export const PUT = defineRoute({
  permission: 'allocations.manage', feature: "allocations",
  params: z.object({ "id": z.string(), "versionId": z.string() }),
  handler: ({ request, params, authz }) => legacyPUT(request, { params: Promise.resolve(params) }, authz),
});
