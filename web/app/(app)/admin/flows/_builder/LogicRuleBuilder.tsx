'use client'

import { Plus, X } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { Button, Input, SearchSelect, Select } from '@openbooks/ui'
import type { FlowSubjectProfile, LogicRule } from '@openbooks/forms-core'
import type { OrgUser } from './graph'

/**
 * Recursive LogicRule editor — the one condition language shared with the
 * form builder (forms-core logicRuleSchema). Groups nest and/or/not up to
 * three levels; leaves pick a field, an operator, and a value input typed by
 * the subject profile's field type.
 */

type GroupOp = 'and' | 'or' | 'not'
type LeafOp = 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'notIn' | 'isSet' | 'isNotSet'

const LEAF_OPS: LeafOp[] = ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in', 'notIn', 'isSet', 'isNotSet']
const LIST_OPS = new Set<LeafOp>(['in', 'notIn'])
const VALUELESS_OPS = new Set<LeafOp>(['isSet', 'isNotSet'])
const MAX_DEPTH = 2

const isGroup = (r: LogicRule): r is Extract<LogicRule, { rules: LogicRule[] } | { rule: LogicRule }> =>
  r.op === 'and' || r.op === 'or' || r.op === 'not'

const defaultLeaf = (field: string): LogicRule => ({ op: 'isSet', field })

function groupChildren(r: LogicRule): LogicRule[] {
  if ('rules' in r) return r.rules
  if ('rule' in r) return [r.rule]
  return []
}

function makeGroup(op: GroupOp, children: LogicRule[], fallbackField: string): LogicRule {
  if (op === 'not') return { op: 'not', rule: children[0] ?? defaultLeaf(fallbackField) }
  return { op, rules: children }
}

/** Change a leaf's operator, keeping the value when the shape still fits. */
function withOp(rule: Extract<LogicRule, { field: string }>, op: LeafOp): LogicRule {
  const field = rule.field
  if (VALUELESS_OPS.has(op)) return { op: op as 'isSet', field }
  const prev = 'value' in rule ? rule.value : undefined
  if (LIST_OPS.has(op)) {
    return { op: op as 'in', field, value: Array.isArray(prev) ? prev : [] }
  }
  return { op: op as 'eq', field, value: Array.isArray(prev) ? (prev[0] ?? '') : (prev ?? '') }
}

function ValueInput({
  rule,
  onChange,
  profile,
  users,
}: {
  rule: Extract<LogicRule, { field: string }>
  onChange: (rule: LogicRule) => void
  profile: FlowSubjectProfile
  users: OrgUser[]
}) {
  const t = useTranslations('admin.flows.logic')
  if (VALUELESS_OPS.has(rule.op as LeafOp)) return null
  const value = 'value' in rule ? rule.value : undefined
  const set = (v: unknown) => onChange({ ...rule, value: v } as LogicRule)
  const field = profile.fields.find((f) => f.key === rule.field)
  const fieldType = field?.type ?? 'text'

  if (LIST_OPS.has(rule.op as LeafOp)) {
    const list = Array.isArray(value) ? value : []
    if (field?.options?.length) {
      return (
        <div className="col-span-2 flex flex-wrap gap-1.5">
          {field.options.map((option) => {
            const selected = list.includes(option.value)
            return (
              <button
                key={option.value}
                type="button"
                onClick={() =>
                  set(
                    selected
                      ? list.filter((item) => item !== option.value)
                      : [...list, option.value],
                  )
                }
                className={
                  selected
                    ? 'rounded-full border border-teal-500 bg-teal-50 px-2.5 py-0.5 text-xs text-teal-700 dark:bg-teal-950 dark:text-teal-300'
                    : 'rounded-full border border-slate-200 px-2.5 py-0.5 text-xs text-slate-500 dark:border-slate-700 dark:text-slate-400'
                }
              >
                {option.label}
              </button>
            )
          })}
        </div>
      )
    }
    return (
      <Input
        value={list.join(', ')}
        placeholder={t('listPlaceholder')}
        onChange={(e) => {
          const parts = e.target.value.split(',').map((s) => s.trim()).filter(Boolean)
          set(fieldType === 'number' ? parts.map((p) => (Number.isNaN(Number(p)) ? p : Number(p))) : parts)
        }}
      />
    )
  }
  if (fieldType === 'bool') {
    return (
      <Select value={String(value ?? 'true')} onChange={(e) => set(e.target.value === 'true')}>
        <option value="true">{t('true')}</option>
        <option value="false">{t('false')}</option>
      </Select>
    )
  }
  if (fieldType === 'number') {
    return (
      <Input
        inputMode="decimal"
        value={value === undefined || value === null ? '' : String(value)}
        placeholder={t('valuePlaceholder')}
        onChange={(e) => {
          const raw = e.target.value
          set(raw === '' || Number.isNaN(Number(raw)) ? raw : Number(raw))
        }}
      />
    )
  }
  if (fieldType === 'date') {
    return <Input type="date" value={String(value ?? '')} onChange={(e) => set(e.target.value)} />
  }
  if (rule.field === 'status') {
    return (
      <Select value={String(value ?? '')} onChange={(e) => set(e.target.value)}>
        <option value="" />
        {profile.statuses.map((s) => (
          <option key={s.value} value={s.value}>
            {s.label}
          </option>
        ))}
      </Select>
    )
  }
  if (field?.options?.length) {
    return (
      <Select value={String(value ?? '')} onChange={(e) => set(e.target.value)}>
        <option value="" />
        {field.options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </Select>
    )
  }
  if (fieldType === 'user') {
    return (
      <SearchSelect
        value={String(value ?? '')}
        options={users.map((u) => ({ value: u.id, label: u.name, hint: u.email }))}
        placeholder={t('valuePlaceholder')}
        onChange={(v) => set(v)}
      />
    )
  }
  return (
    <Input
      value={String(value ?? '')}
      placeholder={t('valuePlaceholder')}
      onChange={(e) => set(e.target.value)}
    />
  )
}

function LeafEditor({
  rule,
  onChange,
  profile,
  users,
}: {
  rule: Extract<LogicRule, { field: string }>
  onChange: (rule: LogicRule) => void
  profile: FlowSubjectProfile
  users: OrgUser[]
}) {
  const t = useTranslations('admin.flows.logic')
  return (
    <div className="min-w-0 flex-1 space-y-1.5">
      <SearchSelect
        value={rule.field}
        options={profile.fields.map((f) => ({ value: f.key, label: f.label, hint: f.key }))}
        onChange={(field) => onChange({ ...rule, field } as LogicRule)}
      />
      <div className="grid grid-cols-2 gap-1.5">
        <Select value={rule.op} onChange={(e) => onChange(withOp(rule, e.target.value as LeafOp))}>
          {LEAF_OPS.map((op) => (
            <option key={op} value={op}>
              {t(`ops.${op}`)}
            </option>
          ))}
        </Select>
        <ValueInput rule={rule} onChange={onChange} profile={profile} users={users} />
      </div>
    </div>
  )
}

function GroupEditor({
  rule,
  onChange,
  profile,
  users,
  depth,
}: {
  rule: LogicRule
  onChange: (rule: LogicRule) => void
  profile: FlowSubjectProfile
  users: OrgUser[]
  depth: number
}) {
  const t = useTranslations('admin.flows.logic')
  const op = rule.op as GroupOp
  const children = groupChildren(rule)
  const fallbackField = profile.fields[0]?.key ?? 'status'
  const setChildren = (next: LogicRule[]) => onChange(makeGroup(op, next, fallbackField))

  return (
    <div className="space-y-1.5">
      <Select
        value={op}
        className="w-36"
        onChange={(e) => onChange(makeGroup(e.target.value as GroupOp, children, fallbackField))}
      >
        <option value="and">{t('groupAnd')}</option>
        <option value="or">{t('groupOr')}</option>
        <option value="not">{t('groupNot')}</option>
      </Select>
      <div className="space-y-1.5 border-l-2 border-slate-200 pl-2.5 dark:border-slate-700">
        {children.map((child, i) => (
          <div key={i} className="flex items-start gap-1.5">
            <div className="min-w-0 flex-1">
              <RuleEditor
                rule={child}
                onChange={(next) => setChildren(children.map((c, j) => (j === i ? next : c)))}
                profile={profile}
                users={users}
                depth={depth + 1}
              />
            </div>
            {op !== 'not' ? (
              <button
                type="button"
                title={t('remove')}
                onClick={() => setChildren(children.filter((_, j) => j !== i))}
                className="mt-1.5 shrink-0 rounded p-1 text-slate-400 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950"
              >
                <X size={13} />
              </button>
            ) : null}
          </div>
        ))}
        {op !== 'not' ? (
          <div className="flex gap-1.5">
            <Button variant="outline" size="sm" onClick={() => setChildren([...children, defaultLeaf(fallbackField)])}>
              <Plus size={12} /> {t('addRule')}
            </Button>
            {depth < MAX_DEPTH ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setChildren([...children, { op: 'and', rules: [defaultLeaf(fallbackField)] }])}
              >
                <Plus size={12} /> {t('addGroup')}
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  )
}

function RuleEditor({
  rule,
  onChange,
  profile,
  users,
  depth,
}: {
  rule: LogicRule
  onChange: (rule: LogicRule) => void
  profile: FlowSubjectProfile
  users: OrgUser[]
  depth: number
}) {
  if (isGroup(rule)) {
    return <GroupEditor rule={rule} onChange={onChange} profile={profile} users={users} depth={depth} />
  }
  return (
    <LeafEditor
      rule={rule as Extract<LogicRule, { field: string }>}
      onChange={onChange}
      profile={profile}
      users={users}
    />
  )
}

/**
 * Root editor. Presents the rule as a group even when a bare leaf is stored
 * (a one-leaf `and` evaluates identically), so authors can always add rows.
 */
export function LogicRuleBuilder({
  rule,
  onChange,
  profile,
  users,
}: {
  rule: LogicRule
  onChange: (rule: LogicRule) => void
  profile: FlowSubjectProfile
  users: OrgUser[]
}) {
  const normalized: LogicRule = isGroup(rule) ? rule : { op: 'and', rules: [rule] }
  return (
    <GroupEditor rule={normalized} onChange={onChange} profile={profile} users={users} depth={0} />
  )
}
