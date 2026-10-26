import { NextResponse } from "next/server";
import { z } from "zod";
import { recordSecurityEvent } from "@openbooks/engine/equity";
import { defineRoute } from "@/lib/api/route";
import { isoDate, uuidId } from "@/lib/api/json";
import { decimalText, idempotencyKey, wholeShares } from "../../../_schema";

export const runtime = "nodejs";

const params = z.object({ id: uuidId });

const common = {
  effectiveOn: isoDate(),
  idempotencyKey,
  reason: z.string().trim().max(2000).nullable().optional(),
};

const eventBody = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("exercise"),
    quantity: wholeShares,
    considerationAccountId: uuidId.nullable().optional(),
    ...common,
  }),
  z.object({ kind: z.literal("settle"), quantity: wholeShares, ...common }),
  z.object({ kind: z.literal("forfeit"), quantity: wholeShares, ...common }),
  z.object({ kind: z.literal("expire"), quantity: wholeShares, ...common }),
  // An award's cancellation names its units; a SAFE or note cancels whole.
  z.object({ kind: z.literal("cancel"), quantity: wholeShares.nullable().optional(), ...common }),
  z.object({
    kind: z.literal("transfer"),
    quantity: wholeShares,
    transfereePartyId: uuidId,
    ...common,
  }),
  z.object({
    kind: z.literal("convert"),
    quantity: wholeShares.nullable().optional(),
    roundId: uuidId.nullable().optional(),
    targetShareClassId: uuidId.nullable().optional(),
    ...common,
  }),
  z.object({ kind: z.literal("election_83b"), ...common }),
  z.object({
    kind: z.literal("repurchase"),
    quantity: wholeShares,
    amount: decimalText.nullable().optional(),
    fairMarketValuePerShare: decimalText.nullable().optional(),
    considerationAccountId: uuidId.nullable().optional(),
    ...common,
  }),
  z.object({
    kind: z.literal("repay"),
    amount: decimalText,
    considerationAccountId: uuidId,
    ...common,
  }),
  z.object({ kind: z.literal("void"), ...common }),
  z.object({ kind: z.literal("reverse"), reversesEventId: uuidId, ...common }),
]);

/**
 * Record share, award and convertible activity (equity.manage): exercise
 * (including early exercise of unvested options), settlement, forfeiture,
 * expiry, cancellation, transfer, conversion, a restricted holder's 83(b)
 * election, a repurchase into treasury, the repayment of a SAFE or note, a
 * void, or the reversal of one event recorded in error.
 *
 * Voids, reversals, repurchases and the repayment or cancellation of a SAFE
 * or note are governed: each is submitted to any enabled Equity action Flow.
 * It applies at once (201) when no Flow gates it, and otherwise waits for
 * the Flow's decision (202, status pending_approval) and applies when the
 * gate approves.
 */
export const POST = defineRoute({
  permission: "equity.manage",
  feature: "equity",
  params,
  invalidParamsNotFound: "record",
  body: eventBody,
  invalidBodyStatus: 422,
  handler: async ({ authz, params: { id }, body }) => {
    const result = await recordSecurityEvent({
      orgId: authz.user.orgId,
      actorId: authz.user.id,
      securityId: id,
      ...body,
    });
    return NextResponse.json(result, {
      status: result.replayed ? 200 : result.status === "pending_approval" ? 202 : 201,
    });
  },
});
