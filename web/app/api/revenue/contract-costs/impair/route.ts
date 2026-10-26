import { NextResponse } from "next/server";
import { z } from "zod";
import { recognizeContractCostImpairment } from "@openbooks/engine/revenue";
import { defineRoute } from "@/lib/api/route";
import { isoDate, uuidId } from "@/lib/api/json";
import { contractCostErrorResponse, parseCostAmountMinor } from "@/lib/contract-costs";

export const runtime = "nodejs";

const impairBody = z.object({
  assetId: z.string().refine((v) => uuidId.safeParse(v).success, "invalid asset"),
  remainingConsideration: z.string().min(1),
  costsNotYetRecognized: z.string().optional(),
  currency: z.string().min(3).max(3),
  reason: z.string().min(8).max(2000),
  assessedOn: isoDate(),
});

/**
 * Recognize impairment: writes the asset down to its recoverable amount
 * when the carrying amount exceeds it. Segregated duty — the route
 * requires the approve permission the manage routes never grant.
 */
export const POST = defineRoute({
  permission: "contract_costs.approve",
  feature: "contractCosts",
  body: impairBody,
  invalidBodyStatus: 422,
  handler: async ({ authz: gate, body }) => {
    const user = gate.user;
    try {
      const result = await recognizeContractCostImpairment({
        orgId: user.orgId,
        actorId: user.id,
        assetId: body.assetId,
        remainingConsiderationMinor: await parseCostAmountMinor(
          user.orgId,
          body.remainingConsideration,
          body.currency,
          { allowZero: true },
        ),
        costsNotYetRecognizedMinor: body.costsNotYetRecognized
          ? await parseCostAmountMinor(user.orgId, body.costsNotYetRecognized, body.currency, {
              allowZero: true,
            })
          : 0n,
        reason: body.reason,
        assessedOn: body.assessedOn,
      });
      return NextResponse.json(result, { status: 201 });
    } catch (e: unknown) {
      return contractCostErrorResponse(e, "Unable to recognize the impairment.");
    }
  },
});
