import { NextResponse } from "next/server";
import { z } from "zod";
import { proposeRevenueModification } from "@openbooks/engine/src/revenue/contract-modifications.ts";
import { isIsoCalendarDate } from "@openbooks/engine/src/platform/business-date.ts";
import { guardPermission } from "@/lib/authz";
import { exactMoney, parseJsonBody } from "@/lib/api/json";
import { isUuid } from "@/lib/list-params";
export const runtime = "nodejs";
const date = z.string().refine(isIsoCalendarDate, "enter a calendar date");
export const revenueModificationSchema = z.object({
  effectiveOn: date,
  reason: z.string().trim().min(8).max(1000),
  idempotencyKey: z.string().min(1).max(120),
  subsidiaryId: z.uuid(),
  enforceableRightsEvidence: z.string().trim().min(8).max(4000),
  assessment: z.string().trim().min(8).max(4000),
  bookRates: z
    .array(z.object({ bookId: z.uuid(), fxRate: z.string().max(40) }))
    .min(1)
    .max(100),
  groups: z
    .array(
      z.object({
        treatment: z.enum(["separate", "prospective", "catch_up"]),
        existingObligationIds: z.array(z.uuid()).max(500),
        considerationChange: exactMoney(),
        remainingDistinct: z.boolean(),
        additionsAtStandalonePrice: z.boolean(),
        promises: z
          .array(
            z.object({
              existingId: z.uuid().optional(),
              description: z.string().trim().min(1).max(1000),
              standaloneSellingPrice: exactMoney(),
              recognitionRuleId: z.uuid(),
              recognitionEndsOn: date.nullable().optional(),
              percentComplete: exactMoney(),
              deferredAccountId: z.uuid(),
              recognizedAccountId: z.uuid(),
              events: z
                .array(
                  z.object({
                    periodMonth: date,
                    amount: exactMoney(),
                    description: z.string().max(1000),
                  }),
                )
                .max(1200)
                .optional(),
            }),
          )
          .min(1)
          .max(500),
      }),
    )
    .min(1)
    .max(100),
});
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const gate = await guardPermission("ar.post");
  if (gate instanceof NextResponse) return gate;
  const { id } = await params;
  if (!isUuid(id))
    return NextResponse.json({ error: "invalid contract" }, { status: 422 });
  const body = await parseJsonBody(req, revenueModificationSchema, {
    status: 422,
  });
  if (!body.ok) return body.response;
  try {
    return NextResponse.json(
      await proposeRevenueModification(
        gate.user.orgId,
        id,
        gate.user.id,
        body.data,
      ),
    );
  } catch (e) {
    return NextResponse.json(
      {
        error: e instanceof Error ? e.message : "contract modification failed",
      },
      { status: 422 },
    );
  }
}
