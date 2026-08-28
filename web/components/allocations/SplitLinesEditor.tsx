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

export type CodingKey = 'department' | 'project' | 'location' | 'class' | 'tax' | 'party'

const CODING_FIELD: Record<CodingKey, keyof AllocationLine> = {
  department: 'departmentId',
  project: 'projectId',
  location: 'locationId',
  class: 'classId',
  tax: 'taxCodeId',
  party: 'partyId',
}

export interface CodingConfig {
  key: CodingKey
  label: string
  options: { value: string; label: string }[]
}

export interface AllocationLine {
  accountId: string
  // Fixed amounts stay as their exact decimal text while they are being
  // edited. Converting every keystroke through Number loses precision before
  // the server-side money validator can canonicalize the value.
  portion: { kind: 'remainder' } | { kind: 'percent'; value: number } | { kind: 'fixed'; value: string }
  departmentId?: string | null
  projectId?: string | null
  locationId?: string | null
  classId?: string | null
  taxCodeId?: string | null
  partyId?: string | null
  description?: string | null
}

export interface SplitLinesLabels {
  account: string
  accountPlaceholder: string
  portion: string
  remainder: string
  percent: string
  fixed: string
  addLine: string
  removeLine: string
  none: string
  descriptionPlaceholder: string
}

const DEFAULT_LABELS: SplitLinesLabels = {
  account: 'Account',
  accountPlaceholder: 'Select an account',
  portion: 'Portion',
  remainder: 'Remainder',
  percent: 'Percent',
  fixed: 'Fixed',
  addLine: 'Add line',
  removeLine: 'Remove line',
  none: '—',
  descriptionPlaceholder: 'Line memo',
}

export function newAllocationLine(accountId = ''): AllocationLine {
  return { accountId, portion: { kind: 'remainder' } }
}

/** Convert an amount input without coercing fixed money through IEEE-754. */
export function allocationPortionFromInput(
  portion: AllocationLine['portion'],
  rawValue: string,
): AllocationLine['portion'] {
  if (portion.kind === 'fixed') return { kind: 'fixed', value: rawValue }
  if (portion.kind === 'percent') return { kind: 'percent', value: Number(rawValue) || 0 }
  return portion
}

export function SplitLinesEditor({
  lines,
  onChange,
  accountOptions,
  codings = [],
  showDescription = false,
  labels: labelOverrides,
}: {
  lines: AllocationLine[]
  onChange: (lines: AllocationLine[]) => void
  accountOptions: { value: string; label: string }[]
  codings?: CodingConfig[]
  showDescription?: boolean
  labels?: Partial<SplitLinesLabels>
}) {
  const labels = { ...DEFAULT_LABELS, ...labelOverrides }

  const setLine = (i: number, patch: Partial<AllocationLine>) => {
    const next = lines.map((l, j) => (j === i ? { ...l, ...patch } : l))
    onChange(next)
  }
  const removeAt = (i: number) => onChange(lines.filter((_, j) => j !== i))
  const add = () => onChange([...lines, newAllocationLine(accountOptions[0]?.value ?? '')])

  const setPortionKind = (i: number, kind: AllocationLine['portion']['kind']) => {
    const portion: AllocationLine['portion'] =
      kind === 'remainder'
        ? { kind: 'remainder' }
        : kind === 'percent'
          ? { kind: 'percent', value: 100 }
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
                placeholder={labels.accountPlaceholder}
              />
            </div>
            <Select
              className="h-8 w-32"
              value={line.portion.kind}
              onChange={(e) => setPortionKind(i, e.target.value as AllocationLine['portion']['kind'])}
            >
              <option value="remainder">{labels.remainder}</option>
              <option value="percent">{labels.percent}</option>
              <option value="fixed">{labels.fixed}</option>
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

          {(codings.length > 0 || showDescription) && (
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
