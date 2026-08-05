'use client'

import { Plus, X } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { Button, Input, SearchSelect, Select } from '@openbooks/ui'
import type { FlowSubjectProfile, RecipientTarget } from '@openbooks/forms-core'
import type { OrgRole, OrgUser } from './graph'

/**
 * Assignee / recipient target editors. One row = one target; the type select
 * swaps the detail input (user picker, role picker, field picker, email
 * list). Gates use `allowEmail=false` (AssigneeTarget is RecipientTarget
 * minus the literal-email variant), emails/notifications allow all six.
 */

type TargetType = RecipientTarget['type']

const ASSIGNEE_TYPES: TargetType[] = ['user', 'role', 'submitter', 'supervisor', 'field']
const RECIPIENT_TYPES: TargetType[] = [...ASSIGNEE_TYPES, 'email']

export function defaultTarget(
  type: TargetType,
  profile: FlowSubjectProfile,
  users: OrgUser[],
): RecipientTarget {
  switch (type) {
    case 'user':
      return { type: 'user', userId: users[0]?.id ?? '' }
    case 'role':
      return { type: 'role', role: profile.roles?.[0] ?? '' }
    case 'field':
      return {
        type: 'field',
        field:
          profile.fields.find((f) => f.type === 'user')?.key ?? profile.fields[0]?.key ?? '',
      }
    case 'email':
      return { type: 'email', email: '' }
    case 'supervisor':
      return { type: 'supervisor' }
    default:
      return { type: 'submitter' }
  }
}

export function TargetRow({
  target,
  onChange,
  onRemove,
  profile,
  users,
  roles,
  allowEmail,
}: {
  target: RecipientTarget
  onChange: (target: RecipientTarget) => void
  onRemove?: () => void
  profile: FlowSubjectProfile
  users: OrgUser[]
  roles: OrgRole[]
  allowEmail: boolean
}) {
  const t = useTranslations('admin.flows.targets')
  const types = allowEmail ? RECIPIENT_TYPES : ASSIGNEE_TYPES
  // Fields holding a user id first — those are what `field` targets resolve.
  const fieldOptions = [...profile.fields]
    .sort((a, b) => Number(b.type === 'user') - Number(a.type === 'user'))
    .map((f) => ({ value: f.key, label: f.label, hint: f.key }))

  return (
    <div className="space-y-1.5 rounded-md border border-slate-200 p-2 dark:border-slate-700">
      <div className="flex items-center gap-1.5">
        <Select
          value={target.type}
          onChange={(e) => onChange(defaultTarget(e.target.value as TargetType, profile, users))}
        >
          {types.map((k) => (
            <option key={k} value={k}>
              {t(`types.${k}`)}
            </option>
          ))}
        </Select>
        {onRemove ? (
          <button
            type="button"
            title={t('remove')}
            onClick={onRemove}
            className="shrink-0 rounded p-1 text-slate-400 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950"
          >
            <X size={14} />
          </button>
        ) : null}
      </div>
      {target.type === 'user' ? (
        <SearchSelect
          value={target.userId}
          options={users.map((u) => ({ value: u.id, label: u.name, hint: u.email }))}
          placeholder={t('pickUser')}
          onChange={(userId) => onChange({ type: 'user', userId })}
        />
      ) : null}
      {target.type === 'role' ? (
        <Select value={target.role} onChange={(e) => onChange({ type: 'role', role: e.target.value })}>
          <option value="">{t('pickRole')}</option>
          {(profile.roles ?? []).map((r) => (
            <option key={r} value={r}>
              {roles.find((role) => role.key === r)?.name ?? r}
            </option>
          ))}
        </Select>
      ) : null}
      {target.type === 'field' ? (
        <SearchSelect
          value={target.field}
          options={fieldOptions}
          placeholder={t('pickField')}
          onChange={(field) => onChange({ type: 'field', field })}
        />
      ) : null}
      {target.type === 'email' ? (
        <Input
          value={target.email}
          placeholder={t('emailPlaceholder')}
          onChange={(e) => onChange({ type: 'email', email: e.target.value })}
        />
      ) : null}
    </div>
  )
}

export function TargetsEditor({
  value,
  onChange,
  profile,
  users,
  roles,
  allowEmail,
  addLabel,
}: {
  value: RecipientTarget[]
  onChange: (value: RecipientTarget[]) => void
  profile: FlowSubjectProfile
  users: OrgUser[]
  roles: OrgRole[]
  allowEmail: boolean
  addLabel: string
}) {
  const rows = value.length > 0 ? value : [{ type: 'submitter' } as RecipientTarget]
  return (
    <div className="space-y-2">
      {rows.map((target, i) => (
        <TargetRow
          key={i}
          target={target}
          onChange={(next) => onChange(rows.map((r, j) => (j === i ? next : r)))}
          onRemove={rows.length > 1 ? () => onChange(rows.filter((_, j) => j !== i)) : undefined}
          profile={profile}
          users={users}
          roles={roles}
          allowEmail={allowEmail}
        />
      ))}
      <Button variant="outline" size="sm" onClick={() => onChange([...rows, { type: 'submitter' }])}>
        <Plus size={13} /> {addLabel}
      </Button>
    </div>
  )
}
