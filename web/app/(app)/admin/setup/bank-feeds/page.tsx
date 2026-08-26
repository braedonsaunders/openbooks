import { getTranslations } from "next-intl/server";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/db.ts";
import { loadDaemonConfig, hostKeyFingerprint } from "@openbooks/engine/src/sftp/manager.ts";
import { requirePermission } from "../../../../../lib/authz";
import { featureEnabled, resolvedFeatureState } from "../../../../../lib/features";
import { BankFeedsClient } from "./BankFeedsClient";

export const dynamic = "force-dynamic";

export async function generateMetadata() {
  const t = await getTranslations("banking");
  return { title: t("bankFeeds.title") };
}

/**
 * Company Settings → Bank Feeds. One cohesive surface for every way statements
 * reach an account: live aggregator feeds (Plaid / GoCardless / TrueLayer),
 * SFTP file drops, and manual upload — all shown as one connection list, added
 * from a global bank directory. Gated by the `bankFeeds` feature.
 */
export default async function BankFeedsPage() {
  const authz = await requirePermission("admin.setup.manage");
  const features = await resolvedFeatureState(authz.user.orgId);
  if (!featureEnabled(features, "bankFeeds")) redirect("/admin/setup/features");

  const [conns, accts, servers, sched, cfg, hdrs] = await Promise.all([
    db.execute<any>(sql`
      select c.id, c.name, c.provider, c.account_id as "accountId", c.status,
             c.external_account_id as "externalAccountId", c.sync_cadence as "syncCadence",
             c.last_sync_at as "lastSyncAt", c.last_attempt_at as "lastAttemptAt",
             c.last_result as "lastResult", c.last_error as "lastError",
             c.is_active as "isActive", (c.credentials is not null) as "hasCredentials",
             a.number as "accountNumber", a.name as "accountName"
        from bank_feed_connections c
        join accounts a on a.id = c.account_id and a.org_id = c.org_id
       where c.org_id = ${authz.user.orgId} order by c.created_at desc
    `),
    db.execute(sql`
      select id, number, name from accounts
       where org_id = ${authz.user.orgId} and reconcilable and not is_summary and is_active
       order by number nulls last
    `),
    db.execute<any>(sql`
      select id, name, username, root_prefix as "rootPrefix", is_active as "isActive",
             last_connected_at as "lastConnectedAt"
        from sftp_servers where org_id = ${authz.user.orgId} order by created_at desc
    `),
    db.execute<any>(sql`
      select sc.id, sc.sftp_server_id as "sftpServerId", sc.account_id as "accountId", sc.format, sc.folder,
             sc.is_active as "isActive", sc.last_run_at as "lastRunAt",
             a.number as "accountNumber", a.name as "accountName"
        from sftp_import_schedules sc
        join accounts a on a.id = sc.account_id and a.org_id = sc.org_id
       where sc.org_id = ${authz.user.orgId} order by sc.created_at desc
    `),
    loadDaemonConfig(),
    headers(),
  ]);

  const host = cfg.advertisedHost || hdrs.get("host")?.split(":")[0] || "localhost";
  const daemon = {
    enabled: cfg.enabled,
    port: cfg.port,
    host,
    fingerprint: hostKeyFingerprint(cfg.hostKey),
  };
  const accounts = accts.rows.map((a: any) => ({
    id: a.id,
    label: [a.number, a.name].filter(Boolean).join(" · "),
  }));

  return (
    <BankFeedsClient
      connections={conns.rows}
      sftpServers={servers.rows}
      sftpSchedules={sched.rows}
      accounts={accounts}
      daemon={daemon}
    />
  );
}
