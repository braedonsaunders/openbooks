import Link from 'next/link'
import { getTranslations } from 'next-intl/server'
import { UrlDrawer } from '@openbooks/ui'
import { ModuleActions } from './ModuleActions'
import { ModuleView } from '../../../../components/viewspec/module-view'
import { adminModulesSpec, loadAdminModules, type AdminModulesData } from './view'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

async function ModuleDrawer({ data }: { data: AdminModulesData }) {
  const t = await getTranslations('admin.modules')
  const drawer = data.drawer
  if (!data.drawerOpen || !drawer) return null
  return (
    <UrlDrawer
      open
      closeHref="/admin/modules"
      size="xl"
      title={drawer.name}
      description={`${drawer.key} · ${drawer.versionLabel}`}
    >
      <div className="space-y-6">
        <ModuleActions key={`${drawer.key}:${drawer.versionLabel}:${drawer.pendingGates.map(g => g.gateId).join(',')}`} drawer={drawer} sandboxes={data.sandboxes} canCustomize={data.canCustomize} />
        <p className="text-sm text-slate-600 dark:text-slate-300">{drawer.description}</p>

        <section>
          <h3 className="text-xs font-semibold tracking-wider text-slate-500 uppercase dark:text-slate-400">
            {t('drawer.lifecycle')}
          </h3>
          <dl className="mt-2 space-y-1 text-sm">
            <div className="flex gap-2">
              <dt className="text-slate-500">{t('drawer.liveVersion')}</dt>
              <dd className="font-medium">{drawer.versionStatusLabel}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="text-slate-500">{t('columns.status')}</dt>
              <dd className="font-medium">{drawer.statusLabel}</dd>
            </div>
          </dl>
          {drawer.versions.length > 0 ? (
            <ul className="mt-2 space-y-1 text-sm">
              {drawer.versions.map((v) => (
                <li key={v.version} className="flex items-baseline justify-between gap-2">
                  <code className="text-xs">{v.version}</code>
                  <span className="text-slate-500">
                    {v.statusLabel} · {v.created}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </section>

        <section>
          <h3 className="text-xs font-semibold tracking-wider text-slate-500 uppercase dark:text-slate-400">
            {t('drawer.approvals')}
          </h3>
          {drawer.pendingGates.length > 0 ? (
            <ul className="mt-2 space-y-1 text-sm">
              {drawer.pendingGates.map((g) => (
                <li key={g.gateId}>
                  {t('drawer.pendingApproval', { version: g.version, date: g.waitingSince })}
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 text-sm text-slate-500">{t('drawer.noPendingApprovals')}</p>
          )}
          <Link
            href={drawer.approvalsHref as never}
            className="mt-2 inline-block text-sm font-medium text-teal-700 hover:underline dark:text-teal-300"
          >
            {t('drawer.reviewInApprovals')}
          </Link>
        </section>

        <section>
          <h3 className="text-xs font-semibold tracking-wider text-slate-500 uppercase dark:text-slate-400">
            {t('drawer.permissions')}
          </h3>
          {drawer.grantedPermissions.length > 0 ? (
            <ul className="mt-2 flex flex-wrap gap-1">
              {drawer.grantedPermissions.map((p) => (
                <li key={p}>
                  <code className="rounded bg-slate-100 px-1.5 py-0.5 text-xs dark:bg-slate-800">{p}</code>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 text-sm text-slate-500">{t('drawer.noPermissions')}</p>
          )}
        </section>

        <section>
          <h3 className="text-xs font-semibold tracking-wider text-slate-500 uppercase dark:text-slate-400">
            {t('drawer.contents')}
          </h3>
          {drawer.contributions.length > 0 ? (
            <ul className="mt-2 space-y-1 text-sm">
              {drawer.contributions.map((c, i) => (
                <li key={`${c.kind}-${c.target}-${i}`} className="flex items-baseline gap-2">
                  <code className="text-xs">{c.kind}</code>
                  {c.target ? <span className="text-slate-500">{c.target}</span> : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 text-sm text-slate-500">{t('drawer.noContents')}</p>
          )}
        </section>

        <section>
          <h3 className="text-xs font-semibold tracking-wider text-slate-500 uppercase dark:text-slate-400">
            {t('drawer.history')}
          </h3>
          <p className="mt-1 text-xs text-slate-500">{t('drawer.historyHelp')}</p>
          {drawer.audit.length > 0 ? (
            <ul className="mt-2 space-y-2 text-sm">
              {drawer.audit.map((a, i) => (
                <li key={`${a.at}-${a.event}-${i}`} className="border-l-2 border-slate-200 pl-2 dark:border-slate-700">
                  <div className="text-xs text-slate-500">
                    {a.at} · {a.actorLabel}
                  </div>
                  <div>
                    <code className="text-xs">{a.event}</code>
                    {a.reason ? <span className="text-slate-600 dark:text-slate-300"> — {a.reason}</span> : null}
                  </div>
                  <details className="mt-1"><summary className="cursor-pointer text-xs">{t('drawer.auditEvidence')}</summary>
                    <p className="mt-2 text-xs font-medium">{t('drawer.before')}</p><pre className="overflow-auto text-xs">{a.before}</pre>
                    <p className="mt-2 text-xs font-medium">{t('drawer.after')}</p><pre className="overflow-auto text-xs">{a.after}</pre>
                  </details>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 text-sm text-slate-500">{t('drawer.noHistory')}</p>
          )}
        </section>
      </div>
    </UrlDrawer>
  )
}

export default async function ModulesAdminPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  const data = await loadAdminModules(sp)
  const t = await getTranslations('admin.modules')
  return (
    <>
      <ModuleView spec={adminModulesSpec(data)} data={data} searchParams={sp} trusted />
      <ModuleDrawer data={data} />
      {sp.new === '1' && !data.drawerOpen && data.canCustomize ? <UrlDrawer open closeHref="/admin/modules" size="xl" title={t('actions.new')}><ModuleActions drawer={null} sandboxes={data.sandboxes} canCustomize /></UrlDrawer> : null}
    </>
  )
}
