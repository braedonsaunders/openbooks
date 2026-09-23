import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import {
  AdvancedSubscriptionError,
  activateLifecycle,
  advancedSubscriptionWorkspace,
  applyAmendment,
  createPlanVersion,
  subscriptionPeriodCount,
  publishPlanVersion,
  type AmendmentRequest,
  type AmendmentType,
  type BillingTiming,
  type Interval,
  type RenewalPolicy,
} from "@openbooks/engine/src/billing/advanced-subscriptions.ts";
import { normalizeMoney } from "@openbooks/engine/src/money/money.ts";
import { guardPermission } from "../../../../lib/authz";
import { canonicalDecimal } from "../../../../lib/exact-decimal";
import { isFeatureEnabled } from "../../../../lib/features";

export const runtime = "nodejs";

/** Exact numeric(19,4) money string, or null when the request value is not canonical. */
function exactMoney(value: unknown): string | null {
  const exact = canonicalDecimal(value, 4);
  if (exact === null) return null;
  try {
    return normalizeMoney(exact);
  } catch {
    return null;
  }
}

function invalidDecimal(label: string) {
  return NextResponse.json({ error: `${label} must be an exact decimal` }, { status: 422 });
}

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
  return NextResponse.json(await advancedSubscriptionWorkspace(authz.user.orgId, authz.allowedSubsidiaryIds));
}

export async function POST(req: Request) {
  const authz = await gate("ar.create");
  if (authz instanceof NextResponse) return authz;
  const parsedBody = await parseJsonBody(req, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const body = ((parsedBody.data));
  try {
    switch (body.action) {
      case "createVersion": {
        // Plan-version currency is Multi-currency configuration. Turning that
        // switch off must refuse a new write; omitting the field copies the
        // plan's stored code so turning the feature back on restores it.
        if (body.currency !== undefined && !(await isFeatureEnabled(authz.user.orgId, "multiCurrency"))) {
          return NextResponse.json({ error: "not found" }, { status: 404 });
        }
        if (!body.planId || !body.effectiveFrom) return NextResponse.json({ error: "plan and effective date are required" }, { status: 400 });
        const components: Array<{
          componentKey: string;
          name: string;
          description: string | null;
          quantity: string;
          unitPrice: string;
          incomeAccountId: string | null;
          itemId: string | null;
          taxCodeId: string | null;
          isOptional: boolean;
        }> = [];
        if (body.components !== undefined && !Array.isArray(body.components)) {
          return NextResponse.json({ error: "components must be an array" }, { status: 422 });
        }
        if (Array.isArray(body.components)) {
          for (const [index, entry] of body.components.entries()) {
            // Property access on a null/primitive throws a TypeError the
            // handler below does not catch (HTTP 500), so the shape is
            // refused with an indexed 422 before anything is read.
            if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
              return NextResponse.json({ error: `components[${index}] must be an object` }, { status: 422 });
            }
            const component = entry as Record<string, unknown>;
            const quantity = exactMoney(component.quantity ?? "1");
            const unitPrice = exactMoney(component.unitPrice ?? "0");
            if (quantity === null) return invalidDecimal("quantity");
            if (unitPrice === null) return invalidDecimal("unit price");
            components.push({
              componentKey: String(component.componentKey ?? ""),
              name: String(component.name ?? ""),
              description: component.description == null ? null : String(component.description),
              quantity,
              unitPrice,
              incomeAccountId: (component.incomeAccountId as string) || null,
              itemId: (component.itemId as string) || null,
              taxCodeId: (component.taxCodeId as string) || null,
              isOptional: Boolean(component.isOptional),
            });
          }
        }
        const id = await createPlanVersion(authz.user.orgId, authz.user.id, {
          planId: String(body.planId),
          effectiveFrom: String(body.effectiveFrom),
          name: body.name == null ? undefined : String(body.name),
          description: body.description == null ? null : String(body.description),
          currency: body.currency === undefined ? undefined : body.currency == null ? null : String(body.currency),
          interval: body.interval as Interval | undefined,
          intervalCount: body.intervalCount == null ? undefined : subscriptionPeriodCount(body.intervalCount),
          billingTiming: body.billingTiming as BillingTiming | undefined,
          changeSummary: body.changeSummary == null ? null : String(body.changeSummary),
          components,
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
          termEndsOn: typeof body.termEndsOn === "string" || body.termEndsOn == null ? body.termEndsOn || null : String(body.termEndsOn),
          trialEndsOn: typeof body.trialEndsOn === "string" || body.trialEndsOn == null ? body.trialEndsOn || null : String(body.trialEndsOn),
          renewalPolicy: (body.renewalPolicy ?? "auto") as RenewalPolicy,
          renewalTermMonths: body.renewalTermMonths == null || body.renewalTermMonths === "" ? null : subscriptionPeriodCount(body.renewalTermMonths, "renewal term"),
          billFromUnbilledBoundary: body.billFromUnbilledBoundary == null ? undefined : Boolean(body.billFromUnbilledBoundary),
        }, authz.allowedSubsidiaryIds);
        return NextResponse.json({ ok: true });
      case "amend": {
        if (!body.subscriptionId || !body.type || !body.effectiveOn || !body.idempotencyKey) {
          return NextResponse.json({ error: "subscription, amendment type, effective date and idempotency key are required" }, { status: 400 });
        }
        if (typeof body.subscriptionId !== "string" || typeof body.type !== "string" ||
          typeof body.effectiveOn !== "string" || typeof body.idempotencyKey !== "string") {
          return NextResponse.json({ error: "subscription, amendment type, effective date and idempotency key must be strings" }, { status: 400 });
        }
        // The amendment is built field by field from an allowlist — never by
        // spreading the request body — so unknown or mistyped input cannot
        // reach the engine or the persisted request snapshot. Value rules
        // stay in applyAmendment; the route only enforces transport shape.
        const amendmentText = (name: string): string | null | undefined | NextResponse => {
          const value = (body as Record<string, unknown>)[name];
          if (value === undefined || value === null) return value;
          if (typeof value !== "string") return NextResponse.json({ error: `amendment field ${name} must be a string` }, { status: 422 });
          return value;
        };
        const text: Record<string, string | null | undefined> = {};
        for (const name of ["reason", "componentKey", "name", "description", "incomeAccountId", "itemId", "taxCodeId", "termEndsOn", "billingTiming", "anchorSubscriptionId"] as const) {
          const value = amendmentText(name);
          if (value instanceof NextResponse) return value;
          text[name] = value;
        }
        const renewalTermMonthsRaw = (body as Record<string, unknown>).renewalTermMonths;
        if (renewalTermMonthsRaw !== undefined && renewalTermMonthsRaw !== null &&
          typeof renewalTermMonthsRaw !== "number" && typeof renewalTermMonthsRaw !== "string") {
          return NextResponse.json({ error: "amendment field renewalTermMonths must be a number" }, { status: 422 });
        }
        const amendment: AmendmentRequest = {
          subscriptionId: body.subscriptionId,
          type: body.type as AmendmentType,
          effectiveOn: body.effectiveOn,
          idempotencyKey: body.idempotencyKey,
          reason: text.reason,
          componentKey: text.componentKey ?? undefined,
          name: text.name ?? undefined,
          description: text.description,
          incomeAccountId: text.incomeAccountId,
          itemId: text.itemId,
          taxCodeId: text.taxCodeId,
          termEndsOn: text.termEndsOn,
          billingTiming: (text.billingTiming ?? undefined) as BillingTiming | undefined,
          renewalTermMonths: (renewalTermMonthsRaw ?? undefined) as number | undefined,
          anchorSubscriptionId: text.anchorSubscriptionId ?? undefined,
        };
        if (body.quantity != null && body.quantity !== "") {
          const quantity = exactMoney(body.quantity);
          if (quantity === null) return invalidDecimal("quantity");
          amendment.quantity = quantity;
        }
        if (body.unitPrice != null && body.unitPrice !== "") {
          const unitPrice = exactMoney(body.unitPrice);
          if (unitPrice === null) return invalidDecimal("unit price");
          amendment.unitPrice = unitPrice;
        }
        const result = await applyAmendment(authz.user.orgId, authz.user.id, amendment, { allowedSubsidiaryIds: authz.allowedSubsidiaryIds });
        return NextResponse.json(result, { status: result.replayed ? 200 : 201 });
      }
      default:
        return NextResponse.json({ error: "unknown action" }, { status: 400 });
    }
  } catch (error) {
    if (error instanceof AdvancedSubscriptionError) return NextResponse.json({ error: error.message }, { status: error.status });
    throw error;
  }
}
