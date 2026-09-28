'use client'

import { useMoney } from '@/components/money-provider'
import Link from 'next/link'
import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { Badge, Button, UrlDrawer } from '@openbooks/ui'
import { DrawerTabStrip } from '@/components/drawer-tab-strip'
import { JournalEntryLink } from '@/components/journal-entry-link'
import { ApprovalActions } from '@/components/approval-actions'
import { ApprovalHistory } from '@/components/approval-history'
import type { ReleaseDrawerData } from './view'

type ReleaseTab = 'details' | 'approvals'

const STATUS_VARIANT: Record<string, 'success' | 'secondary' | 'warning' | 'outline'> = {
  draft: 'outline',
  pending_approval: 'warning',
  posted: 'success',
  void: 'secondary',
}

/**
 * Fund-release record drawer — the approval deep-link landing surface. The
 * details read the same row the flow adapter resolves; the approvals tab
 * carries the native decision controls and history bound to the
 * `fund_release` subject. No submit control lives here: this page lands
 * before any release-submitting surface.
 */
export function ReleaseDrawer({ drawer }: { drawer: ReleaseDrawerData }) {
  const { money } = useMoney()
  const t = useTranslations('nonprofit')
  const tCommon = useTranslations('common')
  const [tab, setTab] = useState<ReleaseTab>('details')
  const release = drawer.release

  return (
    <UrlDrawer
      open
      closeHref={drawer.closeHref}
      size="2xl"
      title={
        <span className="flex items-center gap-2.5">
          <span className="font-mono text-sm text-slate-500 dark:text-slate-400">{release.number}</span>
          <span>
            {release.fromCode} → {release.toCode}
          </span>
          <Badge variant={STATUS_VARIANT[release.status] ?? 'secondary'}>{release.status}</Badge>
        </span>
      }
      description={t('releases.details')}
      subtabs={
        <DrawerTabStrip
          ariaLabel={t('releases.tabsAria')}
          activeKey={tab}
          onSelect={setTab}
          tabs={
            [
              { key: 'details', label: tCommon('auditTrail.tabs.details') },
              { key: 'approvals', label: t('releases.approvals') },
            ] as const
          }
        />
      }
      headerActions={
        <div className="flex items-center gap-1.5">
          {tab === 'approvals' ? (
            <ApprovalActions subjectKind="fund_release" subjectId={release.id} />
          ) : null}
          {drawer.canCustomize ? (
            <Button asChild variant="outline" size="sm" className="h-8 px-2.5 text-xs">
              <Link href="/admin/customization?recordType=fund_release&tab=forms">
                {tCommon('actions.customize')}
              </Link>
            </Button>
          ) : null}
        </div>
      }
    >
      {tab === 'details' ? (
        <div className="space-y-5 p-1">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <p className="text-xs font-medium text-slate-500 dark:text-slate-400">{t('releases.fromFund')}</p>
              <p className="font-mono text-sm">
                {release.fromCode} <span className="font-sans text-slate-500">· {release.fromName}</span>
              </p>
            </div>
            <div className="space-y-1.5">
              <p className="text-xs font-medium text-slate-500 dark:text-slate-400">{t('releases.toFund')}</p>
              <p className="font-mono text-sm">
                {release.toCode} <span className="font-sans text-slate-500">· {release.toName}</span>
              </p>
            </div>
            <div className="space-y-1.5">
              <p className="text-xs font-medium text-slate-500 dark:text-slate-400">{t('releases.amount')}</p>
              <p className="text-sm tabular-nums">{money(release.amount)}</p>
            </div>
            <div className="space-y-1.5">
              <p className="text-xs font-medium text-slate-500 dark:text-slate-400">{t('releases.releaseDate')}</p>
              <p className="font-mono text-sm">{release.releaseDate}</p>
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <p className="text-xs font-medium text-slate-500 dark:text-slate-400">{t('releases.purpose')}</p>
              <p className="text-sm">{release.purpose}</p>
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <p className="text-xs font-medium text-slate-500 dark:text-slate-400">{t('releases.satisfactionRef')}</p>
              <p className="text-sm">{release.satisfactionRef}</p>
            </div>
          </div>
          <section className="rounded-xl border border-slate-200 p-4 dark:border-slate-800">
            <h3 className="font-semibold text-slate-900 dark:text-slate-100">{t('releases.evidence')}</h3>
            {release.postedEntryId || release.voidEntryId ? (
              <div className="mt-2 space-y-1.5 text-sm">
                {release.postedEntryId ? (
                  <p>
                    {t('releases.postedEntry')}:{' '}
                    <JournalEntryLink
                      entryId={release.postedEntryId}
                      className="font-mono text-[13px] text-teal-700 hover:underline dark:text-teal-300"
                    >
                      {release.postedEntryId.slice(0, 8)}
                    </JournalEntryLink>
                  </p>
                ) : null}
                {release.voidEntryId ? (
                  <p>
                    {t('releases.voidEntry')}:{' '}
                    <JournalEntryLink
                      entryId={release.voidEntryId}
                      className="font-mono text-[13px] text-teal-700 hover:underline dark:text-teal-300"
                    >
                      {release.voidEntryId.slice(0, 8)}
                    </JournalEntryLink>
                  </p>
                ) : null}
              </div>
            ) : (
              <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{t('releases.noEvidence')}</p>
            )}
          </section>
        </div>
      ) : (
        <div className="p-1">
          <ApprovalHistory subjectKind="fund_release" subjectId={release.id} showEmptyState />
        </div>
      )}
    </UrlDrawer>
  )
}
