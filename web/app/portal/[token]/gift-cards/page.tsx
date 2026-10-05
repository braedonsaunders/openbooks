import { getLocale, getTranslations } from 'next-intl/server'
import { portalPage } from '@/lib/portal/pages'
import { decimalDisplay, minorDisplay } from '@/lib/portal/display'
import { PortalEmpty, PortalShell } from '@/components/portal/portal-shell'
import { GiftCardForm } from '@/components/portal/portal-sections'

export const runtime = 'nodejs'

export default async function PortalGiftCardsPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const t = await getTranslations('portal')
  const locale = await getLocale()
  const { home } = await portalPage(token, 'giftCards')
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
        {home.storeCredit.length === 0 && home.prepaidGrants.length === 0 ? (
          <p className="mt-2"><PortalEmpty>{t('giftCards.empty')}</PortalEmpty></p>
        ) : (
          <ul className="mt-2 space-y-2">
            {home.storeCredit.map((credit) => (
              <li key={credit.id} className="flex items-center justify-between text-sm">
                <span className="text-slate-700 dark:text-slate-200">
                  {t('giftCards.storeCredit')} ···· {credit.codeLast4}
                </span>
                <span className="font-semibold tabular-nums text-slate-900 dark:text-white">
                  {minorDisplay(credit.balanceMinor, credit.currency, locale)}
                </span>
              </li>
            ))}
            {home.prepaidGrants.map((grant) => (
              <li key={grant.id} className="flex items-center justify-between text-sm">
                <span className="text-slate-700 dark:text-slate-200">{t('giftCards.prepaid')}</span>
                <span className="font-semibold tabular-nums text-slate-900 dark:text-white">
                  {decimalDisplay(grant.amount, grant.currency || 'USD', locale)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </PortalShell>
  )
}
