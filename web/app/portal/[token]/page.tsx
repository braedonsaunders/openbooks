import { notFound, redirect } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { consumePortalLink, portalBillingReviews, portalHome, resolvePortalSession } from '@openbooks/engine/portal'
import { db, withOrgContext } from '@openbooks/engine/platform/database'
import { PortalNav, PortalShell } from '@/components/portal/portal-shell'

export const runtime = 'nodejs'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export default async function PortalTokenPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>
  searchParams?: Promise<Record<string, string | string[] | undefined>>
}) {
  const { token } = await params
  // A review invitation lands the customer on the package it names.
  const review = (await searchParams)?.review
  const reviewId = typeof review === 'string' && UUID_RE.test(review) ? review : null
  const t = await getTranslations('portal')
  const session = await resolvePortalSession(token)
  if (!session) {
    // The redirect throws to abort rendering, so it must stay outside the
    // try: catching it here would swallow a successful consume into a 404.
    let consumed
    try {
      consumed = await consumePortalLink(token)
    } catch {
      notFound()
    }
    redirect(`/portal/${consumed.sessionToken}${reviewId ? `/reviews/${reviewId}` : ''}`)
  }
  const active = session!
  const [home, reviews] = await withOrgContext(active.orgId, () => Promise.all([
    portalHome(active.orgId, active.partyId, db),
    portalBillingReviews(active.orgId, active.partyId, db),
  ]))
  const awaitingReview = reviews.filter((entry) => entry.status === 'customer_review').length
  const nav = [
    ...(home.settings.sections.invoices ? [{ href: '/invoices', label: t('nav.invoices') }] : []),
    ...(home.settings.sections.paymentMethods ? [{ href: '/methods', label: t('nav.methods') }] : []),
    ...(home.settings.sections.subscriptions ? [{ href: '/subscriptions', label: t('nav.subscriptions') }] : []),
    ...(home.settings.sections.orders ? [{ href: '/orders', label: t('nav.orders') }] : []),
    ...(home.settings.sections.returns ? [{ href: '/returns', label: t('nav.returns') }] : []),
    ...(home.settings.sections.giftCards ? [{ href: '/gift-cards', label: t('nav.giftCards') }] : []),
  ]
  // The home page never lists records: each concept renders one summary
  // link with its count, and the full list lives on its own page. Store
  // credit and prepaid grants are separate concepts with separate links.
  const summaries: Array<{ href: string; label: string; count: number; empty: string }> = [
    // Billing reviews appear only once the supplier has sent one.
    ...(reviews.length > 0 ? [{
      href: `/portal/${token}/reviews`,
      label: t('home.billingReviews'),
      count: awaitingReview,
      empty: t('home.noBillingReviews'),
    }] : []),
    ...(home.settings.sections.invoices ? [{
      href: `/portal/${token}/invoices`,
      label: t('home.openInvoices'),
      count: home.invoices.length,
      empty: t('home.noInvoices'),
    }] : []),
    ...(home.settings.sections.subscriptions ? [{
      href: `/portal/${token}/subscriptions`,
      label: t('home.subscriptions'),
      count: home.subscriptions.length,
      empty: t('home.noSubscriptions'),
    }] : []),
    // Each balance links only its own allowed section: store credit needs
    // the gift-cards section, prepaid grants need usage or gift-cards, so a
    // usage-only portal keeps its balances and never lands on a refusal.
    ...(home.settings.sections.giftCards ? [{
      href: `/portal/${token}/gift-cards?kind=credit`,
      label: t('home.storeCredit'),
      count: home.storeCredit.length,
      empty: t('giftCards.empty'),
    }] : []),
    ...((home.settings.sections.usage || home.settings.sections.giftCards) ? [{
      href: `/portal/${token}/gift-cards?kind=grants`,
      label: t('home.prepaid'),
      count: home.prepaidGrants.length,
      empty: t('giftCards.empty'),
    }] : []),
    ...(home.settings.sections.orders ? [{
      href: `/portal/${token}/orders`,
      label: t('home.orders'),
      count: home.orders.length,
      empty: t('home.noOrders'),
    }] : []),
  ]
  return (
    <PortalShell orgName={home.settings.portalName} title={t('home.title', { name: home.partyName })}>
      <PortalNav token={token} sections={nav} />
      <div className="mt-6 space-y-2">
        {summaries.map((summary) => (
          <a
            key={summary.href}
            href={summary.href}
            className="flex items-center justify-between gap-3 rounded-xl border border-slate-200 p-4 hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800"
          >
            <span>
              <span className="block text-base font-semibold text-slate-900 dark:text-white">
                {summary.label}
              </span>
              {summary.count === 0 ? (
                <span className="mt-0.5 block text-sm text-slate-500 dark:text-slate-400">
                  {summary.empty}
                </span>
              ) : null}
            </span>
            <span className="flex shrink-0 items-center gap-2 text-sm font-medium text-teal-700 dark:text-teal-300">
              {summary.count > 0 ? (
                <span className="rounded-full bg-slate-100 px-2 py-0.5 tabular-nums text-slate-700 dark:bg-slate-800 dark:text-slate-200">
                  {summary.count}
                </span>
              ) : null}
              {t('common.viewAll')} →
            </span>
          </a>
        ))}
      </div>
    </PortalShell>
  )
}
