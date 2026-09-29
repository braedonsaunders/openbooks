import { z } from 'zod';
import { defineRoute } from '@/lib/api/route';
import { apiErrorResponse } from '@/lib/api/error-response'
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
import { UnrestrictedScopeError } from "@openbooks/engine/src/organization/subsidiary-scope.ts";
import { guardUnrestrictedScope } from "../../../../lib/authz";
import { canonicalDecimal } from "../../../../lib/exact-decimal";
import { moneyRefusal } from "../../../../lib/payroll-decimal-refusal";
import { isFeatureEnabled } from "../../../../lib/features";
import { notFound } from "@/lib/api/responses";
// Component items reach the handler with only transport shape enforced:
// an omitted price, a mistyped quantity, or a non-boolean flag is refused
// there with an indexed 422 naming the component, which a boundary schema
// cannot do. Everything the handler does not name stays refused here, so no
// previously rejected shape passes further than before: objects still need
// their key and name, reference ids still need UUID shape, and primitives
// only travel as far as the indexed object-shape refusal.
const planComponentSchema = z.union([
  z.object({
    componentKey: z.string().min(1),
    name: z.string().min(1),
    description: z.string().nullable().optional(),
    quantity: z.unknown().optional(),
    unitPrice: z.unknown().optional(),
    incomeAccountId: z.string().uuid().nullable().optional(),
    itemId: z.string().uuid().nullable().optional(),
    taxCodeId: z.string().uuid().nullable().optional(),
    isOptional: z.unknown().optional(),
  }),
  z.null(),
  z.number(),
  z.string(),
  z.boolean(),
  z.array(z.unknown()),
]);
const periodCountSchema = z.union([z.number().int().positive(), z.string().regex(/^[1-9]\d*$/)]).nullable().optional();
const POSTBodySchema1 = z.discriminatedUnion('action', [
  z.object({ action: z.literal('createVersion'), planId: z.string().uuid(), effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), components: z.array(planComponentSchema).optional(), currency: z.string().nullable().optional(), interval: z.enum(['weekly', 'monthly', 'quarterly', 'annually']).optional(), intervalCount: z.union([z.number().int().positive(), z.string().regex(/^[1-9]\d*$/)]).optional(), billingTiming: z.enum(['advance', 'arrears']).optional(), changeSummary: z.string().nullable().optional(), name: z.string().nullable().optional(), description: z.string().nullable().optional() }),
  z.object({ action: z.literal('publishVersion'), versionId: z.string().uuid() }),
  z.object({ action: z.literal('activateLifecycle'), subscriptionId: z.string().uuid(), planVersionId: z.string().uuid(), termStartsOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), termEndsOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(), trialEndsOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(), renewalPolicy: z.enum(['auto', 'manual', 'none']).optional(), renewalTermMonths: periodCountSchema, billFromUnbilledBoundary: z.boolean().nullable().optional() }),
  z.object({ action: z.literal('amend'), subscriptionId: z.string().uuid(), type: z.enum(['add_component', 'remove_component', 'change_component', 'change_term', 'change_timing', 'renew', 'coterm']), effectiveOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), idempotencyKey: z.string().uuid(), quantity: z.string().nullable().optional(), unitPrice: z.string().nullable().optional(), renewalTermMonths: periodCountSchema, reason: z.string().nullable().optional(), componentKey: z.unknown(), name: z.string().nullable().optional(), description: z.string().nullable().optional(), incomeAccountId: z.string().uuid().nullable().optional(), itemId: z.string().uuid().nullable().optional(), taxCodeId: z.string().uuid().nullable().optional(), termEndsOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(), billingTiming: z.enum(['advance', 'arrears']).nullable().optional(), anchorSubscriptionId: z.string().uuid().nullable().optional() }),
]);



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

function invalidDecimal(label: string, raw: unknown, noun = "an amount") {
  return NextResponse.json({ error: moneyRefusal(label, raw, noun) }, { status: 422 });
}

export const GET = defineRoute({
  permission: 'ar.read',
  feature: 'advancedSubscriptions',
  handler: async ({ authz }) => {
    return NextResponse.json(await advancedSubscriptionWorkspace(authz.user.orgId, authz.allowedSubsidiaryIds));
  },
});

export const POST = defineRoute({
  permission: 'ar.create',
  feature: 'advancedSubscriptions',
  body: POSTBodySchema1,
  opaque: {
    componentKey: "amendment keys are matched by name in the handler with an indexed 422",
    quantity: "quantities are parsed to exact decimals in the handler with an indexed 422",
    unitPrice: "an omitted price is refused in the handler with an indexed 422 naming the component",
    isOptional: "flags are type-checked in the handler with an indexed 422 naming the component",
  },
  handler: async ({ request: _req, authz: routeAuthz, body: routeBody }) => {
    const authz = routeAuthz;

    const body = routeBody;
    try {
        switch (body.action) {
          case "createVersion": {
            // Plan versions price every subsidiary's future invoices, so the
            // catalog write needs unrestricted subsidiary scope — same gate as
            // the other org-wide config writes (driver values, payment
            // providers, cashflow categories).
            const versionScopeDenied = guardUnrestrictedScope(authz);
            if (versionScopeDenied) return versionScopeDenied;
            // Plan-version currency is Multi-currency configuration. Turning that
            // switch off must refuse a new write; omitting the field copies the
            // plan's stored code so turning the feature back on restores it.
            if (body.currency !== undefined && !(await isFeatureEnabled(authz.user.orgId, "multiCurrency"))) {
              return notFound("record");
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
                if (component.isOptional !== undefined && component.isOptional !== null && typeof component.isOptional !== "boolean") {
                  return NextResponse.json({ error: `components[${index}].isOptional must be a boolean` }, { status: 422 });
                }
                // Quantity defaults to one per the documented catalog contract;
                // a unit price is never defaulted: a missing price once became a
                // silent free component, so it is required and must be canonical
                // (an explicit "0" stays a valid free component).
                const quantity = exactMoney(component.quantity ?? "1");
                if (component.unitPrice === undefined || component.unitPrice === null || component.unitPrice === "") {
                  return NextResponse.json({ error: `components[${index}] unit price is required — send an explicit "0" for a free component` }, { status: 422 });
                }
                const unitPrice = exactMoney(component.unitPrice);
                if (quantity === null) return invalidDecimal("quantity", component.quantity ?? "1", "a quantity");
                if (unitPrice === null) return NextResponse.json({ error: moneyRefusal(`components[${index}] unit price`, component.unitPrice) }, { status: 422 });
                components.push({
                  componentKey: String(component.componentKey ?? ""),
                  name: String(component.name ?? ""),
                  description: component.description == null ? null : String(component.description),
                  quantity,
                  unitPrice,
                  incomeAccountId: (component.incomeAccountId as string) || null,
                  itemId: (component.itemId as string) || null,
                  taxCodeId: (component.taxCodeId as string) || null,
                  isOptional: component.isOptional === true,
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
            }, authz.allowedSubsidiaryIds);
            return NextResponse.json({ id }, { status: 201 });
          }
          case "publishVersion": {
            // Publishing activates the version for every subsidiary at once —
            // same unrestricted-scope gate as creation.
            const publishScopeDenied = guardUnrestrictedScope(authz);
            if (publishScopeDenied) return publishScopeDenied;
            if (!body.versionId) return NextResponse.json({ error: "version required" }, { status: 400 });
            await publishPlanVersion(authz.user.orgId, authz.user.id, String(body.versionId), authz.allowedSubsidiaryIds);
            return NextResponse.json({ ok: true });
          }
          case "activateLifecycle":
            if (!body.subscriptionId || !body.planVersionId || !body.termStartsOn) {
              return NextResponse.json({ error: "subscription, version and term start are required" }, { status: 400 });
            }
            if (body.billFromUnbilledBoundary !== undefined && body.billFromUnbilledBoundary !== null && typeof body.billFromUnbilledBoundary !== "boolean") {
              return NextResponse.json({ error: "billFromUnbilledBoundary must be a boolean" }, { status: 400 });
            }
            await activateLifecycle(authz.user.orgId, authz.user.id, {
              subscriptionId: String(body.subscriptionId),
              planVersionId: String(body.planVersionId),
              termStartsOn: String(body.termStartsOn),
              termEndsOn: typeof body.termEndsOn === "string" || body.termEndsOn == null ? body.termEndsOn || null : String(body.termEndsOn),
              trialEndsOn: typeof body.trialEndsOn === "string" || body.trialEndsOn == null ? body.trialEndsOn || null : String(body.trialEndsOn),
              renewalPolicy: (body.renewalPolicy ?? "auto") as RenewalPolicy,
              renewalTermMonths: body.renewalTermMonths == null || body.renewalTermMonths === "" ? null : subscriptionPeriodCount(body.renewalTermMonths, "renewal term"),
              billFromUnbilledBoundary: body.billFromUnbilledBoundary == null ? undefined : body.billFromUnbilledBoundary === true,
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
              if (quantity === null) return invalidDecimal("quantity", body.quantity, "a quantity");
              amendment.quantity = quantity;
            }
            if (body.unitPrice != null && body.unitPrice !== "") {
              const unitPrice = exactMoney(body.unitPrice);
              if (unitPrice === null) return invalidDecimal("unit price", body.unitPrice);
              amendment.unitPrice = unitPrice;
            }
            const result = await applyAmendment(authz.user.orgId, authz.user.id, amendment, { allowedSubsidiaryIds: authz.allowedSubsidiaryIds });
            return NextResponse.json(result, { status: result.replayed ? 200 : 201 });
          }
          default:
            return NextResponse.json({ error: "unknown action" }, { status: 400 });
        }
      } catch (error) {
        if (error instanceof AdvancedSubscriptionError) return apiErrorResponse(error);
        // Defence in depth: the engine asserts unrestricted scope itself, so a
        // restricted caller reaching past the route gate still gets the named
        // 403 instead of an anonymous 500.
        if (error instanceof UnrestrictedScopeError) return apiErrorResponse(error);
        throw error;
      }
  },
});
