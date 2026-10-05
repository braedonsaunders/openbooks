import { EmptyState } from '@openbooks/ui'
import { HomePanel, HomeStatTile } from '../../../../components/module-home/client'
import { LiveDirectory } from '../../../../components/module-home/ui'
import { CompensationCycleRegister } from './CompensationRegisters'
import type { CompHomeData } from '../../../../lib/hrm/compensation'
import type { Accent } from '../../../../components/cockpit/ui'

const TILE_ACCENTS: Record<string, Accent> = { blue: 'sky', rose: 'red' }

/** The Benefits/Customers module-home composition: live vitals, one bounded
 * hero register, and an independently scrolling work queue and directory. */
export function CompensationOverview({ data }: { data: CompHomeData }) {
  const pendingPlans = data.plans.filter((plan) => plan.status === 'submitted')
  return (
    <>
      <div className="grid shrink-0 grid-cols-2 gap-3 sm:grid-cols-4">
        {data.tiles.map((tile) => (
          <HomeStatTile key={tile.label} icon={tile.iconKey}
            accent={TILE_ACCENTS[tile.accent] ?? tile.accent as Accent}
            label={tile.label} value={tile.value} tone={tile.tone === 'default' ? 'neutral' : tile.tone} />
        ))}
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-1 grid-rows-2 gap-4 lg:grid-cols-3 lg:grid-rows-1">
        <HomePanel title={data.cyclesTitle} icon="coins"
          className="min-h-0 lg:col-span-2" bodyClassName="flex min-h-0 flex-col overflow-hidden">
          <CompensationCycleRegister data={data} />
        </HomePanel>
        <div className="app-scroll flex min-h-0 flex-col gap-4 overflow-y-auto">
          {data.refusal ? <HomePanel title={data.refusal.title} icon="scale" className="shrink-0">
            <EmptyState title={data.refusal.title} description={data.refusal.message} />
          </HomePanel> : null}
          <HomePanel title={data.plansTitle} icon="users" className="shrink-0">
            {pendingPlans.length === 0 ? <EmptyState title={data.plansAwaitingEmpty} /> : <LiveDirectory items={pendingPlans.map((plan) => ({
              href: plan.href, label: plan.name, iconKey: 'users',
              badge: { value: plan.statusLabel, tone: 'warning' },
            }))} />}
          </HomePanel>
          <LiveDirectory items={data.workspaceTabs.filter((tab) => !tab.active).map((tab) => ({
            href: tab.href, label: tab.label, iconKey: 'coins',
          })).concat([{ href: data.equityHref, label: data.equityLabel, iconKey: 'scale' }])} />
        </div>
      </div>
    </>
  )
}
