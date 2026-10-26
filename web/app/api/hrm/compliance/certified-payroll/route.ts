import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@openbooks/engine/platform/db";
import {
  amendRun,
  downloadRun,
  generate,
  listFormats,
  listRuns,
  submitRun,
} from "@openbooks/engine/hrm/construction/certified";
import { constructionErrorResponse } from "../_lib";
import { certifiedActionBody, generateCertifiedBody } from "../bodies";
/** Certified payroll runs: list, generate, submit, amend, download. */
export const GET = defineRoute({
  permission: "hrm.construction.read",
  feature: "hrmConstructionCompliance",
  handler: async ({ request: req, authz: gate }) => {
    const url = new URL(req.url);
    try {
      if (url.searchParams.get("formats") === "1") {
        const declared = await listFormats(db, gate.user.orgId, gate.user.id);
        return NextResponse.json(declared);
      }
      const runs = await listRuns(
        db,
        gate.user.orgId,
        gate.user.id,
        url.searchParams.get("projectId"),
      );
      return NextResponse.json({ runs });
    } catch (e) {
      return constructionErrorResponse(e);
    }
  },
});
export const POST = defineRoute({
  permission: "hrm.construction.manage",
  feature: "hrmConstructionCompliance",
  body: ({ request }) =>
    new URL(request.url).searchParams.get("action") === "1"
      ? certifiedActionBody
      : generateCertifiedBody,
  handler: async ({ request: req, authz: gate, body }) => {
    const url = new URL(req.url);
    if (url.searchParams.get("action") === "1") {
      const parsedBody = body as z.output<typeof certifiedActionBody>;
      try {
        if (parsedBody.action === "submit") {
          const run = await submitRun(db, {
            orgId: gate.user.orgId,
            actorId: gate.user.id,
            runId: parsedBody.runId,
          });
          return NextResponse.json({ run });
        }
        if (parsedBody.action === "amend") {
          const run = await amendRun(db, {
            orgId: gate.user.orgId,
            actorId: gate.user.id,
            runId: parsedBody.runId,
          });
          return NextResponse.json({ run }, { status: 201 });
        }
        const file = await downloadRun(db, gate.user.orgId, gate.user.id, parsedBody.runId);
        return NextResponse.json({ file });
      } catch (e) {
        return constructionErrorResponse(e);
      }
    }
    const parsedBody = body as z.output<typeof generateCertifiedBody>;
    try {
      const run = await generate(db, {
        orgId: gate.user.orgId,
        actorId: gate.user.id,
        ...parsedBody,
      });
      return NextResponse.json({ run }, { status: 201 });
    } catch (e) {
      return constructionErrorResponse(e);
    }
  },
});
