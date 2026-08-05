import { NextResponse } from "next/server";
import { IncomeTaxProvisionError, postProvisionRun } from "@openbooks/engine/src/income-tax-provision.ts";
import { guardPermission } from "../../../../../../lib/authz";
import { isUuid } from "../../../../../../lib/list-params";

export const runtime = "nodejs";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission("reports.create");
  if (gate instanceof NextResponse) return gate;
  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: "invalid id" }, { status: 400 });
  try {
    const result = await postProvisionRun(gate.user.orgId, id, gate.user.id);
    return NextResponse.json(result);
  } catch (e) {
    const status = e instanceof IncomeTaxProvisionError ? 422 : 500;
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status });
  }
}
