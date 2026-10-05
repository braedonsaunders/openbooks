import { getLocale, getTranslations } from 'next-intl/server'
import { portalAcceptanceProviders } from '@openbooks/engine/portal'
import { db, withOrgContext } from '@openbooks/engine/platform/database'
import { portalPage } from '@/lib/portal/pages'
import { decimalDisplay } from '@/lib/portal/display'
import { PortalEmpty, PortalShell } from '@/components/portal/portal-shell'
import { PayInvoiceButton } from '@/components/portal/portal-client'

export const runtime = 'nodejs'

export default async function PortalInvoicesPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const t = await getTranslations('portal')
  const locale = await getLocale()
  const { home, orgId } = await portalPage(token, 'invoices')
  const providers = await withOrgContext(orgId, () => portalAcceptanceProviders(orgId, db))
  return (
    <PortalShell orgName={home.settings.portalName} title={t('invoices.title')}>
      <a href={`/portal/${token}`} className="text-sm font-medium text-teal-700 hover:underline">← {t('common.back')}</a>
      {home.invoices.length === 0 ? (
        <p className="mt-4"><PortalEmpty>{t('invoices.empty')}</PortalEmpty></p>
      ) : (
        <ul className="mt-4 space-y-3">
          {home.invoices.map((invoice) => (
            <li key={invoice.id} className="rounded-xl border border-slate-200 p-4 dark:border-slate-700">
              <div className="flex items-center justify-between">
                <div>
                  <p className="font-medium text-slate-900 dark:text-white">{invoice.documentNumber}</p>
                  <p className="text-sm text-slate-500">{invoice.documentDate} · {invoice.status}</p>
                </div>
                <div className="text-right">
                  <p className="font-semibold tabular-nums text-slate-900 dark:text-white">
                    {decimalDisplay(invoice.openBalance, invoice.currency, locale)}
                  </p>
                  <p className="text-xs text-slate-500">{t('invoices.ofTotal', { total: decimalDisplay(invoice.total, invoice.currency, locale) })}</p>
                </div>
              </div>
              <div className="mt-3 flex gap-2">
                <PayInvoiceButton sessionToken={token} documentId={invoice.id} providers={providers.map((p) => p.provider)} label={t('invoices.payNow')} />
                <a
                  href={`/api/portal/invoices/${invoice.id}/pdf?sessionToken=${token}`}
                  className="rounded-xl border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 dark:border-slate-600 dark:text-slate-200"
                >
                  {t('invoices.downloadPdf')}
                </a>
              </div>
            </li>
          ))}
        </ul>
      )}
    </PortalShell>
  )
}
