import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { IncomeTaxProvisionError, postProvisionRun } from "@openbooks/engine/src/tax-returns/income-tax-provision.ts";
import { db } from "@openbooks/engine/src/platform/db.ts";
import { guardPermission, guardUnrestrictedScope } from "../../../../../../lib/authz";
import { isUuid } from "../../../../../../lib/list-params";

export const runtime = "nodejs";

/** A provision posts and reverses the complete organization-wide entity set.
 * Root-entity access alone cannot authorize journals in its siblings/children. */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission("gl.post");
  if (gate instanceof NextResponse) return gate;
  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: "invalid id" }, { status: 400 });
  // Org-wide write (canonical shape 2 in
  // engine/src/organization/subsidiary-scope.ts): posting a provision
  // creates and reverses journals for the complete entity set, so a
  // subsidiary-restricted caller gets the named 403 before any existence
  // lookup — an existing run and a missing id answer identically.
  const scope = guardUnrestrictedScope(gate);
  if (scope) return scope;
  const owned = (
    (await db.execute<{ id: string }>(sql`
      select id from tax_provision_runs where org_id = ${gate.user.orgId} and id = ${id}
    `))
  ).rows[0];
  if (!owned) return NextResponse.json({ error: "not found" }, { status: 404 });
  try {
    const result = await postProvisionRun(gate.user.orgId, id, gate.user.id);
    return NextResponse.json(result);
  } catch (e) {
    const status = e instanceof IncomeTaxProvisionError ? 422 : 500;
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status });
  }
}
