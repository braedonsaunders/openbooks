import { notFound } from 'next/navigation'
import { getLocale, getTranslations } from 'next-intl/server'
import { portalBillingReview } from '@openbooks/engine/portal'
import { db, withOrgContext } from '@openbooks/engine/platform/database'
import { portalPage } from '@/lib/portal/pages'
import { decimalDisplay } from '@/lib/portal/display'
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from '@openbooks/ui'
import { PortalShell } from '@/components/portal/portal-shell'
import { BillingReviewDecision } from '@/components/portal/billing-review-form'
import { markPrebillViewedByCustomer } from '@/lib/pre-billing'

export const runtime = 'nodejs'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * One billing package as the customer sees it: the lines that will be
 * invoiced and their total, never cost or internal adjustments. While it
 * awaits a decision the customer accepts it or requests changes line by line.
 */
export default async function PortalReviewPage({ params }: { params: Promise<{ token: string; id: string }> }) {
  const { token, id } = await params
  if (!UUID_RE.test(id)) notFound()
  const t = await getTranslations('portal')
  const locale = await getLocale()
  const { home, orgId, partyId } = await portalPage(token, null)
  const review = await withOrgContext(orgId, () => portalBillingReview(orgId, partyId, id, db))
  if (!review) notFound()
  if (review.status === 'customer_review') await markPrebillViewedByCustomer(orgId, partyId, id)
  const money = (value: string) => decimalDisplay(value, review.currency, locale)
  return (
    <PortalShell orgName={home.settings.portalName} title={review.projectName}>
      <a href={`/portal/${token}/reviews`} className="text-sm font-medium text-teal-700 hover:underline">← {t('common.back')}</a>
      <dl className="mt-4 grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
        <div>
          <dt className="text-slate-500">{t('reviews.reference')}</dt>
          <dd className="font-medium text-slate-900 dark:text-white">{review.worksheetNumber}</dd>
        </div>
        <div>
          <dt className="text-slate-500">{t('reviews.periodLabel')}</dt>
          <dd className="font-medium text-slate-900 dark:text-white">
            {review.periodStart
              ? t('reviews.period', { start: review.periodStart, end: review.periodEnd })
              : t('reviews.through', { date: review.periodEnd })}
          </dd>
        </div>
        {review.purchaseOrderNumber ? (
          <div>
            <dt className="text-slate-500">{t('reviews.purchaseOrder')}</dt>
            <dd className="font-medium text-slate-900 dark:text-white">{review.purchaseOrderNumber}</dd>
          </div>
        ) : null}
      </dl>

      {review.status !== 'customer_review' ? (
        <p className="mt-4 rounded-xl bg-slate-50 p-3 text-sm text-slate-700 dark:bg-slate-800 dark:text-slate-200" role="status">
          {review.decision === 'disputed'
            ? t('reviews.disputedBanner', { date: review.decidedAt?.slice(0, 10) ?? '' })
            : t('reviews.acceptedBanner', { date: review.decidedAt?.slice(0, 10) ?? '' })}
        </p>
      ) : null}

      {review.status === 'customer_review' ? (
        <BillingReviewDecision
          sessionToken={token}
          prebillId={review.id}
          digest={review.digest}
          total={money(review.total)}
          lines={review.lines.map((line) => ({
            id: line.id,
            sourceDate: line.sourceDate,
            description: line.description,
            quantity: line.quantity,
            unit: line.unit,
            amount: money(line.amount),
          }))}
          labels={{
            date: t('reviews.date'),
            description: t('reviews.description'),
            quantity: t('reviews.quantity'),
            amount: t('reviews.amount'),
            total: t('reviews.total'),
            accept: t('reviews.accept'),
            requestChanges: t('reviews.requestChanges'),
            signerName: t('reviews.signerName'),
            purchaseOrder: t('reviews.purchaseOrderOptional'),
            comment: t('reviews.comment'),
            confirm: t('reviews.confirm'),
            acceptSubmit: t('reviews.acceptSubmit'),
            accepting: t('reviews.accepting'),
            disputeHint: t('reviews.disputeHint'),
            lineNotePlaceholder: t('reviews.lineNotePlaceholder'),
            generalComment: t('reviews.generalComment'),
            disputeSubmit: t('reviews.disputeSubmit'),
            sending: t('reviews.sending'),
            addNote: t('reviews.addNote'),
          }}
        />
      ) : (
        <div className="mt-4 overflow-x-auto rounded-xl border border-slate-200 dark:border-slate-700">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="px-3 py-2">{t('reviews.date')}</TableHead>
                <TableHead className="px-3 py-2">{t('reviews.description')}</TableHead>
                <TableHead className="px-3 py-2 text-right">{t('reviews.amount')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {review.lines.map((line) => (
                <TableRow key={line.id} className="border-t border-slate-100 dark:border-slate-800">
                  <TableCell className="whitespace-nowrap px-3 py-2 text-slate-500">{line.sourceDate}</TableCell>
                  <TableCell className="px-3 py-2 text-slate-900 dark:text-white">
                    {line.description ?? '—'}
                    {line.disputeNote ? <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">{line.disputeNote}</p> : null}
                  </TableCell>
                  <TableCell className="px-3 py-2 text-right tabular-nums">{money(line.amount)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
            <TableFooter>
              <TableRow className="border-t border-slate-200 font-semibold dark:border-slate-700">
                <TableCell className="px-3 py-2" colSpan={2}>{t('reviews.total')}</TableCell>
                <TableCell className="px-3 py-2 text-right tabular-nums">{money(review.total)}</TableCell>
              </TableRow>
            </TableFooter>
          </Table>
        </div>
      )}
    </PortalShell>
  )
}
