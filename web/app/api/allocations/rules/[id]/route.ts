import type { Authz } from "@/lib/authz";
import { defineRoute } from "@/lib/api/route";
import { z } from "zod";
import { NextResponse } from "next/server";
import { getRuleDetail, updateRule } from "@openbooks/engine/allocations/runtime";
import { allocationWriteErrorResponse, requireRevision, requireRuleId } from "../../_lib.ts";
import { isUuid } from "@/lib/list-params";

export const runtime = "nodejs";

const bodyObjectSchema = z
  .object({
    name: z.string().optional(),
    description: z.string().nullable().optional(),
    sortOrder: z.number().optional(),
    isActive: z.boolean().optional(),
    expectedRevision: z.union([z.string(), z.null()]).optional(),
  })
  .strict();

/** One rule head (identity/ordering) with its version timeline. */
async function legacyGET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
  injectedGate?: Authz | null,
) {
  const gate = injectedGate as Authz;
  const id = requireRuleId((await params).id);
  if (id instanceof NextResponse) return id;
  try {
    return NextResponse.json(await getRuleDetail(gate.user.orgId, id, gate.allowedSubsidiaryIds));
  } catch (error) {
    return allocationWriteErrorResponse(error);
  }
}

/** Update the head (name/description/order/active). `expectedRevision` is required. */
async function legacyPATCH(
  { params }: { params: Promise<{ id: string }> },
  body: z.output<typeof bodyObjectSchema>,
  injectedGate?: Authz | null,
) {
  const gate = injectedGate as Authz;
  const id = requireRuleId((await params).id);
  if (id instanceof NextResponse) return id;
  const patchBody = body as {
    name?: unknown;
    description?: unknown;
    sortOrder?: unknown;
    isActive?: unknown;
    expectedRevision?: unknown;
  };
  const revision = requireRevision(patchBody);
  if (revision instanceof NextResponse) return revision;
  if (
    (patchBody.name !== undefined && typeof patchBody.name !== "string") ||
    (patchBody.description !== undefined &&
      patchBody.description !== null &&
      typeof patchBody.description !== "string") ||
    (patchBody.sortOrder !== undefined && typeof patchBody.sortOrder !== "number") ||
    (patchBody.isActive !== undefined && typeof patchBody.isActive !== "boolean")
  ) {
    return NextResponse.json({ error: "Invalid rule head fields." }, { status: 400 });
  }
  try {
    const updated = await updateRule(
      id,
      {
        orgId: gate.user.orgId,
        expectedRevision: revision,
        name: patchBody.name as string | undefined,
        description: patchBody.description as string | null | undefined,
        sortOrder: patchBody.sortOrder as number | undefined,
        isActive: patchBody.isActive as boolean | undefined,
        allowedSubsidiaryIds: gate.allowedSubsidiaryIds,
      },
      { actorId: gate.user.id },
    );
    return NextResponse.json({ rule: { ...updated.rule, revision: updated.revision } });
  } catch (error) {
    return allocationWriteErrorResponse(error);
  }
}

export const GET = defineRoute({
  permission: "allocations.read",
  feature: "allocations",
  params: z.object({ id: z.string() }),
  handler: ({ request, params, authz }) =>
    legacyGET(request, { params: Promise.resolve(params) }, authz),
});

export const PATCH = defineRoute({
  permission: "allocations.manage",
  feature: "allocations",
  params: z.object({ id: z.string().refine((value) => isUuid(value)) }),
  invalidParamsNotFound: "record",
  body: bodyObjectSchema,
  opaque: {
    name: "The update handler requires the expected revision and validates the supplied patch fields.",
    description:
      "The update handler requires the expected revision and validates the supplied patch fields.",
    sortOrder:
      "The update handler requires the expected revision and validates the supplied patch fields.",
    isActive:
      "The update handler requires the expected revision and validates the supplied patch fields.",
    expectedRevision:
      "The handler returns its established revision refusal when this concurrency token is omitted.",
  },
  handler: ({ params, authz, body }) =>
    legacyPATCH({ params: Promise.resolve(params) }, body, authz),
});
