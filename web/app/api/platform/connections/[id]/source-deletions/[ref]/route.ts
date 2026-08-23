import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import {
  resolveSourceDeletion,
  SourceDeletionResolutionError,
  type SourceDeletionAction,
} from "@openbooks/engine/src/sync/source-deletions.ts";
import { guardPermission } from "../../../../../../../lib/authz";

export const runtime = "nodejs";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string; ref: string }> },
) {
  const gate = await guardPermission("admin.setup.manage");
  if (gate instanceof NextResponse) return gate;
  const { id, ref } = await params;
  const parsedBody = await parseJsonBody(req, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const body = (parsedBody.data) as {
    action?: SourceDeletionAction;
    note?: string;
  };
  if (body.action !== "retain" && body.action !== "void") {
    return NextResponse.json(
      { error: "action must be retain or void" },
      { status: 400 },
    );
  }
  try {
    const result = await resolveSourceDeletion({
      orgId: gate.user.orgId,
      connectionId: id,
      sourceRef: decodeURIComponent(ref),
      action: body.action,
      actorId: gate.user.id,
      note: body.note?.trim() || null,
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    if (error instanceof SourceDeletionResolutionError) {
      return NextResponse.json({ error: error.message }, { status: 422 });
    }
    throw error;
  }
}
