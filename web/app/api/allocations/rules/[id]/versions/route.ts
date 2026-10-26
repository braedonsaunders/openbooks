import type { Authz } from "@/lib/authz";
import { defineRoute } from "@/lib/api/route";
import { z } from "zod";
import { NextResponse } from "next/server";
import { createDraftVersion } from "@openbooks/engine/allocations/runtime";
import { guardUnrestrictedScope } from "@/lib/authz";
import { allocationWriteErrorResponse, requireRuleId } from "../../../_lib.ts";
import { isUuid } from "@/lib/list-params";

export const runtime = "nodejs";

const bodyObjectSchema = z.object({ fromVersionId: z.string().optional() });

/**
 * New draft version from the latest (or a named) version — "New version from
 * current". Definition overrides cannot be combined with a source copy (A1
 * refuses); edit the copy afterwards through the version PATCH.
 */
async function legacyPOST(
  { params }: { params: Promise<{ id: string }> },
  body: z.output<typeof bodyObjectSchema>,
  injectedGate?: Authz | null,
) {
  const gate = injectedGate as Authz;
  const id = requireRuleId((await params).id);
  if (id instanceof NextResponse) return id;
  // A blank draft names no subsidiaries, so it is org-wide policy from the
  // first row: restricted callers get the named 403 with no lookup at all.
  // Copies name the source version's subsidiaries and are asserted in the
  // engine, where a denied copy answers exactly like a missing version.
  if (body.fromVersionId === undefined) {
    const scope = guardUnrestrictedScope(gate);
    if (scope) return scope;
  }
  try {
    const created = await createDraftVersion(
      id,
      {
        orgId: gate.user.orgId,
        fromVersionId: typeof body.fromVersionId === "string" ? body.fromVersionId : undefined,
        allowedSubsidiaryIds: gate.allowedSubsidiaryIds,
      },
      { actorId: gate.user.id },
    );
    return NextResponse.json(
      {
        version: { ...created.version, revision: created.revision },
        targets: created.targets,
      },
      { status: 201 },
    );
  } catch (error) {
    return allocationWriteErrorResponse(error);
  }
}

export const POST = defineRoute({
  permission: "allocations.manage",
  feature: "allocations",
  params: z.object({ id: z.string().refine((value) => isUuid(value)) }),
  invalidParamsNotFound: "record",
  body: bodyObjectSchema,
  opaque: {
    fromVersionId: "An empty object intentionally creates a new blank draft version.",
  },
  handler: ({ params, authz, body }) =>
    legacyPOST({ params: Promise.resolve(params) }, body, authz),
});
