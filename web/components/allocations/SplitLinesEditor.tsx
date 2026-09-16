'use client'

import { Plus, Trash2 } from 'lucide-react'
import { Button, Input, Select, SearchSelect, cn } from '@openbooks/ui'

/**
 * Reusable editor for allocating an amount across coded lines. Each line points
 * at an account, takes a portion (remainder / percentage / fixed amount), and
 * carries any subset of dimensions (department, project, location, class), a tax
 * code, a party, and a description. App-level and generic: bank rules split a
 * deposit into revenue + fees here, but the same editor fits any "code this
 * amount across lines" surface. The consumer chooses which codings appear.
 */

export type {
  AllocationLine,
  AllocationTargetBasis,
  CodingConfig,
  CodingKey,
} from './split-lines-model'
export {
  allocationPortionFromInput,
  allocationTargetBasisFromLine,
  CODING_FIELD,
  newAllocationLine,
} from './split-lines-model'
import type { AllocationLine, CodingConfig } from './split-lines-model'
import { allocationPortionFromInput, CODING_FIELD, newAllocationLine } from './split-lines-model'

export interface SplitLinesLabels {
  account: string
  accountPlaceholder: string
  portion: string
  remainder: string
  percent: string
  fixed: string
  weight: string
  sameAccount: string
  addLine: string
  removeLine: string
  none: string
  descriptionPlaceholder: string
  labelPlaceholder: string
}

const DEFAULT_LABELS: SplitLinesLabels = {
  account: 'Account',
  accountPlaceholder: 'Select an account',
  portion: 'Portion',
  remainder: 'Remainder',
  percent: 'Percent',
  fixed: 'Fixed',
  weight: 'Weight',
  sameAccount: 'Same account',
  addLine: 'Add line',
  removeLine: 'Remove line',
  none: '—',
  descriptionPlaceholder: 'Line memo',
  labelPlaceholder: 'Target label',
}

const PORTION_LABEL: Record<AllocationLine['portion']['kind'], keyof SplitLinesLabels> = {
  remainder: 'remainder',
  percent: 'percent',
  fixed: 'fixed',
  weight: 'weight',
}

const DEFAULT_PORTION_KINDS: AllocationLine['portion']['kind'][] = ['remainder', 'percent', 'fixed']

export function SplitLinesEditor({
  lines,
  onChange,
  accountOptions,
  codings = [],
  showDescription = false,
  labels: labelOverrides,
  portionKinds = DEFAULT_PORTION_KINDS,
  allowEmptyAccount = false,
  showLabel = false,
}: {
  lines: AllocationLine[]
  onChange: (lines: AllocationLine[]) => void
  accountOptions: { value: string; label: string }[]
  codings?: CodingConfig[]
  showDescription?: boolean
  labels?: Partial<SplitLinesLabels>
  /** Which portion kinds the select offers (allocation targets use remainder/percent/weight). */
  portionKinds?: AllocationLine['portion']['kind'][]
  /** An empty account means "same account" (allocation targets). */
  allowEmptyAccount?: boolean
  /** Show the per-line target label input (allocation targets). */
  showLabel?: boolean
}) {
  const labels = { ...DEFAULT_LABELS, ...labelOverrides }

  const setLine = (i: number, patch: Partial<AllocationLine>) => {
    const next = lines.map((l, j) => (j === i ? { ...l, ...patch } : l))
    onChange(next)
  }
  const removeAt = (i: number) => onChange(lines.filter((_, j) => j !== i))
  const add = () => onChange([...lines, newAllocationLine(allowEmptyAccount ? '' : (accountOptions[0]?.value ?? ''))])

  const setPortionKind = (i: number, kind: AllocationLine['portion']['kind']) => {
    const portion: AllocationLine['portion'] =
      kind === 'remainder'
        ? { kind: 'remainder' }
        : kind === 'percent'
          ? { kind: 'percent', value: 100 }
          : kind === 'weight'
            ? { kind: 'weight', value: '1' }
            : { kind: 'fixed', value: '0' }
    setLine(i, { portion })
  }

  return (
    <div className="space-y-2">
      {lines.map((line, i) => (
        <div key={i} className="space-y-2 rounded-lg border border-slate-200 p-2.5 dark:border-slate-800">
          <div className="flex flex-wrap items-center gap-2">
            <div className="min-w-[14rem] flex-1">
              <SearchSelect
                options={accountOptions}
                value={line.accountId}
                onChange={(v) => setLine(i, { accountId: v ?? '' })}
                placeholder={allowEmptyAccount ? labels.sameAccount : labels.accountPlaceholder}
                clearable={allowEmptyAccount}
                emptyLabel={allowEmptyAccount ? labels.sameAccount : undefined}
              />
            </div>
            <Select
              className="h-8 w-32"
              value={line.portion.kind}
              onChange={(e) => setPortionKind(i, e.target.value as AllocationLine['portion']['kind'])}
            >
              {portionKinds.map((kind) => (
                <option key={kind} value={kind}>{labels[PORTION_LABEL[kind]]}</option>
              ))}
            </Select>
            {line.portion.kind !== 'remainder' ? (
              <div className="relative">
                <Input
                  className={cn('h-8 w-24 text-right tabular-nums', line.portion.kind === 'percent' ? 'pr-6' : 'pr-2')}
                  inputMode="decimal"
                  value={String(line.portion.value ?? '')}
                  onChange={(e) => {
                    setLine(i, { portion: allocationPortionFromInput(line.portion, e.target.value) })
                  }}
                />
                {line.portion.kind === 'percent' ? (
                  <span className="pointer-events-none absolute top-1.5 right-2 text-xs text-slate-400">%</span>
                ) : null}
              </div>
            ) : (
              <span className="w-24 text-right text-xs text-slate-400">{labels.remainder.toLowerCase()}</span>
            )}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => removeAt(i)}
              aria-label={labels.removeLine}
              disabled={lines.length <= 1}
            >
              <Trash2 size={14} />
            </Button>
          </div>

          {(codings.length > 0 || showDescription || showLabel) && (
            <div className="flex flex-wrap items-center gap-2 pl-0.5">
              {codings.map((c) => {
                const fieldKey = CODING_FIELD[c.key]
                const value = (line[fieldKey] as string | null | undefined) ?? ''
                return (
                  <div key={c.key} className="min-w-[9rem] flex-1">
                    <SearchSelect
                      options={c.options}
                      value={value}
                      onChange={(v) => setLine(i, { [fieldKey]: v || null } as Partial<AllocationLine>)}
                      placeholder={c.label}
                      clearable
                      emptyLabel={c.label}
                    />
                  </div>
                )
              })}
              {showDescription ? (
                <Input
                  className="h-8 min-w-[10rem] flex-1"
                  value={line.description ?? ''}
                  placeholder={labels.descriptionPlaceholder}
                  onChange={(e) => setLine(i, { description: e.target.value || null })}
                />
              ) : null}
              {showLabel ? (
                <Input
                  className="h-8 min-w-[8rem] flex-1"
                  value={line.label ?? ''}
                  placeholder={labels.labelPlaceholder}
                  onChange={(e) => setLine(i, { label: e.target.value || null })}
                />
              ) : null}
            </div>
          )}
        </div>
      ))}

      <Button type="button" variant="outline" size="sm" onClick={add}>
        <Plus size={14} /> {labels.addLine}
      </Button>
    </div>
  )
}
