import { sql } from "drizzle-orm";
import { parseJsonBody } from "@/lib/api/json";
import { leasePostSchema } from "../../_schema";
import { NextResponse } from "next/server";
import { subsidiaryScopeAllows } from "@openbooks/engine/src/organization/subsidiary-scope.ts";
import { guardFeaturePermission } from "@/lib/feature-gates";
import { isUuid } from "@/lib/list-params";
import { db } from "@openbooks/engine/src/platform/db.ts";
import { postDueLeaseSchedules } from "@openbooks/engine/src/revenue/leases.ts";
export const runtime = "nodejs";
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const gate = await guardFeaturePermission("assets.manage", "fixedAssets");
  if (gate instanceof NextResponse) return gate;
  const { id } = await params;
  if (!isUuid(id))
    return NextResponse.json({ error: "invalid lease" }, { status: 422 });
  const body = await parseJsonBody(req, leasePostSchema);
  if (!body.ok) return body.response;
  // A valid-but-unknown id is a missing record, not an empty run: posting
  // nothing with a 200 would read as success for a lease that is gone (or
  // belongs to another tenant). Inactive leases and weeks with nothing due
  // still answer 200 with posted: 0 — only the unknown id is a 404.
  const known = await db.execute<{ id: string; subsidiary_id: string | null }>(sql`
    select id, subsidiary_id from lease_agreements
     where org_id = ${gate.user.orgId} and id = ${id}
  `);
  if (!known.rows[0])
    return NextResponse.json({ error: "lease not found" }, { status: 404 });
  // An out-of-scope lease answers exactly like a missing one — same body,
  // same status — without which a restricted caller told B's lease apart
  // (200 {posted: 0} or 422) from a missing id (404). The write transaction
  // rechecks under its row lock in postDueLeaseSchedules via
  // assertFinancialChangeAccess.
  if (!subsidiaryScopeAllows(gate.allowedSubsidiaryIds, known.rows[0].subsidiary_id)) {
    return NextResponse.json({ error: "lease not found" }, { status: 404 });
  }
  try {
    return NextResponse.json(
      await postDueLeaseSchedules(
        gate.user.orgId,
        body.data.asOfDate,
        gate.user.id,
        { leaseId: id },
      ),
    );
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "lease action failed" },
      { status: 422 },
    );
  }
}
