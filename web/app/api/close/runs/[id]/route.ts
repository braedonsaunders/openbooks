import { NextResponse } from "next/server";
import {
  attestOwnerManagedClose,
  closeApprovedRun,
  CloseError,
  publishCloseRun,
  requestCloseApproval,
  refreshCloseRun,
} from "@openbooks/engine/src/close.ts";
import { guardPermission } from "../../../../../lib/authz";
import { isFeatureEnabled } from "../../../../../lib/features";
import { isUuid } from "../../../../../lib/list-params";

export const runtime = "nodejs";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!isUuid(id))
    return NextResponse.json({ error: "invalid run id" }, { status: 400 });
  const body = (await req.json().catch(() => ({}))) as {
    action?: string;
    comment?: string;
  };
  const permission =
    body.action === "close" || body.action === "attest"
      ? "close.approve"
      : "close.run";
  const gate = await guardPermission(permission);
  if (gate instanceof NextResponse) return gate;
  if (body.action === "publish" && !(await isFeatureEnabled(gate.user.orgId, "advancedClose"))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  try {
    if (body.action === "refresh") {
      return NextResponse.json({
        ok: true,
        ...(await refreshCloseRun(gate.user.orgId, id, gate.user.id)),
      });
    }
    if (body.action === "request_approval")
      await requestCloseApproval(gate.user.orgId, id, gate.user.id);
    else if (body.action === "attest")
      await attestOwnerManagedClose(gate.user.orgId, id, gate.user.id, body.comment ?? "");
    else if (body.action === "close")
      await closeApprovedRun(gate.user.orgId, id, gate.user.id);
    else if (body.action === "publish")
      await publishCloseRun(gate.user.orgId, id, gate.user.id, body.comment);
    else
      return NextResponse.json(
        { error: "action must be refresh, request_approval, attest, close, or publish" },
        { status: 400 },
      );
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof CloseError)
      return NextResponse.json({ error: error.message }, { status: 422 });
    throw error;
  }
}
