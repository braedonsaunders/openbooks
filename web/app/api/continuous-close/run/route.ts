import { NextResponse } from "next/server";
import {
  isContinuousCloseAgentKey,
  runContinuousCloseAgent,
} from "@openbooks/engine/src/continuous-close.ts";
import { guardPermission } from "../../../../lib/authz";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const gate = await guardPermission("admin.ai.manage");
  if (gate instanceof NextResponse) return gate;
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (!isContinuousCloseAgentKey(body.agentKey)) {
    return NextResponse.json({ error: "invalid_agent" }, { status: 422 });
  }
  const result = await runContinuousCloseAgent({
    orgId: gate.user.orgId,
    agentKey: body.agentKey,
    trigger: "manual",
    initiatedBy: gate.user.id,
  });
  return NextResponse.json(result, { status: result.status === "failed" ? 500 : result.status === "skipped" ? 409 : 200 });
}
