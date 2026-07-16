'use client'

import { useTranslations } from 'next-intl'
import { Input, Label } from '@openbooks/ui'
import type { AssigneeTarget, FlowSubjectProfile, GateData } from '@openbooks/forms-core'
import type { OrgUser } from './graph'
import { TargetRow, TargetsEditor, defaultTarget } from './TargetsEditor'

/**
 * Gate (approval) inspector: title, assignee quorum (any/all), typed
 * signature, and the reminder/escalation timers scanned by the scheduler.
 * Assignees are AssigneeTargets — the recipient editor minus literal emails.
 */

function HoursInput({
  value,
  onChange,
}: {
  value: number | undefined
  onChange: (v: number | undefined) => void
}) {
  return (
    <Input
      inputMode="numeric"
      value={value === undefined ? '' : String(value)}
      onChange={(e) => {
        const n = Number(e.target.value)
        onChange(e.target.value === '' || Number.isNaN(n) || n <= 0 ? undefined : n)
      }}
      placeholder="—"
    />
  )
}

export function GateEditor({
  gate,
  onChange,
  profile,
  users,
}: {
  gate: GateData
  onChange: (gate: GateData) => void
  profile: FlowSubjectProfile
  users: OrgUser[]
}) {
  const t = useTranslations('admin.flows')

  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <Label>{t('gate.title')}</Label>
        <Input
          value={gate.title}
          onChange={(e) => onChange({ ...gate, title: e.target.value })}
          placeholder={t('gate.titlePlaceholder')}
        />
      </div>

      <div className="space-y-1.5">
        <Label>{t('gate.assignees')}</Label>
        <TargetsEditor
          value={gate.assignees}
          onChange={(assignees) => onChange({ ...gate, assignees: assignees as AssigneeTarget[] })}
          profile={profile}
          users={users}
          allowEmail={false}
          addLabel={t('targets.addAssignee')}
        />
      </div>

      <div className="space-y-1.5">
        <Label>{t('gate.mode')}</Label>
        <div className="space-y-1">
          {(['any', 'all'] as const).map((mode) => (
            <label key={mode} className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300">
              <input
                type="radio"
                name="gate-mode"
                checked={gate.mode === mode}
                onChange={() => onChange({ ...gate, mode })}
                className="h-4 w-4 border-slate-300 text-teal-600 focus:ring-teal-500"
              />
              {mode === 'any' ? t('gate.modeAny') : t('gate.modeAll')}
            </label>
          ))}
        </div>
      </div>

      <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300">
        <input
          type="checkbox"
          checked={gate.signatureRequired ?? false}
          onChange={(e) => onChange({ ...gate, signatureRequired: e.target.checked || undefined })}
          className="h-4 w-4 rounded border-slate-300 text-teal-600 focus:ring-teal-500"
        />
        {t('gate.signature')}
      </label>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label>{t('gate.reminderAfter')}</Label>
          <HoursInput
            value={gate.reminderAfterHours}
            onChange={(reminderAfterHours) => onChange({ ...gate, reminderAfterHours })}
          />
        </div>
        <div className="space-y-1.5">
          <Label>{t('gate.escalateAfter')}</Label>
          <HoursInput
            value={gate.escalateAfterHours}
            onChange={(escalateAfterHours) => onChange({ ...gate, escalateAfterHours })}
          />
        </div>
      </div>

      <div className="space-y-1.5">
        <Label>{t('gate.escalateTo')}</Label>
        {gate.escalateTo ? (
          <TargetRow
            target={gate.escalateTo}
            onChange={(next) => onChange({ ...gate, escalateTo: next as AssigneeTarget })}
            onRemove={() => onChange({ ...gate, escalateTo: undefined })}
            profile={profile}
            users={users}
            allowEmail={false}
          />
        ) : (
          <button
            type="button"
            onClick={() =>
              onChange({ ...gate, escalateTo: defaultTarget('supervisor', profile, users) as AssigneeTarget })
            }
            className="w-full rounded-md border border-dashed border-slate-300 px-3 py-2 text-left text-sm text-slate-400 hover:border-slate-400 hover:text-slate-600 dark:border-slate-700 dark:hover:border-slate-500 dark:hover:text-slate-300"
          >
            {t('gate.noEscalation')}
          </button>
        )}
      </div>

      <p className="rounded-md border border-dashed border-slate-200 p-3 text-xs text-slate-500 dark:border-slate-800 dark:text-slate-400">
        {t('gate.hint')}
      </p>
    </div>
  )
}
