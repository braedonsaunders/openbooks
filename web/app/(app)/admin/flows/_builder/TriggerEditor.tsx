'use client'

import { useTranslations } from 'next-intl'
import { Button, Input, Label, Select } from '@openbooks/ui'
import type { FlowSubjectProfile, TriggerData, TriggerKind } from '@openbooks/forms-core'
import { buildTrigger, type OrgUser } from './graph'
import { LogicRuleBuilder } from './LogicRuleBuilder'

/**
 * Trigger inspector: kind picker plus per-kind config — status_change
 * from/to, on_field_value rule, scheduled cron, manual button chrome.
 * Switching kinds rebuilds a schema-valid default via buildTrigger.
 */
export function TriggerEditor({
  trigger,
  onChange,
  profile,
  users,
}: {
  trigger: TriggerData
  onChange: (trigger: TriggerData) => void
  profile: FlowSubjectProfile
  users: OrgUser[]
}) {
  const t = useTranslations('admin.flows')

  const statusSelect = (
    value: string | undefined,
    set: (v: string | undefined) => void,
  ) => (
    <Select value={value ?? ''} onChange={(e) => set(e.target.value || undefined)}>
      <option value="">{t('trigger.anyStatus')}</option>
      {profile.statuses.map((s) => (
        <option key={s.value} value={s.value}>
          {s.label}
        </option>
      ))}
    </Select>
  )

  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <Label>{t('trigger.kind')}</Label>
        <Select
          value={trigger.trigger}
          onChange={(e) => onChange(buildTrigger(e.target.value as TriggerKind, profile))}
        >
          {profile.triggers.map((k) => (
            <option key={k} value={k}>
              {t(`trigger.kinds.${k}`)}
            </option>
          ))}
        </Select>
      </div>

      {trigger.trigger === 'status_change' ? (
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label>{t('trigger.from')}</Label>
            {statusSelect(trigger.from, (from) => onChange({ ...trigger, from }))}
          </div>
          <div className="space-y-1.5">
            <Label>{t('trigger.to')}</Label>
            {statusSelect(trigger.to, (to) => onChange({ ...trigger, to }))}
          </div>
        </div>
      ) : null}

      {trigger.trigger === 'on_field_value' ? (
        <div className="space-y-1.5">
          <Label>{t('trigger.rule')}</Label>
          <LogicRuleBuilder
            rule={trigger.rule}
            onChange={(rule) => onChange({ ...trigger, rule })}
            profile={profile}
            users={users}
          />
        </div>
      ) : null}

      {trigger.trigger === 'scheduled' ? (
        <>
          <div className="space-y-1.5">
            <Label>
              {t('trigger.cron')}{' '}
              <span className="font-normal text-slate-400">{t('trigger.cronHint')}</span>
            </Label>
            <Input
              value={trigger.cron}
              onChange={(e) => onChange({ ...trigger, cron: e.target.value })}
              placeholder="0 8 * * 1"
              className="font-mono text-[13px]"
            />
            <p className="text-xs text-slate-500 dark:text-slate-400">{t('trigger.cronExample')}</p>
          </div>
          <div className="space-y-1.5">
            <Label>{t('trigger.timezone')}</Label>
            <Input
              value={trigger.tz ?? ''}
              onChange={(e) => onChange({ ...trigger, tz: e.target.value || undefined })}
              placeholder="America/Toronto"
            />
          </div>
        </>
      ) : null}

      {trigger.trigger === 'manual' ? (
        <>
          <div className="space-y-1.5">
            <Label>{t('trigger.buttonLabel')}</Label>
            <Input
              value={trigger.label}
              onChange={(e) => onChange({ ...trigger, label: e.target.value })}
            />
          </div>
          <div className="space-y-1.5">
            <Label>{t('trigger.confirmText')}</Label>
            <Input
              value={trigger.confirm ?? ''}
              onChange={(e) => onChange({ ...trigger, confirm: e.target.value || undefined })}
            />
          </div>
          <div className="space-y-1.5">
            <Label>{t('trigger.requirePermission')}</Label>
            <Input
              value={trigger.requirePermission ?? ''}
              onChange={(e) =>
                onChange({ ...trigger, requirePermission: e.target.value || undefined })
              }
              placeholder="ap.post"
              className="font-mono text-[13px]"
            />
          </div>
          <div className="space-y-1.5">
            <Label>{t('trigger.showIf')}</Label>
            {trigger.showIf ? (
              <>
                <LogicRuleBuilder
                  rule={trigger.showIf}
                  onChange={(showIf) => onChange({ ...trigger, showIf })}
                  profile={profile}
                  users={users}
                />
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => onChange({ ...trigger, showIf: undefined })}
                >
                  {t('trigger.showIfRemove')}
                </Button>
              </>
            ) : (
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  onChange({
                    ...trigger,
                    showIf: { op: 'isSet', field: profile.fields[0]?.key ?? 'status' },
                  })
                }
              >
                {t('trigger.showIfAdd')}
              </Button>
            )}
          </div>
        </>
      ) : null}
    </div>
  )
}
