import { NextResponse } from "next/server";
import { getProvisionRun } from "@openbooks/engine/src/income-tax-provision.ts";
import { guardPermission } from "../../../../../lib/authz";
import { isUuid } from "../../../../../lib/list-params";

export const runtime = "nodejs";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission("reports.read");
  if (gate instanceof NextResponse) return gate;
  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: "invalid id" }, { status: 400 });
  const run = await getProvisionRun(gate.user.orgId, id);
  if (!run) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json(run);
}
