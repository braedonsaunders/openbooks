import { NextResponse } from "next/server";
import {
  AdvancedSubscriptionError,
  activateLifecycle,
  advancedSubscriptionWorkspace,
  applyAmendment,
  createPlanVersion,
  publishPlanVersion,
  type AmendmentRequest,
  type BillingTiming,
  type Interval,
  type RenewalPolicy,
} from "@openbooks/engine/src/advanced-subscriptions.ts";
import { guardPermission } from "../../../../lib/authz";
import { isFeatureEnabled } from "../../../../lib/features";

export const runtime = "nodejs";

async function gate(permission: "ar.read" | "ar.create") {
  const authz = await guardPermission(permission);
  if (authz instanceof NextResponse) return authz;
  const [base, advanced] = await Promise.all([
    isFeatureEnabled(authz.user.orgId, "subscriptionBilling"),
    isFeatureEnabled(authz.user.orgId, "advancedSubscriptions"),
  ]);
  if (!base || !advanced) return NextResponse.json({ error: "feature disabled" }, { status: 404 });
  return authz;
}

export async function GET() {
  const authz = await gate("ar.read");
  if (authz instanceof NextResponse) return authz;
  return NextResponse.json(await advancedSubscriptionWorkspace(authz.user.orgId));
}

export async function POST(req: Request) {
  const authz = await gate("ar.create");
  if (authz instanceof NextResponse) return authz;
  const body = (await req.json().catch(() => ({}))) as Record<string, any>;
  try {
    switch (body.action) {
      case "createVersion": {
        if (!body.planId || !body.effectiveFrom) return NextResponse.json({ error: "plan and effective date are required" }, { status: 400 });
        const id = await createPlanVersion(authz.user.orgId, authz.user.id, {
          planId: String(body.planId),
          effectiveFrom: String(body.effectiveFrom),
          name: body.name == null ? undefined : String(body.name),
          description: body.description == null ? null : String(body.description),
          currency: body.currency == null ? null : String(body.currency),
          interval: body.interval as Interval | undefined,
          intervalCount: body.intervalCount == null ? undefined : Number(body.intervalCount),
          billingTiming: body.billingTiming as BillingTiming | undefined,
          changeSummary: body.changeSummary == null ? null : String(body.changeSummary),
          components: Array.isArray(body.components) ? body.components.map((component: any) => ({
            componentKey: String(component.componentKey ?? ""),
            name: String(component.name ?? ""),
            description: component.description == null ? null : String(component.description),
            quantity: String(component.quantity ?? "1"),
            unitPrice: String(component.unitPrice ?? "0"),
            incomeAccountId: component.incomeAccountId || null,
            itemId: component.itemId || null,
            taxCodeId: component.taxCodeId || null,
            isOptional: Boolean(component.isOptional),
          })) : [],
        });
        return NextResponse.json({ id }, { status: 201 });
      }
      case "publishVersion":
        if (!body.versionId) return NextResponse.json({ error: "version required" }, { status: 400 });
        await publishPlanVersion(authz.user.orgId, authz.user.id, String(body.versionId));
        return NextResponse.json({ ok: true });
      case "activateLifecycle":
        if (!body.subscriptionId || !body.planVersionId || !body.termStartsOn) {
          return NextResponse.json({ error: "subscription, version and term start are required" }, { status: 400 });
        }
        await activateLifecycle(authz.user.orgId, authz.user.id, {
          subscriptionId: String(body.subscriptionId),
          planVersionId: String(body.planVersionId),
          termStartsOn: String(body.termStartsOn),
          termEndsOn: body.termEndsOn || null,
          trialEndsOn: body.trialEndsOn || null,
          renewalPolicy: (body.renewalPolicy ?? "auto") as RenewalPolicy,
          renewalTermMonths: body.renewalTermMonths == null || body.renewalTermMonths === "" ? null : Number(body.renewalTermMonths),
        });
        return NextResponse.json({ ok: true });
      case "amend": {
        if (!body.subscriptionId || !body.type || !body.effectiveOn || !body.idempotencyKey) {
          return NextResponse.json({ error: "subscription, amendment type, effective date and idempotency key are required" }, { status: 400 });
        }
        const result = await applyAmendment(authz.user.orgId, authz.user.id, body as AmendmentRequest);
        return NextResponse.json(result, { status: result.replayed ? 200 : 201 });
      }
      default:
        return NextResponse.json({ error: "unknown action" }, { status: 400 });
    }
  } catch (error) {
    if (error instanceof AdvancedSubscriptionError) return NextResponse.json({ error: error.message }, { status: 422 });
    throw error;
  }
}
