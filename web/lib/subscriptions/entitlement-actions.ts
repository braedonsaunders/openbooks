import "server-only";
import { z } from "zod";
import { uuidString } from "@openbooks/engine/platform/identifiers";
import { NextResponse } from "next/server";
import { apiErrorResponse } from "@/lib/api/error-response";
import {
  EntitlementError,
  expireSubscriptionOverride,
  savePlanVersionEntitlements,
  saveSubscriptionOverride,
} from "@openbooks/engine/billing";
import { guardUnrestrictedScope, type Authz } from "@/lib/authz";

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const entitlementRowSchema = z.object({
  featureKey: z.string().min(1),
  enabled: z.boolean().nullable().optional(),
  limit: z.unknown().nullable().optional(),
  customValue: z.string().nullable().optional(),
  overagePolicy: z.enum(["block", "allow_and_bill", "alert"]).nullable().optional(),
  meterKey: z.string().nullable().optional(),
});

export const POSTBodySchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("saveVersionEntitlements"),
    planVersionId: uuidString(),
    effectiveFrom: DATE.nullable().optional(),
    rows: z.array(entitlementRowSchema).min(1),
  }),
  z.object({
    action: z.literal("saveOverride"),
    subscriptionId: uuidString(),
    featureKey: z.string().min(1),
    enabled: z.boolean().nullable().optional(),
    limit: z.unknown().nullable().optional(),
    customValue: z.string().nullable().optional(),
    overagePolicy: z.enum(["block", "allow_and_bill", "alert"]).nullable().optional(),
    reason: z.string().min(1),
    effectiveFrom: DATE.nullable().optional(),
    effectiveTo: DATE.nullable().optional(),
  }),
  z.object({
    action: z.literal("expireOverride"),
    subscriptionId: uuidString(),
    featureKey: z.string().min(1),
    effectiveTo: DATE.nullable().optional(),
  }),
]);

export async function executeEntitlementAction(
  authz: Authz,
  body: z.infer<typeof POSTBodySchema>,
): Promise<NextResponse> {
  try {
    switch (body.action) {
      case "saveVersionEntitlements": {
        // Plan grants price every subscription on the plan, so the write
        // needs unrestricted subsidiary scope — the same gate as the
        // other org-wide catalog writes.
        const scopeDenied = guardUnrestrictedScope(authz);
        if (scopeDenied) return scopeDenied;
        const saved = await savePlanVersionEntitlements(authz.user.orgId, authz.user.id, {
          planVersionId: body.planVersionId,
          effectiveFrom: body.effectiveFrom ?? undefined,
          rows: body.rows.map((row) => ({
            featureKey: row.featureKey,
            enabled: row.enabled ?? undefined,
            limit: row.limit ?? undefined,
            customValue: row.customValue ?? undefined,
            overagePolicy: row.overagePolicy ?? undefined,
            meterKey: row.meterKey ?? undefined,
          })),
        });
        return NextResponse.json({ ok: true, entitlements: saved }, { status: 201 });
      }
      case "saveOverride": {
        const saved = await saveSubscriptionOverride(authz.user.orgId, authz.user.id, {
          subscriptionId: body.subscriptionId,
          allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
          featureKey: body.featureKey,
          enabled: body.enabled ?? undefined,
          limit: body.limit ?? undefined,
          customValue: body.customValue ?? undefined,
          overagePolicy: body.overagePolicy ?? undefined,
          reason: body.reason,
          effectiveFrom: body.effectiveFrom ?? undefined,
          effectiveTo: body.effectiveTo ?? undefined,
        });
        return NextResponse.json({ ok: true, override: saved }, { status: 201 });
      }
      case "expireOverride": {
        const closed = await expireSubscriptionOverride(authz.user.orgId, authz.user.id, {
          subscriptionId: body.subscriptionId,
          allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
          featureKey: body.featureKey,
          effectiveTo: body.effectiveTo ?? undefined,
        });
        return NextResponse.json({ ok: true, override: closed });
      }
      default:
        return NextResponse.json({ error: "unknown action" }, { status: 400 });
    }
  } catch (error) {
    if (error instanceof EntitlementError) return apiErrorResponse(error);
    throw error;
  }
}
