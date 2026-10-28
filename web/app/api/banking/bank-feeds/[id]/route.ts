import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { db } from "@openbooks/engine/platform/db";
import { syncBankFeedNow } from "@openbooks/engine/banking/bank-feed-providers";
import { isUuid } from "../../../../../lib/list-params";
import { notFound } from "@/lib/api/responses";
import {
  BankFeedConnectionError,
  deleteBankFeedConnection,
  lockScopedBankFeedConnection,
  testBankFeedConnectionForActor,
  updateBankFeedConnection,
} from "../../../../../lib/bank-feed-connections";
const POSTBodySchema1 = z.object({ action: z.enum(["test", "sync"]) });

const SYNC_OVERLAP_DAYS_MESSAGE = "syncOverlapDays must be a whole number of days from 0 to 90";
const PATCHBodySchema1 = z
  .object({
    credentials: z.record(z.string(), z.string()).nullable().optional(),
    externalAccountId: z.string().nullable().optional(),
    isActive: z.boolean({ error: "isActive must be a boolean" }).optional(),
    name: z.string().trim().min(1).optional(),
    syncCadence: z.enum(["manual", "hourly", "daily"]).optional(),
    syncOverlapDays: z
      .number({ error: SYNC_OVERLAP_DAYS_MESSAGE })
      .int({ error: SYNC_OVERLAP_DAYS_MESSAGE })
      .min(0, { error: SYNC_OVERLAP_DAYS_MESSAGE })
      .max(90, { error: SYNC_OVERLAP_DAYS_MESSAGE })
      .nullable()
      .optional(),
  })
  .refine((body) => Object.keys(body).length > 0, {
    message: "At least one field must be provided.",
  });

export const runtime = "nodejs";

export const PATCH = defineRoute({
  permission: "admin.setup.manage",
  feature: "bankFeeds",
  body: PATCHBodySchema1,
  handler: async ({ request: req, authz: routeAuthz, params: routeParams, body: routeBody }) => {
    const params = Promise.resolve(routeParams as { id: string });
    const authz = routeAuthz;
    const { id } = await params;
    if (!isUuid(id)) {
      return notFound("record");
    }

    try {
      await updateBankFeedConnection(authz, id, routeBody, req.headers.get("X-Request-Id"));
      return NextResponse.json({ ok: true });
    } catch (error) {
      if (error instanceof BankFeedConnectionError && error.status === 404)
        return notFound("record");
      if (error instanceof BankFeedConnectionError)
        return NextResponse.json({ error: error.message }, { status: error.status });
      throw error;
    }
  },
});

export const DELETE = defineRoute({
  permission: "admin.setup.manage",
  feature: "bankFeeds",
  handler: async ({ request: req, authz: routeAuthz, params: routeParams }) => {
    const params = Promise.resolve(routeParams as { id: string });
    const authz = routeAuthz;
    const { id } = await params;
    if (!isUuid(id)) {
      return notFound("record");
    }
    try {
      await deleteBankFeedConnection(authz, id, req.headers.get("X-Request-Id"));
      return NextResponse.json({ ok: true });
    } catch (error) {
      if (error instanceof BankFeedConnectionError && error.status === 404)
        return notFound("record");
      if (error instanceof BankFeedConnectionError)
        return NextResponse.json({ error: error.message }, { status: error.status });
      throw error;
    }
  },
});

/** Actions: { action: "test" | "sync" }. */
export const POST = defineRoute({
  permission: "admin.setup.manage",
  feature: "bankFeeds",
  body: POSTBodySchema1,
  handler: async ({ request: req, authz: routeAuthz, params: routeParams, body: routeBody }) => {
    const params = Promise.resolve(routeParams as { id: string });
    const authz = routeAuthz;
    const { id } = await params;
    if (!isUuid(id)) {
      return notFound("record");
    }

    const body = routeBody as { action?: string };
    if (body.action === "test") {
      try {
        const result = await testBankFeedConnectionForActor(
          authz,
          id,
          req.headers.get("X-Request-Id"),
        );
        return NextResponse.json(result);
      } catch (error) {
        if (error instanceof BankFeedConnectionError && error.status === 404)
          return notFound("record");
        if (error instanceof BankFeedConnectionError)
          return NextResponse.json({ error: error.message }, { status: error.status });
        throw error;
      }
    }
    if (body.action === "sync") {
      // Gate the connection's account exactly like PATCH, DELETE, and test:
      // without this, an out-of-scope id falls through to syncBankFeedNow,
      // which throws instead of answering the uniform 404.
      const scoped = await db.transaction(async (tx) =>
        lockScopedBankFeedConnection(tx, authz, id),
      );
      if (!scoped) return notFound("record");
      // The interactive operator is the audit actor for everything this sync
      // imports; dropping user.id here would persist system provenance for a
      // human-triggered import.
      const outcome = await syncBankFeedNow(id, {
        orgId: authz.user.orgId,
        userId: authz.user.id,
        allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
      });
      return NextResponse.json(outcome, { status: outcome.error ? 422 : 200 });
    }
    return NextResponse.json({ error: "unknown action" }, { status: 400 });
  },
});
