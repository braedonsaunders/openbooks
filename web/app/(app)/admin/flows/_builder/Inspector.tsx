'use client'

import { useState } from 'react'
import { Trash2 } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { Button, Input, Label, Select } from '@openbooks/ui'
import type { FlowSubjectProfile } from '@openbooks/forms-core'
import {
  connectHandles,
  connectTargets,
  type ConnectRequest,
  type FlowNode,
  type NodeData,
  type OrgRole,
  type OrgUser,
} from './graph'
import { nodeAccessibleName } from './nodes'
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
  nodes,
  profile,
  users,
  roles,
  permissions,
  onChange,
  onDelete,
  onConnect,
}: {
  node: FlowNode | null
  nodes: FlowNode[]
  profile: FlowSubjectProfile
  users: OrgUser[]
  roles: OrgRole[]
  permissions: string[]
  onChange: (id: string, data: NodeData) => void
  onDelete: (id: string) => void
  onConnect: (req: ConnectRequest) => boolean
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

        <ConnectSection key={node.id} node={node} nodes={nodes} onConnect={onConnect} />
      </div>
    </div>
  )
}

/**
 * Keyboard/button edge path for the selected node: pick a source handle
 * (branch nodes) and a successor step, then Connect. Builds through the
 * same buildConnectEdge the pointer onConnect uses — never a second edge
 * path — so a keyboard-connected edge validates exactly like a dragged one.
 */
function ConnectSection({
  node,
  nodes,
  onConnect,
}: {
  node: FlowNode
  nodes: FlowNode[]
  onConnect: (req: ConnectRequest) => boolean
}) {
  const t = useTranslations('admin.flows')
  const handles = connectHandles(node.data.kind)
  const targets = connectTargets(node.id, nodes)
  const [handle, setHandle] = useState(handles[0] ?? 'next')
  const [targetId, setTargetId] = useState('')

  return (
    <section aria-label={t('builder.inspector.connectTitle')} className="mt-6 space-y-3 border-t border-slate-200 pt-4 dark:border-slate-800">
      <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
        {t('builder.inspector.connectTitle')}
      </h3>
      {targets.length === 0 ? (
        <p className="text-xs text-slate-500 dark:text-slate-400">{t('builder.inspector.connectEmpty')}</p>
      ) : (
        <>
          {handles.length > 1 ? (
            <div className="space-y-1.5">
              <Label>{t('builder.inspector.connectFrom')}</Label>
              <Select value={handle} onChange={(e) => setHandle(e.target.value)}>
                {handles.map((h) => (
                  <option key={h} value={h}>
                    {t(`edge.${h}`)}
                  </option>
                ))}
              </Select>
            </div>
          ) : null}
          <div className="space-y-1.5">
            <Label>{t('builder.inspector.connectTo')}</Label>
            <Select value={targetId} onChange={(e) => setTargetId(e.target.value)}>
              <option value="">{t('builder.inspector.connectPlaceholder')}</option>
              {targets.map((target) => (
                <option key={target.id} value={target.id}>
                  {nodeAccessibleName(t, target.data)}
                </option>
              ))}
            </Select>
          </div>
          <Button
            size="sm"
            disabled={!targetId}
            onClick={() => {
              if (onConnect({ source: node.id, sourceHandle: handle, target: targetId })) {
                setTargetId('')
              }
            }}
          >
            {t('builder.inspector.connectAction')}
          </Button>
        </>
      )}
    </section>
  )
}
