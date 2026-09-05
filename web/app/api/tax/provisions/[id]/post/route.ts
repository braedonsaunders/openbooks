import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { IncomeTaxProvisionError, postProvisionRun } from "@openbooks/engine/src/income-tax-provision.ts";
import { db } from "@openbooks/engine/src/db.ts";
import { guardPermission, guardSubsidiaryScope } from "../../../../../../lib/authz";
import { isUuid } from "../../../../../../lib/list-params";

export const runtime = "nodejs";

/** A provision posts and reverses the complete organization-wide entity set.
 * Root-entity access alone cannot authorize journals in its siblings/children. */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission("gl.post");
  if (gate instanceof NextResponse) return gate;
  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: "invalid id" }, { status: 400 });
  const owned = (
    (await db.execute<{ id: string }>(sql`
      select id from tax_provision_runs where org_id = ${gate.user.orgId} and id = ${id}
    `))
  ).rows[0];
  if (!owned) return NextResponse.json({ error: "not found" }, { status: 404 });
  const denied = guardSubsidiaryScope(gate, null);
  if (denied) return denied;
  try {
    const result = await postProvisionRun(gate.user.orgId, id, gate.user.id);
    return NextResponse.json(result);
  } catch (e) {
    const status = e instanceof IncomeTaxProvisionError ? 422 : 500;
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status });
  }
}
