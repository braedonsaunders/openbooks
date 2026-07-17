import Link from 'next/link'
import { getTranslations } from 'next-intl/server'
import { PageHeader } from '@openbooks/ui'
import { requirePermission } from '@/lib/authz'
import { listApps } from '@/lib/apps/store'

export const runtime = 'nodejs'

/** App launcher — the installed Apps a user can open. */
export default async function AppsLauncherPage() {
  const authz = await requirePermission('apps.use')
  const t = await getTranslations('apps')
  const apps = (await listApps(authz.user.orgId)).filter((a) => a.status === 'installed' && a.activeVersionId)

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-6">
      <PageHeader title={t('title')} description={t('description')} />
      <div className="mt-6">
        {apps.length === 0 ? (
          <p className="rounded-lg border border-dashed p-6 text-sm text-neutral-500">
            {t('empty')}
          </p>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {apps.map((a) => (
              <Link
                key={a.key}
                href={`/apps/${encodeURIComponent(a.key)}`}
                className="rounded-lg border p-4 transition hover:border-neutral-400 hover:shadow-sm"
              >
                <div className="font-medium">{a.name}</div>
                {a.description && <p className="mt-1 text-sm text-neutral-500">{a.description}</p>}
                {a.version && <span className="mt-2 inline-block text-xs text-neutral-400">v{a.version}</span>}
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
