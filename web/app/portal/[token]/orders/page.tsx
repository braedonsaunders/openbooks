import { getLocale, getTranslations } from 'next-intl/server'
import { portalOrderTracking } from '@openbooks/engine/portal'
import { db, withOrgContext } from '@openbooks/engine/platform/database'
import { portalPage } from '@/lib/portal/pages'
import { minorDisplay } from '@/lib/portal/display'
import { PortalEmpty, PortalShell } from '@/components/portal/portal-shell'

export const runtime = 'nodejs'

export default async function PortalOrdersPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const t = await getTranslations('portal')
  const locale = await getLocale()
  const { home, orgId } = await portalPage(token, 'orders')
  const tracking = new Map<string, Awaited<ReturnType<typeof portalOrderTracking>>>()
  for (const order of home.orders) {
    tracking.set(order.id, await withOrgContext(orgId, () => portalOrderTracking(orgId, order.id, db)))
  }
  return (
    <PortalShell orgName={home.settings.portalName} title={t('orders.title')}>
      <a href={`/portal/${token}`} className="text-sm font-medium text-teal-700 hover:underline">← {t('common.back')}</a>
      {home.orders.length === 0 ? (
        <p className="mt-4"><PortalEmpty>{t('orders.empty')}</PortalEmpty></p>
      ) : (
        <ul className="mt-4 space-y-3">
          {home.orders.map((order) => (
            <li key={order.id} className="rounded-xl border border-slate-200 p-4 dark:border-slate-700">
              <div className="flex items-center justify-between">
                <div>
                  <p className="font-medium text-slate-900 dark:text-white">{order.externalNumber}</p>
                  <p className="text-sm text-slate-500">
                    {order.orderedAt} · {t('orders.fulfilment', { status: order.fulfilmentStatus })}
                  </p>
                </div>
                <p className="font-semibold tabular-nums text-slate-900 dark:text-white">
                  {minorDisplay(order.totalMinor, order.currency, locale)}
                </p>
              </div>
              {(tracking.get(order.id) ?? []).length > 0 ? (
                <ul className="mt-2 space-y-1">
                  {(tracking.get(order.id) ?? []).map((leg, index) => (
                    <li key={index} className="text-sm text-slate-600 dark:text-slate-300">
                      {leg.carrier ? `${leg.carrier} · ` : ''}{leg.trackingNumber ?? t('orders.noTrackingNumber')}
                    </li>
                  ))}
                </ul>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </PortalShell>
  )
}
