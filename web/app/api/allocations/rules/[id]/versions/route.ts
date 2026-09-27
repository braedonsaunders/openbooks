import type { Authz } from "@/lib/authz";
import { defineRoute } from "@/lib/api/route";
import { z } from "zod";
import { parseJsonBody } from '@/lib/api/json';
import { NextResponse } from 'next/server'
import { createDraftVersion } from '../../../../../../../engine/src/allocations/index.ts'
import { guardUnrestrictedScope } from '../../../../../../lib/authz'
import { allocationWriteErrorResponse, requireRuleId } from '../../../_lib.ts'

export const runtime = 'nodejs'

const bodyObjectSchema = z.object({ fromVersionId: z.string().optional() });

/**
 * New draft version from the latest (or a named) version — "New version from
 * current". Definition overrides cannot be combined with a source copy (A1
 * refuses); edit the copy afterwards through the version PATCH.
 */
async function legacyPOST(req: Request, { params }: { params: Promise<{ id: string }> }, injectedGate?: Authz | null) {
  const gate = injectedGate as Authz;
  const id = requireRuleId((await params).id)
  if (id instanceof NextResponse) return id
  const parsed = await parseJsonBody(req, bodyObjectSchema)
  if (!parsed.ok) return parsed.response
  const body = parsed.data as { fromVersionId?: unknown }
  // A blank draft names no subsidiaries, so it is org-wide policy from the
  // first row: restricted callers get the named 403 with no lookup at all.
  // Copies name the source version's subsidiaries and are asserted in the
  // engine, where a denied copy answers exactly like a missing version.
  if (body.fromVersionId === undefined) {
    const scope = guardUnrestrictedScope(gate)
    if (scope) return scope
  }
  try {
    const created = await createDraftVersion(
      id,
      {
        orgId: gate.user.orgId,
        fromVersionId: typeof body.fromVersionId === 'string' ? body.fromVersionId : undefined,
        allowedSubsidiaryIds: gate.allowedSubsidiaryIds,
      },
      { actorId: gate.user.id },
    )
    return NextResponse.json(
      {
        version: { ...created.version, revision: created.revision },
        targets: created.targets,
      },
      { status: 201 },
    )
  } catch (error) {
    return allocationWriteErrorResponse(error)
  }
}

export const POST = defineRoute({
  permission: 'allocations.manage', feature: "allocations",
  params: z.object({ "id": z.string() }),
  handler: ({ request, params, authz }) => legacyPOST(request, { params: Promise.resolve(params) }, authz),
});
