import { NextResponse } from "next/server";
import { guardPermission } from "../../../../../lib/authz";
import { pingModel } from "../../../../../lib/assistant/client";
import { getOrgAiConfig } from "../../../../../lib/assistant/ai-config";

export const runtime = "nodejs";

/** Live test of the SAVED config — sends a tiny prompt to the fast model. */
export async function POST() {
  const gate = await guardPermission("admin.ai.manage");
  if (gate instanceof NextResponse) return gate;
  const result = await pingModel(await getOrgAiConfig(gate.user.orgId));
  return NextResponse.json(result);
}
