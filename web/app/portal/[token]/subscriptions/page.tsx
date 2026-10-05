import { getTranslations } from 'next-intl/server'
import { portalPage } from '@/lib/portal/pages'
import { PortalEmpty, PortalShell } from '@/components/portal/portal-shell'
import { PortalActionButton } from '@/components/portal/portal-client'
import { CancelFlow, SubscriptionEditor } from '@/components/portal/portal-sections'

export const runtime = 'nodejs'

export default async function PortalSubscriptionsPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const t = await getTranslations('portal')
  const { home } = await portalPage(token, 'subscriptions')
  return (
    <PortalShell orgName={home.settings.portalName} title={t('subscriptions.title')}>
      <a href={`/portal/${token}`} className="text-sm font-medium text-teal-700 hover:underline">← {t('common.back')}</a>
      {home.subscriptions.length === 0 ? (
        <p className="mt-4"><PortalEmpty>{t('subscriptions.empty')}</PortalEmpty></p>
      ) : (
        <ul className="mt-4 space-y-4">
          {home.subscriptions.map((sub) => (
            <li key={sub.id} className="rounded-xl border border-slate-200 p-4 dark:border-slate-700">
              <div className="flex items-center justify-between">
                <div>
                  <p className="font-medium text-slate-900 dark:text-white">{sub.planName}</p>
                  <p className="text-sm text-slate-500">
                    {t('subscriptions.status', { status: sub.status })} · {t('subscriptions.nextBill', { date: sub.nextBillOn })}
                  </p>
                </div>
              </div>
              {sub.status === 'active' || sub.status === 'paused' ? (
                <>
                  <SubscriptionEditor
                    sessionToken={token}
                    subscriptionId={sub.id}
                    labels={{
                      quantity: t('subscriptions.quantity'),
                      price: t('subscriptions.price'),
                      preview: t('subscriptions.preview'),
                      apply: t('subscriptions.apply'),
                      increase: t('subscriptions.increase'),
                      decrease: t('subscriptions.decrease'),
                      charge: t('subscriptions.charge'),
                      credit: t('subscriptions.credit'),
                    }}
                  />
                  <div className="mt-3 flex gap-2">
                    {sub.status === 'active' ? (
                      <PortalActionButton sessionToken={token} payload={{ action: 'pauseSubscription', subscriptionId: sub.id }}>
                        {t('subscriptions.pause')}
                      </PortalActionButton>
                    ) : (
                      <PortalActionButton sessionToken={token} payload={{ action: 'resumeSubscription', subscriptionId: sub.id }}>
                        {t('subscriptions.resume')}
                      </PortalActionButton>
                    )}
                  </div>
                  <details className="mt-3 rounded-lg bg-slate-50 p-3 dark:bg-slate-800">
                    <summary className="cursor-pointer text-sm font-medium text-slate-700 dark:text-slate-200">
                      {t('subscriptions.cancelTitle')}
                    </summary>
                    <CancelFlow
                      sessionToken={token}
                      subscriptionId={sub.id}
                      offers={home.settings.saveOffers.map((offer) => ({ id: offer.id, kind: offer.kind, label: offer.label, note: offer.note }))}
                      labels={{
                        reason: t('subscriptions.cancelReason'),
                        reasonPlaceholder: t('subscriptions.cancelReasonPlaceholder'),
                        cancel: t('subscriptions.cancel'),
                        takeOffer: t('subscriptions.takeOffer'),
                      }}
                    />
                  </details>
                </>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </PortalShell>
  )
}
