import { Fragment, type ComponentProps } from 'react'
import { AssistantApp } from '../assistant/assistant-app'
import { ChatMarkdown } from '../assistant/markdown'
import { AgentsLastRunCell } from '../../app/(app)/admin/setup/agents/AgentsLastRunCell'
import { AgentsPackActions } from '../../app/(app)/admin/setup/agents/AgentsPackActions'
import { AgentsPackFindings } from '../../app/(app)/admin/setup/agents/AgentsPackFindings'
import { AgentsPackCard } from '../../app/(app)/admin/setup/agents/library/AgentsPackCard'
import { AgentPolicyForm } from '../../app/(app)/admin/setup/agents/[agentKey]/AgentPolicyForm'
import { AgentsRunActions } from '../../app/(app)/admin/setup/agents/activity/AgentsRunActions'
import { AgentsTriageKeys } from '../../app/(app)/agents/AgentsTriageKeys'
import { MovedNotice } from '../../app/(app)/agents/MovedNotice'
import { AgentsBriefingActions } from '../../app/(app)/agents/AgentsBriefingActions'
import { KpiStrip } from '../kpi-strip'
import { TabNav, Metric, ReportsCardHeading, NarrativeEntry, FindingCell } from '../../app/(app)/continuous-close/sections'
import { WorkItemDrawer } from '../../app/(app)/continuous-close/WorkItemDrawer'
import { NarrativeDrawer } from '../../app/(app)/continuous-close/NarrativeDrawer'
import { Badge } from '@openbooks/ui'
import { num, str, type WidgetRenderer } from './widget-props'

/** Agentic operations adapters: workbench, assistant handoff and continuous close. Compose native components without changing their props or boundaries. */
export const AGENTS_WIDGETS = {
  /** Due-date cell: the formatted date plus a red Overdue pill when past
   *  due — the house date-plus-flag arrangement, one cell. */
  'agents-due-cell': (props) => {
    const date = str(props, 'date')
    const overdueLabel = str(props, 'overdueLabel')
    if (!date && !overdueLabel) return null
    return (
      <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
        {date ? <span>{date}</span> : null}
        {overdueLabel ? <Badge variant="destructive">{overdueLabel}</Badge> : null}
      </span>
    )
  },
  /** One pack's last-run cell: run-status badge, relative instant, muted next run. */
  'agents-pack-last-run': (props) => (
    <AgentsLastRunCell
      hasRun={props.hasRun === true}
      statusLabel={str(props, 'statusLabel') ?? ''}
      statusVariant={
        (props.statusVariant as ComponentProps<typeof AgentsLastRunCell>['statusVariant']) ?? 'secondary'
      }
      dateLine={str(props, 'dateLine') ?? ''}
      nextLine={str(props, 'nextLine') ?? null}
    />
  ),
  /** One pack's open-findings cell: link when above zero, muted text at zero. */
  'agents-pack-findings': (props) => (
    <AgentsPackFindings
      openFindings={typeof props.openFindings === 'number' ? props.openFindings : 0}
      findingsLine={str(props, 'findingsLine') ?? ''}
      reviewHref={str(props, 'reviewHref') ?? ''}
    />
  ),
  /** One pack's fenced enable switch + run-now for the Agents overview table. */
  'agents-pack-actions': (props) => (
    <AgentsPackActions
      agentKey={str(props, 'agentKey') ?? ''}
      policy={(props.policy as ComponentProps<typeof AgentsPackActions>['policy']) ?? {}}
      packTitle={str(props, 'packTitle') ?? ''}
      enabled={props.enabled === true}
      featureEnabled={props.featureEnabled === true}
      configureHref={str(props, 'configureHref') ?? ''}
      configureLabel={str(props, 'configureLabel') ?? ''}
    />
  ),
  /** One agent-pack marketplace card: medallion, reads/proposes, checks, install/configure footer. */
  'agents-pack-card': (props) => (
    <AgentsPackCard
      agentKey={str(props, 'agentKey') ?? ''}
      name={str(props, 'name') ?? ''}
      description={str(props, 'description') ?? ''}
      reads={str(props, 'reads') ?? ''}
      proposes={str(props, 'proposes') ?? ''}
      installed={props.installed === true}
      installedLabel={str(props, 'installedLabel') ?? ''}
      installLabel={str(props, 'installLabel') ?? ''}
      installPolicy={(props.installPolicy as ComponentProps<typeof AgentsPackCard>['installPolicy']) ?? {}}
      featureEnabled={props.featureEnabled === true}
      permissions={(props.permissions as string[]) ?? []}
      needsLabel={str(props, 'needsLabel') ?? ''}
      moduleLine={str(props, 'moduleLine') ?? ''}
      readsLabel={str(props, 'readsLabel') ?? ''}
      proposesLabel={str(props, 'proposesLabel') ?? ''}
      checksTitle={str(props, 'checksTitle') ?? ''}
      checksNote={str(props, 'checksNote') ?? ''}
      detectors={(props.detectors as ComponentProps<typeof AgentsPackCard>['detectors']) ?? []}
      configureHref={str(props, 'configureHref') ?? ''}
      configureLabel={str(props, 'configureLabel') ?? ''}
    />
  ),
  /** One pack's policy form: shared Card sections, shared form fields. */
  'agents-policy-form': (props) => (
    <AgentPolicyForm
      statusLabel={str(props, 'statusLabel') ?? ''}
      statusEnabled={props.statusEnabled === true}
      description={str(props, 'description') ?? ''}
      runLine={str(props, 'runLine') ?? ''}
      currency={str(props, 'currency') ?? ''}
      pack={props.pack as ComponentProps<typeof AgentPolicyForm>['pack']}
      specs={(props.specs as ComponentProps<typeof AgentPolicyForm>['specs']) ?? []}
      notification={(props.notification as ComponentProps<typeof AgentPolicyForm>['notification']) ?? null}
      roles={(props.roles as ComponentProps<typeof AgentPolicyForm>['roles']) ?? []}
      users={(props.users as ComponentProps<typeof AgentPolicyForm>['users']) ?? []}
      usersTruncated={props.usersTruncated === true}
      featureEnabled={props.featureEnabled === true}
    />
  ),
  /** One run's findings link + re-run for the Agents activity table. */
  'agents-run-actions': (props) => (
    <AgentsRunActions
      agentKey={str(props, 'agentKey') ?? ''}
      findingsHref={str(props, 'findingsHref') ?? ''}
      findingsLabel={str(props, 'findingsLabel') ?? ''}
    />
  ),
  /** Keyboard + bulk selection over the inbox's row links — the shared list
   *  cannot host ephemeral selection or global key handling. */
  'agents-triage-keys': (props) => (
    <AgentsTriageKeys {...(props as unknown as ComponentProps<typeof AgentsTriageKeys>)} />
  ),
  /** Muted keyboard helper for the paging row (never above the KPIs). The
   *  loader computed the localized sentence; this only binds the key caps —
   *  the first token of each ·-separated part — in the house kbd style. */
  'agents-triage-hint': (props) => {
    const text = str(props, 'text')
    if (!text) return null
    return (
      <p className="text-xs text-slate-500 dark:text-slate-400">
        {text.split('·').map((part, index) => {
          const trimmed = part.trim()
          const space = trimmed.indexOf(' ')
          const key = space === -1 ? trimmed : trimmed.slice(0, space)
          const rest = space === -1 ? '' : trimmed.slice(space)
          return (
            <Fragment key={index}>
              {index > 0 ? ' · ' : null}
              <kbd className="rounded border border-slate-200 bg-white px-1.5 py-0.5 font-sans text-[10px] font-medium text-slate-600 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-400">
                {key}
              </kbd>
              {rest}
            </Fragment>
          )
        })}
      </p>
    )
  },
  /** Loader-formatted `Kpi[]` straight through: the KPI strip's markup is not
   *  the stat-tile block's (same arrangement as `equipment-kpi-strip`). */
  'agents-kpi-strip': (props) => (
    <KpiStrip items={(props.items as ComponentProps<typeof KpiStrip>['items']) ?? []} />
  ),
  /** Retired-route landing notice (?from=continuous-close): loader-resolved
   *  strings, session-local dismiss. Renders nothing without a title. */
  'moved-notice': (props) => {
    const title = str(props, 'title')
    if (!title) return null
    return (
      <MovedNotice
        title={title}
        description={str(props, 'description') ?? ''}
        dismissLabel={str(props, 'dismissLabel') ?? ''}
      />
    )
  },
  /** The cached narrative's markdown. A widget, not a block, because no spec
   *  block renders markdown — the loader computed the text, this only binds
   *  the renderer. Null text renders nothing. */
  'agents-briefing-body': (props) => {
    const text = str(props, 'text')
    if (!text) return null
    return <ChatMarkdown>{text}</ChatMarkdown>
  },
  /** The briefing tab's only interactivity: generate + send buttons. */
  'agents-briefing-actions': (props) => (
    <AgentsBriefingActions {...(props as unknown as ComponentProps<typeof AgentsBriefingActions>)} />
  ),

  /* --- assistant -------------------------------------------------------------------- */
  /** Whole: sidebar, streaming thread, composer and every fetch. Serves both
   *  /assistant and /assistant/[id]: `activeId` and `initialMessages` default
   *  to the new-conversation values the launcher route passes natively, and
   *  the deep-link route binds real ones. Hardcoding them here would have made
   *  this entry a single route's assumption wearing a general name. */
  'assistant-app': (props) => (
    <AssistantApp
      conversations={props.conversations as ComponentProps<typeof AssistantApp>['conversations']}
      activeId={str(props, 'activeId') ?? null}
      initialMessages={
        (props.initialMessages as ComponentProps<typeof AssistantApp>['initialMessages']) ?? []
      }
      canWrite={props.canWrite === true}
      canConfigureAi={props.canConfigureAi === true}
      aiEnabled={props.aiEnabled === true}
      initialPrompt={str(props, 'initialPrompt')}
      initialFindingId={str(props, 'initialFindingId')}
    />
  ),

  /* --- continuous close -------------------------------------------------- */
  'tab-nav': (props) => (
    <TabNav
      ariaLabel={str(props, 'ariaLabel') ?? ''}
      tabs={(props.tabs as ComponentProps<typeof TabNav>['tabs']) ?? []}
    />
  ),
  'metric-tile': (props) => (
    <Metric
      label={str(props, 'label') ?? ''}
      value={num(props, 'value') ?? 0}
      locale={str(props, 'locale') ?? 'en'}
      tone={str(props, 'tone')}
    />
  ),
  'reports-card-heading': (props) => (
    <ReportsCardHeading
      title={str(props, 'title') ?? ''}
      description={str(props, 'description') ?? ''}
    />
  ),
  'narrative-entry': (props) => (
    <NarrativeEntry
      narrative={(props.narrative as Record<string, unknown>) ?? {}}
      href={str(props, 'href') ?? ''}
      labels={props.labels as ComponentProps<typeof NarrativeEntry>['labels']}
    />
  ),
  'finding-cell': (props) => (
    <FindingCell
      title={str(props, 'title') ?? ''}
      href={str(props, 'href') ?? ''}
      summary={str(props, 'summary') ?? ''}
    />
  ),
  'work-item-drawer': (props) => {
    const drawer = props.drawer as ComponentProps<typeof WorkItemDrawer> | null
    if (!drawer) return null
    return <WorkItemDrawer {...drawer} />
  },
  'narrative-drawer': (props) => {
    const drawer = props.drawer as ComponentProps<typeof NarrativeDrawer> | null
    if (!drawer) return null
    return <NarrativeDrawer {...drawer} />
  },
} satisfies Record<string, WidgetRenderer>
