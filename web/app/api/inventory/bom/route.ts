import { NextResponse } from "next/server";
import { db, withOrgTransaction } from "@openbooks/engine/platform/db";
import { BomPolicyError, saveBomPolicy } from "@openbooks/engine/inventory/bom-policy";
import { loadBomWorkspace } from "@openbooks/engine/inventory/bom-workspace";
import { businessToday } from "@openbooks/engine/platform/business-date/module";
import { apiErrorResponse } from "@/lib/api/error-response";
import { can } from "@/lib/authz";
import { defineRoute } from "@/lib/api/route";
import { exactMoney, isoDate, uuidId } from "@/lib/api/json";
import { isFeatureEnabled } from "@/lib/features";
import { isUuid } from "@/lib/list-params";
import { z } from "zod";

const optionalDate = z.union([isoDate(), z.literal(""), z.null()]).optional();
const optionalDecimal = z.union([exactMoney(), z.literal(""), z.null()]).optional();
const bomBody = z.object({
  assemblyItemId: uuidId,
  expectedVersion: z.string().nullable(),
  reason: z.string(),
  subsidiaryId: uuidId.optional(),
  components: z.array(
    z.object({
      componentItemId: uuidId,
      quantityPer: exactMoney(),
      quantityBasis: z.enum(["per_unit", "per_batch", "per_formula"]).optional(),
      formulaOutputQuantity: exactMoney().optional(),
      effectiveFrom: optionalDate,
      effectiveTo: optionalDate,
      operationSeq: z.union([z.number(), z.string(), z.null()]).optional(),
      scrapPct: optionalDecimal,
      outputCostWeight: optionalDecimal,
      isByproduct: z.union([z.boolean(), z.enum(["true", "false"]), z.null()]).optional(),
    }),
  ),
});
function refusal(error: string, status = 422) {
  return NextResponse.json({ error }, { status });
}

/** The native command owns validation, fresh authority, effectivity and approval. */
export const PUT = defineRoute({
  permission: "admin.setup.manage",
  feature: "inventory",
  scope: "unrestricted",
  body: bomBody,
  handler: async ({ body, request, authz: gate }) => {
    try {
      const result = await withOrgTransaction(gate.user.orgId, () =>
        saveBomPolicy(db, gate.user.orgId, gate.user.id, {
          assemblyItemId: body.assemblyItemId,
          expectedVersion: body.expectedVersion,
          reason: body.reason,
          subsidiaryId: body.subsidiaryId,
          requestKey: request.headers.get("Idempotency-Key") ?? undefined,
          components: body.components.map((line) => ({
            componentItemId: line.componentItemId,
            quantityPer: line.quantityPer,
            quantityBasis: line.quantityBasis,
            formulaOutputQuantity: line.formulaOutputQuantity,
            effectiveFrom: line.effectiveFrom || null,
            effectiveTo: line.effectiveTo || null,
            operationSeq:
              line.operationSeq === undefined ||
              line.operationSeq === null ||
              line.operationSeq === ""
                ? null
                : Number(line.operationSeq),
            scrapPct: line.scrapPct || null,
            isByproduct: line.isByproduct === true || line.isByproduct === "true",
            outputCostWeight: line.outputCostWeight || null,
          })),
        }),
      );
      return NextResponse.json(result);
    } catch (error) {
      // The editor highlights the offending component from the refusal, so
      // the overlap answers with its structured evidence at the top level —
      // the same body the pre-consolidation route returned. The evidence is
      // the operator's own component and date windows, curated at the
      // policy origin — never driver text.
      if (error instanceof BomPolicyError) {
        if (error.code === "bom_effectivity_overlap" && error.details) {
          const componentItemId = (error.details as { componentItemId?: unknown }).componentItemId;
          const windows = (error.details as { windows?: unknown }).windows;
          if (typeof componentItemId === "string" && Array.isArray(windows))
            return NextResponse.json(
              { error: error.message, code: error.code, componentItemId, windows },
              { status: 422 },
            );
        }
      }
      return apiErrorResponse(error, { request });
    }
  },
});

/**
 * Read one assembly's recipe for operators: the kit Components tab and the
 * bill-of-materials editor share this payload, so component lines carry
 * their catalog identity (code, name, active state) and the editor's
 * eligible choices ride along. Reading needs only the catalog grant — the
 * same grant as the kit availability endpoint beside it — because a
 * restricted operator may inspect a recipe they cannot change; replacing
 * the recipe stays an org-wide configuration write on PUT.
 */
export const GET = defineRoute({
  // Reading serves both grants: catalog readers inspect a recipe they
  // cannot change, and setup managers keep the access they already had.
  // The native helper names the primary grant on refusal.
  authorize: async () => {
    const { guardPermission } = await import("@/lib/authz");
    const catalog = await guardPermission("items.read");
    if (!(catalog instanceof NextResponse)) return catalog;
    const setup = await guardPermission("admin.setup.manage");
    if (!(setup instanceof NextResponse)) return setup;
    return catalog;
  },
  feature: "inventory",
  handler: async ({ request, authz: gate }) => {
    const assemblyItemId = new URL(request.url).searchParams.get("assemblyItemId");
    const manufacturingEnabled = await isFeatureEnabled(gate.user.orgId, "manufacturing");
    const today = await businessToday(gate.user.orgId);
    const canProposeRevision =
      gate.allowedSubsidiaryIds === null &&
      can(gate, "manufacturing.manage") &&
      can(gate, "admin.setup.manage");
    if (assemblyItemId && !isUuid(assemblyItemId)) return refusal("Choose a valid assembly item.");

    const result = await loadBomWorkspace({
      orgId: gate.user.orgId,
      assemblyItemId: assemblyItemId || null,
      manufacturingEnabled,
      canProposeRevision,
      today,
    });
    if (result.kind === "not_found")
      return NextResponse.json({ error: "not found" }, { status: 404 });
    if (result.kind === "empty") {
      return NextResponse.json({
        manufacturingEnabled: result.manufacturingEnabled,
        canProposeRevision: result.canProposeRevision,
        subsidiaries: result.subsidiaries,
        today: result.today,
      });
    }
    return NextResponse.json({
      manufacturingEnabled: result.manufacturingEnabled,
      assemblyItemId: result.assemblyItemId,
      kind: result.itemKind,
      version: result.version,
      today: result.today,
      canProposeRevision: result.canProposeRevision,
      subsidiaries: result.subsidiaries,
      routingOperations: result.routingOperations,
      components: result.components,
      validItems: result.validItems,
    });
  },
});
