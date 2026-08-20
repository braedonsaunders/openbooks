import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/db.ts";
import { sealCredentials } from "@openbooks/engine/src/bank-feed-providers.ts";
import { guardFeaturePermission } from "../../../../lib/feature-gates";

export const runtime = "nodejs";

const PROVIDERS = ["manual", "sftp", "plaid", "gocardless", "truelayer"] as const;
const API_PROVIDERS = new Set(["plaid", "gocardless", "truelayer"]);

/**
 * Bank feed connections — the registry behind Company Settings → Bank Feeds.
 * Credentials are sealed with the org data key on write and NEVER returned; the
 * list only ever exposes whether a connection has credentials configured.
 */
export async function GET() {
  const authz = await guardFeaturePermission("admin.setup.manage", "bankFeeds");
  if (authz instanceof NextResponse) return authz;
  const rows = (await db.execute<Record<string, unknown>>(sql`
    select c.id, c.name, c.provider, c.account_id as "accountId", c.status,
           c.external_account_id as "externalAccountId", c.sync_cadence as "syncCadence",
           c.next_sync_at as "nextSyncAt", c.last_sync_at as "lastSyncAt", c.last_result as "lastResult",
           c.last_error as "lastError", c.is_active as "isActive",
           (c.credentials is not null) as "hasCredentials",
           a.number as "accountNumber", a.name as "accountName"
      from bank_feed_connections c
      join accounts a on a.id = c.account_id and a.org_id = c.org_id
     where c.org_id = ${authz.user.orgId}
     order by c.created_at desc
  `));
  return NextResponse.json({ connections: rows.rows });
}

export async function POST(req: Request) {
  const authz = await guardFeaturePermission("admin.setup.manage", "bankFeeds");
  if (authz instanceof NextResponse) return authz;
  const body = (await req.json().catch(() => ({}))) as {
    name?: string;
    provider?: string;
    accountId?: string;
    externalAccountId?: string | null;
    syncCadence?: string;
    credentials?: Record<string, string> | null;
  };

  if (!body.name?.trim()) return NextResponse.json({ error: "name is required" }, { status: 400 });
  if (!body.provider || !PROVIDERS.includes(body.provider as (typeof PROVIDERS)[number])) {
    return NextResponse.json({ error: "invalid provider" }, { status: 400 });
  }
  if (!body.accountId) return NextResponse.json({ error: "a bank account is required" }, { status: 400 });

  const acct = (await db.execute(sql`
    select id from accounts where id = ${body.accountId} and org_id = ${authz.user.orgId}
      and reconcilable and not is_summary
  `));
  if (!acct.rows.length) return NextResponse.json({ error: "not a reconcilable account" }, { status: 400 });

  const isApi = API_PROVIDERS.has(body.provider);
  const sealed = isApi && body.credentials ? sealCredentials(body.credentials) : null;
  const status = isApi ? "pending" : "connected";
  const cadence = isApi ? (body.syncCadence ?? "daily") : "manual";

  const created = (await db.execute<{ id: string }>(sql`
    insert into bank_feed_connections (org_id, name, provider, account_id, external_account_id,
                                       sync_cadence, credentials, status, created_by, updated_by)
    values (${authz.user.orgId}, ${body.name}, ${body.provider}, ${body.accountId},
            ${body.externalAccountId ?? null}, ${cadence}, ${sealed}, ${status},
            ${authz.user.id}, ${authz.user.id})
    returning id
  `));
  return NextResponse.json({ id: created.rows[0]!.id }, { status: 201 });
}
