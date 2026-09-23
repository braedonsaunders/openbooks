import { sql } from "drizzle-orm";
import { parseJsonBody } from "@/lib/api/json";
import { leasePostSchema } from "../../_schema";
import { NextResponse } from "next/server";
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
  const known = await db.execute(sql`
    select id from lease_agreements
     where org_id = ${gate.user.orgId} and id = ${id}
  `);
  if (!known.rows[0])
    return NextResponse.json({ error: "lease not found" }, { status: 404 });
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
