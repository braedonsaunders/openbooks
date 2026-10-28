import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { apiErrorResponse } from "@/lib/api/error-response";
import { NextResponse } from "next/server";
import { UnrestrictedScopeError } from "@openbooks/engine/organization/scope";
import type { Authz } from "@/lib/authz";
import { runSetupAgentNow } from "@/lib/setup/agents";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/admin/setup/agents/[agentKey]/run — manual scan from the Setup
 * area. Same `runContinuousCloseAgent` command as POST
 * /api/continuous-close/run, behind the setup gate instead of the provider
 * key; a disabled Continuous Close module 404s like every other hidden-module
 * API surface.
 */
export async function runSetupAgentAction(
  _request: Request,
  { params }: { params: Promise<{ agentKey: string }> },
  gate: Authz,
) {
  const { agentKey } = await params;
  let result;
  try {
    // A manual scan runs the org-wide detector pack and auto-resolves other
    // entities' unmatched findings, so subsidiary-restricted callers are
    // refused by name before the scan persists anything.
    result = await runSetupAgentNow(
      gate.user.orgId,
      gate.user.id,
      agentKey,
      gate.allowedSubsidiaryIds,
    );
  } catch (error) {
    // A disable landing after the preflight refuses by name; only a genuinely
    // unknown key is an invalid agent. Collapsing both into invalid_agent
    // would tell the operator the pack does not exist when the switch is off.
    if (error instanceof Error && error.message === "feature_disabled") {
      return NextResponse.json({ error: "feature_disabled" }, { status: 409 });
    }
    if (error instanceof UnrestrictedScopeError) {
      return apiErrorResponse(error);
    }
    if (error instanceof Error && error.message === "invalid_agent") {
      return NextResponse.json({ error: "invalid_agent" }, { status: 404 });
    }
    return apiErrorResponse(error);
  }
  if (result.status === "claimed_elsewhere") return NextResponse.json(result, { status: 409 });
  return NextResponse.json(result, {
    status: result.status === "failed" ? 500 : result.status === "skipped" ? 409 : 200,
  });
}

export const POST = defineRoute({
  permission: "admin.setup.manage",
  feature: "continuousClose",
  params: z.object({ agentKey: z.string() }),
  handler: async ({ request, params, authz }) =>
    runSetupAgentAction(request, { params: Promise.resolve(params) }, authz),
});
