'use client'

import { Plus, Trash2 } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { Button, Input, Select } from '@openbooks/ui'
import {
  operatorsForKind,
  type ReportEntity,
  type ReportFilterOperator,
  type ReportRule,
  type ReportRuleGroup,
} from '@openbooks/reports'

/**
 * Recursive nested and/or filter builder. Edits a ReportRuleGroup in place via
 * an onChange callback, mirroring the exact tree shape the engine compiles
 * (filters.ts). Each leaf picks a column, then an operator scoped to that
 * column's kind (operatorsForKind), then a value input whose shape follows the
 * operator's `needsValue` ('none' | 'one' | 'list').
 *
 * Column and operator labels come from packages/reports (server-defined
 * constants) and render verbatim.
 */

type Node = ReportRule | ReportRuleGroup

function isGroup(n: Node): n is ReportRuleGroup {
  return typeof n === 'object' && n !== null && Array.isArray((n as ReportRuleGroup).rules)
}

export function FilterTree({
  entity,
  group,
  onChange,
  depth = 0,
}: {
  entity: ReportEntity
  group: ReportRuleGroup
  onChange: (g: ReportRuleGroup) => void
  depth?: number
}) {
  const t = useTranslations('reports.custom.filterTree')
  const setRule = (i: number, rule: Node) => {
    const rules = [...group.rules]
    rules[i] = rule
    onChange({ ...group, rules })
  }
  const removeAt = (i: number) => {
    onChange({ ...group, rules: group.rules.filter((_, j) => j !== i) })
  }
  const addRule = () => {
    const first = entity.columns[0]
    onChange({
      ...group,
      rules: [...group.rules, { field: first?.key ?? '', op: 'eq', value: '' } as ReportRule],
    })
  }
  const addGroup = () => {
    onChange({ ...group, rules: [...group.rules, { combinator: 'and', rules: [] }] })
  }

  return (
    <div
      className={
        'space-y-2 rounded-lg border p-3 ' +
        (depth === 0
          ? 'border-slate-200 dark:border-slate-800'
          : 'border-slate-200 bg-slate-50/60 dark:border-slate-800 dark:bg-slate-900/40')
      }
    >
      <div className="flex items-center gap-2">
        <span className="text-xs text-slate-500 dark:text-slate-400">{t('match')}</span>
        <Select
          className="h-8 w-48"
          value={group.combinator}
          onChange={(e) => onChange({ ...group, combinator: e.target.value as 'and' | 'or' })}
        >
          <option value="and">{t('allOfFollowing')}</option>
          <option value="or">{t('anyOfFollowing')}</option>
        </Select>
      </div>

      <div className="space-y-2">
        {group.rules.map((rule, i) =>
          isGroup(rule) ? (
            <FilterTree
              key={i}
              entity={entity}
              group={rule}
              depth={depth + 1}
              onChange={(g) => setRule(i, g)}
            />
          ) : (
            <RuleRow
              key={i}
              entity={entity}
              rule={rule}
              onChange={(r) => setRule(i, r)}
              onRemove={() => removeAt(i)}
            />
          ),
        )}
        {group.rules.length === 0 ? (
          <p className="text-xs text-slate-400 dark:text-slate-500">
            {t('noConditions')}
          </p>
        ) : null}
      </div>

      <div className="flex gap-2">
        <Button type="button" variant="outline" size="sm" onClick={addRule}>
          <Plus size={14} /> {t('addCondition')}
        </Button>
        {depth < 3 ? (
          <Button type="button" variant="ghost" size="sm" onClick={addGroup}>
            <Plus size={14} /> {t('addGroup')}
          </Button>
        ) : null}
      </div>
    </div>
  )
}

function RuleRow({
  entity,
  rule,
  onChange,
  onRemove,
}: {
  entity: ReportEntity
  rule: ReportRule
  onChange: (r: ReportRule) => void
  onRemove: () => void
}) {
  const t = useTranslations('reports.custom.filterTree')
  const column = entity.columns.find((c) => c.key === rule.field) ?? entity.columns[0]
  const ops = column ? operatorsForKind(column.kind) : []
  const opMeta = ops.find((o) => o.key === rule.op) ?? ops[0]
  const needsValue = opMeta?.needsValue ?? 'none'

  const changeField = (field: string) => {
    const col = entity.columns.find((c) => c.key === field)
    const nextOps = col ? operatorsForKind(col.kind) : []
    // Keep the operator if still valid for the new kind, else fall back.
    const op = nextOps.some((o) => o.key === rule.op)
      ? rule.op
      : (nextOps[0]?.key ?? 'eq')
    onChange({ field, op: op as ReportFilterOperator, value: '' })
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select
        className="h-8 min-w-[10rem]"
        value={rule.field}
        onChange={(e) => changeField(e.target.value)}
      >
        {entity.columns.map((c) => (
          <option key={c.key} value={c.key}>
            {c.label}
          </option>
        ))}
      </Select>
      <Select
        className="h-8 min-w-[9rem]"
        value={rule.op}
        onChange={(e) => onChange({ ...rule, op: e.target.value as ReportFilterOperator })}
      >
        {ops.map((o) => (
          <option key={o.key} value={o.key}>
            {o.label}
          </option>
        ))}
      </Select>
      {needsValue === 'one' ? (
        <Input
          className="h-8 w-40"
          value={typeof rule.value === 'string' || typeof rule.value === 'number' ? String(rule.value) : ''}
          placeholder={column?.kind === 'date' ? 'YYYY-MM-DD' : t('valuePlaceholder')}
          type={column?.kind === 'date' ? 'date' : column?.kind === 'number' ? 'number' : 'text'}
          onChange={(e) => onChange({ ...rule, value: e.target.value })}
        />
      ) : needsValue === 'list' ? (
        <Input
          className="h-8 w-52"
          value={Array.isArray(rule.value) ? rule.value.join(', ') : ''}
          placeholder={t('listPlaceholder')}
          onChange={(e) =>
            onChange({
              ...rule,
              value: e.target.value
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean),
            })
          }
        />
      ) : (
        <span className="text-xs text-slate-400 dark:text-slate-500">{t('noValue')}</span>
      )}
      <Button type="button" variant="ghost" size="sm" onClick={onRemove} aria-label={t('removeConditionAria')}>
        <Trash2 size={14} />
      </Button>
    </div>
  )
}
