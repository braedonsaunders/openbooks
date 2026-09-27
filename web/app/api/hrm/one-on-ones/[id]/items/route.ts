import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { notFound } from "@/lib/api/responses";
import { NextResponse } from "next/server";
import {
  addOneOnOneItem,
  getOneOnOne,
  setOneOnOneItemDone,
} from "@openbooks/engine/src/hrm/performance/one-on-ones.ts";

import { isFeatureEnabled } from "../../../../../../lib/features";
import { performanceErrorResponse } from "../../../review-cycles/_lib";
import { addOneOnOneItemBody, patchOneOnOneItemBody } from "../../bodies";

export const runtime = "nodejs";

async function gated(orgId: string): Promise<boolean> {
  return (
    (await isFeatureEnabled(orgId, "hrm")) &&
    (await isFeatureEnabled(orgId, "hrmPerformance"))
  );
}

/**
 * 1:1 agenda items. GET reads the 1:1 with its visibility-filtered
 * items; POST adds one; PATCH toggles done. The client checks res.ok
 * before parsing.
 */
export const GET = defineRoute({
  public: "session",
  params: z.object({ id: z.string().min(1) }),
  handler: async ({ request: _req, authz: authz, params: routeParams }) => {
    if (!(await gated(authz.user.orgId))) {
      return notFound("record");
    }
    const { id } = routeParams;
    try {
      const one = await getOneOnOne({
        orgId: authz.user.orgId,
        actorId: authz.user.id,
        id,
      });
      return NextResponse.json({ items: one.items });
    } catch (e) {
      return performanceErrorResponse(e);
    }
  },
});

export const POST = defineRoute({
  public: "session",
  params: z.object({ id: z.string().min(1) }),
  body: addOneOnOneItemBody,
  handler: async ({
    authz: authz,
    params: routeParams,
    body: body,
  }) => {
    if (!(await gated(authz.user.orgId))) {
      return notFound("record");
    }

    const { id } = routeParams;
    try {
      const item = await addOneOnOneItem({
        orgId: authz.user.orgId,
        actorId: authz.user.id,
        oneOnOneId: id,
        kind: body.kind,
        body: body.body,
        visibility: body.visibility ?? "shared",
        assigneePartyId: body.assigneePartyId ?? null,
        dueOn: body.dueOn ?? null,
      });
      return NextResponse.json({ item }, { status: 201 });
    } catch (e) {
      return performanceErrorResponse(e);
    }
  },
});

export const PATCH = defineRoute({
  public: "session",
  params: z.object({ id: z.string().min(1) }),
  body: patchOneOnOneItemBody,
  handler: async ({
    authz: authz,
    params: routeParams,
    body: body,
  }) => {
    if (!(await gated(authz.user.orgId))) {
      return notFound("record");
    }

    const { id } = routeParams;
    try {
      await setOneOnOneItemDone({
        orgId: authz.user.orgId,
        actorId: authz.user.id,
        oneOnOneId: id,
        itemId: body.itemId,
        done: body.done,
      });
      return NextResponse.json({ ok: true });
    } catch (e) {
      return performanceErrorResponse(e);
    }
  },
});
