import { z } from "zod";
import { uuidString } from "@openbooks/engine/platform/identifiers";
import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { isUuid } from "../../../../../lib/list-params";
import { notFound } from "@/lib/api/responses";
import {
  AccountGroupPinError,
  pinAccountToGroup,
  unpinAccountFromGroup,
} from "../../../../../lib/account-groups/pins";
const POSTBodySchema1 = z.object({ accountId: uuidString() });

export const runtime = "nodejs";

/**
 * Account pins for one group — the PIN half of the rule+pin model. POST pins
 * an account into this group (moving it out of any other group in the SAME
 * dimension); DELETE removes the pin so the account falls back to rule
 * matching (or Unassigned).
 */
export const POST = defineRoute({
  permission: "admin.setup.manage",
  feature: {
    none: "This always-on route is governed by admin.setup.manage; the existing route has no separate feature gate.",
  },
  body: POSTBodySchema1,
  handler: async ({ request: _req, authz: routeAuthz, params: routeParams, body: routeBody }) => {
    const params = Promise.resolve(routeParams as { id: string });
    const gate = routeAuthz;
    const { id } = await params;
    if (!isUuid(id)) return notFound("record");

    const { accountId } = routeBody as { accountId?: string };
    if (typeof accountId !== "string" || !isUuid(accountId)) {
      return NextResponse.json({ error: "accountId required" }, { status: 400 });
    }
    try {
      await pinAccountToGroup(gate, id, accountId);
    } catch (error) {
      if (!(error instanceof AccountGroupPinError)) throw error;
      if (error.status === 404) return notFound("record");
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json({ ok: true });
  },
});

export const DELETE = defineRoute({
  permission: "admin.setup.manage",
  feature: {
    none: "This always-on route is governed by admin.setup.manage; the existing route has no separate feature gate.",
  },
  handler: async ({ request: req, authz: routeAuthz, params: routeParams }) => {
    const params = Promise.resolve(routeParams as { id: string });
    const gate = routeAuthz;
    const { id } = await params;
    if (!isUuid(id)) return notFound("record");
    const accountId = new URL(req.url).searchParams.get("accountId");
    if (!accountId || !isUuid(accountId)) {
      return NextResponse.json({ error: "accountId required" }, { status: 400 });
    }
    try {
      await unpinAccountFromGroup(gate, id, accountId);
    } catch (error) {
      if (!(error instanceof AccountGroupPinError)) throw error;
      if (error.status === 404) return notFound("record");
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json({ ok: true });
  },
});
