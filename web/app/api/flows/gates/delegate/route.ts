import { z } from "zod";
import { uuidString } from "@openbooks/engine/platform/identifiers";
import { defineRoute } from "@/lib/api/route";

import { NextResponse } from "next/server";
import { delegateGate } from "@openbooks/engine/flows/module";
import { guardSubsidiaryScope } from "../../../../../lib/authz";
import { isUuid } from "../../../../../lib/list-params";
import { gateErrorResponse, loadGateHeader } from "../../_lib";

export const requestBodySchema = z.object({ gateId: uuidString(), toUserId: uuidString() });

export const runtime = "nodejs";

/**
 * Hand a pending gate to another user in the org. The engine's delegateGate()
 * authorizes (current assignee or an org admin), verifies the target is an
 * active in-org user, records the hand-off, and notifies the new assignee —
 * the route only session-guards, org-scopes, and maps errors.
 */

export async function delegateApprovalGateAction({
  body,
  authz: routeAuthz,
}: {
  body: z.infer<typeof requestBodySchema>;
  authz: import("@/lib/authz").Authz;
}) {
  const authz = routeAuthz;

  if (!body.gateId || !isUuid(body.gateId) || !body.toUserId || !isUuid(body.toUserId)) {
    return NextResponse.json({ error: "gateId and toUserId required" }, { status: 400 });
  }

  const gate = await loadGateHeader(body.gateId, authz.user.orgId, authz.allowedSubsidiaryIds);
  if (!gate) return NextResponse.json({ error: "approval not found" }, { status: 404 });
  const subsidiaryDenied = guardSubsidiaryScope(authz, gate.subsidiary_id);
  if (subsidiaryDenied) return subsidiaryDenied;
  if (gate.status !== "pending") {
    return NextResponse.json(
      { error: "only a pending approval can be delegated" },
      { status: 409 },
    );
  }

  try {
    // The route 404s out-of-scope gates above; the engine re-checks the
    // same boundary inside the decision so a concurrent edit cannot race it.
    await delegateGate(
      body.gateId,
      authz.user.id,
      body.toUserId,
      authz.allowedSubsidiaryIds == null
        ? authz.allowedSubsidiaryIds
        : new Set(authz.allowedSubsidiaryIds),
    );
    return NextResponse.json({ ok: true });
  } catch (e) {
    return gateErrorResponse(e);
  }
}

export const POST = defineRoute({
  public: "session",
  body: requestBodySchema,
  handler: delegateApprovalGateAction,

  feature: "flows",
});
