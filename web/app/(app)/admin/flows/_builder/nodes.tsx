'use client'

import { Handle, Position, type NodeProps } from '@xyflow/react'
import { GitBranch, ShieldCheck, Zap, Play } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { cn } from '@openbooks/ui'
import type { ActionData, TriggerData } from '@openbooks/forms-core'
import type { NodeData } from './graph'

/**
 * The four canvas node cards. Handles encode the branch vocabulary:
 * trigger/action expose one 'next' source; condition exposes 'then'/'else';
 * gate exposes 'approve'/'reject'. Every non-trigger node has one target.
 */

const CARD =
  'w-52 rounded-lg border bg-white px-3 py-2 text-xs shadow-sm transition-shadow dark:bg-slate-900'
const SELECTED = 'border-teal-500 ring-2 ring-teal-500/40'
const HANDLE_STYLE = { width: 9, height: 9 }

function BranchHandles({ a, b }: { a: string; b: string }) {
  return (
    <>
      <Handle type="source" position={Position.Right} id={a} style={{ ...HANDLE_STYLE, top: '38%' }} />
      <Handle type="source" position={Position.Right} id={b} style={{ ...HANDLE_STYLE, top: '72%' }} />
    </>
  )
}

export function triggerSummary(t: (key: string) => string, d: TriggerData): string {
  switch (d.trigger) {
    case 'status_change':
      return `${d.from ?? '*'} → ${d.to ?? '*'}`
    case 'scheduled':
      return d.cron
    case 'manual':
      return d.label
    case 'on_field_value':
      return t('trigger.kinds.on_field_value')
    default:
      return t(`trigger.kinds.${d.trigger}`)
  }
}

export function actionSummary(t: (key: string) => string, d: ActionData): string {
  switch (d.action) {
    case 'send_email':
      return d.subject || t('action.kinds.send_email')
    case 'notify':
      return d.title || t('action.kinds.notify')
    case 'set_field':
      return `${d.field} = …`
    case 'change_status':
      return `→ ${d.to}`
    case 'post_document':
      return t('action.kinds.post_document')
    case 'lock_record':
      return d.exemptRoles?.length
        ? `${t('action.kinds.lock_record')} (${d.exemptRoles.join(', ')})`
        : t('action.kinds.lock_record')
    case 'unlock_record':
      return t('action.kinds.unlock_record')
  }
}

function TriggerNode({ data, selected }: NodeProps) {
  const t = useTranslations('admin.flows')
  const d = data as Extract<NodeData, { kind: 'trigger' }>
  return (
    <div className={cn(CARD, selected ? SELECTED : 'border-emerald-300 dark:border-emerald-800')}>
      <div className="flex items-center gap-1.5 font-semibold text-emerald-700 dark:text-emerald-400">
        <Zap size={13} /> {t('node.trigger')}
      </div>
      <div className="mt-0.5 truncate text-slate-600 dark:text-slate-400">
        {t(`trigger.kinds.${d.trigger.trigger}`)}
      </div>
      {d.trigger.trigger === 'status_change' || d.trigger.trigger === 'scheduled' || d.trigger.trigger === 'manual' ? (
        <div className="truncate font-mono text-[10px] text-slate-400 dark:text-slate-500">
          {triggerSummary(t, d.trigger)}
        </div>
      ) : null}
      <Handle type="source" position={Position.Right} id="next" style={HANDLE_STYLE} />
    </div>
  )
}

function ConditionNode({ data, selected }: NodeProps) {
  const t = useTranslations('admin.flows')
  const d = data as Extract<NodeData, { kind: 'condition' }>
  return (
    <div className={cn(CARD, 'relative', selected ? SELECTED : 'border-amber-300 dark:border-amber-800')}>
      <Handle type="target" position={Position.Left} style={HANDLE_STYLE} />
      <div className="flex items-center gap-1.5 font-semibold text-amber-700 dark:text-amber-400">
        <GitBranch size={13} /> {t('node.condition')}
      </div>
      <div className="mt-0.5 truncate text-slate-600 dark:text-slate-400">
        {d.label || t('node.conditionDefault')}
      </div>
      <BranchHandles a="then" b="else" />
    </div>
  )
}

function ActionNode({ data, selected }: NodeProps) {
  const t = useTranslations('admin.flows')
  const d = data as Extract<NodeData, { kind: 'action' }>
  return (
    <div className={cn(CARD, selected ? SELECTED : 'border-sky-300 dark:border-sky-800')}>
      <Handle type="target" position={Position.Left} style={HANDLE_STYLE} />
      <div className="flex items-center gap-1.5 font-semibold text-sky-700 dark:text-sky-400">
        <Play size={13} /> {t(`action.kinds.${d.action.action}`)}
      </div>
      <div className="mt-0.5 truncate text-slate-600 dark:text-slate-400">
        {actionSummary(t, d.action)}
      </div>
      <Handle type="source" position={Position.Right} id="next" style={HANDLE_STYLE} />
    </div>
  )
}

function GateNode({ data, selected }: NodeProps) {
  const t = useTranslations('admin.flows')
  const d = data as Extract<NodeData, { kind: 'gate' }>
  return (
    <div className={cn(CARD, 'relative', selected ? SELECTED : 'border-violet-300 dark:border-violet-800')}>
      <Handle type="target" position={Position.Left} style={HANDLE_STYLE} />
      <div className="flex items-center gap-1.5 font-semibold text-violet-700 dark:text-violet-400">
        <ShieldCheck size={13} /> {t('node.gate')}
      </div>
      <div className="mt-0.5 truncate text-slate-600 dark:text-slate-400">
        {d.gate.title || t('node.gateDefault')}
      </div>
      <div className="truncate text-[10px] text-slate-400 dark:text-slate-500">
        {d.gate.assignees.length} · {d.gate.mode}
      </div>
      <BranchHandles a="approve" b="reject" />
    </div>
  )
}

/** Stable module-level map — React Flow requires a constant nodeTypes ref. */
export const NODE_TYPES = {
  trigger: TriggerNode,
  condition: ConditionNode,
  action: ActionNode,
  gate: GateNode,
}
