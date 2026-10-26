import { NextResponse } from "next/server";
import { z } from "zod";
import { runExpenseAmortization } from "@openbooks/engine/amortization";
import { defineRoute } from "@/lib/api/route";
import { isoDate, uuidId } from "@/lib/api/json";

export const runtime = "nodejs";

const runBody = z
  .object({
    periodId: uuidId.optional(),
    asOf: isoDate().optional(),
    scheduleIds: z.array(uuidId).max(500).optional(),
  })
  .refine(
    (body) =>
      (body.periodId !== undefined && body.asOf === undefined) ||
      (body.periodId === undefined && body.asOf !== undefined),
    {
      message: "name exactly one of periodId or asOf",
    },
  );

/**
 * Amortize through a period end or an as-of date: every due planned period
 * of the active schedules the caller's role reaches posts once through the
 * journal kernel. Closed periods and inactive books are reported per
 * schedule with their remedy rather than failing the run.
 */
export const POST = defineRoute({
  permission: "amortization.manage",
  feature: "expenseAmortization",
  body: runBody,
  invalidBodyStatus: 422,
  handler: async ({ authz, body }) => {
    const result = await runExpenseAmortization({
      orgId: authz.user.orgId,
      actorId: authz.user.id,
      periodId: body.periodId ?? null,
      asOf: body.asOf ?? null,
      scheduleIds: body.scheduleIds,
    });
    return NextResponse.json(result);
  },
});
