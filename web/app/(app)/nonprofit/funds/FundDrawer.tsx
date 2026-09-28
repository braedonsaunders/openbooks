'use client'

import { useMoney } from '@/components/money-provider'
import Link from 'next/link'
import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { Badge, Button, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, UrlDrawer } from '@openbooks/ui'
import { DrawerTabStrip } from '@/components/drawer-tab-strip'
import type { FundDrawerData } from './view'

type FundTab = 'details' | 'pairs' | 'releases'

const RELEASE_STATUS_VARIANT: Record<string, 'success' | 'secondary' | 'warning' | 'outline'> = {
  draft: 'outline',
  pending_approval: 'warning',
  posted: 'success',
  void: 'secondary',
}

/**
 * Fund record drawer — classification, interfund pairs, and recent releases.
 * Read-only by design: funds change through the fund commands, and releases
 * move through their approval lifecycle, so the drawer links onward instead
 * of editing in place.
 */
export function FundDrawer({ drawer }: { drawer: FundDrawerData }) {
  const { money } = useMoney()
  const t = useTranslations('nonprofit')
  const tCommon = useTranslations('common')
  const [tab, setTab] = useState<FundTab>('details')
  const fund = drawer.fund

  return (
    <UrlDrawer
      open
      closeHref={drawer.closeHref}
      size="2xl"
      title={
        <span className="flex items-center gap-2.5">
          <span className="font-mono text-sm text-slate-500 dark:text-slate-400">{fund.code}</span>
          <span>{fund.name}</span>
          <Badge variant={fund.isActive ? 'success' : 'outline'}>
            {fund.isActive ? t('funds.active') : t('funds.archived')}
          </Badge>
        </span>
      }
      description={t('funds.details')}
      subtabs={
        <DrawerTabStrip
          ariaLabel={t('funds.tabsAria')}
          activeKey={tab}
          onSelect={setTab}
          tabs={(
            [
              { key: 'details', label: tCommon('auditTrail.tabs.details') },
              { key: 'pairs', label: t('funds.pairs') },
              { key: 'releases', label: t('funds.recentReleases') },
            ] as const
          ).map((item) => ({ key: item.key, label: item.label }))}
        />
      }
      headerActions={
        drawer.canCustomize ? (
          <div className="flex items-center gap-1.5">
            <Button asChild variant="outline" size="sm" className="h-8 px-2.5 text-xs">
              <Link href="/admin/customization?recordType=fund&tab=forms">{tCommon('actions.customize')}</Link>
            </Button>
          </div>
        ) : undefined
      }
    >
      {tab === 'details' ? (
        <div className="grid gap-4 p-1 sm:grid-cols-2">
          <div className="space-y-1.5">
            <p className="text-xs font-medium text-slate-500 dark:text-slate-400">{t('funds.code')}</p>
            <p className="font-mono text-sm">{fund.code}</p>
          </div>
          <div className="space-y-1.5">
            <p className="text-xs font-medium text-slate-500 dark:text-slate-400">{t('funds.kind')}</p>
            <p className="text-sm">{fund.kind}</p>
          </div>
          <div className="space-y-1.5">
            <p className="text-xs font-medium text-slate-500 dark:text-slate-400">{t('funds.restrictionClass')}</p>
            <p className="text-sm">{fund.restrictionClass}</p>
          </div>
          <div className="space-y-1.5">
            <p className="text-xs font-medium text-slate-500 dark:text-slate-400">{t('funds.budgetaryControl')}</p>
            <p className="text-sm">{fund.budgetaryControl}</p>
          </div>
        </div>
      ) : null}
      {tab === 'pairs' ? (
        <div className="space-y-3 p-1">
          {drawer.pairs.length === 0 ? (
            <p className="text-sm text-slate-500 dark:text-slate-400">{t('funds.pairsEmpty')}</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('funds.pair')}</TableHead>
                  <TableHead>{t('funds.settlementAccounts')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {drawer.pairs.map((pair) => (
                  <TableRow key={pair.id}>
                    <TableCell className="font-mono text-[13px]">
                      {pair.fromCode} → {pair.toCode}
                    </TableCell>
                    <TableCell className="font-mono text-[13px]">
                      {pair.dueFromNumber ?? '—'} / {pair.dueToNumber ?? '—'}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>
      ) : null}
      {tab === 'releases' ? (
        <div className="space-y-3 p-1">
          {drawer.releases.length === 0 ? (
            <p className="text-sm text-slate-500 dark:text-slate-400">{t('funds.releasesEmpty')}</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('releases.title')}</TableHead>
                  <TableHead>{t('releases.releaseDate')}</TableHead>
                  <TableHead className="text-right">{t('releases.amount')}</TableHead>
                  <TableHead>{t('releases.status')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {drawer.releases.map((release) => (
                  <TableRow key={release.id}>
                    <TableCell>
                      <Link
                        href={`/nonprofit/releases?release=${release.id}`}
                        className="font-mono text-[13px] text-teal-700 hover:underline dark:text-teal-300"
                      >
                        {release.number}
                      </Link>
                    </TableCell>
                    <TableCell className="font-mono text-[13px]">{release.releaseDate}</TableCell>
                    <TableCell className="text-right tabular-nums">{money(release.amount)}</TableCell>
                    <TableCell>
                      <Badge variant={RELEASE_STATUS_VARIANT[release.status] ?? 'secondary'}>{release.status}</Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>
      ) : null}
    </UrlDrawer>
  )
}
