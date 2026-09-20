import { parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import {
  generateStatement,
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
 * through comp.read, the person through their own scope in the
 * service); POST freezes a new one. GET ?pdf=<id> renders the stored
 * statement through packages/pdf. The client checks res.ok before
 * parsing.
 */
export async function GET(req: Request) {
  const gate = await guardPermission("hrm.compensation.read");
  if (gate instanceof NextResponse) return gate;
  if (!(await isFeatureEnabled(gate.user.orgId, "hrmCompensation"))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const url = new URL(req.url);
  const employmentId = url.searchParams.get("employmentId");
  if (!employmentId || !isUuid(employmentId)) {
    return NextResponse.json({ error: "employmentId must be a uuid" }, { status: 400 });
  }
  const pdf = url.searchParams.get("pdf");
  try {
    if (pdf) {
      if (!isUuid(pdf)) return NextResponse.json({ error: "invalid statement" }, { status: 400 });
      const org = await getOrgName(gate.user.orgId);
      const bytes = await renderStatementPdf({ orgId: gate.user.orgId, actorId: gate.user.id, statementId: pdf, orgName: org });
      return new NextResponse(new Uint8Array(bytes), { headers: { "content-type": "application/pdf" } });
    }
    const statements = await listStatements({ orgId: gate.user.orgId, actorId: gate.user.id, employmentId });
    return NextResponse.json({ statements });
  } catch (e) {
    return compensationErrorResponse(e);
  }
}

async function getOrgName(orgId: string): Promise<string> {
  const { db } = await import("@openbooks/engine/src/platform/db.ts");
  const { sql } = await import("drizzle-orm");
  const row = (await db.execute<{ name: string }>(sql`select name from orgs where id = ${orgId}`)).rows[0];
  return row?.name ?? "Organization";
}

export async function POST(req: Request) {
  const gate = await guardPermission("hrm.compensation.manage");
  if (gate instanceof NextResponse) return gate;
  if (!(await isFeatureEnabled(gate.user.orgId, "hrmCompensation"))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const parsedBody = await parseJsonBody(req, createStatementBody);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data;
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
}
