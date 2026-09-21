import { NextResponse } from "next/server";
import { z } from "zod";
import {
  previewTaxMatchingReplay,
  proposeTaxMatchingReplay,
  TaxMatchingReplayError,
} from "@openbooks/engine/src/tax-returns/consolidated-matching-replay.ts";
import { guardFeaturePermission } from "@/lib/feature-gates";
import { parseJsonBody } from "@/lib/api/json";
import { isUuid } from "@/lib/list-params";

export const runtime = "nodejs";

const query = z.object({ replacementWorkpaperChangeId: z.uuid() }).strict();
const proposal = z.object({
  replacementWorkpaperChangeId: z.uuid(),
  citedHistoricalPeriodIds: z.array(z.uuid()).min(1).refine(
    (ids) => new Set(ids).size === ids.length,
    "Reload the replacement workpaper: each historical matching period is cited once",
  ),
  reason: z.string().trim().min(8).max(1000),
  idempotencyKey: z.string().trim().min(1).max(120),
}).strict();

function refusal(error: unknown) {
  return NextResponse.json({
    error: error instanceof TaxMatchingReplayError || error instanceof Error
      ? error.message : "Tax matching replay could not be prepared",
  }, { status: 422 });
}

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardFeaturePermission("assets.manage", "fixedAssets");
  if (gate instanceof NextResponse) return gate;
  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: "invalid asset" }, { status: 422 });
  const search = new URL(req.url).searchParams;
  const parsed = query.safeParse(Object.fromEntries(search));
  if (!parsed.success || search.getAll("replacementWorkpaperChangeId").length !== 1)
    return NextResponse.json({ error: "Select one applied replacement tax basis workpaper" }, { status: 422 });
  try {
    const preview = await previewTaxMatchingReplay(
      gate.user.orgId, gate.user.id, parsed.data.replacementWorkpaperChangeId,
    );
    if (preview.assetId !== id)
      return NextResponse.json({ error: "replacement tax basis workpaper not found for this asset" }, { status: 404 });
    return NextResponse.json(preview);
  } catch (error) {
    return refusal(error);
  }
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardFeaturePermission("assets.manage", "fixedAssets");
  if (gate instanceof NextResponse) return gate;
  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: "invalid asset" }, { status: 422 });
  const body = await parseJsonBody(req, proposal, { status: 422 });
  if (!body.ok) return body.response;
  try {
    // The command's subject is the immutable workpaper subject. Bind that
    // subject to the URL; a client-supplied asset id is never a new tax fact.
    const preview = await previewTaxMatchingReplay(
      gate.user.orgId, gate.user.id, body.data.replacementWorkpaperChangeId,
    );
    if (preview.assetId !== id)
      return NextResponse.json({ error: "replacement tax basis workpaper not found for this asset" }, { status: 404 });
    // Keep the submitted citation set intact. The domain compares it to the
    // live set under its fence; silently replacing stale IDs defeats review.
    const changeId = await proposeTaxMatchingReplay(gate.user.orgId, gate.user.id, body.data);
    return NextResponse.json({ changeId }, { status: 201 });
  } catch (error) {
    return refusal(error);
  }
}
