import { z } from "zod";
import { NextResponse } from "next/server";
import { defineRoute } from "@/lib/api/route";
import { notFound } from "@/lib/api/responses";
import {
  attachAssetComponent,
  createAssetComponent,
  detachAssetComponent,
  listComponentCandidates,
  loadCompoundAsset,
} from "@openbooks/engine/assets/asset-components";
import { calendarDate, id, money, optionalText, reasonText, scopeOf } from "../../_depth";

export const runtime = "nodejs";

const params = z.object({ id });

/**
 * The compound view: the parent, its components and the per-book roll-up,
 * plus the assets that could be attached (same legal entity, top level,
 * owning no components, not yet disposed).
 */
export const GET = defineRoute({
  permission: "assets.read",
  feature: "assetComponents",
  params,
  handler: async ({ authz: gate, params: routeParams }) => {
    const { id: assetId } = await routeParams;
    const scope = scopeOf(gate);
    const view = await loadCompoundAsset(gate.user.orgId, assetId, { allowedSubsidiaryIds: scope });
    if (!view) return notFound("record");
    const candidates = await listComponentCandidates(gate.user.orgId, view.parent.id);
    return NextResponse.json({ ...view, candidates });
  },
});

const body = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("attach"), componentAssetId: id, reason: optionalText(2000) }),
  z.strictObject({ action: z.literal("detach"), componentAssetId: id, reason: reasonText }),
  z.strictObject({
    action: z.literal("create"),
    name: z.string().trim().min(1, "name is required").max(200),
    categoryId: id,
    acquisitionCost: money("acquisitionCost"),
    acquiredOn: calendarDate("acquiredOn").nullable().optional(),
    inServiceOn: calendarDate("inServiceOn").nullable().optional(),
    description: optionalText(4000),
    serialNumber: optionalText(200),
  }),
]);

/** Attach an existing asset as a component, detach one, or create a new draft component. */
export const POST = defineRoute({
  permission: "assets.manage",
  feature: "assetComponents",
  params,
  body,
  invalidBodyStatus: 422,
  handler: async ({ authz: gate, params: routeParams, body: input }) => {
    const { id: parentAssetId } = await routeParams;
    const allowedSubsidiaryIds = scopeOf(gate);
    const actorId = gate.user.id;
    switch (input.action) {
      case "attach":
        return NextResponse.json(
          await attachAssetComponent(gate.user.orgId, {
            parentAssetId,
            componentAssetId: input.componentAssetId,
            reason: input.reason ?? null,
            actorId,
            allowedSubsidiaryIds,
          }),
        );
      case "detach":
        return NextResponse.json(
          await detachAssetComponent(gate.user.orgId, {
            componentAssetId: input.componentAssetId,
            reason: input.reason,
            actorId,
            allowedSubsidiaryIds,
          }),
        );
      case "create":
        return NextResponse.json(
          await createAssetComponent(gate.user.orgId, {
            parentAssetId,
            actorId,
            allowedSubsidiaryIds,
            name: input.name,
            categoryId: input.categoryId,
            acquisitionCost: input.acquisitionCost,
            acquiredOn: input.acquiredOn ?? null,
            inServiceOn: input.inServiceOn ?? null,
            description: input.description ?? null,
            serialNumber: input.serialNumber ?? null,
          }),
          { status: 201 },
        );
    }
  },
});
