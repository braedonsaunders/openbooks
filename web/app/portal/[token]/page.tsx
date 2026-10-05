import { notFound, redirect } from 'next/navigation'
import { getLocale, getTranslations } from 'next-intl/server'
import { consumePortalLink, portalHome, resolvePortalSession } from '@openbooks/engine/portal'
import { db, withOrgContext } from '@openbooks/engine/platform/database'
import { decimalDisplay, minorDisplay } from '@/lib/portal/display'
import { PortalEmpty, PortalNav, PortalSection, PortalShell } from '@/components/portal/portal-shell'

export const runtime = 'nodejs'

export default async function PortalTokenPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const t = await getTranslations('portal')
  const locale = await getLocale()
  const session = await resolvePortalSession(token)
  if (!session) {
    try {
      const consumed = await consumePortalLink(token)
      redirect(`/portal/${consumed.sessionToken}`)
    } catch {
      notFound()
    }
  }
  const active = session!
  const home = await withOrgContext(active.orgId, () => portalHome(active.orgId, active.partyId, db))
  const nav = [
    ...(home.settings.sections.invoices ? [{ href: '/invoices', label: t('nav.invoices') }] : []),
    ...(home.settings.sections.paymentMethods ? [{ href: '/methods', label: t('nav.methods') }] : []),
    ...(home.settings.sections.subscriptions ? [{ href: '/subscriptions', label: t('nav.subscriptions') }] : []),
    ...(home.settings.sections.orders ? [{ href: '/orders', label: t('nav.orders') }] : []),
    ...(home.settings.sections.returns ? [{ href: '/returns', label: t('nav.returns') }] : []),
    ...(home.settings.sections.giftCards ? [{ href: '/gift-cards', label: t('nav.giftCards') }] : []),
  ]
  return (
    <PortalShell orgName={home.settings.portalName} title={t('home.title', { name: home.partyName })}>
      <PortalNav token={token} sections={nav} />
      {home.settings.sections.invoices ? (
        <PortalSection
          title={t('home.openInvoices')}
          action={<a href={`/portal/${token}/invoices`} className="text-sm font-medium text-teal-700 hover:underline">{t('common.viewAll')}</a>}
        >
          {home.invoices.length === 0 ? (
            <PortalEmpty>{t('home.noInvoices')}</PortalEmpty>
          ) : (
            <ul className="space-y-2">
              {home.invoices.slice(0, 3).map((invoice) => (
                <li key={invoice.id} className="flex items-center justify-between text-sm">
                  <span className="text-slate-700 dark:text-slate-200">
                    {invoice.documentNumber} · {invoice.documentDate}
                  </span>
                  <span className="font-semibold tabular-nums text-slate-900 dark:text-white">
                    {decimalDisplay(invoice.openBalance, invoice.currency, locale)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </PortalSection>
      ) : null}
      {home.settings.sections.subscriptions ? (
        <PortalSection
          title={t('home.subscriptions')}
          action={<a href={`/portal/${token}/subscriptions`} className="text-sm font-medium text-teal-700 hover:underline">{t('common.viewAll')}</a>}
        >
          {home.subscriptions.length === 0 ? (
            <PortalEmpty>{t('home.noSubscriptions')}</PortalEmpty>
          ) : (
            <ul className="space-y-2">
              {home.subscriptions.slice(0, 3).map((sub) => (
                <li key={sub.id} className="flex items-center justify-between text-sm">
                  <span className="text-slate-700 dark:text-slate-200">{sub.planName} · {sub.status}</span>
                  <span className="tabular-nums text-slate-500">{sub.nextBillOn}</span>
                </li>
              ))}
            </ul>
          )}
        </PortalSection>
      ) : null}
      {(home.settings.sections.usage || home.settings.sections.giftCards) && (home.storeCredit.length > 0 || home.prepaidGrants.length > 0) ? (
        <PortalSection title={t('home.balances')}>
          <ul className="space-y-2">
            {home.storeCredit.map((credit) => (
              <li key={credit.id} className="flex items-center justify-between text-sm">
                <span className="text-slate-700 dark:text-slate-200">
                  {t('home.storeCredit')} ···· {credit.codeLast4}
                </span>
                <span className="font-semibold tabular-nums text-slate-900 dark:text-white">
                  {minorDisplay(credit.balanceMinor, credit.currency, locale)}
                </span>
              </li>
            ))}
            {home.prepaidGrants.map((grant) => (
              <li key={grant.id} className="flex items-center justify-between text-sm">
                <span className="text-slate-700 dark:text-slate-200">{t('home.prepaid')}</span>
                <span className="font-semibold tabular-nums text-slate-900 dark:text-white">
                  {decimalDisplay(grant.amount, grant.currency || 'USD', locale)}
                </span>
              </li>
            ))}
          </ul>
        </PortalSection>
      ) : null}
      {home.settings.sections.orders ? (
        <PortalSection
          title={t('home.orders')}
          action={<a href={`/portal/${token}/orders`} className="text-sm font-medium text-teal-700 hover:underline">{t('common.viewAll')}</a>}
        >
          {home.orders.length === 0 ? (
            <PortalEmpty>{t('home.noOrders')}</PortalEmpty>
          ) : (
            <ul className="space-y-2">
              {home.orders.slice(0, 3).map((order) => (
                <li key={order.id} className="flex items-center justify-between text-sm">
                  <span className="text-slate-700 dark:text-slate-200">{order.externalNumber}</span>
                  <span className="tabular-nums text-slate-500">{order.fulfilmentStatus}</span>
                </li>
              ))}
            </ul>
          )}
        </PortalSection>
      ) : null}
    </PortalShell>
  )
}
