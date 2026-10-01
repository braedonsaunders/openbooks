import 'server-only'

import { getTranslations } from 'next-intl/server'
import {
  badge,
  column,
  field as item,
  link,
  text,
  widgetBlock,
  type PageSpec,
} from '@braedonsaunders/appkit-viewspec'
import {
  calibrationDistribution,
  calibrationPotentialOptions,
  getCalibrationSession,
  listCalibrationSessions,
} from '@openbooks/engine/src/hrm/performance/calibration.ts'
import { HrmPerformanceError } from '@openbooks/engine/src/hrm/performance/errors.ts'
import { getFeedbackSettings } from '@openbooks/engine/src/hrm/performance/feedback.ts'
import { listCycleProgress } from '@openbooks/engine/src/hrm/performance/performance-read.ts'
import {
  listSuccessionPlans,
  listTalentDirectory,
  listTalentReviews,
  nineBoxForCycle,
} from '@openbooks/engine/src/hrm/performance/talent.ts'
import type { Authz } from '../../../../lib/authz'
import { registeredListTable } from '../../../../lib/list/prepared-spec'
import { translateTalentCode } from './talent-labels.ts'

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

export type ContinuousTab =
  'cycles' | 'calibration' | 'talent' | 'settings' | 'retention'

/**
 * A section read that failed for an unexpected reason (typed NOT_FOUND
 * and FORBIDDEN stay null/missing as before). The tab renders the
 * localized message with a retry link that re-runs the loader — a dead
 * read never looks like an empty grid again.
 */
export interface ContinuousLoadError {
  message: string
  retryHref: string
  retryLabel: string
}

/** True for the typed absence/scope refusals a null section already names. */
function isExpectedAbsence(error: unknown): boolean {
  return (
    error instanceof HrmPerformanceError &&
    (error.code === 'NOT_FOUND' || error.code === 'FORBIDDEN')
  )
}

export interface ContinuousData {
  tab: ContinuousTab
  setupLabel: string
  showCalibration: boolean
  showTalent: boolean
  calibration: {
    title: string
    description: string
    newLabel: string
    newHref: string
    create: {
      cycles: { value: string; label: string }[]
      nameLabel: string
      cycleLabel: string
      submitLabel: string
      cancelLabel: string
      closeHref: string
      failed: string
      emptyLabel: string
      newCycleLabel: string
    } | null
    sessionsEmpty: string
    sessionCols: { name: string; status: string; opened: string }
    sessions: {
      id: string
      name: string
      status: string
      statusLabel: string
      href: string
    }[]
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
    } | null
    detailError: ContinuousLoadError | null
  } | null
  talent: {
    title: string
    description: string
    view: string
    viewLabel: string
    assessmentsLabel: string
    viewOptions: { value: string; label: string }[]
    noCycle: string
    scaleNote: string | null
    cycleAction: string
    cycleActionHref: string
    newLabel: string
    cycleLabel: string
    cycles: { value: string; label: string }[]
    cycleId: string
    gridTitle: string
    gridEmpty: string
    unplacedNote: string | null
    boxRows: {
      perf: string
      cells: Record<string, { count: string; href: string }>
    }[]
    boxCols: { perf: string; pots: string[] }
    tableCols: {
      employee: string
      performance: string
      potential: string
      loss: string
      ready: string
    }
    reviews: {
      id: string
      employee: string
      performance: string
      potential: string
      loss: string
      ready: string
    }[]
    reviewsEmpty: string
    plansTitle: string
    plansEmpty: string
    planCols: {
      position: string
      incumbent: string
      candidates: string
      status: string
    }
    planDetail: {
      id: string
      title: string
      closeHref: string
      status: string
      statusLabel: string
      statusOptions: { value: string; label: string }[]
      notes: string
      notesLabel: string
      saveLabel: string
      failed: string
      addLabel: string
      employeeLabel: string
      readinessLabel: string
      removeLabel: string
      readinessOptions: { value: string; label: string }[]
      employments: { value: string; label: string }[]
      candidates: {
        id: string
        name: string
        readiness: string
        order: number
      }[]
      empty: string
    } | null
    planMissing: string | null
    plans: {
      id: string
      href: string
      position: string
      incumbent: string
      candidates: string
      status: string
    }[]
    dialog: {
      initialMode?: 'talent' | 'succession'
      incumbentLabel: string
      cycleId: string
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
  talentError: ContinuousLoadError | null
  settingsError: ContinuousLoadError | null
}

const f = item

function calibrationStatusLabel(
  t: (key: string) => string,
  status: string,
): string {
  const known = new Set(['draft', 'open', 'closed'])
  return t(
    known.has(status)
      ? `performance.continuous.calibration.status.${status}`
      : 'performance.continuous.calibration.status.unknown',
  )
}

export async function loadContinuousTab(
  authz: Authz,
  sp: Record<string, string | undefined>,
  canManage: boolean,
  canRetain: boolean,
): Promise<ContinuousData> {
  const t = await getTranslations('hrm')
  const retryLabel = (await getTranslations('common'))('actions.retry')
  const rawTab = typeof sp.tab === 'string' ? sp.tab : null
  // The page already requires Performance, which carries calibration,
  // talent reviews and feedback: only the grants decide these tabs.
  const showCalibration = canManage
  const showTalent = canManage
  // Settings and Retention are tabs of their own. They used to render as
  // extra sections BELOW the cycles table: a naked "Feedback settings"
  // select with a Save button, then unboxed retention statistics, stacked
  // under a list. Three unrelated things down one page, none of them
  // reachable on its own.
  const showSettings = canManage
  const showRetention = canRetain
  const tab: ContinuousTab =
    rawTab === 'calibration' && showCalibration
      ? 'calibration'
      : rawTab === 'talent' && showTalent
        ? 'talent'
        : rawTab === 'settings' && showSettings
          ? 'settings'
          : rawTab === 'retention' && showRetention
            ? 'retention'
            : 'cycles'
  let calibration: ContinuousData['calibration'] = null
  if (tab === 'calibration' && showCalibration) {
    const sessions = await listCalibrationSessions({
      orgId: authz.user.orgId,
      actorId: authz.user.id,
    })
    // ?session=new opens the create dialog: it is not a session id, so it
    // never reaches getCalibrationSession (whose requireId rejects it).
    const creating = sp.session === 'new'
    const sessionId = creating
      ? null
      : typeof sp.session === 'string' && sp.session.length > 0
        ? sp.session
        : null
    type CalibrationDetail = NonNullable<
      NonNullable<ContinuousData['calibration']>['detail']
    >
    let detail: CalibrationDetail | null = null
    let detailError: ContinuousLoadError | null = null
    if (sessionId) {
      try {
        const session = await getCalibrationSession({
          orgId: authz.user.orgId,
          actorId: authz.user.id,
          id: sessionId,
        })
        // The editor offers the session cycle's declared scale
        // labels — the same source setPotential enforces, so an offered
        // option always saves. A labelless template offers nothing.
        const potentialOptions = await calibrationPotentialOptions({
          orgId: authz.user.orgId,
          actorId: authz.user.id,
          sessionId,
        })
        const distribution = await calibrationDistribution({
          orgId: authz.user.orgId,
          actorId: authz.user.id,
          id: sessionId,
        })
        const distEntries = [...Object.entries(distribution.calibrated)]
        const distMax = Math.max(1, ...distEntries.map(([, count]) => count))
        detail = {
          id: session.id,
          name: session.name,
          status: session.status,
          statusLabel: calibrationStatusLabel(t, session.status),
          gridTitle: t('performance.continuous.calibration.gridTitle'),
          gridCols: {
            review: t('performance.continuous.calibration.colReview'),
            proposed: t('performance.continuous.calibration.colProposed'),
            decide: t('performance.continuous.calibration.colDecide'),
          },
          entries: session.entries.map((entry) => ({
            id: entry.id,
            review: entry.subjectName,
            proposed:
              entry.proposedRating ??
              t('performance.continuous.calibration.unrated'),
            editor: {
              entryId: entry.id,
              calibratedRating: entry.calibratedRating,
              potentialKey: entry.potentialKey,
              potentialOptions,
              justification: entry.justification,
              ratingLabel: t('performance.continuous.calibration.ratingLabel'),
              potentialLabel: t(
                'performance.continuous.calibration.potentialLabel',
              ),
              justificationLabel: t(
                'performance.continuous.calibration.justificationLabel',
              ),
              saveLabel: t('performance.continuous.calibration.saveLabel'),
              revertLabel: t('performance.continuous.calibration.revertLabel'),
              revertReasonLabel: t(
                'performance.continuous.calibration.revertReasonLabel',
              ),
              failed: t('performance.actionFailed'),
            },
          })),
          gridEmpty: t('performance.continuous.calibration.gridEmpty'),
          distributionTitle: t(
            'performance.continuous.calibration.distributionTitle',
          ),
          distribution: distEntries.map(([key, count]) => ({
            key,
            count,
            width: Math.round((count / distMax) * 100),
          })),
          missingTitle: t('performance.continuous.calibration.missingTitle'),
          missing: session.missing.map((m) => ({
            review: m.subjectName,
            reason: t(
              `performance.continuous.calibration.missingReasons.${m.reason}` as never,
            ),
          })),
          openLabel: t('performance.continuous.calibration.openSession'),
          closeLabel: t('performance.continuous.calibration.closeSession'),
          failed: t('performance.actionFailed'),
        }
      } catch (error) {
        // A session that vanished (or left scope) simply has no detail —
        // the sessions table above stays the named outcome. Anything else
        // is an outage the grid must not hide.
        if (!isExpectedAbsence(error)) {
          detailError = {
            message: t('performance.continuous.calibration.detailLoadFailed'),
            retryHref: `/hrm/performance?tab=calibration&session=${sessionId}`,
            retryLabel,
          }
        }
        detail = null
      }
    }
    // The create dialog resolves without a session: the cycle picker lists
    // the manager's visible cycles, and the POST endpoint owns the grant.
    let create: NonNullable<ContinuousData['calibration']>['create'] = null
    if (creating) {
      const cycles = await listCycleProgress({
        orgId: authz.user.orgId,
        actorId: authz.user.id,
      })
      create = {
        cycles: cycles.map((c) => ({ value: c.id, label: c.name })),
        nameLabel: t('performance.continuous.calibration.sessionName'),
        cycleLabel: t('performance.continuous.calibration.sessionCycle'),
        submitLabel: t('performance.continuous.calibration.createSession'),
        cancelLabel: t('performance.cancel'),
        closeHref: '/hrm/performance?tab=calibration',
        failed: t('performance.actionFailed'),
        emptyLabel: t('performance.empty'),
        newCycleLabel: t('performance.newCycle'),
      }
    }
    calibration = {
      title: t('performance.continuous.calibration.title'),
      description: t('performance.continuous.calibration.description'),
      newLabel: t('performance.continuous.calibration.newSession'),
      newHref: '/hrm/performance?tab=calibration&session=new',
      create,
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
        statusLabel: calibrationStatusLabel(t, s.status),
        href: `/hrm/performance?tab=calibration&session=${s.id}`,
      })),
      detail,
      detailError,
    }
  }

  let talent: ContinuousData['talent'] = null
  let talentError: ContinuousLoadError | null = null
  if (tab === 'talent' && showTalent) {
    const cycles = await listCycleProgress({
      orgId: authz.user.orgId,
      actorId: authz.user.id,
    })
    // The talent filter rides talentCycle, never cycle: cycle opens the
    // cycle drawer (performance/view reads it as the drawer id), so sharing
    // the name popped the drawer over the talent tab.
    const cycleId =
      typeof sp.talentCycle === 'string' && sp.talentCycle.length > 0
        ? sp.talentCycle
        : (cycles.find((c) => c.status !== 'closed')?.id ??
          cycles[0]?.id ??
          null)
    const perfFilter = typeof sp.perf === 'string' ? sp.perf : null
    const potFilter = typeof sp.pot === 'string' ? sp.pot : null
    const view =
      sp.talentView === 'succession'
        ? 'succession'
        : sp.talentView === 'matrix'
          ? 'matrix'
          : 'assessments'
    const directory = await listTalentDirectory({
      orgId: authz.user.orgId,
      actorId: authz.user.id,
      activeOnly: view === 'succession' || cycles.find((cycle) => cycle.id === cycleId)?.status !== 'closed',
    })
    {
      try {
        const [box, reviews, plans] = await Promise.all([
          cycleId && view !== 'succession'
            ? nineBoxForCycle({
                orgId: authz.user.orgId,
                actorId: authz.user.id,
                cycleId,
              }).catch((error) => {
                if (
                  error instanceof HrmPerformanceError &&
                  error.code === 'REFUSED'
                )
                  return {
                    performance: [],
                    potential: [],
                    cells: {} as Record<string, Record<string, number>>,
                    unplaced: 0,
                  }
                throw error
              })
            : Promise.resolve({
                performance: [],
                potential: [],
                cells: {} as Record<string, Record<string, number>>,
                unplaced: 0,
              }),
          cycleId && view !== 'succession'
            ? listTalentReviews({
                orgId: authz.user.orgId,
                actorId: authz.user.id,
                cycleId,
              })
            : Promise.resolve([]),
          listSuccessionPlans({
            orgId: authz.user.orgId,
            actorId: authz.user.id,
          }),
        ])
        const base = cycleId
          ? `/hrm/performance?tab=talent&talentCycle=${cycleId}`
          : '/hrm/performance?tab=talent'
        const talentLabel = (key: string) => t(key as never)
        const visible = reviews.filter(
          (r) =>
            (!perfFilter || r.performanceKey === perfFilter) &&
            (!potFilter || r.potentialKey === potFilter),
        )
        talent = {
          view,
          viewLabel: t('performance.workspace.view'),
          assessmentsLabel: t('performance.workspace.assessments'),
          viewOptions: ['succession', 'matrix'].map((value) => ({
            value,
            label: t(`performance.workspace.${value}`),
          })),
          noCycle: t('performance.workspace.noCycle'),
          scaleNote:
            cycleId &&
            view !== 'succession' &&
            (!box.performance.length || !box.potential.length)
              ? t('performance.workspace.noScale')
              : null,
          cycleAction: t('performance.newCycle'),
          cycleActionHref: '/hrm/performance?cycle=new',
          title: t('performance.continuous.talent.title'),
          description: t(`performance.workspace.${view}Description`),
          newLabel: t('performance.continuous.talent.newRecord'),
          cycleLabel: t('performance.continuous.talent.cycleLabel'),
          cycles: cycles.map((c) => ({ value: c.id, label: c.name })),
          cycleId: cycleId ?? '',
          gridTitle: t('performance.continuous.talent.gridTitle'),
          gridEmpty: t('performance.continuous.talent.gridEmpty'),
          unplacedNote:
            box.unplaced > 0
              ? t('performance.continuous.talent.unplacedNote', {
                  count: box.unplaced,
                })
              : null,
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
          boxCols: {
            perf: t('performance.continuous.talent.colPerformance'),
            pots: [...box.potential],
          },
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
            loss: `${translateTalentCode('loss', r.impactOfLoss, talentLabel)} / ${translateTalentCode('loss', r.riskOfLoss, talentLabel)}`,
            ready: r.promotionReady
              ? t('performance.continuous.talent.readyYes')
              : t('performance.continuous.talent.readyNo'),
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
          planMissing:
            sp.plan && !plans.some((p) => p.id === sp.plan)
              ? t('performance.workspace.planNotFound')
              : null,
          planDetail: (() => {
            const plan = plans.find((p) => p.id === sp.plan)
            if (!plan) return null
            return {
              id: plan.id,
              title: `${plan.positionCode} · ${plan.positionTitle}`,
              closeHref: `${base}&talentView=succession`,
              status: plan.status,
              statusLabel: t('performance.continuous.talent.colStatus'),
              statusOptions: (['draft', 'active', 'archived'] as const).map(
                (value) => ({
                  value,
                  label: translateTalentCode('planStatus', value, talentLabel),
                }),
              ),
              notes: plan.notes ?? '',
              notesLabel: t('performance.continuous.talent.notesLabel'),
              saveLabel: t('performance.continuous.talent.submitLabel'),
              failed: t('performance.actionFailed'),
              addLabel: t('performance.workspace.addCandidate'),
              removeLabel: t('performance.workspace.removeCandidate'),
              employeeLabel: t('performance.continuous.talent.employeeLabel'),
              readinessLabel: t('performance.workspace.readiness'),
              readinessOptions: (
                ['ready_now', 'one_to_two_years', 'three_plus'] as const
              ).map((value) => ({
                value,
                label: translateTalentCode('readiness', value, talentLabel),
              })),
              employments: directory.employments.map((e) => ({
                value: e.id,
                label: e.name,
              })),
              empty: t('performance.workspace.noCandidates'),
              candidates: plan.candidates.map((c) => ({
                id: c.id,
                name: c.employeeName,
                readiness: translateTalentCode(
                  'readiness',
                  c.readiness,
                  talentLabel,
                ),
                order: c.order,
              })),
            }
          })(),
          plans: plans.map((p) => ({
            id: p.id,
            href: `${base}&talentView=succession&plan=${p.id}`,
            position: `${p.positionCode} · ${p.positionTitle}`,
            incumbent: p.incumbentName ?? '—',
            candidates:
              p.candidates
                .map((c) => {
                  const readiness = translateTalentCode(
                    'readiness',
                    c.readiness,
                    talentLabel,
                  )
                  return `${c.employeeName} (${readiness})`
                })
                .join(', ') || '—',
            status: translateTalentCode('planStatus', p.status, talentLabel),
          })),
          dialog: {
            initialMode: view === 'succession' ? 'succession' : 'talent',
            incumbentLabel: t('performance.continuous.talent.colIncumbent'),
            cycleId: cycleId ?? '',
            employments: directory.employments.map((e) => ({
              value: e.id,
              label: e.name,
            })),
            positions: directory.positions.map((p) => ({
              value: p.id,
              label: `${p.code} · ${p.title}`,
            })),
            perfOptions: [...box.performance],
            potOptions: [...box.potential],
            perfLabel: t('performance.continuous.talent.colPerformance'),
            potLabel: t('performance.continuous.talent.colPotential'),
            impactLabel: t('performance.continuous.talent.impactLabel'),
            riskLabel: t('performance.continuous.talent.riskLabel'),
            lossOptions: (['low', 'medium', 'high'] as const).map((v) => ({
              value: v,
              label: translateTalentCode('loss', v, talentLabel),
            })),
            promotionLabel: t('performance.continuous.talent.promotionLabel'),
            notesLabel: t('performance.continuous.talent.notesLabel'),
            submitLabel: t('performance.continuous.talent.submitLabel'),
            cancelLabel: t('performance.cancel'),
            closeHref: `${base}&talentView=${view}`,
            failed: t('performance.actionFailed'),
            openLabel: t(
              view === 'succession'
                ? 'performance.workspace.newPlan'
                : 'performance.continuous.talent.newRecord',
            ),
            modeLabel: t('performance.continuous.talent.modeLabel'),
            modeTalentLabel: t('performance.continuous.talent.modeTalentLabel'),
            modeSuccessionLabel: t(
              'performance.continuous.talent.modeSuccessionLabel',
            ),
            employeeLabel: t('performance.continuous.talent.employeeLabel'),
            positionLabel: t('performance.continuous.talent.positionLabel'),
          },
        }
      } catch {
          talentError = {
            message: t('performance.continuous.talent.loadFailed'),
            retryHref: cycleId
              ? `/hrm/performance?tab=talent&talentCycle=${cycleId}`
              : '/hrm/performance?tab=talent',
            retryLabel,
          }
        talent = null
      }
    }
  }

  let feedbackSettings: ContinuousData['feedbackSettings'] = null
  let settingsError: ContinuousLoadError | null = null
  if (tab === 'settings' && showSettings) {
    try {
      const settings = await getFeedbackSettings({
        orgId: authz.user.orgId,
        actorId: authz.user.id,
      })
      feedbackSettings = {
        title: t('performance.continuous.feedback.settingsTitle'),
        anyoneLabel: t('performance.continuous.feedback.anyoneLabel'),
        managersLabel: t('performance.continuous.feedback.managersLabel'),
        saveLabel: t('performance.continuous.feedback.saveLabel'),
        failed: t('performance.actionFailed'),
        current: settings.publicPraiseBy,
      }
    } catch (error) {
      if (!isExpectedAbsence(error)) {
        settingsError = {
          message: t('performance.continuous.feedback.settingsLoadFailed'),
          retryHref: '/hrm/performance?tab=settings',
          retryLabel,
        }
      }
      feedbackSettings = null
    }
  }

  return {
    tab,
    setupLabel: t('performance.workspace.setupTitle'),
    showCalibration,
    showTalent,
    calibration,
    talent,
    talentError,
    feedbackSettings,
    settingsError,
  }
}

/**
 * A failed section read as house blocks: the note carries the localized
 * failure and the plain link button re-runs the loader for the same tab.
 */
function loadErrorBlocks(error: ContinuousLoadError): PageSpec['body'] {
  return [
    widgetBlock('hrm-note', { note: error.message }),
    // widgetBlock, not widget: a bare WidgetRef is not a body Block, and
    // the retry link must live in the tab body beside the note.
    widgetBlock('plain-link-button', {
      href: error.retryHref,
      label: error.retryLabel,
      variant: 'outline',
    }),
  ]
}

export function continuousBlocks(data: ContinuousData): PageSpec['body'] {
  const blocks: PageSpec['body'] = []
  if (data.tab === 'calibration' && data.calibration) {
    const cal = data.calibration
    blocks.push(
      registeredListTable('hrm_calibration_sessions', {
        variant: 'app',
        rows: f('continuous.calibration.sessions'),
        rowKey: item('id'),
        empty: { title: cal.sessionsEmpty },
        columns: [
          column(cal.sessionCols.name, link(item('name'), item('href'))),
          column(
            cal.sessionCols.status,
            badge(item('statusLabel'), { variant: 'secondary' }),
          ),
        ],
      }),
    )
    if (cal.detail)
      blocks.push(
        widgetBlock('hrm-calibration-session', { detail: cal.detail }),
      )
    else if (cal.detailError) blocks.push(...loadErrorBlocks(cal.detailError))
    if (cal.create)
      blocks.push(widgetBlock('hrm-session-dialog', { create: cal.create }))
  }
  if (data.tab === 'talent' && data.talentError)
    blocks.push(...loadErrorBlocks(data.talentError))
  if (data.tab === 'talent' && data.talent) {
    const tal = data.talent
    blocks.push(
      widgetBlock('list-toolbar', {
        basePath: '/hrm/performance',
        currentParams: {
          tab: 'talent',
          ...(tal.cycleId ? { talentCycle: tal.cycleId } : {}),
          talentView: tal.view,
        },
        filters: [
          {
            paramKey: 'talentView',
            label: tal.viewLabel,
            hideAll: true,
            defaultValue: 'assessments',
            options: [{ value: 'assessments', label: tal.assessmentsLabel }, ...tal.viewOptions],
          },
          ...(tal.cycles.length
            ? [
                {
                  paramKey: 'talentCycle',
                  label: tal.cycleLabel,
                  hideAll: true,
                  defaultValue: tal.cycleId,
                  options: tal.cycles,
                },
              ]
            : []),
        ],
      }),
    )
    if (tal.view === 'succession') {
      blocks.push(
        registeredListTable('hrm_succession_plans', {
          variant: 'app',
          rows: f('continuous.talent.plans'),
          rowKey: item('id'),
          empty: { title: tal.plansEmpty },
          columns: [
            column(tal.planCols.position, link(item('position'), item('href'))),
            column(tal.planCols.incumbent, text(item('incumbent'))),
            column(tal.planCols.candidates, text(item('candidates'))),
            column(
              tal.planCols.status,
              badge(item('status'), { variant: 'secondary' }),
            ),
          ],
        }),
      )
    } else if (!tal.cycleId) {
      blocks.push(
        widgetBlock('empty-state', {
          title: tal.title,
          description: tal.noCycle,
          action: 'plain-link-button',
          actionProps: {
            href: tal.cycleActionHref,
            label: tal.cycleAction,
            variant: 'outline',
          },
        }),
      )
    } else if (tal.view === 'matrix' && tal.scaleNote) {
      blocks.push(
        widgetBlock('empty-state', {
          title: tal.gridTitle,
          description: tal.scaleNote,
          action: 'plain-link-button',
          actionProps: {
            href: '/admin/setup/performance',
            label: data.setupLabel,
            variant: 'outline',
          },
        }),
      )
    } else if (tal.view === 'matrix') {
      blocks.push(
        registeredListTable('hrm_talent_matrix', {
          variant: 'app',
          rows: f('continuous.talent.boxRows'),
          rowKey: item('perf'),
          empty: { title: tal.gridEmpty },
          columns: [
            column(tal.boxCols.perf, text(item('perf'))),
            ...tal.boxCols.pots.map((pot) =>
              column(
                pot,
                link(item(`cells.${pot}.count`), item(`cells.${pot}.href`)),
              ),
            ),
          ],
        }),
      )
      if (tal.unplacedNote)
        blocks.push(widgetBlock('hrm-note', { note: tal.unplacedNote }))
    } else {
      if (tal.scaleNote)
        blocks.push(widgetBlock('hrm-note', { note: tal.scaleNote }))
      blocks.push(
        registeredListTable('hrm_talent_reviews', {
          variant: 'app',
          rows: f('continuous.talent.reviews'),
          rowKey: item('id'),
          empty: { title: tal.reviewsEmpty },
          columns: [
            column(tal.tableCols.employee, text(item('employee'))),
            column(tal.tableCols.performance, text(item('performance'))),
            column(tal.tableCols.potential, text(item('potential'))),
            column(tal.tableCols.loss, text(item('loss'))),
            column(tal.tableCols.ready, text(item('ready'))),
          ],
        }),
      )
    }
  }
  if (data.tab === 'talent' && data.talent?.planDetail)
    blocks.push(
      widgetBlock('hrm-succession-plan', { detail: data.talent.planDetail }),
    )
  if (data.tab === 'talent' && data.talent?.planMissing)
    blocks.push(widgetBlock('hrm-note', { note: data.talent.planMissing }))
  if (data.tab === 'settings' && data.feedbackSettings)
    blocks.push(
      widgetBlock('hrm-feedback-settings', { settings: data.feedbackSettings }),
    )
  else if (data.tab === 'settings' && data.settingsError)
    blocks.push(...loadErrorBlocks(data.settingsError))
  return blocks
}
