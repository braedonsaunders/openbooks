import { apiErrorResponse } from '@/lib/api/error-response'
import { NextResponse } from "next/server";
import { z } from "zod";
import { proposeRevenueModification } from "@openbooks/engine/src/revenue/contract-modifications.ts";
import { isIsoCalendarDate } from "@openbooks/engine/src/platform/business-date.ts";
import { defineRoute } from "@/lib/api/route";
import { parseJsonBody } from "@/lib/api/json";
import { isUuid } from "@/lib/list-params";
import { canonicalDecimal } from "@/lib/exact-decimal";
import { moneyRefusal } from "@/lib/payroll-decimal-refusal";
import { normalizeMoney } from "@openbooks/engine/src/money/money.ts";

function monetaryInput(field: string) {
  return z.string({ error: `${field} must be a decimal string` }).transform((raw, ctx) => {
    const exact = canonicalDecimal(raw, 4);
    if (exact === null) {
      ctx.addIssue({ code: "custom", message: moneyRefusal(field, raw, "an amount", 4) });
      return z.NEVER;
    }
    try {
      return normalizeMoney(exact);
    } catch {
      ctx.addIssue({ code: "custom", message: moneyRefusal(field, raw, "an amount", 4) });
      return z.NEVER;
    }
  });
}

function rateInput(field: string) {
  return z.string({ error: `${field} must be a decimal string` }).max(40).transform((raw, ctx) => {
    const exact = canonicalDecimal(raw, 10);
    if (exact === null) {
      ctx.addIssue({ code: "custom", message: moneyRefusal(field, raw, "a rate", 10) });
      return z.NEVER;
    }
    return exact;
  });
}

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
    .array(z.object({ bookId: z.uuid(), fxRate: rateInput("FX rate") }))
    .min(1)
    .max(100),
  groups: z
    .array(
      z.object({
        treatment: z.enum(["separate", "prospective", "catch_up"]),
        existingObligationIds: z.array(z.uuid()).max(500),
        considerationChange: monetaryInput("Consideration change"),
        remainingDistinct: z.boolean(),
        additionsAtStandalonePrice: z.boolean(),
        promises: z
          .array(
            z.object({
              existingId: z.uuid().optional(),
              description: z.string().trim().min(1).max(1000),
              standaloneSellingPrice: monetaryInput("Standalone selling price"),
              recognitionRuleId: z.uuid(),
              recognitionEndsOn: date.nullable().optional(),
              percentComplete: monetaryInput("Progress"),
              deferredAccountId: z.uuid(),
              recognizedAccountId: z.uuid(),
              events: z
                .array(
                  z.object({
                    periodMonth: date,
                      amount: monetaryInput("Recognition event amount"),
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
export const POST = defineRoute({
  permission: "ar.post",
  feature: "revenueRecognition",
  params: z.object({ id: z.string() }),
  handler: async ({ request: req, authz: gate, params }) => {
  const { id } = params;
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
    return apiErrorResponse(e);
  }
  },
});
