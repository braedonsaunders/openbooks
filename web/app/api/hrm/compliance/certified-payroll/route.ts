import { parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import { db } from "@openbooks/engine/src/platform/db.ts";
import {
  amendRun,
  downloadRun,
  generate,
  listFormats,
  listRuns,
  submitRun,
} from "@openbooks/engine/src/hrm/construction/certified.ts";
import { guardPermission } from "../../../../../lib/authz";
import { isFeatureEnabled } from "../../../../../lib/features";
import { constructionErrorResponse } from "../_lib";
import { certifiedActionBody, generateCertifiedBody } from "../bodies";

export const runtime = "nodejs";

/** Certified payroll runs: list, generate, submit, amend, download. */
export async function GET(req: Request) {
  const gate = await guardPermission("hrm.construction.read");
  if (gate instanceof NextResponse) return gate;
  if (!(await isFeatureEnabled(gate.user.orgId, "hrmConstructionCompliance"))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const url = new URL(req.url);
  try {
    if (url.searchParams.get("formats") === "1") {
      const declared = await listFormats(db, gate.user.orgId, gate.user.id);
      return NextResponse.json(declared);
    }
    const runs = await listRuns(db, gate.user.orgId, gate.user.id, url.searchParams.get("projectId"));
    return NextResponse.json({ runs });
  } catch (e) {
    return constructionErrorResponse(e);
  }
}

export async function POST(req: Request) {
  const gate = await guardPermission("hrm.construction.manage");
  if (gate instanceof NextResponse) return gate;
  if (!(await isFeatureEnabled(gate.user.orgId, "hrmConstructionCompliance"))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const url = new URL(req.url);
  if (url.searchParams.get("action") === "1") {
    const parsedBody = await parseJsonBody(req, certifiedActionBody);
    if (!parsedBody.ok) return parsedBody.response;
    try {
      if (parsedBody.data.action === "submit") {
        const run = await submitRun(db, { orgId: gate.user.orgId, actorId: gate.user.id, runId: parsedBody.data.runId });
        return NextResponse.json({ run });
      }
      if (parsedBody.data.action === "amend") {
        const run = await amendRun(db, { orgId: gate.user.orgId, actorId: gate.user.id, runId: parsedBody.data.runId });
        return NextResponse.json({ run }, { status: 201 });
      }
      const file = await downloadRun(db, gate.user.orgId, gate.user.id, parsedBody.data.runId);
      return NextResponse.json({ file });
    } catch (e) {
      return constructionErrorResponse(e);
    }
  }
  const parsedBody = await parseJsonBody(req, generateCertifiedBody);
  if (!parsedBody.ok) return parsedBody.response;
  try {
    const run = await generate(db, {
      orgId: gate.user.orgId,
      actorId: gate.user.id,
      ...parsedBody.data,
    });
    return NextResponse.json({ run }, { status: 201 });
  } catch (e) {
    return constructionErrorResponse(e);
  }
}
