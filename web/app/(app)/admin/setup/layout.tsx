import type { ReactNode } from 'react'
import { redirect } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { PageHeader } from '@openbooks/ui'
import { can, getAuthz } from '../../../../lib/authz'
import { resolvedFeatureState, featureEnabled } from '../../../../lib/features'
import { SETUP_ENTITIES } from '../../../../lib/setup/registry'
import { SetupNav } from './SetupNav'

export const dynamic = 'force-dynamic'

/**
 * Setup workspace shell — a single admin.setup.manage gate, a page header with
 * a back-link to the admin hub, and a two-column body: the grouped tab rail
 * (SetupNav) beside the active tab's content. The whole area scrolls together.
 */
export default async function SetupLayout({ children }: { children: ReactNode }) {
  const authz = await getAuthz()
  if (!authz) redirect('/login')
  const canManageSetup = can(authz, 'admin.setup.manage')
  if (!canManageSetup && !can(authz, 'crm.setup.manage')) redirect('/')
  const t = await getTranslations('admin')
  const canExport = can(authz, 'data.export')
  const canImport = can(authz, 'data.import')
  const features = canManageSetup ? await resolvedFeatureState(authz.user.orgId) : {}
  const hiddenEntityKeys = SETUP_ENTITIES.filter(
    (entity) => entity.featureKey && !featureEnabled(features, entity.featureKey),
  ).map((entity) => entity.key)

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Fixed header — never scrolls */}
      <div className="shrink-0 border-b border-slate-200 bg-white px-3 py-3 sm:px-6 dark:border-slate-800 dark:bg-slate-900">
        <PageHeader
          title={t('setup.title')}
          description={t('setup.description')}
          back={{ href: '/admin', label: t('hub.title') }}
        />
      </div>

      {/* Body — two panes, each scrolls independently within the viewport */}
      <div className="flex min-h-0 flex-1">
        <aside className="app-scroll w-44 shrink-0 overflow-y-auto border-r border-slate-200 bg-white p-3 sm:w-52 lg:w-60 dark:border-slate-800 dark:bg-slate-900">
          <SetupNav
            canExport={canExport}
            canImport={canImport}
            canManageSetup={canManageSetup}
            hiddenEntityKeys={hiddenEntityKeys}
            projectsEnabled={featureEnabled(features, 'projects')}
            currencyEnabled={featureEnabled(features, 'multiCurrency')}
            bankFeedsEnabled={featureEnabled(features, 'bankFeeds')}
            onlinePaymentsEnabled={featureEnabled(features, 'onlinePayments')}
          />
        </aside>
        <div className="app-scroll min-h-0 flex-1 overflow-y-auto bg-slate-50 dark:bg-slate-950">
          <div className="mx-auto w-full max-w-5xl p-4 sm:p-6">{children}</div>
        </div>
      </div>
    </div>
  )
}
