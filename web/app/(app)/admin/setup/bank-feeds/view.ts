import 'server-only'

import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { loadDaemonConfig, hostKeyFingerprint } from '@openbooks/engine/src/sftp/manager.ts'
import { page, widgetBlock, type PageSpec } from '@openbooks/viewspec'
import { requirePermission } from '../../../../../lib/authz'
import { featureEnabled, resolvedFeatureState } from '../../../../../lib/features'
import type { BankFeedsClient } from './BankFeedsClient'

/**
 * Company Settings → Bank Feeds, split into a loader and a spec.
 *
 * The native page is a permission gate + a feature gate + a six-way fetch,
 * then the whole surface renders inside ONE client island
 * (`BankFeedsClient`): the connection list, the SFTP cards, the shared
 * endpoint card and the multi-step add-connection flow all own `useState`
 * (adding/msg/busy, per-card routing/account/folder, the configure wizard's
 * provider/creds/secret), fire `fetch` POST/PATCH/DELETE mutations, and
 * filter the bank directory client-side. Decomposing any of that into spec
 * blocks would render unfiltered data and strand the inputs from what they
 * filter (the labor-costing precedent) — so the island arrives whole
 * through one widget, the same arrangement as
 * `labor-costing-workspace` / `property-management-workspace`.
 *
 * Loader work copied VERBATIM from page.tsx: the `admin.setup.manage`
 * gate, the `bankFeeds` feature redirect, the six-way
 * connections/accounts/servers/schedules/daemon-config/headers fan-out,
 * the advertised-host fallback chain, and the account label join
 * (`number · name`). Nothing travels through the spec except plain data.
 *
 * Date note: the island formats `lastSyncAt`/`lastAttemptAt` CLIENT-side
 * with `new Date(…).toLocaleDateString("en-CA")`, so the loader passes the
 * raw values through untouched (the payment-operations `nextRunAt`
 * precedent) — server locale/TZ must not pre-format them. `timestamptz`
 * columns arrive as Dates; they are serialized to ISO strings first.
 */

type BankFeedsClientProps = Parameters<typeof BankFeedsClient>[0]

export interface BankFeedsData {
  connections: BankFeedsClientProps['connections']
  sftpServers: BankFeedsClientProps['sftpServers']
  sftpSchedules: BankFeedsClientProps['sftpSchedules']
  accounts: BankFeedsClientProps['accounts']
  daemon: BankFeedsClientProps['daemon']
}

const iso = (v: unknown): string | null =>
  v instanceof Date ? v.toISOString() : typeof v === 'string' ? v : null

export async function loadBankFeeds(): Promise<BankFeedsData> {
  const authz = await requirePermission('admin.setup.manage')
  const features = await resolvedFeatureState(authz.user.orgId)
  if (!featureEnabled(features, 'bankFeeds')) redirect('/admin/setup/features')

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
  ])

  const host = cfg.advertisedHost || hdrs.get('host')?.split(':')[0] || 'localhost'
  const daemon = {
    enabled: cfg.enabled,
    port: cfg.port,
    host,
    fingerprint: hostKeyFingerprint(cfg.hostKey),
  }
  const accounts = accts.rows.map((a: any) => ({
    id: a.id,
    label: [a.number, a.name].filter(Boolean).join(' · '),
  }))

  return {
    // Client-side dates stay raw: the island renders them with
    // `new Date(…).toLocaleDateString("en-CA")` in the browser.
    connections: conns.rows.map((c: any) => ({
      ...c,
      lastSyncAt: iso(c.lastSyncAt),
      lastAttemptAt: iso(c.lastAttemptAt),
    })),
    sftpServers: servers.rows.map((s: any) => ({
      ...s,
      lastConnectedAt: iso(s.lastConnectedAt),
    })),
    sftpSchedules: sched.rows.map((s: any) => ({
      ...s,
      lastRunAt: iso(s.lastRunAt),
    })),
    accounts,
    daemon,
  }
}

export function bankFeedsSpec(data: BankFeedsData): PageSpec {
  return page({
    route: '/admin/setup/bank-feeds',
    // The setup workspace renders its own shell around every setup page, so a
    // second page layout would nest the chrome. And the `mx-auto w-full
    // max-w-4xl space-y-6 p-1` wrapper belongs to BankFeedsClient itself —
    // the spec must NOT place it too, or the page renders that div twice.
    layout: 'bare',
    header: [],
    body: [
      widgetBlock('bank-feeds-workspace', {
        connections: data.connections,
        sftpServers: data.sftpServers,
        sftpSchedules: data.sftpSchedules,
        accounts: data.accounts,
        daemon: data.daemon,
      }),
    ],
  })
}
