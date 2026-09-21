import { parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import {
  createFramework,
  getFramework,
  listFrameworks,
  setFrameworkActive,
} from "@openbooks/engine/src/hrm/performance/competencies.ts";
import { getAuthz } from "../../../../lib/authz";
import { isFeatureEnabled } from "../../../../lib/features";
import { performanceErrorResponse } from "../review-cycles/_lib";
import { createFrameworkBody, patchFrameworkBody } from "./bodies";

export const runtime = "nodejs";

async function gated(orgId: string): Promise<boolean> {
  return (
    (await isFeatureEnabled(orgId, "hrm")) &&
    (await isFeatureEnabled(orgId, "hrmPerformance")) &&
    (await isFeatureEnabled(orgId, "hrmCompetencies"))
  );
}

/**
 * Competency frameworks (Setup-owned vocabulary). GET lists with
 * competencies and levels, POST creates, PATCH deactivates (history is
 * preserved, never deleted). The client checks res.ok before parsing.
 */
export async function GET(req: Request) {
  const authz = await getAuthz();
  if (!authz) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!(await gated(authz.user.orgId))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const id = new URL(req.url).searchParams.get("id");
  try {
    if (id) {
      const framework = await getFramework({ orgId: authz.user.orgId, actorId: authz.user.id, id });
      if (!framework) return NextResponse.json({ error: "competency framework was not found" }, { status: 404 });
      return NextResponse.json({ framework });
    }
    const frameworks = await listFrameworks({ orgId: authz.user.orgId, actorId: authz.user.id });
    return NextResponse.json({ frameworks });
  } catch (e) {
    return performanceErrorResponse(e);
  }
}

export async function POST(req: Request) {
  const authz = await getAuthz();
  if (!authz) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!(await gated(authz.user.orgId))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const parsedBody = await parseJsonBody(req, createFrameworkBody);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data;
  try {
    const framework = await createFramework({
      orgId: authz.user.orgId,
      actorId: authz.user.id,
      name: body.name,
      appliesTo: body.appliesTo ?? null,
    });
    return NextResponse.json({ framework }, { status: 201 });
  } catch (e) {
    return performanceErrorResponse(e);
  }
}

export async function PATCH(req: Request) {
  const authz = await getAuthz();
  if (!authz) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!(await gated(authz.user.orgId))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });
  const parsedBody = await parseJsonBody(req, patchFrameworkBody);
  if (!parsedBody.ok) return parsedBody.response;
  try {
    await setFrameworkActive({ orgId: authz.user.orgId, actorId: authz.user.id, id, isActive: parsedBody.data.isActive });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return performanceErrorResponse(e);
  }
}
