import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { db } from "@openbooks/engine/src/platform/db.ts";
import {
  acknowledgeFinding,
  listFindings,
  resolveFinding,
} from "@openbooks/engine/src/hrm/construction/findings.ts";
import { constructionErrorResponse } from "../_lib";
import { findingActionBody } from "../bodies";
/** Compliance findings: list, acknowledge, resolve. */
export const GET = defineRoute({
  permission: "hrm.construction.read",
  feature: "hrmConstructionCompliance",
  handler: async ({ request: req, authz: gate }) => {
    const url = new URL(req.url);
    try {
      const findings = await listFindings(
        db,
        gate.user.orgId,
        gate.user.id,
        url.searchParams.get("status"),
      );
      return NextResponse.json({ findings });
    } catch (e) {
      return constructionErrorResponse(e);
    }
  },
});
export const PUT = defineRoute({
  permission: "hrm.construction.manage",
  feature: "hrmConstructionCompliance",
  body: findingActionBody,
  handler: async ({ request: _req, authz: gate, body }) => {
    try {
      const finding =
        body.action === "acknowledge"
          ? await acknowledgeFinding(
              db,
              gate.user.orgId,
              gate.user.id,
              body.findingId,
            )
          : await resolveFinding(
              db,
              gate.user.orgId,
              gate.user.id,
              body.findingId,
              body.reason ?? "resolved from the Compliance page",
            );
      return NextResponse.json({ finding });
    } catch (e) {
      return constructionErrorResponse(e);
    }
  },
});
