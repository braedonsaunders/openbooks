import 'server-only'

import { sql } from 'drizzle-orm'
import { getTranslations } from 'next-intl/server'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { getSurvey, listSurveys } from '@openbooks/engine/src/hrm/surveys/surveys.ts'
import { getSurveyResults } from '@openbooks/engine/src/hrm/surveys/responses.ts'
import { hrmGroupTabs } from '../../components/module-home/group-tabs'
import { hrmTalentViewTabs } from './workspace-tabs'
import { can, requirePermission, type Authz } from '../authz'
import { requireFeatureEnabled } from '../feature-gates'

/**
 * Surveys home loader (0230, HR-19).
 *
 * Rows resolve through the canonical engine reads (listSurveys,
 * getSurvey, getSurveyResults); participation comes from the results
 * reader so the list and the results panel never disagree. Renders
 * only when hrm and hrmSurveys are on and the actor holds
 * hrm.surveys.manage — a switched-off feature redirects to its remedy
 * instead. Responding rides
 * invitation tokens on the public route, never a grant, so it lives
 * nowhere here.
 */

export const SURVEY_STATUSES = ['draft', 'open', 'closed'] as const

export interface SurveysHomeAuthz {
  orgId: string
  userId: string
  session: Authz
}

export async function surveysAuthz(): Promise<SurveysHomeAuthz | null> {
  let gate
  try {
    gate = await requirePermission('hrm.surveys.manage')
  } catch {
    return null
  }
  await requireFeatureEnabled(gate.user.orgId, 'hrm')
  await requireFeatureEnabled(gate.user.orgId, 'hrmSurveys')
  return { orgId: gate.user.orgId, userId: gate.user.id, session: gate }
}

export interface SurveyRow {
  id: string
  name: string
  kind: string
  kindLabel: string
  anonymity: string
  anonymityLabel: string
  status: string
  statusLabel: string
  statusVariant: 'default' | 'secondary' | 'outline' | 'destructive' | 'warning' | 'success'
  participation: string | null
  closes: string | null
  href: string
}

function statusVariant(status: string): SurveyRow['statusVariant'] {
  switch (status) {
    case 'open':
      return 'success'
    case 'closed':
      return 'default'
    default:
      return 'secondary'
  }
}

function hrefFor(status: string | null, survey: string | null, authoring: boolean): string {
  const params = new URLSearchParams()
  if (status) params.set('status', status)
  if (survey) params.set('survey', survey)
  if (authoring) params.set('author', '1')
  const query = params.toString()
  return query ? `/hrm/surveys?${query}` : '/hrm/surveys'
}

export async function loadSurveysHome(authz: SurveysHomeAuthz, sp: Record<string, string | undefined>) {
  const t = await getTranslations('hrm')
  const tabs = await hrmGroupTabs(authz.session, '/hrm/surveys')
  const viewTabs = await hrmTalentViewTabs(authz.session, '/hrm/surveys')
  const status =
    typeof sp.status === 'string' && (SURVEY_STATUSES as readonly string[]).includes(sp.status)
      ? sp.status
      : null
  const authoring = sp.author === '1'
  const surveyId = typeof sp.survey === 'string' && sp.survey.length > 0 ? sp.survey : null

  const surveys = await listSurveys({ orgId: authz.orgId, actorId: authz.userId, ...(status ? { status } : {}) })
  const kindLabel = (value: string): string => t(`surveys.kind.${value}`)
  const anonymityLabel = (value: string): string => t(`surveys.anonymity.${value}`)
  const statusLabel = (value: string): string => t(`surveys.status.${value}`)

  // Participation resolves through the results reader per survey so the
  // list figure and the results panel share one source of truth.
  const rows: SurveyRow[] = []
  const counts = new Map<string, number>()
  for (const survey of surveys) {
    counts.set(survey.status, (counts.get(survey.status) ?? 0) + 1)
    let participation: string | null = null
    try {
      const results = await getSurveyResults({ orgId: authz.orgId, actorId: authz.userId, surveyId: survey.id })
      participation = results.participationPct === null ? null : `${results.participationPct}%`
    } catch {
      participation = null
    }
    rows.push({
      id: survey.id,
      name: survey.name,
      kind: survey.kind,
      kindLabel: kindLabel(survey.kind),
      anonymity: survey.anonymity,
      anonymityLabel: anonymityLabel(survey.anonymity),
      status: survey.status,
      statusLabel: statusLabel(survey.status),
      statusVariant: statusVariant(survey.status),
      participation,
      closes: survey.closesAt,
      href: hrefFor(status, survey.id, false),
    })
  }

  let drawer: {
    closeHref: string
    title: string
    survey: Awaited<ReturnType<typeof getSurvey>> | null
    results: Awaited<ReturnType<typeof getSurveyResults>> | null
    people: { value: string; label: string }[]
    missingDetail: string | null
    labels: Record<string, string>
  } | null = null
  if (surveyId) {
    try {
      const [survey, results] = await Promise.all([
        getSurvey({ orgId: authz.orgId, actorId: authz.userId, surveyId }),
        getSurveyResults({ orgId: authz.orgId, actorId: authz.userId, surveyId }),
      ])
      const people = (await db.execute<{ id: string; name: string }>(sql`
        select id::text as id, display_name as name from parties
         where org_id = ${authz.orgId}::uuid and kind = 'person' and is_active
         order by display_name limit 200`)).rows
      drawer = {
        closeHref: hrefFor(status, null, false),
        title: survey.name,
        survey,
        results,
        people: people.map((p) => ({ value: p.id, label: p.name })),
        missingDetail: null,
        labels: {
          results: t('surveys.drawer.results'),
          participation: t('surveys.drawer.participation'),
          enps: t('surveys.drawer.enps'),
          drivers: t('surveys.drawer.drivers'),
          heatmap: t('surveys.drawer.heatmap'),
          suppressed: t('surveys.drawer.suppressed'),
          comments: t('surveys.drawer.comments'),
          trend: t('surveys.drawer.trend'),
          questions: t('surveys.drawer.questions'),
          open: t('surveys.drawer.open'),
          close: t('surveys.drawer.close'),
          actionFailed: t('surveys.drawer.actionFailed'),
          inviteLabel: t('surveys.drawer.invite'),
          cancel: t('surveys.drawer.cancel'),
        },
      }
    } catch {
      drawer = {
        closeHref: hrefFor(status, null, false),
        title: t('surveys.drawer.title'),
        survey: null,
        results: null,
        people: [],
        missingDetail: t('surveys.drawer.missing'),
        labels: {},
      }
    }
  }

  // The author dialog's inputs: kinds, anonymity grades, and question
  // kinds — ids and labels only; the drawer posts the question cards.
  const author = authoring
    ? {
        closeHref: hrefFor(status, null, false),
        kinds: (['engagement', 'pulse', 'onboarding', 'exit', 'custom'] as const).map((value) => ({
          value,
          label: kindLabel(value),
        })),
        anonymity: (['anonymous', 'confidential', 'named'] as const).map((value) => ({
          value,
          label: anonymityLabel(value),
        })),
        questionKinds: (['scale', 'enps', 'text', 'single', 'multi'] as const).map((value) => ({
          value,
          label: t(`surveys.questionKind.${value}`),
        })),
        labels: {
          title: t('surveys.author.title'),
          name: t('surveys.author.name'),
          kind: t('surveys.author.kind'),
          anonymity: t('surveys.author.anonymity'),
          minGroup: t('surveys.author.minGroup'),
          minGroupInvalid: t('surveys.author.minGroupInvalid'),
          questions: t('surveys.author.questions'),
          addQuestion: t('surveys.author.addQuestion'),
          prompt: t('surveys.author.prompt'),
          driver: t('surveys.author.driver'),
          options: t('surveys.author.options'),
          optionsHint: t('surveys.author.optionsHint'),
          remove: t('surveys.author.remove'),
          submit: t('surveys.author.submit'),
          failed: t('surveys.author.failed'),
        },
      }
    : null

  return {
    title: t('surveys.title'),
    description: t('surveys.description'),
    tabs,
    viewTabs,
    canManage: can(authz.session, 'hrm.surveys.manage'),
    addLabel: t('surveys.author.open'),
    addHref: hrefFor(status, null, true),
    segmentsLabel: t('surveys.segmentsLabel'),
    allLabel: t('surveys.statusAll'),
    segmentOptions: SURVEY_STATUSES.map((value) => ({
      value,
      label: statusLabel(value),
      count: counts.get(value) ?? 0,
    })),
    currentParams: { ...(status ? { status } : {}) },
    columns: {
      name: t('surveys.columns.name'),
      kind: t('surveys.columns.kind'),
      anonymity: t('surveys.columns.anonymity'),
      participation: t('surveys.columns.participation'),
      closes: t('surveys.columns.closes'),
      status: t('surveys.columns.status'),
    },
    rows,
    empty: t('surveys.empty'),
    drawerOpen: drawer !== null,
    drawer,
    authorOpen: author !== null,
    author,
  }
}
