import { type ReactNode } from 'react'
import { getTranslations } from 'next-intl/server'
import { PageHeader, PagePresentationProvider } from '@openbooks/ui'
import { can, type Authz } from '../../../../lib/authz'
import { resolvedFeatureState, featureEnabled } from '../../../../lib/features'
import { SETUP_ENTITIES, resolveSetupEntityGate } from '../../../../lib/setup/registry'
import { SetupNav } from './SetupNav'

/** Shared Company Setup chrome, content width, spacing and scrolling. */
export async function SetupWorkspace({
  authz,
  children,
  contentLayout = 'form',
}: {
  authz: Authz
  children: ReactNode
  contentLayout?: 'form' | 'section'
}) {
  const canManageSetup = can(authz, 'admin.setup.manage')
  const t = await getTranslations('admin')
  const canExport = can(authz, 'data.export')
  const canImport = can(authz, 'data.import')
  const features = await resolvedFeatureState(authz.user.orgId)
  // One authoritative gate hides rail tabs — never a local OR over featureKey.
  const hiddenEntityKeys = SETUP_ENTITIES.filter(
    (entity) => !resolveSetupEntityGate(entity, features).enabled,
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

      {/* Body — the rail stacks above the content below sm so a 390px panel
          gets full width; sm and up keep the side-by-side rail untouched. */}
      <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
        <aside className="app-scroll w-full shrink-0 overflow-x-auto border-b border-slate-200 bg-white p-2 sm:w-52 sm:overflow-y-auto sm:border-r sm:border-b-0 sm:p-3 lg:w-60 dark:border-slate-800 dark:bg-slate-900">
          <SetupNav
            canExport={canExport}
            canImport={canImport}
            canManageSetup={canManageSetup}
            canReadPayrollPackages={can(authz, 'payroll.read') && featureEnabled(features, 'payroll')}
            canManagePerformance={can(authz, 'hrm.performance.manage') && featureEnabled(features, 'hrm') && featureEnabled(features, 'hrmPerformance')}
            canManageCompensation={can(authz, 'hrm.compensation.manage') && authz.allowedSubsidiaryIds === null && featureEnabled(features, 'hrmCompensation')}
            canManageCrm={can(authz, 'crm.setup.manage')}
            canManagePeriods={can(authz, 'periods.manage')}
            hiddenEntityKeys={hiddenEntityKeys}
            projectsEnabled={featureEnabled(features, 'projects')}
            currencyEnabled={featureEnabled(features, 'multiCurrency')}
            fixedAssetsEnabled={featureEnabled(features, 'fixedAssets')}
            crmEnabled={featureEnabled(features, 'crm')}
            bankFeedsEnabled={featureEnabled(features, 'bankFeeds')}
            onlinePaymentsEnabled={featureEnabled(features, 'onlinePayments')}
            shippingEnabled={featureEnabled(features, 'shippingHub')}
            payrollEnabled={featureEnabled(features, 'payroll')}
            hrmEnabled={featureEnabled(features, 'hrm')}
          />
        </aside>
        <div className="app-scroll min-h-0 min-w-0 flex-1 overflow-y-auto bg-slate-50 dark:bg-slate-950">
          <div className="mx-auto w-full max-w-5xl p-4 sm:p-6">
            <PagePresentationProvider presentation={contentLayout === 'section' ? 'section' : 'page'}>
              {children}
            </PagePresentationProvider>
          </div>
        </div>
      </div>
    </div>
  )
}
