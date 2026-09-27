import { defineRoute } from "@/lib/api/route";
import { notFound } from "@/lib/api/responses";
import { NextResponse } from "next/server";
import {
  generateStatement,
  getStatementOrganizationName,
  listStatements,
  renderStatementPdf,
} from "@openbooks/engine/src/hrm/compensation/statements.ts";
import { guardPermission } from "../../../../lib/authz";
import { isFeatureEnabled } from "../../../../lib/features";
import { isUuid } from "../../../../lib/list-params";
import { compensationErrorResponse } from "../compensation/_lib";
import { createStatementBody } from "../compensation/bodies";

export const runtime = "nodejs";

/**
 * Total-rewards statements. GET lists an employment's statements (HR
 * through comp.read fenced to the subsidiary lens in the service, the
 * person through hrm.self.read for their own employment); POST freezes
 * a new one behind comp.manage. GET ?pdf=<id> renders the stored
 * statement through packages/pdf. The client checks res.ok before
 * parsing.
 */
export const GET = defineRoute({
  public: "session",
  handler: async ({ request: req }) => {
    const hr = await guardPermission("hrm.compensation.read");
    const gate =
      hr instanceof NextResponse ? await guardPermission("hrm.self.read") : hr;
    if (gate instanceof NextResponse) return gate;
    if (!(await isFeatureEnabled(gate.user.orgId, "hrmCompensation"))) {
      return notFound("record");
    }
    const url = new URL(req.url);
    const employmentId = url.searchParams.get("employmentId");
    if (!employmentId || !isUuid(employmentId)) {
      return NextResponse.json(
        { error: "employmentId must be a uuid" },
        { status: 400 },
      );
    }
    const pdf = url.searchParams.get("pdf");
    try {
      if (pdf) {
        if (!isUuid(pdf))
          return NextResponse.json(
            { error: "invalid statement" },
            { status: 400 },
          );
        const org = await getStatementOrganizationName(gate.user.orgId);
        const bytes = await renderStatementPdf({
          orgId: gate.user.orgId,
          actorId: gate.user.id,
          statementId: pdf,
          orgName: org,
        });
        return new NextResponse(new Uint8Array(bytes), {
          headers: { "content-type": "application/pdf" },
        });
      }
      const statements = await listStatements({
        orgId: gate.user.orgId,
        actorId: gate.user.id,
        employmentId,
      });
      return NextResponse.json({ statements });
    } catch (e) {
      return compensationErrorResponse(e);
    }
  },
});

export const POST = defineRoute({
  permission: "hrm.compensation.manage",
  feature: "hrmCompensation",
  body: createStatementBody,
  handler: async ({ authz: gate, body: body }) => {
    try {
      const statement = await generateStatement({
        orgId: gate.user.orgId,
        actorId: gate.user.id,
        employmentId: body.employmentId,
        cycleId: body.cycleId ?? null,
        periodFrom: body.periodFrom,
        periodTo: body.periodTo,
      });
      return NextResponse.json({ statement }, { status: 201 });
    } catch (e) {
      return compensationErrorResponse(e);
    }
  },
});
