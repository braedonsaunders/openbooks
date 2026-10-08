import { getLocale, getTranslations } from 'next-intl/server'
import { portalBillingReviews } from '@openbooks/engine/portal'
import { db, withOrgContext } from '@openbooks/engine/platform/database'
import { portalPage } from '@/lib/portal/pages'
import { decimalDisplay } from '@/lib/portal/display'
import { PortalEmpty, PortalShell } from '@/components/portal/portal-shell'

export const runtime = 'nodejs'

/** Billing packages the supplier has sent this customer for review. */
export default async function PortalReviewsPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const t = await getTranslations('portal')
  const locale = await getLocale()
  const { home, orgId, partyId } = await portalPage(token, null)
  const reviews = await withOrgContext(orgId, () => portalBillingReviews(orgId, partyId, db))
  return (
    <PortalShell orgName={home.settings.portalName} title={t('reviews.title')}>
      <a href={`/portal/${token}`} className="text-sm font-medium text-teal-700 hover:underline">← {t('common.back')}</a>
      {reviews.length === 0 ? (
        <p className="mt-4"><PortalEmpty>{t('reviews.empty')}</PortalEmpty></p>
      ) : (
        <ul className="mt-4 space-y-3">
          {reviews.map((review) => (
            <li key={review.id}>
              <a
                href={`/portal/${token}/reviews/${review.id}`}
                className="flex items-center justify-between gap-3 rounded-xl border border-slate-200 p-4 hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800"
              >
                <span>
                  <span className="block font-medium text-slate-900 dark:text-white">{review.projectName}</span>
                  <span className="block text-sm text-slate-500">
                    {review.worksheetNumber} · {review.periodStart
                      ? t('reviews.period', { start: review.periodStart, end: review.periodEnd })
                      : t('reviews.through', { date: review.periodEnd })}
                  </span>
                </span>
                <span className="text-right">
                  <span className="block font-semibold tabular-nums text-slate-900 dark:text-white">
                    {decimalDisplay(review.total, review.currency, locale)}
                  </span>
                  <span className={`mt-1 inline-block rounded-full px-2 py-0.5 text-xs font-medium ${review.status === 'customer_review'
                    ? 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200'
                    : review.decision === 'disputed'
                      ? 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200'
                      : 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200'}`}>
                    {review.status === 'customer_review'
                      ? t('reviews.awaiting')
                      : review.decision === 'disputed' ? t('reviews.disputed') : t('reviews.accepted')}
                  </span>
                </span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </PortalShell>
  )
}
