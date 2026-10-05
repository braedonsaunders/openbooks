import { getTranslations } from 'next-intl/server'
import { portalAcceptanceProviders } from '@openbooks/engine/portal'
import { db, withOrgContext } from '@openbooks/engine/platform/database'
import { portalPage } from '@/lib/portal/pages'
import { PortalEmpty, PortalShell } from '@/components/portal/portal-shell'
import { MethodSetupButton, PortalActionButton } from '@/components/portal/portal-client'

export const runtime = 'nodejs'

export default async function PortalMethodsPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const t = await getTranslations('portal')
  const { home, orgId } = await portalPage(token, 'paymentMethods')
  const providers = await withOrgContext(orgId, () => portalAcceptanceProviders(orgId, db))
  return (
    <PortalShell orgName={home.settings.portalName} title={t('methods.title')}>
      <a href={`/portal/${token}`} className="text-sm font-medium text-teal-700 hover:underline">← {t('common.back')}</a>
      {home.paymentMethods.length === 0 ? (
        <p className="mt-4"><PortalEmpty>{t('methods.empty')}</PortalEmpty></p>
      ) : (
        <ul className="mt-4 space-y-3">
          {home.paymentMethods.map((method) => (
            <li key={method.id} className="flex items-center justify-between rounded-xl border border-slate-200 p-4 dark:border-slate-700">
              <div>
                <p className="font-medium text-slate-900 dark:text-white">
                  {method.brand ?? method.provider} ···· {method.last4 ?? '····'}
                  {method.isDefault ? ` · ${t('methods.default')}` : ''}
                </p>
                <p className="text-sm text-slate-500">
                  {method.expMonth && method.expYear ? `${method.expMonth}/${method.expYear}` : method.provider}
                </p>
              </div>
              <div className="flex gap-2">
                {!method.isDefault ? (
                  <PortalActionButton sessionToken={token} payload={{ action: 'setDefaultMethod', methodId: method.id }}>
                    {t('methods.setDefault')}
                  </PortalActionButton>
                ) : null}
                <PortalActionButton sessionToken={token} payload={{ action: 'removeMethod', methodId: method.id }}>
                  {t('methods.remove')}
                </PortalActionButton>
              </div>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-4">
        <MethodSetupButton sessionToken={token} providers={providers.map((p) => p.provider)} label={t('methods.add')} />
      </div>
    </PortalShell>
  )
}
