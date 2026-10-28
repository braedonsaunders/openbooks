import { z } from "zod";
import { uuidString } from "@openbooks/engine/platform/identifiers";
import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/platform/db";
import { resolveFeedSyncOverlapDays } from "@openbooks/engine/banking/bank-feed-providers";
import { isUuid } from "../../../../lib/list-params";
import { guardSubsidiaryScope } from "../../../../lib/authz";
import { subsidiaryVisibleFilter } from "../../../../lib/subsidiaries";
import { reconcilableBankMembership } from "../../../../lib/banking-accounts";
import { persistBankFeedConnection } from "../../../../lib/bank-feed-connections";
const SYNC_OVERLAP_DAYS_MESSAGE = "syncOverlapDays must be a whole number of days from 0 to 90";
const POSTBodySchema1 = z.object({
  name: z.string().trim().min(1),
  provider: z.enum(["manual", "sftp", "plaid", "gocardless", "truelayer"]),
  accountId: uuidString(),
  externalAccountId: z.string().nullable().optional(),
  syncCadence: z.enum(["manual", "hourly", "daily"]).optional(),
  syncOverlapDays: z
    .number({ error: SYNC_OVERLAP_DAYS_MESSAGE })
    .int({ error: SYNC_OVERLAP_DAYS_MESSAGE })
    .min(0, { error: SYNC_OVERLAP_DAYS_MESSAGE })
    .max(90, { error: SYNC_OVERLAP_DAYS_MESSAGE })
    .nullable()
    .optional(),
  credentials: z.record(z.string(), z.string()).nullable().optional(),
});

export const runtime = "nodejs";

const PROVIDERS = ["manual", "sftp", "plaid", "gocardless", "truelayer"] as const;
const CADENCES = ["manual", "hourly", "daily"] as const;

/**
 * Bank feed connections — the registry behind Company Settings → Bank Feeds.
 * Credentials are sealed with the org data key on write and NEVER returned; the
 * list only ever exposes whether a connection has credentials configured.
 */
export const GET = defineRoute({
  permission: "admin.setup.manage",
  feature: "bankFeeds",
  handler: async ({ authz: routeAuthz }) => {
    const authz = routeAuthz;
    const rows = await db.execute<Record<string, unknown>>(
      sql`
        select c.id, c.name, c.provider, c.account_id as "accountId", c.status,
               c.external_account_id as "externalAccountId", c.sync_cadence as "syncCadence",
               c.sync_overlap_days as "syncOverlapDays",
               c.next_sync_at as "nextSyncAt", c.last_sync_at as "lastSyncAt", c.last_attempt_at as "lastAttemptAt",
               c.last_result as "lastResult",
               c.last_error as "lastError", c.is_active as "isActive",
               (c.credentials is not null) as "hasCredentials",
               a.number as "accountNumber", a.name as "accountName"
          from bank_feed_connections c
          join accounts a on a.id = c.account_id and a.org_id = c.org_id
         where c.org_id = ${authz.user.orgId}
           ${subsidiaryVisibleFilter(sql`a.subsidiary_id`, authz.allowedSubsidiaryIds)}
         order by c.created_at desc
      `,
      "objects",
    );
    return NextResponse.json({ connections: rows });
  },
});

export const POST = defineRoute({
  permission: "admin.setup.manage",
  feature: "bankFeeds",
  body: POSTBodySchema1,
  handler: async ({ request: req, authz: routeAuthz, body: routeBody }) => {
    const authz = routeAuthz;

    const body = routeBody as {
      name?: string;
      provider?: string;
      accountId?: string;
      externalAccountId?: string | null;
      syncCadence?: string;
      syncOverlapDays?: number | null;
      credentials?: Record<string, string> | null;
    };
    if (typeof body.name !== "string" || !body.name.trim()) {
      return NextResponse.json({ error: "name is required" }, { status: 400 });
    }
    if (!body.provider || !PROVIDERS.includes(body.provider as (typeof PROVIDERS)[number])) {
      return NextResponse.json({ error: "invalid provider" }, { status: 400 });
    }
    if (
      body.syncCadence !== undefined &&
      !CADENCES.includes(body.syncCadence as (typeof CADENCES)[number])
    ) {
      return NextResponse.json({ error: "invalid syncCadence" }, { status: 400 });
    }
    if (body.syncOverlapDays !== undefined && body.syncOverlapDays !== null) {
      try {
        resolveFeedSyncOverlapDays(body.syncOverlapDays);
      } catch {
        return NextResponse.json(
          { error: "syncOverlapDays must be a whole number of days from 0 to 90" },
          { status: 400 },
        );
      }
    }
    if (typeof body.accountId !== "string" || !isUuid(body.accountId)) {
      return NextResponse.json({ error: "a bank account is required" }, { status: 400 });
    }
    const externalAccountId =
      typeof body.externalAccountId === "string" ? body.externalAccountId.trim() : "";
    if (body.provider === "plaid" && !externalAccountId) {
      return NextResponse.json({ error: "Plaid account id is required" }, { status: 400 });
    }
    const acct = await db.execute<{ subsidiary_id: string | null }>(
      sql`
        select a.subsidiary_id from accounts a where a.id = ${body.accountId} and a.org_id = ${authz.user.orgId}
          and ${reconcilableBankMembership()}
      `,
      "objects",
    );
    if (!acct.length)
      return NextResponse.json({ error: "not a reconcilable account" }, { status: 400 });
    const scoped = guardSubsidiaryScope(authz, acct[0]!.subsidiary_id);
    if (scoped) return scoped;
    const id = await persistBankFeedConnection(
      authz,
      {
        name: body.name,
        provider: body.provider as (typeof PROVIDERS)[number],
        accountId: body.accountId,
        externalAccountId: externalAccountId || null,
        syncCadence: (body.syncCadence ?? "daily") as (typeof CADENCES)[number],
        syncOverlapDays: body.syncOverlapDays ?? null,
        credentials: body.credentials ?? null,
      },
      req.headers.get("X-Request-Id"),
    );
    return NextResponse.json({ id }, { status: 201 });
  },
});
