'use client'

import { useTranslations } from 'next-intl'
import { Input, Label, Select, Textarea } from '@openbooks/ui'
import type { ActionData, ActionKind, FlowSubjectProfile } from '@openbooks/forms-core'
import { buildAction, type OrgUser } from './graph'
import { TargetsEditor } from './TargetsEditor'

/**
 * Action inspector: kind picker plus per-kind editors. Email/notify bodies
 * support {{field}} interpolation — the hint lists the subject's tokens.
 * Switching kinds rebuilds a schema-valid default via buildAction.
 */

function FieldTokensHint({ profile }: { profile: FlowSubjectProfile }) {
  const t = useTranslations('admin.flows.action')
  return (
    <details className="rounded-md border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-xs text-slate-500 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-400">
      <summary className="cursor-pointer select-none">{t('interpolationHint')}</summary>
      <div className="mt-1.5 flex flex-wrap gap-1">
        {profile.fields.map((f) => (
          <code
            key={f.key}
            title={f.label}
            className="rounded bg-white px-1 py-0.5 font-mono text-[10px] text-slate-600 ring-1 ring-slate-200 dark:bg-slate-950 dark:text-slate-300 dark:ring-slate-700"
          >
            {`{{${f.key}}}`}
          </code>
        ))}
      </div>
    </details>
  )
}

export function ActionEditor({
  action,
  onChange,
  profile,
  users,
}: {
  action: ActionData
  onChange: (action: ActionData) => void
  profile: FlowSubjectProfile
  users: OrgUser[]
}) {
  const t = useTranslations('admin.flows')
  const writableFields = profile.fields.filter((f) => f.writable)

  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <Label>{t('action.kind')}</Label>
        <Select
          value={action.action}
          onChange={(e) => onChange(buildAction(e.target.value as ActionKind, profile))}
        >
          {profile.actions.map((k) => (
            <option key={k} value={k}>
              {t(`action.kinds.${k}`)}
            </option>
          ))}
        </Select>
      </div>

      {action.action === 'send_email' ? (
        <>
          <div className="space-y-1.5">
            <Label>{t('action.recipients')}</Label>
            <TargetsEditor
              value={action.to}
              onChange={(to) => onChange({ ...action, to })}
              profile={profile}
              users={users}
              allowEmail
              addLabel={t('targets.add')}
            />
          </div>
          <div className="space-y-1.5">
            <Label>{t('action.subject')}</Label>
            <Input
              value={action.subject}
              onChange={(e) => onChange({ ...action, subject: e.target.value })}
            />
          </div>
          <div className="space-y-1.5">
            <Label>{t('action.body')}</Label>
            <Textarea
              rows={6}
              value={action.body}
              onChange={(e) => onChange({ ...action, body: e.target.value })}
            />
          </div>
          <FieldTokensHint profile={profile} />
        </>
      ) : null}

      {action.action === 'notify' ? (
        <>
          <div className="space-y-1.5">
            <Label>{t('action.recipients')}</Label>
            <TargetsEditor
              value={action.to}
              onChange={(to) => onChange({ ...action, to })}
              profile={profile}
              users={users}
              allowEmail
              addLabel={t('targets.add')}
            />
          </div>
          <div className="space-y-1.5">
            <Label>{t('action.title')}</Label>
            <Input
              value={action.title}
              onChange={(e) => onChange({ ...action, title: e.target.value })}
            />
          </div>
          <div className="space-y-1.5">
            <Label>{t('action.notifyBody')}</Label>
            <Textarea
              rows={3}
              value={action.body ?? ''}
              onChange={(e) => onChange({ ...action, body: e.target.value || undefined })}
            />
          </div>
          <div className="space-y-1.5">
            <Label>{t('action.href')}</Label>
            <Input
              value={action.href ?? ''}
              onChange={(e) => onChange({ ...action, href: e.target.value || undefined })}
              placeholder="/approvals"
            />
          </div>
          <FieldTokensHint profile={profile} />
        </>
      ) : null}

      {action.action === 'set_field' ? (
        <>
          <div className="space-y-1.5">
            <Label>{t('action.field')}</Label>
            <Select
              value={action.field}
              onChange={(e) => onChange({ ...action, field: e.target.value })}
            >
              {writableFields.map((f) => (
                <option key={f.key} value={f.key}>
                  {f.label}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>{t('action.value')}</Label>
            <Input
              value={
                action.value.kind === 'literal' ? String(action.value.value ?? '') : ''
              }
              onChange={(e) => {
                const raw = e.target.value
                const type = profile.fields.find((f) => f.key === action.field)?.type
                const value =
                  type === 'number' && raw !== '' && !Number.isNaN(Number(raw))
                    ? Number(raw)
                    : raw
                onChange({ ...action, value: { kind: 'literal', value } })
              }}
            />
          </div>
        </>
      ) : null}

      {action.action === 'change_status' ? (
        <div className="space-y-1.5">
          <Label>{t('action.status')}</Label>
          <Select value={action.to} onChange={(e) => onChange({ ...action, to: e.target.value })}>
            {profile.statuses.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </Select>
        </div>
      ) : null}

      {action.action === 'webhook' ? (
        <>
          <div className="space-y-1.5">
            <Label>{t('action.url')}</Label>
            <Input
              value={action.url}
              onChange={(e) => onChange({ ...action, url: e.target.value })}
              placeholder="https://example.com/hooks/openbooks"
              className="font-mono text-[13px]"
            />
          </div>
          <div className="space-y-1.5">
            <Label>{t('action.method')}</Label>
            <Select
              value={action.method}
              onChange={(e) => onChange({ ...action, method: e.target.value as 'POST' | 'PUT' })}
            >
              <option value="POST">POST</option>
              <option value="PUT">PUT</option>
            </Select>
          </div>
          <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300">
            <input
              type="checkbox"
              checked={action.includeRecord ?? false}
              onChange={(e) => onChange({ ...action, includeRecord: e.target.checked || undefined })}
              className="h-4 w-4 rounded border-slate-300 text-teal-600 focus:ring-teal-500"
            />
            {t('action.includeRecord')}
          </label>
        </>
      ) : null}

      {action.action === 'post_document' ? (
        <p className="rounded-md border border-dashed border-slate-200 p-3 text-xs text-slate-500 dark:border-slate-800 dark:text-slate-400">
          {t('action.postDocumentHint')}
        </p>
      ) : null}

      {action.action === 'lock_record' ? (
        <>
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-500 dark:text-slate-400">
              {t('action.lockReason')}
            </label>
            <Input
              value={action.reason ?? ''}
              onChange={(e) => onChange({ ...action, reason: e.target.value || undefined })}
              placeholder={t('action.lockReasonPlaceholder')}
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-500 dark:text-slate-400">
              {t('action.lockExemptRoles')}
            </label>
            <div className="flex flex-wrap gap-2">
              {(profile.roles ?? []).map((role) => {
                const selected = action.exemptRoles?.includes(role) ?? false
                return (
                  <button
                    key={role}
                    type="button"
                    onClick={() => {
                      const next = selected
                        ? (action.exemptRoles ?? []).filter((r) => r !== role)
                        : [...(action.exemptRoles ?? []), role]
                      onChange({ ...action, exemptRoles: next.length > 0 ? next : undefined })
                    }}
                    className={
                      selected
                        ? 'rounded-full border border-teal-500 bg-teal-50 px-2.5 py-0.5 text-xs text-teal-700 dark:bg-teal-950 dark:text-teal-300'
                        : 'rounded-full border border-slate-200 px-2.5 py-0.5 text-xs text-slate-500 dark:border-slate-700 dark:text-slate-400'
                    }
                  >
                    {role}
                  </button>
                )
              })}
            </div>
            <p className="mt-1 text-xs text-slate-400 dark:text-slate-500">{t('action.lockExemptHint')}</p>
          </div>
        </>
      ) : null}

      {action.action === 'unlock_record' ? (
        <p className="rounded-md border border-dashed border-slate-200 p-3 text-xs text-slate-500 dark:border-slate-800 dark:text-slate-400">
          {t('action.unlockHint')}
        </p>
      ) : null}
    </div>
  )
}
