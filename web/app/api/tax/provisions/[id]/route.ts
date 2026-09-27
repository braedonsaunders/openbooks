import type { Authz } from "@/lib/authz";
import { defineRoute } from "@/lib/api/route";
import { z } from "zod";
import { NextResponse } from "next/server";
import { getProvisionRun } from "@openbooks/engine/src/tax-returns/income-tax-provision.ts";
import { isUuid } from "../../../../../lib/list-params";
import { notFound } from "@/lib/api/responses";


export const runtime = "nodejs";

async function legacyGET(_req: Request, { params }: { params: Promise<{ id: string }> }, injectedGate?: Authz | null) {
  const gate = injectedGate as Authz;

  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: "invalid id" }, { status: 400 });
  const run = await getProvisionRun(gate.user.orgId, id, gate.allowedSubsidiaryIds);
  if (!run) return notFound("record");
  return NextResponse.json(run);
}

export const GET = defineRoute({
  permission: "reports.read", feature: { none: "This route is governed by its permission and service authorization." },
  params: z.object({ "id": z.string() }),
  handler: ({ request, params, authz }) => legacyGET(request, { params: Promise.resolve(params) }, authz),
});
