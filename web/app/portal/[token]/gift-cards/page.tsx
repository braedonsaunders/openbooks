import { getLocale, getTranslations } from 'next-intl/server'
import { portalPage } from '@/lib/portal/pages'
import { decimalDisplay, minorDisplay } from '@/lib/portal/display'
import { PortalEmpty, PortalShell } from '@/components/portal/portal-shell'
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
  const { home } = await portalPage(token, 'giftCards')
  // Store credit and prepaid grants are separate concepts: the shared kind
  // tab shows one list at a time, never stacked.
  const kind = (await searchParams)?.kind === 'grants' ? 'grants' : 'credit'
  const rows = kind === 'grants' ? home.prepaidGrants : home.storeCredit
  return (
    <PortalShell orgName={home.settings.portalName} title={t('giftCards.title')}>
      <a href={`/portal/${token}`} className="text-sm font-medium text-teal-700 hover:underline">← {t('common.back')}</a>
      <div className="mt-4 rounded-xl border border-slate-200 p-4 dark:border-slate-700">
        <h2 className="text-base font-semibold text-slate-900 dark:text-white">{t('giftCards.lookupTitle')}</h2>
        <div className="mt-3">
          <GiftCardForm sessionToken={token} labels={{ code: t('giftCards.code'), check: t('giftCards.check') }} />
        </div>
      </div>
      <div className="mt-4 rounded-xl border border-slate-200 p-4 dark:border-slate-700">
        <h2 className="text-base font-semibold text-slate-900 dark:text-white">{t('giftCards.yours')}</h2>
        <nav className="mt-2 flex gap-2" aria-label={t('giftCards.yours')}>
          <a
            href={`/portal/${token}/gift-cards?kind=credit`}
            aria-current={kind === 'credit' ? 'page' : undefined}
            className={`rounded-lg border px-3 py-1.5 text-sm font-medium ${kind === 'credit'
              ? 'border-teal-600 text-teal-700 dark:border-teal-400 dark:text-teal-300'
              : 'border-slate-200 text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800'}`}
          >
            {t('giftCards.storeCredit')}
          </a>
          <a
            href={`/portal/${token}/gift-cards?kind=grants`}
            aria-current={kind === 'grants' ? 'page' : undefined}
            className={`rounded-lg border px-3 py-1.5 text-sm font-medium ${kind === 'grants'
              ? 'border-teal-600 text-teal-700 dark:border-teal-400 dark:text-teal-300'
              : 'border-slate-200 text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800'}`}
          >
            {t('giftCards.prepaid')}
          </a>
        </nav>
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
