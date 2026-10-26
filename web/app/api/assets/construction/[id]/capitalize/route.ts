import { z } from "zod";
import { NextResponse } from "next/server";
import { defineRoute } from "@/lib/api/route";
import { apiErrorResponse } from "@/lib/api/error-response";
import { capitalizeCip } from "@openbooks/engine/assets/asset-cip";
import {
  calendarDate,
  id,
  idempotencyKey,
  money,
  optionalText,
  reasonText,
  scopeOf,
} from "../../../_depth";

export const runtime = "nodejs";

const assetLine = {
  name: z.string().trim().min(1, "each asset needs a name").max(200),
  categoryId: id,
  amount: money("amount"),
  description: optionalText(4000),
  placeInService: z.boolean().optional(),
};

const body = z.strictObject({
  idempotencyKey,
  capitalizedOn: calendarDate("capitalizedOn"),
  reason: reasonText,
  closeWhenEmpty: z.boolean().optional(),
  lines: z
    .array(
      z.discriminatedUnion("kind", [
        z.strictObject({ kind: z.literal("asset"), ...assetLine }),
        z.strictObject({ kind: z.literal("component"), parentAssetId: id, ...assetLine }),
        z.strictObject({
          kind: z.literal("expense"),
          expenseAccountId: id,
          amount: money("amount"),
          memo: optionalText(500),
        }),
      ]),
    )
    .min(1, "add at least one line")
    .max(200),
});

/**
 * Capitalize part or all of a construction-in-progress balance into new
 * assets or components and an expensed remainder, through one journal
 * crediting the CIP account.
 */
export const POST = defineRoute({
  permission: "assets.capitalize",
  feature: "constructionInProgress",
  params: z.object({ id }),
  body,
  invalidBodyStatus: 422,
  handler: async ({ authz: gate, params, body: input }) => {
    const { id: cipAssetId } = await params;
    try {
      const result = await capitalizeCip(
        gate.user.orgId,
        { ...input, cipAssetId },
        { actorId: gate.user.id, allowedSubsidiaryIds: scopeOf(gate) },
      );
      return NextResponse.json(result, { status: result.replayed ? 200 : 201 });
    } catch (error) {
      // Placing a capitalized asset in service can raise the native schedule refusals.
      return apiErrorResponse(error, { safeStatus: 422 });
    }
  },
});
