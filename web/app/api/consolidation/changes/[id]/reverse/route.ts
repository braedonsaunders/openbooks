import { NextResponse } from "next/server";
import { z } from "zod";
import { authorizeChange } from "@/app/api/accounting/changes/_authorization";
import { parseJsonBody } from "@/lib/api/json";
import { guardFeaturePermission } from "@/lib/feature-gates";
import { proposeLossOfControlReversal } from "@openbooks/engine/src/consolidation/loss-of-control.ts";
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const capability = await guardFeaturePermission(
    "close.run",
    "multiSubsidiary",
  );
  if (capability instanceof NextResponse) return capability;
  const { id } = await params,
    gate = await authorizeChange(id);
  if (gate instanceof NextResponse) return gate;
  if (gate.domain !== "consolidation")
    return NextResponse.json(
      { error: "select a consolidation change" },
      { status: 422 },
    );
  const body = await parseJsonBody(
    req,
    z.object({
      reason: z.string().trim().min(8).max(1000),
      idempotencyKey: z.string().min(1).max(120),
    }),
    { status: 422 },
  );
  if (!body.ok) return body.response;
  try {
    return NextResponse.json({
      changeId: await proposeLossOfControlReversal(
        gate.auth.user.orgId,
        id,
        gate.auth.user.id,
        body.data.reason,
        body.data.idempotencyKey,
      ),
    });
  } catch (e) {
    return NextResponse.json(
      {
        error:
          e instanceof Error ? e.message : "correction could not be proposed",
      },
      { status: 422 },
    );
  }
}
