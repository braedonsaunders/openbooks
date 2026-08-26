import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { IncomeTaxProvisionError, postProvisionRun } from "@openbooks/engine/src/income-tax-provision.ts";
import { db } from "@openbooks/engine/src/db.ts";
import { guardPermission, guardSubsidiaryScope } from "../../../../../../lib/authz";
import { isUuid } from "../../../../../../lib/list-params";

export const runtime = "nodejs";

/**
 * Posting a provision creates posted GL entries and reverses prior ones, so it
 * demands journal posting authority (`gl.post`) at the same boundary as every
 * other ledger write — report authorship (`reports.create`) is deliberately
 * not enough. The run is loaded under org scope first, then the ROOT
 * subsidiary — the entity the kernel always posts into — is fenced with the
 * shared direct-record gate, so an out-of-scope target denies identically to a
 * missing run. Every refusal returns before postProvisionRun: a denied caller
 * writes nothing.
 */
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
  const rootSubsidiaryId = (
    (await db.execute<{ id: string }>(sql`
      select id from subsidiaries where org_id = ${gate.user.orgId} and parent_id is null limit 1
    `))
  ).rows[0]?.id;
  const denied = guardSubsidiaryScope(gate, rootSubsidiaryId ?? null);
  if (denied) return denied;
  try {
    const result = await postProvisionRun(gate.user.orgId, id, gate.user.id);
    return NextResponse.json(result);
  } catch (e) {
    const status = e instanceof IncomeTaxProvisionError ? 422 : 500;
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status });
  }
}
