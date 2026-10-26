import { z } from "zod";
import { NextResponse } from "next/server";
import { defineRoute } from "@/lib/api/route";
import { apiErrorResponse } from "@/lib/api/error-response";
import { acceptAssetProposals } from "@openbooks/engine/assets/asset-proposals";
import { calendarDate, id, idempotencyKey, money, optionalText, scopeOf } from "../../_depth";

export const runtime = "nodejs";

const target = z.strictObject({
  name: z.string().trim().min(1, "each asset needs a name").max(200),
  categoryId: id,
  amount: money("amount"),
  quantity: z
    .string()
    .regex(/^\d+(\.\d{1,8})?$/, "quantity must be a positive decimal")
    .nullable()
    .optional(),
  description: optionalText(4000),
  serialNumber: optionalText(200),
  inServiceOn: calendarDate("inServiceOn").nullable().optional(),
  placeInService: z.boolean().optional(),
});

const body = z.strictObject({
  idempotencyKey,
  operation: z.enum(["asset", "split", "merge", "component", "cip"]),
  proposalIds: z.array(id).min(1, "select at least one proposal").max(200),
  acceptedOn: calendarDate("acceptedOn"),
  reason: optionalText(2000),
  targets: z.array(target).max(500).default([]),
  parentAssetId: id.nullable().optional(),
  cipAssetId: id.nullable().optional(),
});

/**
 * Accept pending proposals as one asset, a split into several, a merge into
 * one, a component of an existing asset, or construction in progress. The
 * reclassification posts once under the request's idempotency key; replaying
 * the same request returns the original acceptance.
 */
export const POST = defineRoute({
  permission: "assets.capitalize",
  feature: "assetProposals",
  body,
  invalidBodyStatus: 422,
  handler: async ({ authz: gate, body: input }) => {
    try {
      const result = await acceptAssetProposals(
        gate.user.orgId,
        {
          idempotencyKey: input.idempotencyKey,
          operation: input.operation,
          proposalIds: input.proposalIds,
          acceptedOn: input.acceptedOn,
          reason: input.reason ?? null,
          targets: input.targets.map((entry) => ({ ...entry, quantity: entry.quantity ?? null })),
          parentAssetId: input.parentAssetId ?? null,
          cipAssetId: input.cipAssetId ?? null,
        },
        { actorId: gate.user.id, allowedSubsidiaryIds: scopeOf(gate) },
      );
      return NextResponse.json(result, { status: result.replayed ? 200 : 201 });
    } catch (error) {
      // Placing an accepted asset in service can raise the native schedule refusals.
      return apiErrorResponse(error, { safeStatus: 422 });
    }
  },
});
