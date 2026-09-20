import { parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import { db } from "@openbooks/engine/src/platform/db.ts";
import {
  acknowledgeFinding,
  listFindings,
  resolveFinding,
} from "@openbooks/engine/src/hrm/construction/findings.ts";
import { guardPermission } from "../../../../../lib/authz";
import { isFeatureEnabled } from "../../../../../lib/features";
import { constructionErrorResponse } from "../_lib";
import { findingActionBody } from "../bodies";

export const runtime = "nodejs";

/** Compliance findings: list, acknowledge, resolve. */
export async function GET(req: Request) {
  const gate = await guardPermission("hrm.construction.read");
  if (gate instanceof NextResponse) return gate;
  if (!(await isFeatureEnabled(gate.user.orgId, "hrmConstructionCompliance"))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const url = new URL(req.url);
  try {
    const findings = await listFindings(db, gate.user.orgId, gate.user.id, url.searchParams.get("status"));
    return NextResponse.json({ findings });
  } catch (e) {
    return constructionErrorResponse(e);
  }
}

export async function PUT(req: Request) {
  const gate = await guardPermission("hrm.construction.manage");
  if (gate instanceof NextResponse) return gate;
  if (!(await isFeatureEnabled(gate.user.orgId, "hrmConstructionCompliance"))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const parsedBody = await parseJsonBody(req, findingActionBody);
  if (!parsedBody.ok) return parsedBody.response;
  try {
    const finding =
      parsedBody.data.action === "acknowledge"
        ? await acknowledgeFinding(db, gate.user.orgId, gate.user.id, parsedBody.data.findingId)
        : await resolveFinding(
            db,
            gate.user.orgId,
            gate.user.id,
            parsedBody.data.findingId,
            parsedBody.data.reason ?? "resolved from the Compliance page",
          );
    return NextResponse.json({ finding });
  } catch (e) {
    return constructionErrorResponse(e);
  }
}
