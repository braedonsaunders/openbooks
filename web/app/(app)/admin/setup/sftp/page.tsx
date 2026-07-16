import { getTranslations } from 'next-intl/server'
import { headers } from 'next/headers'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { loadDaemonConfig, hostKeyFingerprint } from '@openbooks/engine/src/sftp/manager.ts'
import { EmptyState } from '@openbooks/ui'
import { requirePermission } from '../../../../../lib/authz'
import { SftpManager } from './SftpManager'
import { ImportSchedules } from './ImportSchedules'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  const t = await getTranslations('banking')
  return { title: t('sftp.title') }
}

export default async function SetupSftpPage() {
  const authz = await requirePermission('admin.setup.manage')
  const t = await getTranslations('banking')
  const [r, cfg, hdrs, sched, accts] = await Promise.all([
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
    db.execute(sql`
      select id, number, name from accounts
       where org_id = ${authz.user.orgId} and reconcilable and not is_summary and is_active order by number nulls last
    `) as unknown as Promise<{ rows: any[] }>,
  ])
  const host = cfg.advertisedHost || hdrs.get('host')?.split(':')[0] || 'localhost'
  const daemon = { enabled: cfg.enabled, port: cfg.port, host, advertisedHost: cfg.advertisedHost, fingerprint: hostKeyFingerprint(cfg.hostKey) }

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">{t('sftp.title')}</h2>
        <p className="mt-1 max-w-2xl text-sm text-slate-500 dark:text-slate-400">{t('sftp.description')}</p>
      </div>
      <SftpManager
        servers={r.rows}
        daemon={daemon}
        empty={<EmptyState title={t('sftp.emptyTitle')} description={t('sftp.emptyDescription')} />}
      />
      <ImportSchedules
        schedules={sched.rows}
        servers={r.rows.map((s: any) => ({ id: s.id, name: s.name }))}
        accounts={accts.rows.map((a: any) => ({ id: a.id, label: [a.number, a.name].filter(Boolean).join(' · ') }))}
      />
    </div>
  )
}
