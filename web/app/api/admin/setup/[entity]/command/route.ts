import { z } from "zod";
import { NextResponse } from "next/server";
import { defineRoute } from "@/lib/api/route";
import { parseJsonBody } from "@/lib/api/json";
import { notFound } from "@/lib/api/responses";
import { can, getAuthz, type Authz } from "@/lib/authz";
import { featureEnabled, resolvedFeatureState } from "@/lib/features";
import { applicationContextFromSession } from "@/lib/application/context";
import { executeIdempotent } from "@/lib/application/idempotency";
import { isUuid } from "@/lib/list-params";
import { SETUP_ENTITY_BY_KEY } from "@/lib/setup/registry";
import type { SetupCommandName } from "@/lib/setup/types";
import { setFramework } from "@openbooks/engine/src/nonprofit/frameworks.ts";
import { setFundPair } from "@openbooks/engine/src/nonprofit/funds.ts";
import { setFunctionalMapping } from "@openbooks/engine/src/nonprofit/functional.ts";
import {
  CHANNEL_ACCOUNT_ROLES,
  recordChannelAdSpend,
  upsertAccountMap,
  upsertChannelLocation,
} from "@openbooks/engine/commerce";
import { savePortalSettings } from "@openbooks/engine/portal";

export const runtime = "nodejs";

/**
 * POST /api/admin/setup/[entity]/command — the domain-command counterpart to
 * the generic CRUD route beside it. The entity comes from the URL through the
 * Setup registry, never the body: unknown entities, entities without a
 * command marker, and feature-off entities fail closed before the body is
 * read. The marker's literal name selects one of three strict schemas and
 * one direct engine call — no dynamic lookup, no table/SQL derivation, no
 * generic fallback. Identity (org, actor) comes from the session, never the
 * request. Domain refusals keep their typed status with message, code,
 * remedy, and field intact; anything else follows the standard error path.
 */

const paramsSchema = z.object({ entity: z.string() });

const frameworkBody = z.strictObject({
  framework: z.enum(["us_asc958", "ew_sorp_frs102"]),
  reason: z.string(),
});

const fundPairBody = z.strictObject({
  fromFundId: z.string(),
  toFundId: z.string(),
  dueFromAccountId: z.string(),
  dueToAccountId: z.string(),
  isActive: z.boolean().optional(),
  // The boundary requires the reason so a blank reason never reaches the
  // domain; the fund-pair domain stores it with its reason implementation.
  reason: z.string().trim().min(1),
});

const functionalMappingBody = z.strictObject({
  departmentId: z.string().nullish(),
  projectId: z.string().nullish(),
  functionKey: z.enum(["program", "management_general", "fundraising"]),
  programKey: z.string().nullish(),
  effectiveFrom: z.string(),
  effectiveTo: z.string().nullish(),
  reason: z.string(),
});

const channelAccountMapBody = z.strictObject({
  channelId: z.string().uuid(),
  role: z.enum(CHANNEL_ACCOUNT_ROLES),
  key: z.string().max(120).nullish(),
  accountId: z.string().uuid(),
  effectiveFrom: z.string(),
});

const channelLocationBody = z.strictObject({
  channelId: z.string().uuid(),
  externalLocationId: z.string().min(1).max(120),
  externalName: z.string().min(1).max(200),
  stockLocationId: z.string().uuid().nullish(),
  syncInventory: z.boolean().nullish(),
  fulfilsOrders: z.boolean().nullish(),
  bufferQuantity: z.string().trim().min(1).max(30).nullish(),
  stopSellingAtZero: z.boolean().nullish(),
});

const portalSettingsBody = z.strictObject({
  portalName: z.string().min(1).max(80).optional(),
  effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  sectionsInvoices: z.boolean().optional(),
  sectionsPaymentMethods: z.boolean().optional(),
  sectionsSubscriptions: z.boolean().optional(),
  sectionsUsage: z.boolean().optional(),
  sectionsOrders: z.boolean().optional(),
  sectionsReturns: z.boolean().optional(),
  sectionsGiftCards: z.boolean().optional(),
  returnWindowDays: z.number().int().min(0).max(365).optional(),
  returnReasons: z.array(z.string().min(1).max(40)).min(1).max(20).optional(),
  resolutionRefund: z.boolean().optional(),
  resolutionExchange: z.boolean().optional(),
  resolutionStoreCredit: z.boolean().optional(),
  storeCreditBonusPercent: z.union([z.string(), z.number()]).optional(),
  saveOffers: z.array(z.strictObject({
    id: z.string().max(80).optional(),
    label: z.string().min(1).max(120),
    kind: z.enum(["pause", "discount"]),
    promotionCode: z.string().max(32).optional(),
    note: z.string().max(200).optional(),
  })).max(10).optional(),
});

// The drawer also POSTs the row id on edits; the spend upserts by its
// natural key (channel, day, source), so the id is accepted and ignored.
const channelAdSpendBody = z.strictObject({
  id: z.string().uuid().nullish(),
  channelId: z.string().uuid(),
  spendDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  amountMinor: z.number().int().min(0),
  currency: z.string().trim().min(3).max(3),
  source: z.string().trim().max(120).nullish(),
});

/** Domain refusals keep typed status with message, code, remedy, and field. */
export function commandRefusalResponse(error: unknown): { status: number; body: Record<string, unknown> } | null {
  if (!(error instanceof Error)) return null;
  const source = error as Error & { status?: unknown; code?: unknown; remedy?: unknown; field?: unknown };
  if (typeof source.status !== "number" || !Number.isInteger(source.status) || source.status < 400 || source.status > 499) {
    return null;
  }
  return {
    status: source.status,
    body: {
      error: error.message,
      ...(typeof source.code === "string" ? { code: source.code } : {}),
      ...(typeof source.remedy === "string" ? { remedy: source.remedy } : {}),
      ...(typeof source.field === "string" ? { field: source.field } : {}),
    },
  };
}

/** Shape failures map through the same typed refusal path as domain refusals. */
function invalidCommandBody(): Error {
  return Object.assign(new Error("invalid command body"), { status: 400, code: "invalid" });
}

/** Parse with the descriptor's literal schema and run the matching engine command. */
async function runCommandBody(
  authz: Authz,
  command: { name: SetupCommandName },
  raw: Record<string, unknown>,
): Promise<unknown> {
  const orgId = authz.user.orgId;
  const actorId = authz.user.id;
  switch (command.name) {
    case "setFramework": {
      const parsed = frameworkBody.safeParse(raw);
      if (!parsed.success) throw invalidCommandBody();
      return setFramework({ orgId, actorId, framework: parsed.data.framework, reason: parsed.data.reason });
    }
    case "setFundPair": {
      const parsed = fundPairBody.safeParse(raw);
      if (!parsed.success) throw invalidCommandBody();
      // The reason travels with the call so the fund-pair domain receives it;
      // the cast carries the boundary-required field the stored input type
      // gains with its reason implementation.
      return setFundPair({ orgId, actorId, ...parsed.data } as Parameters<typeof setFundPair>[0] & { reason: string });
    }
    case "setFunctionalMapping": {
      const parsed = functionalMappingBody.safeParse(raw);
      if (!parsed.success) throw invalidCommandBody();
      return setFunctionalMapping({ orgId, actorId, ...parsed.data });
    }
    case "upsertChannelAccountMap": {
      const parsed = channelAccountMapBody.safeParse(raw);
      if (!parsed.success) throw invalidCommandBody();
      return upsertAccountMap(orgId, actorId, {
        channelId: parsed.data.channelId,
        role: parsed.data.role,
        key: parsed.data.key ?? "",
        accountId: parsed.data.accountId,
        effectiveFrom: parsed.data.effectiveFrom,
      });
    }
    case "recordChannelAdSpend": {
      const parsed = channelAdSpendBody.safeParse(raw);
      if (!parsed.success) throw invalidCommandBody();
      // Minor units travel as JSON integers; the engine prices in exact
      // bigint arithmetic and restates the day's orders beside the write.
      return recordChannelAdSpend(orgId, actorId, {
        channelId: parsed.data.channelId,
        spendDate: parsed.data.spendDate,
        amountMinor: BigInt(parsed.data.amountMinor),
        currency: parsed.data.currency.trim().toUpperCase(),
        source: parsed.data.source?.trim() ? parsed.data.source.trim() : "manual",
      });
    }
    case "upsertChannelLocation": {
      const parsed = channelLocationBody.safeParse(raw);
      if (!parsed.success) throw invalidCommandBody();
      return upsertChannelLocation(orgId, actorId, {
        channelId: parsed.data.channelId,
        externalLocationId: parsed.data.externalLocationId,
        externalName: parsed.data.externalName,
        stockLocationId: parsed.data.stockLocationId ?? null,
        syncInventory: parsed.data.syncInventory ?? undefined,
        fulfilsOrders: parsed.data.fulfilsOrders ?? undefined,
        bufferQuantity: parsed.data.bufferQuantity ?? null,
        stopSellingAtZero: parsed.data.stopSellingAtZero ?? undefined,
      });
    }
    case "savePortalSettings": {
      const parsed = portalSettingsBody.safeParse(raw);
      if (!parsed.success) throw invalidCommandBody();
      const data = parsed.data;
      const sections = {
        ...(data.sectionsInvoices !== undefined ? { invoices: data.sectionsInvoices } : {}),
        ...(data.sectionsPaymentMethods !== undefined ? { paymentMethods: data.sectionsPaymentMethods } : {}),
        ...(data.sectionsSubscriptions !== undefined ? { subscriptions: data.sectionsSubscriptions } : {}),
        ...(data.sectionsUsage !== undefined ? { usage: data.sectionsUsage } : {}),
        ...(data.sectionsOrders !== undefined ? { orders: data.sectionsOrders } : {}),
        ...(data.sectionsReturns !== undefined ? { returns: data.sectionsReturns } : {}),
        ...(data.sectionsGiftCards !== undefined ? { giftCards: data.sectionsGiftCards } : {}),
      };
      return savePortalSettings(orgId, actorId, {
        ...(data.portalName !== undefined ? { portalName: data.portalName } : {}),
        ...(data.effectiveFrom !== undefined ? { effectiveFrom: data.effectiveFrom } : {}),
        ...(Object.keys(sections).length > 0 ? { sections } : {}),
        ...(data.returnWindowDays !== undefined ? { returnWindowDays: data.returnWindowDays } : {}),
        ...(data.returnReasons !== undefined ? { returnReasons: data.returnReasons } : {}),
        ...((data.resolutionRefund !== undefined || data.resolutionExchange !== undefined
          || data.resolutionStoreCredit !== undefined || data.storeCreditBonusPercent !== undefined)
          ? {
            returnResolutions: {
              ...(data.resolutionRefund !== undefined ? { refund: data.resolutionRefund } : {}),
              ...(data.resolutionExchange !== undefined ? { exchange: data.resolutionExchange } : {}),
              ...(data.resolutionStoreCredit !== undefined ? { storeCredit: data.resolutionStoreCredit } : {}),
              ...(data.storeCreditBonusPercent !== undefined ? { storeCreditBonusPercent: String(data.storeCreditBonusPercent) } : {}),
            },
          }
          : {}),
        ...(data.saveOffers !== undefined
          ? {
            saveOffers: data.saveOffers.map((offer, index) => ({
              id: offer.id?.trim() || `offer-${index + 1}-${offer.label.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`,
              kind: offer.kind,
              label: offer.label.trim(),
              ...(offer.promotionCode?.trim() ? { promotionCode: offer.promotionCode.trim() } : {}),
              ...(offer.note?.trim() ? { note: offer.note.trim() } : {}),
            })),
          }
          : {}),
      });
    }
  }
}

async function runCommand(
  authz: Authz,
  entityKey: string,
  command: { name: SetupCommandName },
  requestId: string,
  raw: Record<string, unknown>,
): Promise<NextResponse> {
  try {
    // The key fences the command: exact replay returns the stored response
    // and key reuse with a changed body refuses — both owned by the
    // canonical boundary, not this route. A domain refusal thrown inside
    // executes unrecorded (the claim rolls back) and maps below.
    const outcome = await executeIdempotent({
      context: applicationContextFromSession(authz, "api", requestId),
      operation: `setup.${command.name}`,
      idempotencyKey: requestId,
      request: { entity: entityKey, body: raw },
      execute: () => runCommandBody(authz, command, raw),
    });
    return NextResponse.json(outcome.value, { status: 200 });
  } catch (error) {
    const refusal = commandRefusalResponse(error);
    if (refusal) return NextResponse.json(refusal.body, { status: refusal.status });
    throw error;
  }
}

/** The 403 names the missing grant and where an admin restores it. */
function permissionRefusal(permission: string): NextResponse {
  return NextResponse.json(
    { error: `missing permission: ${permission} — ask an administrator to grant it in Admin → Users & Roles`, code: "forbidden" },
    { status: 403 },
  );
}

async function handler(request: Request, params: { entity: string }, authz: Authz): Promise<NextResponse> {
  // Entity selection is URL + registry only. Unknown, marker-less, and
  // feature-off entities are indistinguishable 404s — the same answer the
  // generic route gives a disabled entity — and all of it happens before the
  // body is read.
  const entity = SETUP_ENTITY_BY_KEY.get(params.entity);
  if (!entity?.command) return notFound("setup entity");
  if (!featureEnabled(await resolvedFeatureState(authz.user.orgId), entity.command.feature)) {
    return notFound("setup entity");
  }
  // The static gate already enforced one command grant, but the descriptor
  // names the entity's own — so it is re-asserted here from the declaration
  // itself, never a parallel map, before anything is parsed.
  if (!can(authz, entity.command.permission)) return permissionRefusal(entity.command.permission);
  // Creates are upserts keyed by the caller's idempotency key, mirroring the
  // generic route's anti-double-submit contract; row identity stays
  // engine-owned and every command runs through its domain handler.
  const requestId = request.headers.get("Idempotency-Key")?.trim() ?? "";
  if (!requestId) {
    return NextResponse.json({ error: "Idempotency-Key header is required", code: "invalid" }, { status: 400 });
  }
  if (!isUuid(requestId)) {
    return NextResponse.json({ error: "Idempotency-Key must be a UUID", code: "invalid" }, { status: 400 });
  }
  const parsed = await parseJsonBody(request, z.record(z.string(), z.json()));
  if (!parsed.ok) return parsed.response;
  return runCommand(authz, params.entity, entity.command, requestId, parsed.data as Record<string, unknown>);
}

/** Every grant a command descriptor may name. The handler re-asserts the entity's own. */
const COMMAND_PERMISSIONS = ["funds.manage", "channels.manage"] as const;

export const POST = defineRoute({
  authorize: async () => {
    // A command grant gates before params and body: the 403 names the grants
    // and where an admin restores them, so the operator never guesses.
    const authz = await getAuthz();
    if (!authz) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    // Static pre-gate: the descriptor type admits only the grants above, and
    // the handler re-asserts the entity's own before anything is parsed.
    if (!COMMAND_PERMISSIONS.some((permission) => can(authz, permission))) {
      return NextResponse.json(
        { error: `missing permission: ${COMMAND_PERMISSIONS.join(" or ")} — ask an administrator to grant it in Admin → Users & Roles`, code: "forbidden" },
        { status: 403 },
      );
    }
    return authz;
  },
  feature: { none: "This endpoint has no single route-wide feature gate; the descriptor's authoritative feature is checked per entity in the handler." },
  params: paramsSchema,
  handler: async ({ request, authz, params }) => handler(request, params as { entity: string }, authz),
});
