import { getTranslations } from "next-intl/server";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/db.ts";
import { loadDaemonConfig, hostKeyFingerprint } from "@openbooks/engine/src/sftp/manager.ts";
import Link from "next/link";
import { EmptyState, cn } from "@openbooks/ui";
import { requirePermission } from "../../../../../lib/authz";
import { featureEnabled, resolvedFeatureState } from "../../../../../lib/features";
import { SftpManager } from "../sftp/SftpManager";
import { ImportSchedules } from "../sftp/ImportSchedules";
import { BankFeedsClient } from "./BankFeedsClient";

export const dynamic = "force-dynamic";

export async function generateMetadata() {
  const t = await getTranslations("banking");
  return { title: t("bankFeeds.title") };
}

const VIEWS = ["connections", "sftp-endpoint", "sftp-servers", "sftp-schedules"] as const;
type View = (typeof VIEWS)[number];

/**
 * Company Settings → Bank Feeds. One home for every way statements reach an
 * account: live aggregator connections (Plaid / GoCardless / TrueLayer) and
 * manual, plus the built-in SFTP endpoint that banks drop files onto. Gated by
 * the `bankFeeds` feature.
 */
export default async function BankFeedsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const authz = await requirePermission("admin.setup.manage");
  const features = await resolvedFeatureState(authz.user.orgId);
  if (!featureEnabled(features, "bankFeeds")) redirect("/admin/setup/features");

  const t = await getTranslations("banking");
  const sp = await searchParams;
  const raw = typeof sp.view === "string" ? sp.view : "";
  const view: View = (VIEWS as readonly string[]).includes(raw) ? (raw as View) : "connections";

  const [conns, accts, servers, cfg, hdrs, sched] = await Promise.all([
    db.execute(sql`
      select c.id, c.name, c.provider, c.account_id as "accountId", c.status,
             c.external_account_id as "externalAccountId", c.sync_cadence as "syncCadence",
             c.last_sync_at as "lastSyncAt", c.last_result as "lastResult", c.last_error as "lastError",
             c.is_active as "isActive", (c.credentials is not null) as "hasCredentials",
             a.number as "accountNumber", a.name as "accountName"
        from bank_feed_connections c
        join accounts a on a.id = c.account_id and a.org_id = c.org_id
       where c.org_id = ${authz.user.orgId} order by c.created_at desc
    `) as unknown as Promise<{ rows: any[] }>,
    db.execute(sql`
      select id, number, name from accounts
       where org_id = ${authz.user.orgId} and reconcilable and not is_summary and is_active
       order by number nulls last
    `) as unknown as Promise<{ rows: any[] }>,
    db.execute(sql`
      select id, name, username, backend, bucket, root_prefix, is_active, last_connected_at
        from sftp_servers where org_id = ${authz.user.orgId} order by created_at desc
    `) as unknown as Promise<{ rows: any[] }>,
    loadDaemonConfig(),
    headers(),
    db.execute(sql`
      select sc.id, sc.sftp_server_id, sc.account_id, sc.format, sc.folder, sc.is_active, sc.last_run_at, sc.last_result,
             sv.name as server_name, a.number as account_number, a.name as account_name
        from sftp_import_schedules sc
        join sftp_servers sv on sv.id = sc.sftp_server_id
        join accounts a on a.id = sc.account_id
       where sc.org_id = ${authz.user.orgId} order by sc.created_at desc
    `) as unknown as Promise<{ rows: any[] }>,
  ]);

  const host = cfg.advertisedHost || hdrs.get("host")?.split(":")[0] || "localhost";
  const daemon = {
    enabled: cfg.enabled,
    port: cfg.port,
    host,
    advertisedHost: cfg.advertisedHost,
    fingerprint: hostKeyFingerprint(cfg.hostKey),
  };
  const accounts = accts.rows.map((a: any) => ({
    id: a.id,
    label: [a.number, a.name].filter(Boolean).join(" · "),
  }));

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">{t("bankFeeds.title")}</h2>
        <p className="mt-1 max-w-2xl text-sm text-slate-500 dark:text-slate-400">{t("bankFeeds.description")}</p>
      </div>
      <div className="flex flex-wrap gap-1 border-b border-slate-200 dark:border-slate-800">
        {VIEWS.map((item) => (
          <Link
            key={item}
            href={`/admin/setup/bank-feeds?view=${item}`}
            className={cn(
              "-mb-px border-b-2 px-3 py-2 text-sm font-medium",
              view === item
                ? "border-teal-600 text-teal-700 dark:text-teal-300"
                : "border-transparent text-slate-500 hover:text-slate-900 dark:hover:text-slate-100",
            )}
          >
            {t(`bankFeeds.tabs.${item}`)}
          </Link>
        ))}
      </div>

      {view === "connections" && <BankFeedsClient connections={conns.rows} accounts={accounts} />}
      {view === "sftp-endpoint" && <SftpManager servers={servers.rows} daemon={daemon} show="daemon" />}
      {view === "sftp-servers" && (
        <SftpManager
          servers={servers.rows}
          daemon={daemon}
          show="servers"
          empty={<EmptyState title={t("sftp.emptyTitle")} description={t("sftp.emptyDescription")} />}
        />
      )}
      {view === "sftp-schedules" && (
        <ImportSchedules
          schedules={sched.rows}
          servers={servers.rows.map((s: any) => ({ id: s.id, name: s.name }))}
          accounts={accts.rows.map((a: any) => ({ id: a.id, label: [a.number, a.name].filter(Boolean).join(" · ") }))}
        />
      )}
    </div>
  );
}
