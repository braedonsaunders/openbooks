import { notFound } from 'next/navigation'
import { getLocale, getTranslations } from 'next-intl/server'
import { portalPage } from '@/lib/portal/pages'
import { decimalDisplay, minorDisplay } from '@/lib/portal/display'
import { PortalEmpty, PortalNav, PortalShell } from '@/components/portal/portal-shell'
import { GiftCardForm } from '@/components/portal/portal-sections'

export const runtime = 'nodejs'

export default async function PortalGiftCardsPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>
  searchParams: Promise<{ kind?: string }>
}) {
  const { token } = await params
  const t = await getTranslations('portal')
  const locale = await getLocale()
  const { home } = await portalPage(token, null)
  // Store credit is the gift-cards section; prepaid grants are usage
  // balances, visible under either section. Both off refuses like any
  // disabled section; each kind renders only under its own section.
  if (!home.settings.sections.giftCards && !home.settings.sections.usage) notFound()
  const canCredit = home.settings.sections.giftCards
  const canGrants = home.settings.sections.giftCards || home.settings.sections.usage
  // Store credit and prepaid grants are separate concepts: the shared kind
  // strip shows one list at a time, never stacked. A requested kind outside
  // its section falls back to the allowed one.
  const requested = (await searchParams)?.kind === 'grants' ? 'grants' : 'credit'
  const kind = requested === 'grants' ? (canGrants ? 'grants' : 'credit') : (canCredit ? 'credit' : 'grants')
  const rows = kind === 'grants' ? home.prepaidGrants : home.storeCredit
  const activeHref = `/portal/${token}/gift-cards?kind=${kind}`
  return (
    <PortalShell orgName={home.settings.portalName} title={t('giftCards.title')}>
      <a href={`/portal/${token}`} className="text-sm font-medium text-teal-700 hover:underline">← {t('common.back')}</a>
      {canCredit ? (
        <div className="mt-4 rounded-xl border border-slate-200 p-4 dark:border-slate-700">
          <h2 className="text-base font-semibold text-slate-900 dark:text-white">{t('giftCards.lookupTitle')}</h2>
          <div className="mt-3">
            <GiftCardForm sessionToken={token} labels={{ code: t('giftCards.code'), check: t('giftCards.check') }} />
          </div>
        </div>
      ) : null}
      <div className="mt-4 rounded-xl border border-slate-200 p-4 dark:border-slate-700">
        <h2 className="text-base font-semibold text-slate-900 dark:text-white">{t('giftCards.yours')}</h2>
        {canCredit && canGrants ? (
          <PortalNav
            token={token}
            ariaLabel={t('giftCards.yours')}
            activeHref={activeHref}
            sections={[
              { href: '/gift-cards?kind=credit', label: t('giftCards.storeCredit') },
              { href: '/gift-cards?kind=grants', label: t('giftCards.prepaid') },
            ]}
          />
        ) : null}
        {rows.length === 0 ? (
          <p className="mt-2"><PortalEmpty>{t('giftCards.empty')}</PortalEmpty></p>
        ) : kind === 'grants' ? (
          <ul className="mt-2 space-y-2">
            {home.prepaidGrants.map((grant) => (
              <li key={grant.id} className="flex items-center justify-between text-sm">
                <span className="text-slate-700 dark:text-slate-200">{t('giftCards.prepaid')}</span>
                {grant.currency ? (
                  <span className="font-semibold tabular-nums text-slate-900 dark:text-white">
                    {decimalDisplay(grant.amount, grant.currency, locale)}
                  </span>
                ) : (
                  <span className="text-sm text-amber-700 dark:text-amber-300">
                    {t('giftCards.noCurrency')}
                  </span>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <ul className="mt-2 space-y-2">
            {home.storeCredit.map((credit) => (
              <li key={credit.id} className="flex items-center justify-between text-sm">
                <span className="text-slate-700 dark:text-slate-200">
                  {t('giftCards.storeCredit')} ···· {credit.codeLast4}
                </span>
                {credit.currency ? (
                  <span className="font-semibold tabular-nums text-slate-900 dark:text-white">
                    {minorDisplay(credit.balanceMinor, credit.currency, locale)}
                  </span>
                ) : (
                  <span className="text-sm text-amber-700 dark:text-amber-300">
                    {t('giftCards.noCurrency')}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </PortalShell>
  )
}
