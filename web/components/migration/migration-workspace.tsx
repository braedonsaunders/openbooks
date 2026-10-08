'use client'

import { useCallback, useMemo, useRef } from 'react'
import { useTranslations } from 'next-intl'
import { AssistantApp, type AssistantWorkspace, type ConversationSummary, type StoredMessage } from '@/components/assistant/assistant-app'
import { MIGRATION_WORKSPACE_HREF } from '@/lib/migration/links'
import { stageImportAttachment } from '@/lib/migration/stage-attachment'
import type { MigrationJourney } from '@/lib/migration/journey'
import { MigrationPlanPanel, type MigrationPlanPanelHandle } from './migration-plan-panel'
import { MigrationWelcome } from './migration-welcome'

export interface MigrationWorkspaceProps {
  conversations: ConversationSummary[]
  activeId: string | null
  initialMessages: StoredMessage[]
  canWrite: boolean
  canConfigureAi: boolean
  aiEnabled: boolean
  canImport: boolean
  journey: MigrationJourney
  initialPrompt?: string
}

/**
 * The migration workspace: the assistant conversation, scoped to migration,
 * beside the measured migration plan. Files dropped into the conversation are
 * staged through the native durable import for the assistant to read.
 */
export function MigrationWorkspace(props: MigrationWorkspaceProps) {
  const t = useTranslations('sync.migrationAssistant')
  const panel = useRef<MigrationPlanPanelHandle>(null)
  const refreshPlan = useCallback(() => panel.current?.refresh(), [])
  const sourceHint = props.journey.facts.bookStart === 'migrate' && !props.journey.plan.path ? t('welcome.fromWizard') : null

  const workspace = useMemo<AssistantWorkspace>(() => ({
    mode: 'migration',
    basePath: MIGRATION_WORKSPACE_HREF,
    title: t('title'),
    placeholder: t('placeholder'),
    welcome: function Welcome({ onPick }) { return <MigrationWelcome onPick={onPick} sourceHint={sourceHint} /> },
    aside: <MigrationPlanPanel initial={props.journey} handle={panel} />,
    asideLabel: t('plan.toggle'),
    attach: props.canImport ? {
      accept: '.csv,.txt,.xlsx,.json',
      label: t('attach.label'),
      stage: (file, onProgress) => stageImportAttachment(file, {
        unsupported: t('attach.unsupported'),
        noImport: t('attach.noImport'),
        uploading: (name) => t('attach.uploading', { name }),
        reading: (name) => t('attach.reading', { name }),
        staged: (name, id, rows) => t('attach.message', { name, id, rows }),
        stillReading: (name, id) => t('attach.messageStillReading', { name, id }),
        failed: (name, reason) => t('attach.failed', { name, reason }),
      }, onProgress),
    } : undefined,
    onTurnSettled: refreshPlan,
  }), [props.canImport, props.journey, refreshPlan, sourceHint, t])

  return (
    <AssistantApp
      conversations={props.conversations}
      activeId={props.activeId}
      initialMessages={props.initialMessages}
      canWrite={props.canWrite}
      canConfigureAi={props.canConfigureAi}
      aiEnabled={props.aiEnabled}
      initialPrompt={props.initialPrompt}
      workspace={workspace}
    />
  )
}
