'use client'

import { Plus, Trash2 } from 'lucide-react'
import { Button, Input, Select, cn } from '@openbooks/ui'
import {
  type Condition,
  type ConditionGroup,
  type FieldDef,
  isConditionGroup,
  newCondition,
  operatorsForField,
  valueShapeFor,
} from '../../lib/conditions'

/**
 * Reusable, catalog-driven nested and/or condition builder. Given a field
 * catalog, it renders a recursive tree of condition rows and sub-groups, each
 * row a field → operator → value picker whose value input follows the operator's
 * shape. Emits a generic ConditionGroup (see lib/conditions). App-level and
 * decoupled: every label has an English default and can be overridden for i18n,
 * so bank rules, payment-run selection, and saved searches share one builder.
 */

export interface ConditionBuilderLabels {
  match: string
  allOf: string
  anyOf: string
  addCondition: string
  addGroup: string
  noConditions: string
  remove: string
  valuePlaceholder: string
  andJoin: string
  toJoin: string
}

const DEFAULT_LABELS: ConditionBuilderLabels = {
  match: 'Match',
  allOf: 'all of the following',
  anyOf: 'any of the following',
  addCondition: 'Add condition',
  addGroup: 'Add group',
  noConditions: 'No conditions — this matches every line.',
  remove: 'Remove condition',
  valuePlaceholder: 'Value',
  andJoin: 'and',
  toJoin: 'to',
}

export function ConditionBuilder({
  catalog,
  group,
  onChange,
  operatorLabels,
  labels: labelOverrides,
  maxDepth = 3,
  depth = 0,
}: {
  catalog: FieldDef[]
  group: ConditionGroup
  onChange: (g: ConditionGroup) => void
  operatorLabels?: Record<string, string>
  labels?: Partial<ConditionBuilderLabels>
  maxDepth?: number
  depth?: number
}) {
  const labels = { ...DEFAULT_LABELS, ...labelOverrides }

  const setRule = (i: number, rule: Condition | ConditionGroup) => {
    const rules = [...group.rules]
    rules[i] = rule
    onChange({ ...group, rules })
  }
  const removeAt = (i: number) => onChange({ ...group, rules: group.rules.filter((_, j) => j !== i) })
  const addCondition = () => onChange({ ...group, rules: [...group.rules, newCondition(catalog)] })
  const addGroup = () => onChange({ ...group, rules: [...group.rules, { combinator: 'and', rules: [] }] })

  return (
    <div
      className={cn(
        'space-y-2 rounded-lg border p-3',
        depth === 0
          ? 'border-slate-200 dark:border-slate-800'
          : 'border-slate-200 bg-slate-50/60 dark:border-slate-800 dark:bg-slate-900/40',
      )}
    >
      <div className="flex items-center gap-2">
        <span className="text-xs text-slate-500 dark:text-slate-400">{labels.match}</span>
        <Select
          className="h-8 w-52"
          value={group.combinator}
          onChange={(e) => onChange({ ...group, combinator: e.target.value as 'and' | 'or' })}
        >
          <option value="and">{labels.allOf}</option>
          <option value="or">{labels.anyOf}</option>
        </Select>
      </div>

      <div className="space-y-2">
        {group.rules.map((rule, i) =>
          isConditionGroup(rule) ? (
            <ConditionBuilder
              key={i}
              catalog={catalog}
              group={rule}
              depth={depth + 1}
              maxDepth={maxDepth}
              operatorLabels={operatorLabels}
              labels={labelOverrides}
              onChange={(g) => setRule(i, g)}
            />
          ) : (
            <ConditionRow
              key={i}
              catalog={catalog}
              condition={rule}
              operatorLabels={operatorLabels}
              labels={labels}
              onChange={(r) => setRule(i, r)}
              onRemove={() => removeAt(i)}
            />
          ),
        )}
        {group.rules.length === 0 ? (
          <p className="text-xs text-slate-400 dark:text-slate-500">{labels.noConditions}</p>
        ) : null}
      </div>

      <div className="flex gap-2">
        <Button type="button" variant="outline" size="sm" onClick={addCondition}>
          <Plus size={14} /> {labels.addCondition}
        </Button>
        {depth < maxDepth ? (
          <Button type="button" variant="ghost" size="sm" onClick={addGroup}>
            <Plus size={14} /> {labels.addGroup}
          </Button>
        ) : null}
      </div>
    </div>
  )
}

function ConditionRow({
  catalog,
  condition,
  operatorLabels,
  labels,
  onChange,
  onRemove,
}: {
  catalog: FieldDef[]
  condition: Condition
  operatorLabels?: Record<string, string>
  labels: ConditionBuilderLabels
  onChange: (c: Condition) => void
  onRemove: () => void
}) {
  const field = catalog.find((f) => f.key === condition.field) ?? catalog[0]
  const ops = operatorsForField(field, operatorLabels)
  const shape = valueShapeFor(field, condition.op)

  const changeField = (key: string) => {
    const next = catalog.find((f) => f.key === key)
    const nextOps = operatorsForField(next)
    const op = nextOps.some((o) => o.key === condition.op) ? condition.op : (nextOps[0]?.key ?? 'contains')
    onChange({ field: key, op, value: '' })
  }

  const range = Array.isArray(condition.value) ? condition.value : [undefined, undefined]

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select className="h-8 w-full sm:w-44" value={condition.field} onChange={(e) => changeField(e.target.value)}>
        {catalog.map((f) => (
          <option key={f.key} value={f.key}>
            {f.label}
          </option>
        ))}
      </Select>
      <Select
        className="h-8 w-full sm:w-40"
        value={condition.op}
        onChange={(e) => onChange({ ...condition, op: e.target.value, value: condition.value })}
      >
        {ops.map((o) => (
          <option key={o.key} value={o.key}>
            {o.label}
          </option>
        ))}
      </Select>

      {shape === 'none' ? null : shape === 'enum' || shape === 'flow' ? (
        <Select
          className="h-8 w-44"
          value={typeof condition.value === 'string' ? condition.value : ''}
          onChange={(e) => onChange({ ...condition, value: e.target.value })}
        >
          <option value="">{labels.valuePlaceholder}</option>
          {(field?.options ?? []).map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Select>
      ) : shape === 'range' ? (
        <div className="flex items-center gap-1.5">
          <Input
            className="h-8 w-24 text-right tabular-nums"
            inputMode="decimal"
            value={range[0] ?? ''}
            onChange={(e) => onChange({ ...condition, value: [Number(e.target.value), Number(range[1] ?? 0)] })}
          />
          <span className="text-xs text-slate-400">{labels.toJoin}</span>
          <Input
            className="h-8 w-24 text-right tabular-nums"
            inputMode="decimal"
            value={range[1] ?? ''}
            onChange={(e) => onChange({ ...condition, value: [Number(range[0] ?? 0), Number(e.target.value)] })}
          />
        </div>
      ) : (
        <Input
          className={cn('h-8 w-44', shape === 'number' && 'w-32 text-right tabular-nums')}
          type={shape === 'date' ? 'date' : shape === 'number' ? 'number' : 'text'}
          inputMode={shape === 'number' ? 'decimal' : undefined}
          placeholder={field?.placeholder ?? labels.valuePlaceholder}
          value={typeof condition.value === 'string' || typeof condition.value === 'number' ? String(condition.value) : ''}
          onChange={(e) => onChange({ ...condition, value: shape === 'number' ? e.target.value : e.target.value })}
        />
      )}

      <Button type="button" variant="ghost" size="sm" onClick={onRemove} aria-label={labels.remove}>
        <Trash2 size={14} />
      </Button>
    </div>
  )
}
