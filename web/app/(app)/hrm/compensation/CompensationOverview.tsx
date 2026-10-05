import Link from 'next/link'
import { getTranslations } from 'next-intl/server'
import { Button } from '@openbooks/ui'
import { HomePanel, HomeStatTile } from '../../../../components/module-home/client'
import { LiveDirectory } from '../../../../components/module-home/ui'
import { CompensationBandsWorkspace } from './CompensationBandsWorkspace'
import type { CompHomeData } from '../../../../lib/hrm/compensation'
import type { Accent } from '../../../../components/cockpit/ui'

const TILE_ACCENTS: Record<string, Accent> = { blue: 'sky', rose: 'red' }

/** Native module-home summaries with the current pay-band register as the main work area. */
export async function CompensationOverview({ data, orgId, actorId, allowedSubsidiaryIds, canSetup }: {
  data: CompHomeData; orgId: string; actorId: string; allowedSubsidiaryIds: ReadonlySet<string> | null; canSetup: boolean
}) {
  const t = await getTranslations('hrm.compensation.dashboard')
  const overview = data.overview
  if (!overview) return null
  return <>
    <div className="grid shrink-0 grid-cols-2 gap-3 sm:grid-cols-4">
      {data.tiles.map((tile) => <HomeStatTile key={tile.label} icon={tile.iconKey}
        accent={TILE_ACCENTS[tile.accent] ?? tile.accent as Accent} label={tile.label} value={tile.value} sub={tile.sub}
        tone={tile.tone === 'default' ? 'neutral' : tile.tone} />)}
    </div>
    <div className="grid min-h-0 flex-1 grid-cols-1 grid-rows-2 gap-4 lg:grid-cols-3 lg:grid-rows-1">
      <HomePanel title={data.workspaceTabs.find((tab) => tab.href.endsWith('view=bands'))?.label ?? data.bandsTitle} icon="scale"
        className="min-h-0 lg:col-span-2" bodyClassName="flex min-h-0 flex-col overflow-hidden">
        <CompensationBandsWorkspace orgId={orgId} actorId={actorId} allowedSubsidiaryIds={allowedSubsidiaryIds}
          canSetup={canSetup} searchParams={{ ...data.currentParams, view: 'overview' }} />
      </HomePanel>
      <div className="app-scroll flex min-h-0 flex-col gap-4 overflow-y-auto">
        <HomePanel title={t('actualWages')} icon="coins" className="shrink-0">
          <div className="space-y-3">
            {data.wageTiles.map((tile) => <HomeStatTile key={`${tile.label}:${tile.value}`} icon={tile.iconKey}
              accent="teal" label={tile.label} value={tile.value} sub={tile.sub} />)}
            <p className="text-sm text-slate-500">{t('wageCoverage', { covered: overview.wages.covered, total: overview.wages.workers })}</p>
            {overview.wages.missing > 0 ? <p className="text-sm text-amber-700 dark:text-amber-300">{t('missingWages', { count: overview.wages.missing })}</p> : null}
            {overview.wages.ambiguous > 0 ? <p className="text-sm text-amber-700 dark:text-amber-300">{t('ambiguousWages', { count: overview.wages.ambiguous })}</p> : null}
            <p className="text-xs text-slate-500">{t('averageHelp')}</p>
            <Button variant="outline" size="sm" asChild><Link href="/entities/employees">{t('reviewWages')}</Link></Button>
          </div>
        </HomePanel>
        <HomePanel title={data.cyclesTitle} icon="calendar-clock" className="shrink-0">
          <div className="space-y-3">
            <p className="text-sm">{t('cyclesCount', { count: overview.cycles })}</p>
            <p className="text-xs text-slate-500">{t('historicalCount', { count: overview.historicalCycles })}</p>
            <Button variant="outline" size="sm" asChild><Link href="/hrm/compensation?view=cycles">{t('reviewCycles')}</Link></Button>
          </div>
        </HomePanel>
        <LiveDirectory items={data.workspaceTabs.filter((tab) => !tab.active).map((tab) => ({
          href: tab.href, label: tab.label, iconKey: tab.href.endsWith('view=families') ? 'briefcase' : tab.href.endsWith('view=levels') ? 'trending-up' : tab.href.endsWith('view=bands') ? 'scale' : tab.href.endsWith('view=cycles') ? 'calendar-clock' : 'users',
        })).concat([{ href: data.equityHref, label: data.equityLabel, iconKey: 'scale' }])} />
      </div>
    </div>
  </>
}
