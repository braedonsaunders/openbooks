import { NextResponse } from "next/server";
import { z } from "zod";
import { createShareClass } from "@openbooks/engine/equity";
import { defineRoute } from "@/lib/api/route";
import { isoDate, uuidId } from "@/lib/api/json";
import { decimalText, optionalDecimal, wholeShares } from "../_schema";

export const runtime = "nodejs";

const body = z.object({
  subsidiaryId: uuidId,
  code: z.string().trim().min(1).max(40),
  name: z.string().trim().min(1).max(200),
  kind: z.enum(["common", "preferred"]),
  effectiveOn: isoDate(),
  authorizedShares: wholeShares,
  parValue: decimalText,
  originalIssuePrice: optionalDecimal,
  conversionPrice: optionalDecimal,
  liquidationMultiple: optionalDecimal,
  liquidationPreferenceBasis: z.enum(["amount_paid", "original_issue_price"]).nullable().optional(),
  participation: z.enum(["none", "full", "capped"]).optional(),
  participationCapMultiple: optionalDecimal,
  seniority: z.number().int().min(0).max(1000).optional(),
  antiDilution: z.enum(["none", "broad_based", "narrow_based", "full_ratchet"]).optional(),
  conversionShareClassId: uuidId.nullable().optional(),
  conversionAdjustsForSplits: z.boolean().optional(),
});

/** Record a share class of a legal entity. */
export const POST = defineRoute({
  permission: "equity.manage",
  feature: "equity",
  body,
  invalidBodyStatus: 422,
  handler: async ({ authz, body }) =>
    NextResponse.json(
      await createShareClass({ orgId: authz.user.orgId, actorId: authz.user.id, ...body }),
      { status: 201 },
    ),
});
