import { NextResponse } from "next/server";
import { z } from "zod";
import { runEntityWaterfallScenario } from "@openbooks/engine/equity";
import { defineRoute } from "@/lib/api/route";
import { isoDate, uuidId } from "@/lib/api/json";
import { decimalText, optionalDecimal } from "../../_schema";

export const runtime = "nodejs";

const body = z.object({
  subsidiaryId: uuidId,
  asOf: isoDate(),
  exitValue: decimalText,
  /** Fees and expenses paid from the exit before any holder. */
  transactionFees: optionalDecimal,
  unvestedAwards: z.enum(["participate", "cancel"]).default("participate"),
  changeOfControl: z.boolean().default(true),
  terminated: z.boolean().default(false),
});

/**
 * Distribute an exit value, net of transaction fees, through the preference
 * stack to classes, holders and securities, with the distribution across
 * exit values from zero to twice the one asked for. Nothing is recorded.
 */
export const POST = defineRoute({
  permission: "equity.read",
  feature: "equity",
  body,
  invalidBodyStatus: 422,
  handler: async ({ authz, body }) =>
    NextResponse.json(
      await runEntityWaterfallScenario({
        orgId: authz.user.orgId,
        actorId: authz.user.id,
        ...body,
      }),
    ),
});
