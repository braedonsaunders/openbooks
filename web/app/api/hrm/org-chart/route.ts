import { NextResponse } from "next/server";
import { loadDirectory, loadOrgChart } from "@openbooks/engine/src/hrm/org-chart.ts";
import { guardPermission } from "../../../../lib/authz";
import { isFeatureEnabled } from "../../../../lib/features";
import { hrmDocumentsErrorResponse } from "../documents/_lib";
import { civilDate } from "../documents/bodies";

/**
 * GET /api/hrm/org-chart?asOf=YYYY-MM-DD[&root=...] — the tree, or
 * ?mode=directory[&search=...] — the people list. Readable with
 * hrm.employment.read OR hrm.self.read (fenced in the service); the
 * hrmOrgChart switch gates the surface.
 */
export async function GET(req: Request) {
  const hr = await guardPermission("hrm.employment.read");
  const actor = hr instanceof NextResponse ? await guardPermission("hrm.self.read") : hr;
  if (actor instanceof NextResponse) return actor;
  if (!(await isFeatureEnabled(actor.user.orgId, "hrm"))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  if (!(await isFeatureEnabled(actor.user.orgId, "hrmOrgChart"))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  try {
    const params = new URL(req.url).searchParams;
    if (params.get("mode") === "directory") {
      const directory = await loadDirectory({
        orgId: actor.user.orgId,
        actorId: actor.user.id,
        search: params.get("search") ?? undefined,
      });
      return NextResponse.json({ directory });
    }
    const asOf = params.get("asOf") ?? new Date().toISOString().slice(0, 10);
    if (!civilDate.safeParse(asOf).success) {
      return NextResponse.json({ error: "asOf must be YYYY-MM-DD" }, { status: 400 });
    }
    const chart = await loadOrgChart({
      orgId: actor.user.orgId,
      actorId: actor.user.id,
      asOf,
      rootEmploymentId: params.get("root") ?? undefined,
    });
    return NextResponse.json({ chart });
  } catch (e) {
    return hrmDocumentsErrorResponse(e);
  }
}
