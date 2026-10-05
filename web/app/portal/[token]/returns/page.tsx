import { getTranslations } from 'next-intl/server'
import { portalPage } from '@/lib/portal/pages'
import { PortalEmpty, PortalShell } from '@/components/portal/portal-shell'
import { ReturnRequestForm } from '@/components/portal/portal-sections'
import { portalReturnableSources } from '@/lib/portal/returns'

export const runtime = 'nodejs'

export default async function PortalReturnsPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>
  searchParams: Promise<{ source?: string }>
}) {
  const { token } = await params
  const { source } = await searchParams
  const t = await getTranslations('portal')
  const { home } = await portalPage(token, 'returns')
  const invoices = home.invoices
  const reasons = home.settings.returnReasons.map((reason) => ({ value: reason, label: reason }))
  const resolutions = [
    ...(home.settings.returnResolutions.refund ? [{ value: 'refund', label: t('returns.refund') }] : []),
    ...(home.settings.returnResolutions.exchange ? [{ value: 'exchange', label: t('returns.exchange') }] : []),
    ...(home.settings.returnResolutions.storeCredit ? [{ value: 'store_credit', label: t('returns.storeCredit') }] : []),
  ]
  const sources = source ? await portalReturnableSources(token, source) : []
  return (
    <PortalShell orgName={home.settings.portalName} title={t('returns.title')}>
      <a href={`/portal/${token}`} className="text-sm font-medium text-teal-700 hover:underline">← {t('common.back')}</a>
      <p className="mt-4 text-sm text-slate-500 dark:text-slate-400">
        {t('returns.window', { days: home.settings.returnWindowDays })}
      </p>
      {invoices.length === 0 ? (
        <p className="mt-4"><PortalEmpty>{t('returns.empty')}</PortalEmpty></p>
      ) : (
        <ul className="mt-4 space-y-3">
          {invoices.map((invoice) => (
            <li key={invoice.id} className="rounded-xl border border-slate-200 p-4 dark:border-slate-700">
              <div className="flex items-center justify-between">
                <div>
                  <p className="font-medium text-slate-900 dark:text-white">{invoice.documentNumber}</p>
                  <p className="text-sm text-slate-500">{invoice.documentDate}</p>
                </div>
                {source === invoice.id ? null : (
                  <a
                    href={`/portal/${token}/returns?source=${invoice.id}`}
                    className="rounded-xl border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 dark:border-slate-600 dark:text-slate-200"
                  >
                    {t('returns.start')}
                  </a>
                )}
              </div>
              {source === invoice.id ? (
                <div className="mt-3">
                  {sources.length === 0 ? (
                    <PortalEmpty>{t('returns.nothingReturnable')}</PortalEmpty>
                  ) : (
                    <ReturnRequestForm
                      sessionToken={token}
                      sourceDocumentId={invoice.id}
                      sources={sources.map((item) => ({ movementId: item.movementId, movedAt: item.movedAt, remaining: item.remaining, lotCode: item.lotCode, serialCode: item.serialCode }))}
                      reasons={reasons}
                      resolutions={resolutions}
                      labels={{
                        quantity: t('returns.quantity'),
                        reason: t('returns.reason'),
                        resolution: t('returns.resolution'),
                        submit: t('returns.submit'),
                        submitted: t('returns.submitted'),
                        available: t('returns.available'),
                      }}
                    />
                  )}
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </PortalShell>
  )
}
