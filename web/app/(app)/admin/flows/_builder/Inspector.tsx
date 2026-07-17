'use client'

import { Trash2 } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { Button, Input, Label } from '@openbooks/ui'
import type { FlowSubjectProfile } from '@openbooks/forms-core'
import type { FlowNode, NodeData, OrgRole, OrgUser } from './graph'
import { LogicRuleBuilder } from './LogicRuleBuilder'
import { TriggerEditor } from './TriggerEditor'
import { ActionEditor } from './ActionEditor'
import { GateEditor } from './GateEditor'

/**
 * Right-hand inspector: edits the selected node's payload, dispatching to
 * the per-kind editors. All edits flow up as a whole-NodeData replacement so
 * the canvas summary re-renders instantly.
 */

const KIND_BADGE: Record<NodeData['kind'], string> = {
  trigger:
    'bg-emerald-50 text-emerald-700 ring-emerald-200 dark:bg-emerald-950/50 dark:text-emerald-300 dark:ring-emerald-900',
  condition:
    'bg-amber-50 text-amber-700 ring-amber-200 dark:bg-amber-950/50 dark:text-amber-300 dark:ring-amber-900',
  action:
    'bg-sky-50 text-sky-700 ring-sky-200 dark:bg-sky-950/50 dark:text-sky-300 dark:ring-sky-900',
  gate: 'bg-violet-50 text-violet-700 ring-violet-200 dark:bg-violet-950/50 dark:text-violet-300 dark:ring-violet-900',
}

export function Inspector({
  node,
  profile,
  users,
  roles,
  permissions,
  onChange,
  onDelete,
}: {
  node: FlowNode | null
  profile: FlowSubjectProfile
  users: OrgUser[]
  roles: OrgRole[]
  permissions: string[]
  onChange: (id: string, data: NodeData) => void
  onDelete: (id: string) => void
}) {
  const t = useTranslations('admin.flows')

  if (!node) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center text-sm text-slate-400 dark:text-slate-500">
        {t('builder.inspector.empty')}
      </div>
    )
  }

  const data = node.data
  const patch = (next: NodeData) => onChange(node.id, next)

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-slate-200 px-4 py-3 dark:border-slate-800">
        <span
          className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ${KIND_BADGE[data.kind]}`}
        >
          {t(`node.${data.kind}`)}
        </span>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => onDelete(node.id)}
          className="text-red-600 hover:text-red-700 dark:text-red-400"
        >
          <Trash2 size={14} /> {t('builder.inspector.deleteNode')}
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {data.kind === 'trigger' ? (
          <TriggerEditor
            trigger={data.trigger}
            onChange={(trigger) => patch({ ...data, trigger })}
            profile={profile}
            users={users}
            permissions={permissions}
          />
        ) : null}

        {data.kind === 'condition' ? (
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label>{t('condition.label')}</Label>
              <Input
                value={data.label ?? ''}
                onChange={(e) => patch({ ...data, label: e.target.value || undefined })}
                placeholder={t('condition.labelPlaceholder')}
              />
            </div>
            <div className="space-y-1.5">
              <Label>{t('condition.rule')}</Label>
              <LogicRuleBuilder
                rule={data.rule}
                onChange={(rule) => patch({ ...data, rule })}
                profile={profile}
                users={users}
              />
            </div>
            <p className="rounded-md border border-dashed border-slate-200 p-3 text-xs text-slate-500 dark:border-slate-800 dark:text-slate-400">
              {t('condition.hint')}
            </p>
          </div>
        ) : null}

        {data.kind === 'action' ? (
          <ActionEditor
            action={data.action}
            onChange={(action) => patch({ ...data, action })}
            profile={profile}
            users={users}
            roles={roles}
          />
        ) : null}

        {data.kind === 'gate' ? (
          <GateEditor
            gate={data.gate}
            onChange={(gate) => patch({ ...data, gate })}
            profile={profile}
            users={users}
            roles={roles}
          />
        ) : null}
      </div>
    </div>
  )
}
