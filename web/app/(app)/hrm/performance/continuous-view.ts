import 'server-only'

import type { ModuleHomeTab } from '../../../../components/module-home/tab-types'

import { getTranslations } from 'next-intl/server'
import {
  badge,
  column,
  field as item,
  link,
  table,
  text,
  widgetBlock,
  widgetCell,
  type PageSpec,
} from '@braedonsaunders/appkit-viewspec'
import {
  calibrationDistribution,
  getCalibrationSession,
  listCalibrationSessions,
} from '@openbooks/engine/src/hrm/performance/calibration.ts'
import { getFeedbackSettings } from '@openbooks/engine/src/hrm/performance/feedback.ts'
import {
  listCycleProgress,
} from '@openbooks/engine/src/hrm/performance/performance-read.ts'
import {
  listSuccessionPlans,
  listTalentDirectory,
  listTalentReviews,
  nineBoxForCycle,
} from '@openbooks/engine/src/hrm/performance/talent.ts'
import type { Authz } from '../../../../lib/authz'
import { isFeatureEnabled } from '../../../../lib/features'
import { hrmTalentViewTabs } from '../../../../lib/hrm/workspace-tabs'

/**
 * HR-17 continuous-performance tabs on /hrm/performance: Calibration (the
 * grid over a session with the distribution strip and the missing list)
 * and Talent (the 9-box over org-declared scales, the talent table, and
 * succession plans), plus the HR-owned feedback settings panel on Cycles.
 *
 * Rows stay loader-resolved through the governed services (the page never
 * access-denies non-HR viewers: the Calibration and Talent tabs render
 * only for hrm.performance.manage with their feature on). No org id, user
 * id or Authz crosses into a spec or a widget prop.
 */

export type ContinuousTab = 'cycles' | 'calibration' | 'talent' | 'settings' | 'retention'

export interface ContinuousData {
  tab: ContinuousTab
  tabOptions: { value: string; label: string }[]
  /** The tabs as the shared subtab strip reads them. */
  viewTabs: ModuleHomeTab[]
  showCalibration: boolean
  showTalent: boolean
  calibration: {
    title: string
    description: string
    newLabel: string
    sessionsEmpty: string
    sessionCols: { name: string; status: string; opened: string }
    sessions: { id: string; name: string; status: string; statusLabel: string; href: string }[]
    detail: {
      id: string
      name: string
      status: string
      statusLabel: string
      gridTitle: string
      gridCols: { review: string; proposed: string; decide: string }
      entries: {
        id: string
        review: string
        proposed: string
        editor: {
          entryId: string
          calibratedRating: string | null
          potentialKey: string | null
          potentialOptions: string[]
          justification: string | null
          ratingLabel: string
          potentialLabel: string
          justificationLabel: string
          saveLabel: string
          revertLabel: string
          revertReasonLabel: string
          failed: string
        }
      }[]
      gridEmpty: string
      distributionTitle: string
      distribution: { key: string; count: number; width: number }[]
      missingTitle: string
      missing: { review: string; reason: string }[]
      openLabel: string
      closeLabel: string
      failed: string
      create: {
        cycles: { value: string; label: string }[]
        nameLabel: string
        cycleLabel: string
        submitLabel: string
        cancelLabel: string
        closeHref: string
        failed: string
      } | null
    } | null
  } | null
  talent: {
    title: string
    description: string
    newLabel: string
    cycleLabel: string
    cycles: { value: string; label: string }[]
    cycleId: string
    gridTitle: string
    gridEmpty: string
    unplacedNote: string | null
    boxRows: { perf: string; cells: Record<string, { count: string; href: string }> }[]
    boxCols: { perf: string; pots: string[] }
    tableCols: { employee: string; performance: string; potential: string; loss: string; ready: string }
    reviews: { id: string; employee: string; performance: string; potential: string; loss: string; ready: string }[]
    reviewsEmpty: string
    plansTitle: string
    plansEmpty: string
    planCols: { position: string; incumbent: string; candidates: string; status: string }
    plans: { id: string; position: string; incumbent: string; candidates: string; status: string }[]
    dialog: {
      employments: { value: string; label: string }[]
      positions: { value: string; label: string }[]
      perfOptions: string[]
      potOptions: string[]
      perfLabel: string
      potLabel: string
      impactLabel: string
      riskLabel: string
      lossOptions: { value: string; label: string }[]
      promotionLabel: string
      notesLabel: string
      submitLabel: string
      cancelLabel: string
      closeHref: string
      failed: string
      openLabel: string
      modeLabel: string
      modeTalentLabel: string
      modeSuccessionLabel: string
      employeeLabel: string
      positionLabel: string
    }
  } | null
  feedbackSettings: {
    title: string
    anyoneLabel: string
    managersLabel: string
    saveLabel: string
    failed: string
    current: string
  } | null
}

const f = item

export async function loadContinuousTab(
  authz: Authz,
  sp: Record<string, string | undefined>,
  canManage: boolean,
  canRetain: boolean,
): Promise<ContinuousData> {
  const t = await getTranslations('hrm')
  const rawTab = typeof sp.tab === 'string' ? sp.tab : null
  const calibrationOn = await isFeatureEnabled(authz.user.orgId, 'hrmCalibration')
  const successionOn = await isFeatureEnabled(authz.user.orgId, 'hrmSuccession')
  const feedbackOn = await isFeatureEnabled(authz.user.orgId, 'hrmFeedback')
  const showCalibration = canManage && calibrationOn
  const showTalent = canManage && successionOn
  // Settings and Retention are tabs of their own. They used to render as
  // extra sections BELOW the cycles table: a naked "Feedback settings"
  // select with a Save button, then unboxed retention statistics, stacked
  // under a list. Three unrelated things down one page, none of them
  // reachable on its own.
  const showSettings = canManage && feedbackOn
  const showRetention = canRetain
  const tab: ContinuousTab =
    rawTab === 'calibration' && showCalibration ? 'calibration'
    : rawTab === 'talent' && showTalent ? 'talent'
    : rawTab === 'settings' && showSettings ? 'settings'
    : rawTab === 'retention' && showRetention ? 'retention'
    : 'cycles'
  const tabOptions = [
    { value: 'cycles', label: t('performance.continuous.tabs.cycles') },
    ...(showCalibration ? [{ value: 'calibration', label: t('performance.continuous.tabs.calibration') }] : []),
    ...(showTalent ? [{ value: 'talent', label: t('performance.continuous.tabs.talent') }] : []),
    ...(showRetention ? [{ value: 'retention', label: t('retention.title') }] : []),
    ...(showSettings ? [{ value: 'settings', label: t('performance.continuous.tabs.settings') }] : []),
  ]
  const viewTabs = await hrmTalentViewTabs(
    authz,
    tab === 'cycles' ? '/hrm/performance' : `/hrm/performance?tab=${tab}`,
  )

  let calibration: ContinuousData['calibration'] = null
  if (tab === 'calibration' && showCalibration) {
    const sessions = await listCalibrationSessions({ orgId: authz.user.orgId, actorId: authz.user.id })
    const sessionId = typeof sp.session === 'string' && sp.session.length > 0 ? sp.session : sessions[0]?.id ?? null
    type CalibrationDetail = NonNullable<NonNullable<ContinuousData['calibration']>['detail']>
    let detail: CalibrationDetail | null = null
    if (sessionId) {
      try {
        const session = await getCalibrationSession({ orgId: authz.user.orgId, actorId: authz.user.id, id: sessionId })
        const distribution = await calibrationDistribution({ orgId: authz.user.orgId, actorId: authz.user.id, id: sessionId })
        const distEntries = [...Object.entries(distribution.calibrated)]
        const distMax = Math.max(1, ...distEntries.map(([, count]) => count))
        const cycles = await listCycleProgress({ orgId: authz.user.orgId, actorId: authz.user.id })
        detail = {
          id: session.id,
          name: session.name,
          status: session.status,
          statusLabel: session.status,
          gridTitle: t('performance.continuous.calibration.gridTitle'),
          gridCols: {
            review: t('performance.continuous.calibration.colReview'),
            proposed: t('performance.continuous.calibration.colProposed'),
            decide: t('performance.continuous.calibration.colDecide'),
          },
          entries: session.entries.map((entry) => ({
            id: entry.id,
            review: entry.subjectName,
            proposed: entry.proposedRating ?? t('performance.continuous.calibration.unrated'),
            editor: {
              entryId: entry.id,
              calibratedRating: entry.calibratedRating,
              potentialKey: entry.potentialKey,
              potentialOptions: [],
              justification: entry.justification,
              ratingLabel: t('performance.continuous.calibration.ratingLabel'),
              potentialLabel: t('performance.continuous.calibration.potentialLabel'),
              justificationLabel: t('performance.continuous.calibration.justificationLabel'),
              saveLabel: t('performance.continuous.calibration.saveLabel'),
              revertLabel: t('performance.continuous.calibration.revertLabel'),
              revertReasonLabel: t('performance.continuous.calibration.revertReasonLabel'),
              failed: t('performance.actionFailed'),
            },
          })),
          gridEmpty: t('performance.continuous.calibration.gridEmpty'),
          distributionTitle: t('performance.continuous.calibration.distributionTitle'),
          distribution: distEntries.map(([key, count]) => ({ key, count, width: Math.round((count / distMax) * 100) })),
          missingTitle: t('performance.continuous.calibration.missingTitle'),
          missing: session.missing.map((m) => ({ review: m.reviewId.slice(0, 8), reason: m.reason })),
          openLabel: t('performance.continuous.calibration.openSession'),
          closeLabel: t('performance.continuous.calibration.closeSession'),
          failed: t('performance.actionFailed'),
          create:
            sp.session === 'new'
              ? {
                  cycles: cycles.map((c) => ({ value: c.id, label: c.name })),
                  nameLabel: t('performance.continuous.calibration.sessionName'),
                  cycleLabel: t('performance.continuous.calibration.sessionCycle'),
                  submitLabel: t('performance.continuous.calibration.createSession'),
                  cancelLabel: t('performance.cancel'),
                  closeHref: '/hrm/performance?tab=calibration',
                  failed: t('performance.actionFailed'),
                }
              : null,
        }
      } catch {
        detail = null
      }
    }
    calibration = {
      title: t('performance.continuous.calibration.title'),
      description: t('performance.continuous.calibration.description'),
      newLabel: t('performance.continuous.calibration.newSession'),
      sessionsEmpty: t('performance.continuous.calibration.sessionsEmpty'),
      sessionCols: {
        name: t('performance.continuous.calibration.colSession'),
        status: t('performance.continuous.calibration.colStatus'),
        opened: t('performance.continuous.calibration.colOpened'),
      },
      sessions: sessions.map((s) => ({
        id: s.id,
        name: s.name,
        status: s.status,
        statusLabel: s.status,
        href: `/hrm/performance?tab=calibration&session=${s.id}`,
      })),
      detail,
    }
  }

  let talent: ContinuousData['talent'] = null
  if (tab === 'talent' && showTalent) {
    const cycles = await listCycleProgress({ orgId: authz.user.orgId, actorId: authz.user.id })
    const cycleId = typeof sp.cycle === 'string' && sp.cycle.length > 0 ? sp.cycle : cycles.find((c) => c.status !== 'closed')?.id ?? cycles[0]?.id ?? null
    const perfFilter = typeof sp.perf === 'string' ? sp.perf : null
    const potFilter = typeof sp.pot === 'string' ? sp.pot : null
    const directory = await listTalentDirectory({ orgId: authz.user.orgId, actorId: authz.user.id })
    if (cycleId) {
      try {
        const [box, reviews, plans] = await Promise.all([
          nineBoxForCycle({ orgId: authz.user.orgId, actorId: authz.user.id, cycleId }),
          listTalentReviews({ orgId: authz.user.orgId, actorId: authz.user.id, cycleId }),
          listSuccessionPlans({ orgId: authz.user.orgId, actorId: authz.user.id }),
        ])
        const base = `/hrm/performance?tab=talent&cycle=${cycleId}`
        const visible = reviews.filter(
          (r) => (!perfFilter || r.performanceKey === perfFilter) && (!potFilter || r.potentialKey === potFilter),
        )
        talent = {
          title: t('performance.continuous.talent.title'),
          description: t('performance.continuous.talent.description'),
          newLabel: t('performance.continuous.talent.newRecord'),
          cycleLabel: t('performance.continuous.talent.cycleLabel'),
          cycles: cycles.map((c) => ({ value: c.id, label: c.name })),
          cycleId,
          gridTitle: t('performance.continuous.talent.gridTitle'),
          gridEmpty: t('performance.continuous.talent.gridEmpty'),
          unplacedNote: box.unplaced > 0 ? t('performance.continuous.talent.unplacedNote', { count: box.unplaced }) : null,
          boxRows: box.performance.map((perf) => ({
            perf,
            cells: Object.fromEntries(
              box.potential.map((pot) => [
                pot,
                {
                  count: String(box.cells[perf]?.[pot] ?? 0),
                  href: `${base}&perf=${encodeURIComponent(perf)}&pot=${encodeURIComponent(pot)}`,
                },
              ]),
            ),
          })),
          boxCols: { perf: t('performance.continuous.talent.colPerformance'), pots: [...box.potential] },
          tableCols: {
            employee: t('performance.continuous.talent.colEmployee'),
            performance: t('performance.continuous.talent.colPerformance'),
            potential: t('performance.continuous.talent.colPotential'),
            loss: t('performance.continuous.talent.colLoss'),
            ready: t('performance.continuous.talent.colReady'),
          },
          reviews: visible.map((r) => ({
            id: r.id,
            employee: r.employeeName,
            performance: r.performanceKey,
            potential: r.potentialKey,
            loss: `${r.impactOfLoss} / ${r.riskOfLoss}`,
            ready: r.promotionReady ? t('performance.continuous.talent.readyYes') : t('performance.continuous.talent.readyNo'),
          })),
          reviewsEmpty: t('performance.continuous.talent.reviewsEmpty'),
          plansTitle: t('performance.continuous.talent.plansTitle'),
          plansEmpty: t('performance.continuous.talent.plansEmpty'),
          planCols: {
            position: t('performance.continuous.talent.colPosition'),
            incumbent: t('performance.continuous.talent.colIncumbent'),
            candidates: t('performance.continuous.talent.colCandidates'),
            status: t('performance.continuous.talent.colStatus'),
          },
          plans: plans.map((p) => ({
            id: p.id,
            position: `${p.positionCode} · ${p.positionTitle}`,
            incumbent: p.incumbentName ?? '—',
            candidates: p.candidates.map((c) => `${c.employeeName} (${c.readiness})`).join(', ') || '—',
            status: p.status,
          })),
          dialog: {
            employments: directory.employments.map((e) => ({ value: e.id, label: e.name })),
            positions: directory.positions.map((p) => ({ value: p.id, label: `${p.code} · ${p.title}` })),
            perfOptions: [...box.performance],
            potOptions: [...box.potential],
            perfLabel: t('performance.continuous.talent.colPerformance'),
            potLabel: t('performance.continuous.talent.colPotential'),
            impactLabel: t('performance.continuous.talent.impactLabel'),
            riskLabel: t('performance.continuous.talent.riskLabel'),
            lossOptions: ['low', 'medium', 'high'].map((v) => ({ value: v, label: v })),
            promotionLabel: t('performance.continuous.talent.promotionLabel'),
            notesLabel: t('performance.continuous.talent.notesLabel'),
            submitLabel: t('performance.continuous.talent.submitLabel'),
            cancelLabel: t('performance.cancel'),
            closeHref: `/hrm/performance?tab=talent&cycle=${cycleId}`,
            failed: t('performance.actionFailed'),
            openLabel: t('performance.continuous.talent.newRecord'),
            modeLabel: t('performance.continuous.talent.modeLabel'),
            modeTalentLabel: t('performance.continuous.talent.modeTalentLabel'),
            modeSuccessionLabel: t('performance.continuous.talent.modeSuccessionLabel'),
            employeeLabel: t('performance.continuous.talent.employeeLabel'),
            positionLabel: t('performance.continuous.talent.positionLabel'),
          },
        }
      } catch {
        talent = null
      }
    }
  }

  let feedbackSettings: ContinuousData['feedbackSettings'] = null
  if (tab === 'settings' && showSettings) {
    try {
      const settings = await getFeedbackSettings({ orgId: authz.user.orgId, actorId: authz.user.id })
      feedbackSettings = {
        title: t('performance.continuous.feedback.settingsTitle'),
        anyoneLabel: t('performance.continuous.feedback.anyoneLabel'),
        managersLabel: t('performance.continuous.feedback.managersLabel'),
        saveLabel: t('performance.continuous.feedback.saveLabel'),
        failed: t('performance.actionFailed'),
        current: settings.publicPraiseBy,
      }
    } catch {
      feedbackSettings = null
    }
  }

  return { tab, tabOptions, viewTabs, showCalibration, showTalent, calibration, talent, feedbackSettings }
}

/**
 * The performance view switch, on the shared subtab strip.
 *
 * It was a `filter-chips` dropdown with `label: ''` — an unlabelled control
 * that read as an empty select box, sitting directly above the real status
 * filter, which looked exactly the same. Tabs are tabs.
 */
export function continuousTabChips(data: ContinuousData) {
  return widgetBlock('module-home-tabs', { tabs: data.viewTabs })
}

export function continuousBlocks(data: ContinuousData): PageSpec['body'] {
  const blocks: PageSpec['body'] = []
  if (data.tab === 'calibration' && data.calibration) {
    const cal = data.calibration
    blocks.push(
      table({
        variant: 'app',
        rows: f('continuous.calibration.sessions'),
        rowKey: item('id'),
        empty: { title: f('continuous.calibration.sessionsEmpty') },
        columns: [
          column(cal.sessionCols.name, link(item('name'), item('href'))),
          column(cal.sessionCols.status, badge(item('statusLabel'), { variant: 'secondary' })),
        ],
      }),
    )
    if (cal.detail) {
      const d = cal.detail
      blocks.push(
        widgetBlock('hrm-session-actions', {
          sessionId: d.id,
          status: d.status,
          openLabel: d.openLabel,
          closeLabel: d.closeLabel,
          failed: d.failed,
        }),
      )
      blocks.push(
        widgetBlock('hrm-calibration-distribution', {
          title: d.distributionTitle,
          distribution: d.distribution,
        }),
      )
      blocks.push(
        table({
          variant: 'app',
          rows: f('continuous.calibration.detail.entries'),
          rowKey: item('id'),
          empty: { title: f('continuous.calibration.gridEmpty') },
          columns: [
            column(d.gridCols.review, text(item('review'))),
            column(d.gridCols.proposed, text(item('proposed')), { align: 'right', className: 'tabular-nums' }),
            column(d.gridCols.decide, widgetCell('hrm-calibration-entry', { editor: item('editor') })),
          ],
        }),
      )
      if (d.missing.length > 0) {
        blocks.push(
          widgetBlock('hrm-calibration-missing', { title: d.missingTitle, missing: d.missing }),
        )
      }
      if (d.create) {
        blocks.push(widgetBlock('hrm-session-dialog', { create: d.create }))
      }
    }
  }
  if (data.tab === 'talent' && data.talent) {
    const tal = data.talent
    // The 9-box as the shared table block: rows are performance keys,
    // columns are potential keys, cells link to the filtered table.
    const boxColumns = [
      column(tal.boxCols.perf, text(item('perf'))),
      ...tal.boxCols.pots.map((pot) => column(pot, link(item(`cells.${pot}.count`), item(`cells.${pot}.href`)))),
    ]
    blocks.push(
      widgetBlock('hrm-talent-dialog', { dialog: tal.dialog }),
      table({
        variant: 'app',
        rows: f('continuous.talent.boxRows'),
        rowKey: item('perf'),
        empty: { title: f('continuous.talent.gridEmpty') },
        columns: boxColumns,
      }),
    )
    if (tal.unplacedNote) {
      blocks.push(widgetBlock('hrm-note', { note: tal.unplacedNote }))
    }
    blocks.push(
      table({
        variant: 'app',
        rows: f('continuous.talent.reviews'),
        rowKey: item('id'),
        empty: { title: f('continuous.talent.reviewsEmpty') },
        columns: [
          column(tal.tableCols.employee, text(item('employee'))),
          column(tal.tableCols.performance, text(item('performance'))),
          column(tal.tableCols.potential, text(item('potential'))),
          column(tal.tableCols.loss, text(item('loss'))),
          column(tal.tableCols.ready, text(item('ready'))),
        ],
      }),
      table({
        variant: 'app',
        rows: f('continuous.talent.plans'),
        rowKey: item('id'),
        empty: { title: f('continuous.talent.plansEmpty') },
        columns: [
          column(tal.planCols.position, text(item('position'))),
          column(tal.planCols.incumbent, text(item('incumbent'))),
          column(tal.planCols.candidates, text(item('candidates'))),
          column(tal.planCols.status, badge(item('status'), { variant: 'secondary' })),
        ],
      }),
    )
  }
  if (data.tab === 'settings' && data.feedbackSettings) {
    blocks.push(widgetBlock('hrm-feedback-settings', { settings: data.feedbackSettings }))
  }
  return blocks
}

