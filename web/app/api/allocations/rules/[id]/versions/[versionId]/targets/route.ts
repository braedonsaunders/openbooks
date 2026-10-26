import type { Authz } from "@/lib/authz";
import { defineRoute } from "@/lib/api/route";
import { z } from "zod";
import { uuidString } from "@openbooks/engine/platform/identifiers";
import { NextResponse } from "next/server";
import {
  getRuleVersion,
  replaceTargets,
  type AllocationTargetInput,
} from "@openbooks/engine/allocations/runtime";
import {
  allocationWriteErrorResponse,
  requireRevision,
  requireRuleId,
} from "../../../../../_lib.ts";
import { notFound } from "@/lib/api/responses";
import { isUuid } from "@/lib/list-params";

export const runtime = "nodejs";

const bodyObjectSchema = z
  .object({
    expectedRevision: z.string().min(1),
    targets: z
      .array(
        z
          .object({
            sequence: z.number().int().nonnegative().optional(),
            targetAccountId: uuidString().nullable().optional(),
            departmentId: uuidString().nullable().optional(),
            locationId: uuidString().nullable().optional(),
            classId: uuidString().nullable().optional(),
            projectId: uuidString().nullable().optional(),
            subsidiaryId: uuidString().nullable().optional(),
            extraDims: z.record(z.string(), z.string()).optional(),
            fixedPercent: z.string().nullable().optional(),
            weight: z.string().nullable().optional(),
            isRemainder: z.boolean().optional(),
            label: z.string().nullable().optional(),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

/** Replace a draft version's explicit targets (ordered by array position). */
async function legacyPUT(
  { params }: { params: Promise<{ id: string; versionId: string }> },
  body: z.output<typeof bodyObjectSchema>,
  injectedGate?: Authz | null,
) {
  const gate = injectedGate as Authz;
  const { id, versionId } = await params;
  const ruleId = requireRuleId(id);
  if (ruleId instanceof NextResponse) return ruleId;
  const versionParam = requireRuleId(versionId);
  if (versionParam instanceof NextResponse) return versionParam;
  const revision = requireRevision(body);
  if (revision instanceof NextResponse) return revision;
  const targets = body.targets as AllocationTargetInput[];
  try {
    const current = await getRuleVersion(gate.user.orgId, versionParam, gate.allowedSubsidiaryIds);
    if (current.version.ruleId !== ruleId) {
      return notFound("record");
    }
    const saved = await replaceTargets(
      versionParam,
      {
        orgId: gate.user.orgId,
        expectedRevision: revision,
        targets,
        allowedSubsidiaryIds: gate.allowedSubsidiaryIds,
      },
      { actorId: gate.user.id },
    );
    return NextResponse.json({ targets: saved.targets, revision: saved.revision });
  } catch (error) {
    return allocationWriteErrorResponse(error);
  }
}

export const PUT = defineRoute({
  permission: "allocations.manage",
  feature: "allocations",
  params: z.object({
    id: z.string().refine((value) => isUuid(value)),
    versionId: z.string().refine((value) => isUuid(value)),
  }),
  invalidParamsNotFound: "record",
  body: bodyObjectSchema,
  handler: ({ params, authz, body }) => legacyPUT({ params: Promise.resolve(params) }, body, authz),
});
