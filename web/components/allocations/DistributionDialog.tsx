'use client'

import { useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Button, Drawer, SearchSelect } from '@openbooks/ui'
import {
  SplitLinesEditor,
  type AllocationLine,
  type CodingConfig,
} from './SplitLinesEditor'
import { splitPortionsToAmounts } from './distribution-groups'
import type { EntryDistributionCandidate } from './distribution-groups'

/** One hand-entered child with its exact ledger amount, ready to splice. */
export interface DistributionDialogChild {
  accountId: string
  departmentId?: string | null
  projectId?: string | null
  locationId?: string | null
  classId?: string | null
  description?: string | null
  amount: string
}

/**
 * The Split… dialog for one priced line: pick an entry-mode rule in effect
 * (staged as the line's distributionKey; the server explodes it on save) or
 * hand-edit children in the shared SplitLinesEditor (applied immediately as
 * a locked group). Hand edits win when both are present.
 */
export function DistributionDialog({
  open,
  lineAmount,
  candidates,
  candidatesFailed,
  accountOptions,
  codings,
  initialRuleKey,
  onClose,
  onApplyRule,
  onApplyChildren,
}: {
  open: boolean
  lineAmount: string
  candidates: EntryDistributionCandidate[]
  candidatesFailed: boolean
  accountOptions: { value: string; label: string }[]
  codings: CodingConfig[]
  initialRuleKey: string | null
  onClose: () => void
  onApplyRule: (ruleKey: string) => void
  onApplyChildren: (children: DistributionDialogChild[]) => void
}) {
  const t = useTranslations('allocations')
  // Fresh state per line: the parent remounts the dialog (key=contextKey)
  // for every new split target, so initializers run once per opening and no
  // reset effect (and its cascading render) is needed.
  const [selectedRuleKey, setSelectedRuleKey] = useState<string>(initialRuleKey ?? '')
  const [splitLines, setSplitLines] = useState<AllocationLine[]>([])

  const childAmounts = useMemo(
    () =>
      splitLines.length > 0
        ? splitPortionsToAmounts(
            splitLines.map((line) => line.portion),
            lineAmount,
          )
        : null,
    [splitLines, lineAmount],
  )
  const handChildren: DistributionDialogChild[] | null =
    childAmounts !== null &&
    splitLines.length > 0 &&
    splitLines.every((line) => line.accountId.trim() !== '')
      ? splitLines.map((line, i) => ({
          accountId: line.accountId,
          departmentId: line.departmentId ?? null,
          projectId: line.projectId ?? null,
          locationId: line.locationId ?? null,
          classId: line.classId ?? null,
          description: line.description ?? null,
          amount: childAmounts[i]!,
        }))
      : null
  const canApplyRule = splitLines.length === 0 && selectedRuleKey !== ''
  const canApply = handChildren !== null || canApplyRule

  const apply = () => {
    if (handChildren !== null) onApplyChildren(handChildren)
    else if (canApplyRule) onApplyRule(selectedRuleKey)
  }

  return (
    <Drawer
      open={open}
      onClose={onClose}
      stacked
      size="md"
      title={t('entry.splitTitle', { amount: lineAmount })}
      footer={
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={onClose}>
            {t('entry.dialogCancel')}
          </Button>
          <Button type="button" disabled={!canApply} onClick={apply}>
            {t('entry.dialogApply')}
          </Button>
        </div>
      }
    >
      <div className="space-y-5">
        <div className="space-y-1.5">
          <label className="text-sm font-medium" htmlFor="dist-rule-picker">
            {t('entry.ruleLabel')}
          </label>
          <SearchSelect
            id="dist-rule-picker"
            options={candidates.map((c) => ({ value: c.ruleKey, label: c.ruleName }))}
            value={selectedRuleKey}
            onChange={(v) => setSelectedRuleKey(v)}
            placeholder={t('entry.rulePlaceholder')}
            className="w-full"
          />
          {candidatesFailed ? (
            <p className="text-[13px] text-red-600 dark:text-red-400">{t('entry.candidatesFailed')}</p>
          ) : candidates.length === 0 ? (
            <p className="text-[13px] text-slate-500 dark:text-slate-400">{t('entry.noCandidates')}</p>
          ) : null}
        </div>

        <div className="space-y-2">
          <h3 className="text-sm font-medium">{t('entry.handEditHeading')}</h3>
          <p className="text-[13px] text-slate-500 dark:text-slate-400">{t('entry.handEditHint')}</p>
          <SplitLinesEditor
            lines={splitLines}
            onChange={setSplitLines}
            accountOptions={accountOptions}
            codings={codings}
            showDescription
            // Entry splits price into amounts: weights name no amount (they
            // fail closed in splitPortionsToAmounts), so never offer them.
            portionKinds={['remainder', 'percent', 'fixed']}
            labels={{
              account: t('entry.editor.account'),
              accountPlaceholder: t('entry.editor.accountPlaceholder'),
              portion: t('entry.editor.portion'),
              remainder: t('entry.editor.remainder'),
              percent: t('entry.editor.percent'),
              fixed: t('entry.editor.fixed'),
              addLine: t('entry.editor.addLine'),
              removeLine: t('entry.editor.removeLine'),
              none: t('entry.editor.none'),
              descriptionPlaceholder: t('entry.editor.descriptionPlaceholder'),
            }}
          />
          {splitLines.length > 0 && handChildren === null ? (
            <p className="text-[13px] text-red-600 dark:text-red-400">
              {t('entry.childrenTotalError', { total: '—', expected: lineAmount })}
            </p>
          ) : null}
        </div>
      </div>
    </Drawer>
  )
}
