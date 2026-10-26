import { z } from "zod";
import { NextResponse } from "next/server";
import { defineRoute } from "@/lib/api/route";
import { uuidId } from "@/lib/api/json";
import { notFound } from "@/lib/api/responses";
import { InventoryError } from "@openbooks/engine/inventory/contracts/module";
import { ScopeNotFoundError } from "@openbooks/engine/organization/scope";
import {
  attributeDeficitAccount,
  listUnattributedDeficits,
} from "@openbooks/engine/inventory/provisional-attribution";
import { can } from "@/lib/authz";
import { isUuid } from "../../../../../lib/list-params";

const params = z.object({ id: z.string() });
const attributeBody = z.object({
  deficitId: uuidId,
  accountId: uuidId,
  reason: z.string(),
});

/**
 * Negative-stock shortfalls of one item that still need the account their
 * issue charged. GET lists them; POST records one shortfall's account with a
 * reason, after which a receipt can settle it.
 */
export const GET = defineRoute({
  permission: "items.read",
  feature: "inventory",
  params,
  handler: async ({ params: { id }, authz }) => {
    if (!isUuid(id)) return notFound("record");
    return NextResponse.json({
      shortfalls: await listUnattributedDeficits(authz.user.orgId, id, authz.allowedSubsidiaryIds),
    });
  },
});

export const POST = defineRoute({
  permission: "items.manage",
  feature: "inventory",
  params,
  body: attributeBody,
  invalidBodyStatus: 422,
  handler: async ({ params: { id }, body, authz }) => {
    if (!isUuid(id)) return notFound("record");
    if (!can(authz, "gl.post")) {
      return NextResponse.json({ error: "missing permission: gl.post" }, { status: 403 });
    }
    const pending = await listUnattributedDeficits(
      authz.user.orgId,
      id,
      authz.allowedSubsidiaryIds,
    );
    if (!pending.some((shortfall) => shortfall.id === body.deficitId)) {
      return NextResponse.json(
        { error: "That shortfall is not awaiting an account on this item; reload the item." },
        { status: 409 },
      );
    }
    try {
      return NextResponse.json(
        await attributeDeficitAccount({
          orgId: authz.user.orgId,
          actorId: authz.user.id,
          deficitId: body.deficitId,
          accountId: body.accountId,
          reason: body.reason,
        }),
      );
    } catch (error) {
      if (error instanceof ScopeNotFoundError) return notFound("record");
      if (error instanceof InventoryError)
        return NextResponse.json({ error: error.message }, { status: 422 });
      throw error;
    }
  },
});
