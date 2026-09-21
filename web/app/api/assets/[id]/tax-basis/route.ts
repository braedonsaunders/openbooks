import { NextResponse } from "next/server";
import { z } from "zod";
import {
  listTaxAssetBasisSources,
  proposeTaxAssetBasis,
  TaxAssetBasisError,
} from "@openbooks/engine/src/tax-returns/asset-basis-workpaper.ts";
import { TaxBasisPolicyError } from "@openbooks/engine/src/tax-returns/asset-basis-policy.ts";
import { guardFeaturePermission } from "@/lib/feature-gates";
import { parseJsonBody } from "@/lib/api/json";
import { isUuid } from "@/lib/list-params";

export const runtime = "nodejs";

const proposal = z
  .object({
    sourceChangeId: z.union([z.uuid(), z.null()]).optional(),
    sourceEventId: z.uuid().optional(),
    reason: z.string(),
    assessment: z.string(),
    idempotencyKey: z.string(),
    regimes: z.array(z.looseObject({ regime: z.string() })).min(1),
  })
  .strict();

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const gate = await guardFeaturePermission("assets.manage", "fixedAssets");
  if (gate instanceof NextResponse) return gate;
  const { id } = await params;
  if (!isUuid(id))
    return NextResponse.json({ error: "invalid asset" }, { status: 422 });
  try {
    return NextResponse.json(
      await listTaxAssetBasisSources(gate.user.orgId, id, gate.user.id),
    );
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "tax workpapers could not be listed";
    return NextResponse.json(
      { error: message },
      { status: message === "asset not found" ? 404 : 422 },
    );
  }
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const gate = await guardFeaturePermission("assets.manage", "fixedAssets");
  if (gate instanceof NextResponse) return gate;
  const { id } = await params;
  if (!isUuid(id))
    return NextResponse.json({ error: "invalid asset" }, { status: 422 });
  const body = await parseJsonBody(req, proposal, { status: 422 });
  if (!body.ok) return body.response;
  try {
    return NextResponse.json(
      {
        changeId: await proposeTaxAssetBasis(
          gate.user.orgId,
          id,
          gate.user.id,
          // The body is schema-parsed but structurally loose: the regime
          // union is validated inside proposeTaxAssetBasis
          // (validateTaxRegimeBasis), which refuses an unknown or
          // incomplete regime by name. This is the JSON boundary, not a
          // claim that the parse already produced the union.
          body.data as unknown as Parameters<typeof proposeTaxAssetBasis>[3],
        ),
      },
      { status: 201 },
    );
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof TaxAssetBasisError ||
          error instanceof TaxBasisPolicyError ||
          error instanceof Error
            ? error.message
            : "tax basis workpaper could not be proposed",
      },
      { status: 422 },
    );
  }
}
