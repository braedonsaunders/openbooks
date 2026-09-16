'use client'

import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Plus, Split } from 'lucide-react'
import { Badge, Button, EmptyState } from '@openbooks/ui'
import type { RuleHeadSummary } from '../../../../../../engine/src/allocations/index.ts'
import { PagedTable } from '../../../../../components/paged-table'
import { mergeHref } from '../../../../../lib/list-params'
import { formatWindow } from './rule-window'

/**
 * Rules tab list: every head with its current-version summary. The house
 * header row (section title + New button) lives HERE, above the list, so the
 * New action stays visible on an empty tenant — PagedTable renders only its
 * `empty` slot when there are no rows, which is where a toolbar-placed
 * button would vanish. Empty tenants get the shared EmptyState with the
 * same New-rule primary action. Row click opens the rule drawer
 * (`?rule=<id>`) — the drawer host owns that param.
 */
export function RulesTable({
  rules,
  currentParams,
}: {
  rules: RuleHeadSummary[]
  currentParams: Record<string, string | string[] | undefined>
}) {
  const t = useTranslations('allocations')
  const router = useRouter()
  // Static keys keep next-intl's catalog typing (no dynamic lookup).
  const modeLabels = {
    entry: t('rules.modes.entry'),
    post: t('rules.modes.post'),
    period: t('rules.modes.period'),
  } as const
  const statusLabels = {
    draft: t('rules.statuses.draft'),
    published: t('rules.statuses.published'),
    retired: t('rules.statuses.retired'),
  } as const
  const openRule = (ruleParam: string) => {
    router.push(mergeHref('/admin/setup/allocations', currentParams, { rule: ruleParam }) as never)
  }
  const newRule = () => openRule('new')
  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
          {t('rules.list.heading')}
        </h2>
        <Button onClick={newRule}>
          <Plus size={15} />
          {t('rules.list.new')}
        </Button>
      </div>
      {rules.length === 0 ? (
        <EmptyState
          icon={<Split aria-hidden />}
          title={t('rules.list.emptyTitle')}
          description={t('rules.list.empty')}
          action={
            <Button onClick={newRule}>
              <Plus size={15} />
              {t('rules.list.new')}
            </Button>
          }
        />
      ) : (
        <div className="overflow-x-auto">
          <PagedTable<RuleHeadSummary>
            rows={rules}
            rowKey={(row) => row.rule.id}
            searchable
            pageSize={15}
            empty={<p className="text-sm text-slate-500 dark:text-slate-400">{t('rules.list.empty')}</p>}
            onRowClick={(row) => openRule(row.rule.id)}
            columns={[
              {
                key: 'name',
                header: t('rules.list.columns.name'),
                cell: (row) => <span className="font-medium">{row.rule.name}</span>,
                search: (row) => `${row.rule.name} ${row.rule.key}`,
              },
              {
                key: 'key',
                header: t('rules.list.columns.key'),
                cell: (row) => <code className="text-xs">{row.rule.key}</code>,
                search: (row) => row.rule.key,
              },
              {
                key: 'mode',
                header: t('rules.list.columns.mode'),
                cell: (row) => modeLabels[row.rule.mode],
              },
              {
                key: 'version',
                header: t('rules.list.columns.version'),
                cell: (row) =>
                  row.currentVersion == null ? (
                    <span className="text-slate-400">{t('rules.list.noVersion')}</span>
                  ) : (
                    <span className="inline-flex items-center gap-2">
                      <Badge
                        variant={
                          row.currentVersion.status === 'published'
                            ? 'success'
                            : row.currentVersion.status === 'draft'
                              ? 'secondary'
                              : 'outline'
                        }
                      >
                        {statusLabels[row.currentVersion.status]}
                      </Badge>
                      <span className="text-xs text-slate-500">
                        {t('rules.versions.version', { n: row.currentVersion.versionNo })}
                      </span>
                    </span>
                  ),
              },
              {
                key: 'window',
                header: t('rules.list.columns.window'),
                cell: (row) =>
                  row.currentVersion == null ? (
                    <span className="text-slate-400">—</span>
                  ) : (
                    <span className="text-xs tabular-nums">
                      {formatWindow(
                        row.currentVersion.effectiveFrom,
                        row.currentVersion.effectiveTo,
                        t('rules.versions.openEnded'),
                      )}
                    </span>
                  ),
              },
              {
                key: 'order',
                header: t('rules.list.columns.order'),
                align: 'right',
                cell: (row) => <span className="tabular-nums">{row.rule.sortOrder}</span>,
              },
              {
                key: 'active',
                header: t('rules.list.columns.active'),
                cell: (row) => (
                  <Badge variant={row.rule.isActive ? 'success' : 'outline'}>
                    {row.rule.isActive ? t('rules.list.active') : t('rules.list.inactive')}
                  </Badge>
                ),
              },
            ]}
          />
        </div>
      )}
    </div>
  )
}
