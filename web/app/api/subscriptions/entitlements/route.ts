import { z } from 'zod';
import { defineRoute } from '@/lib/api/route';
import { apiErrorResponse } from '@/lib/api/error-response'
import { NextResponse } from "next/server";
import {
  EntitlementError,
  expireSubscriptionOverride,
  getEntitlementSnapshot,
  listPlanVersionEntitlements,
  listSaasFeatures,
  savePlanVersionEntitlements,
  saveSubscriptionOverride,
} from "@openbooks/engine/src/billing/entitlements.ts";
import { guardUnrestrictedScope } from "../../../../lib/authz";

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const entitlementRowSchema = z.object({
  featureKey: z.string().min(1),
  enabled: z.boolean().nullable().optional(),
  limit: z.unknown().nullable().optional(),
  customValue: z.string().nullable().optional(),
  overagePolicy: z.enum(['block', 'allow_and_bill', 'alert']).nullable().optional(),
  meterKey: z.string().nullable().optional(),
});
const POSTBodySchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('saveVersionEntitlements'),
    planVersionId: z.string().uuid(),
    effectiveFrom: DATE.nullable().optional(),
    rows: z.array(entitlementRowSchema).min(1),
  }),
  z.object({
    action: z.literal('saveOverride'),
    subscriptionId: z.string().uuid(),
    featureKey: z.string().min(1),
    enabled: z.boolean().nullable().optional(),
    limit: z.unknown().nullable().optional(),
    customValue: z.string().nullable().optional(),
    overagePolicy: z.enum(['block', 'allow_and_bill', 'alert']).nullable().optional(),
    reason: z.string().min(1),
    effectiveFrom: DATE.nullable().optional(),
    effectiveTo: DATE.nullable().optional(),
  }),
  z.object({
    action: z.literal('expireOverride'),
    subscriptionId: z.string().uuid(),
    featureKey: z.string().min(1),
    effectiveTo: DATE.nullable().optional(),
  }),
]);

export const runtime = "nodejs";

export const GET = defineRoute({
  permission: 'ar.read',
  feature: 'advancedSubscriptions',
  handler: async ({ authz, request }) => {
    const url = new URL(request.url);
    const subscriptionId = url.searchParams.get('subscriptionId');
    const planVersionId = url.searchParams.get('planVersionId');
    const features = url.searchParams.get('features');
    const at = url.searchParams.get('at');
    const provided = [subscriptionId, planVersionId, features].filter((value) => value !== null);
    if (provided.length !== 1) {
      return NextResponse.json(
        { error: "Supply exactly one of subscriptionId, planVersionId or features=1" },
        { status: 400 },
      );
    }
    try {
      if (features !== null) {
        return NextResponse.json({ ok: true, features: await listSaasFeatures(authz.user.orgId) });
      }
      if (planVersionId !== null) {
        const entitlements = await listPlanVersionEntitlements(
          authz.user.orgId,
          planVersionId,
          at ?? undefined,
        );
        return NextResponse.json({ ok: true, entitlements });
      }
      const snapshot = await getEntitlementSnapshot(
        authz.user.orgId,
        subscriptionId as string,
        at ?? undefined,
      );
      return NextResponse.json({ ok: true, snapshot });
    } catch (error) {
      if (error instanceof EntitlementError) return apiErrorResponse(error);
      throw error;
    }
  },
});

export const POST = defineRoute({
  permission: 'ar.create',
  feature: 'advancedSubscriptions',
  body: POSTBodySchema,
  opaque: {
    limit: "limits are parsed to exact decimals in the handler with a named 422",
  },
  handler: async ({ authz: routeAuthz, body: routeBody }) => {
    const authz = routeAuthz;
    const body = routeBody;
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
  },
});
