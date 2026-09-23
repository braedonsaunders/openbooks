import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import {
  isContinuousCloseAgentKey,
  runContinuousCloseAgent,
} from "@openbooks/engine/src/continuous-close/continuous-close.ts";
import { guardFeaturePermission } from "../../../../lib/feature-gates";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const gate = await guardFeaturePermission("admin.ai.manage", "continuousClose");
  if (gate instanceof NextResponse) return gate;
  let body: Record<string, unknown>;
  try {
    const parsedBody = await parseJsonBody(request, jsonObject);
    if (!parsedBody.ok) return parsedBody.response;
    body = parsedBody.data;
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (!isContinuousCloseAgentKey(body.agentKey)) {
    return NextResponse.json({ error: "invalid_agent" }, { status: 422 });
  }
  let result;
  try {
    result = await runContinuousCloseAgent({
      orgId: gate.user.orgId,
      agentKey: body.agentKey,
      trigger: "manual",
      initiatedBy: gate.user.id,
    });
  } catch (error) {
    // The scan rechecks the continuousClose switch inside its own write
    // transaction: a disable landing after this route's preflight refuses by
    // name here instead of surfacing as an anonymous 500.
    if ((error as Error).message === "feature_disabled") {
      return NextResponse.json({ error: "feature_disabled" }, { status: 409 });
    }
    throw error;
  }
  return NextResponse.json(result, { status: result.status === "failed" ? 500 : result.status === "skipped" ? 409 : 200 });
}
