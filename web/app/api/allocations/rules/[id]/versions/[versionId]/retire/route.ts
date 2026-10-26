import type { Authz } from "@/lib/authz";
import { defineRoute } from "@/lib/api/route";
import { z } from "zod";
import { NextResponse } from "next/server";
import { retireVersion } from "@openbooks/engine/allocations/runtime";
import { allocationWriteErrorResponse, requireRuleId } from "../../../../../_lib.ts";
import { notFound } from "@/lib/api/responses";
import { isUuid } from "@/lib/list-params";

export const runtime = "nodejs";

const bodyObjectSchema = z.object({ reason: z.string().trim().min(1) }).strict();

/** Retire a published version. `{ reason }` is required (the drawer prompts). */
async function legacyPOST(
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
  try {
    const retired = await retireVersion(versionParam, {
      orgId: gate.user.orgId,
      expectedRuleId: ruleId,
      actorId: gate.user.id,
      reason: body.reason.trim(),
      allowedSubsidiaryIds: gate.allowedSubsidiaryIds,
    });
    if (retired.version.ruleId !== ruleId) {
      return notFound("record");
    }
    return NextResponse.json({ version: { ...retired.version, revision: retired.revision } });
  } catch (error) {
    return allocationWriteErrorResponse(error);
  }
}

export const POST = defineRoute({
  permission: "allocations.manage",
  feature: "allocations",
  params: z.object({
    id: z.string().refine((value) => isUuid(value)),
    versionId: z.string().refine((value) => isUuid(value)),
  }),
  invalidParamsNotFound: "record",
  body: bodyObjectSchema,
  invalidBodyStatus: 422,
  handler: ({ params, authz, body }) =>
    legacyPOST({ params: Promise.resolve(params) }, body, authz),
});
