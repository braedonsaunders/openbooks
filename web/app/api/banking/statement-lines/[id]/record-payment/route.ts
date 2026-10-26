import { z } from "zod";
import { NextResponse } from "next/server";
import { defineRoute } from "@/lib/api/route";
import { notFound } from "@/lib/api/responses";
import { exactMoney, uuidId } from "@/lib/api/json";
import { ScopeNotFoundError } from "@openbooks/engine/organization/scope";
import { isUuid } from "../../../../../../lib/list-params";
import { recordPaymentAndMatch } from "../../../../../../lib/banking-match-candidates";
import { paymentErrorResponse } from "../../../../payments/lib";

export const runtime = "nodejs";

const recordPaymentBody = z
  .object({
    reconciliationId: uuidId,
    openLineIds: z.array(uuidId).min(1).max(20),
    /** The open balance shown for each selected line; a change since refuses. */
    expectedOpen: z.record(z.string(), exactMoney()),
    /** Cash applied to each selected line; absent settles every line in full. */
    applied: z.record(z.string(), exactMoney()).nullable().optional(),
    /** Write off each selected document's short-paid remainder. */
    writeOff: z
      .object({
        reason: z
          .string()
          .trim()
          .min(1, "a reason is required: state why the short-paid balance is written off")
          .max(500),
        discountAccountId: uuidId.nullable().optional(),
      })
      .strict()
      .nullable()
      .optional(),
    /** The rate a foreign-currency line was converted at, with its source and reason. */
    exchangeRate: z
      .object({
        rate: z.string().trim().min(1).max(40),
        source: z.string().trim().min(1).max(120),
        reason: z.string().trim().min(1).max(500),
      })
      .strict()
      .nullable()
      .optional(),
    /** Settlement rate per selected document in another currency than the line. */
    settlementRates: z
      .record(
        z.string(),
        z.union([
          z.object({ fxRateId: uuidId }).strict(),
          z
            .object({
              rate: z.string().trim().min(1).max(40),
              source: z.string().trim().min(1).max(120),
              reason: z.string().trim().min(1).max(500),
            })
            .strict(),
        ]),
      )
      .nullable()
      .optional(),
  })
  .strict();

/**
 * "Record payment and match": records the customer receipt or vendor bill
 * payment an unmatched bank line represents through the native payment
 * services — settling the selected open documents in full or in part,
 * keeping any excess on account, optionally writing off a short-paid
 * remainder, measuring a foreign-currency line at its evidenced rate, and
 * settling documents in another currency at their settlement rate —
 * and matches its bank line to the statement line in the same transaction.
 * Posting the payment additionally requires ar.pay or ap.pay for the line's
 * direction; a customer-side write-off also requires ar.create and ar.post.
 */
export const POST = defineRoute({
  permission: "banking.reconcile",
  feature: "banking",
  body: recordPaymentBody,
  handler: async ({ authz, params, body }) => {
    const { id } = params as { id: string };
    if (!isUuid(id)) return notFound("record");
    try {
      const result = await recordPaymentAndMatch(
        authz.user.orgId,
        authz.user.id,
        {
          statementLineId: id,
          reconciliationId: body.reconciliationId,
          openLineIds: body.openLineIds,
          expectedOpen: body.expectedOpen,
          applied: body.applied ?? null,
          writeOff: body.writeOff ?? null,
          exchangeRate: body.exchangeRate ?? null,
          settlementRates: body.settlementRates ?? null,
        },
        authz.allowedSubsidiaryIds,
      );
      return NextResponse.json({ ok: true, ...result });
    } catch (error) {
      if (error instanceof ScopeNotFoundError) return notFound("record");
      return paymentErrorResponse(error);
    }
  },
});
