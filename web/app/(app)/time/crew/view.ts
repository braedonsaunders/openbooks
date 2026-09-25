import 'server-only'

import { redirect  } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/platform/db.ts'
import {
  badge,
  column,
  field as item,
  link,
  page,
  pageHeader,
  panel,
  ref,
  table,
  text,
  widget,
  widgetBlock,
  type PageSpec,
} from '@braedonsaunders/appkit-viewspec'
import { can, getAuthz, requirePermission } from '../../../../lib/authz'
import { requireFeatureEnabled } from '../../../../lib/feature-gates'
import { isFeatureEnabled } from '../../../../lib/features'
import { isUuid } from '../../../../lib/list-params'
import { loadOrRefuse, type PageRefusal } from '../../../../lib/load-or-refuse'
import { businessToday } from '@openbooks/engine/src/platform/business-date.ts'
import { FieldTimeError } from '@openbooks/engine/src/hrm/field-time/errors.ts'
import { listCrewBatches, getBatchDetail } from '@openbooks/engine/src/hrm/field-time/reads.ts'
import { loadFieldTimeSettings } from '@openbooks/engine/src/hrm/field-time/settings.ts'

/**
 * The foreman crew page: batches per project per day as a shared
 * `table` block with `filter-chips` segments, the batch workspace
 * (`hrm-crew-workspace` island) in a drawer from the `batch` search
 * param. 404s when fieldTimeCrewEntry is off — rows stay, they simply
 * stop rendering.
 */

export interface CrewPageData {
  title: string
  description: string
  tabs: { href: string; label: string; active: boolean }[]
  newHref: string
  newLabel: string
  canEnter: boolean
  segmentsLabel: string
  allLabel: string
  segments: { value: string; label: string }[]
  currentParams: Record<string, string | string[] | undefined>
  listTitle: string
  columns: Record<string, string>
  emptyTitle: string
  emptyDescription: string
  rows: Record<string, unknown>[]
  drawerOpen: boolean
  workspace: Record<string, unknown> | null
  createForm: {
    workers: { id: string; name: string }[]
    projects: { id: string; name: string }[]
    defaultWorkedOn: string
  } | null
  setupHref: string
  setupLabel: string
  canSetup: boolean
  /**
   * Set when ?batch= names an unknown batch or ?project= is malformed:
   * the page renders the house empty-state block with the refusal and its
   * remedy instead of throwing out of render (which production shows as
   * generic copy).
   */
  refusal: PageRefusal | null
}

const f = ref<CrewPageData>()

export async function loadCrewPage(sp: Record<string, string | undefined>): Promise<CrewPageData> {
  // Foremen hold time.crew.enter without time.read; approvers the
  // reverse. Either lands here — the static redirect keeps narrowing.
  const session = await getAuthz()
  if (!session) redirect('/login')
  if (!can(session, 'time.read') && !can(session, 'time.crew.enter')) {
    await requirePermission('time.read')
  }
  const authed = session
  await requireFeatureEnabled(authed.user.orgId, 'fieldTimeCrewEntry')
  const t = await getTranslations('timesheets')
  const orgId = authed.user.orgId
  const statusLabel = (status: string) => STATUS_LABELS[status] ?? status
  const STATUS_LABELS: Record<string, string> = {
    draft: t('field.statusDraft'),
    submitted: t('field.statusSubmitted'),
    approved_stage_1: t('field.statusStage1'),
    approved_stage_2: t('field.statusStage2'),
    rejected: t('field.statusRejected'),
    posted: t('field.statusPosted'),
  }
  // Labels never throw; only the reads below convert to refusal state.
  const shell = {
    title: t('field.crewTitle'),
    description: t('field.crewDescription'),
    tabs: [
      { href: '/timesheets', label: t('field.timesheetsTab'), active: false },
      { href: '/time/clock', label: t('field.clockTab'), active: false },
      { href: '/time/crew', label: t('field.crewTab'), active: true },
    ],
    newHref: '/time/crew?new=1',
    newLabel: t('field.newBatch'),
    // The batch POST requires time.crew.enter (crew-batches/route.ts), so
    // the New button shows iff the server would allow the create.
    canEnter: can(authed, 'time.crew.enter'),
    segmentsLabel: t('field.statusLabel'),
    allLabel: t('field.allBatches'),
    segments: ['draft', 'submitted', 'approved_stage_1', 'approved_stage_2', 'rejected', 'posted'].map((status) => ({
      value: status,
      label: statusLabel(status),
    })),
    currentParams: { segment: sp.segment, project: sp.project, batch: sp.batch, new: sp.new },
    listTitle: t('field.batchesTitle'),
    columns: {
      foreman: t('field.foremanLabel'),
      project: t('field.projectLabel'),
      workedOn: t('field.workedOnLabel'),
      status: t('field.statusLabel'),
      hours: t('field.hoursLabel'),
      workers: t('field.workersLabel'),
    },
    emptyTitle: t('field.noBatchesTitle'),
    emptyDescription: t('field.noBatchesDescription'),
    setupHref: '/time/setup',
    setupLabel: t('field.setupLink'),
    // The Setup page requires time.manage (time/setup/view.ts) — a reader
    // without it would land on access-denied, so the link hides instead.
    canSetup: can(authed, 'time.manage'),
  }
  const outcome = await loadOrRefuse(
    () => crewWorkspaceData(
      orgId,
      { actorUserId: authed.user.id, allowedSubsidiaryIds: authed.allowedSubsidiaryIds },
      can(authed, 'time.crew.enter'),
      sp,
      { unknownForeman: t('field.unknownForeman'), signAndSubmit: t('field.signAndSubmit') },
      statusLabel,
    ),
    {
      refusals: [
        { error: FieldTimeError, code: 'batch_unknown' },
        { error: FieldTimeError, code: 'crew_filter_invalid' },
      ],
      title: shell.title,
    },
  )
  if (outcome.ok) return { ...shell, ...outcome.data, refusal: null }
  return { ...shell, rows: [], drawerOpen: false, workspace: null, createForm: null, refusal: outcome.refusal }
}

/**
 * The crew page's throwing reads, separated so ?batch= / ?project=
 * refusals convert to page state through loadOrRefuse: a malformed id
 * never reaches SQL (uuid-shaped or refused), and a stale batch id
 * renders its remedy instead of throwing out of the loader.
 */
async function crewWorkspaceData(
  orgId: string,
  actor: { actorUserId: string; allowedSubsidiaryIds: ReadonlySet<string> | null },
  canEnter: boolean,
  sp: Record<string, string | undefined>,
  text: { unknownForeman: string; signAndSubmit: string },
  statusLabel: (status: string) => string,
): Promise<Pick<CrewPageData, 'rows' | 'drawerOpen' | 'workspace' | 'createForm'>> {
  const segment = sp.segment ?? 'all'
  const projectFilter = sp.project ?? null
  if (projectFilter !== null && !isUuid(projectFilter)) {
    throw new FieldTimeError('crew_filter_invalid', 'The project filter is not a valid id — clear it and retry')
  }
  const batchId = sp.batch ?? null
  if (batchId !== null && !isUuid(batchId)) {
    throw new FieldTimeError('batch_unknown', 'The crew batch is unknown in this organization — reload the crew list')
  }
  // A subsidiary-restricted foreman picks only their entities' workers and
  // projects — the same own-or-in-scope rule the batch list enforces.
  // Unrestricted callers keep the org-wide lists. One literal per scope:
  // bare JS arrays must never be interpolated into ANY().
  const scopeIds = actor.allowedSubsidiaryIds === null
    ? null
    : `{${[...actor.allowedSubsidiaryIds].join(',')}}`
  const partyScopeArm = scopeIds === null ? sql`` : sql`and p.subsidiary_id = any(${scopeIds}::uuid[])`
  const projectScopeArm = scopeIds === null ? sql`` : sql`and subsidiary_id = any(${scopeIds}::uuid[])`
  const batches = await listCrewBatches(orgId, {
    status: segment === 'all' ? null : segment,
    projectId: projectFilter,
  }, actor)
  // Unsaved-create: ?new=1 opens the create workspace over no persisted
  // row. Opening writes nothing — the batch is persisted only by the form's
  // explicit Create (one POST to /api/time/crew-batches). Gated on
  // time.crew.enter exactly like that POST, so the button and the drawer
  // agree; an existing ?batch= wins over ?new=.
  const creating = sp.new === '1' && canEnter && !batchId
  let createForm: CrewPageData['createForm'] = null
  if (creating) {
    const [partyRows, projectRows, today] = await Promise.all([
      db.execute<{ id: string; name: string }>(sql`
        select p.id::text as id, p.display_name as name from parties p
         where p.org_id = ${orgId} and p.is_active ${partyScopeArm} order by p.display_name limit 500`),
      db.execute<{ id: string; code: string | null; name: string | null }>(sql`
        select id::text as id, code, name from projects
         where org_id = ${orgId} and is_active ${projectScopeArm} order by name nulls last, code nulls last limit 200`),
      businessToday(orgId),
    ])
    createForm = {
      workers: partyRows.rows,
      projects: projectRows.rows.map((project) => ({
        id: project.id,
        name: [project.code, project.name].filter(Boolean).join(' · ') || project.id,
      })),
      defaultWorkedOn: today,
    }
  }
  let workspace: CrewPageData['workspace'] = null
  if (batchId) {
    const detail = await getBatchDetail(orgId, actor, batchId)
    const settings = await loadFieldTimeSettings(orgId)
    const equipmentOn = await isFeatureEnabled(orgId, 'fieldTimeEquipment')
    const [workers, timeTypes, tasks, units] = await Promise.all([
      db.execute<{ id: string; name: string }>(sql`
        select p.id::text as id, p.display_name as name from parties p
         where p.org_id = ${orgId} and p.is_active ${partyScopeArm} order by p.display_name limit 500`),
      db.execute<{ id: string; name: string }>(sql`
        select id::text as id, name from time_types where org_id = ${orgId} and is_active order by name`),
      db.execute<{ id: string; name: string }>(sql`
        select t.id::text as id, t.name from project_tasks t
         where t.org_id = ${orgId} and t.project_id = ${detail.projectId} order by t.name limit 200`),
      equipmentOn
        ? db.execute<{ id: string; name: string }>(sql`
          select id::text as id, unit_number || ' · ' || name as name from equipment_units
           where org_id = ${orgId} and status = 'active' order by unit_number limit 200`)
        : Promise.resolve({ rows: [] as { id: string; name: string }[] }),
    ])
    workspace = {
      batchId: detail.id,
      status: statusLabel(detail.status),
      locked: detail.status !== 'draft' && detail.status !== 'rejected',
      initialLines: detail.lines.map((line) => ({
        id: line.id,
        employeePartyId: line.employeePartyId,
        employeeName: line.employeeName,
        hours: line.hours,
        timeTypeId: line.timeTypeId ?? '',
        timeTypeName: null,
        projectTaskId: line.projectTaskId ?? '',
        taskName: null,
        costCodeRef: line.costCodeRef ?? '',
        equipmentId: line.equipmentId ?? '',
        equipmentUnit: line.equipmentUnit,
        equipmentHours: line.equipmentHours ?? '',
        memo: line.memo ?? '',
      })),
      workers: workers.rows,
      timeTypes: timeTypes.rows,
      tasks: tasks.rows,
      equipment: units.rows,
      equipmentOn,
      signatureRequired: settings.signatureRequired,
      signLabel: text.signAndSubmit,
    }
  }
  return {
    rows: batches.map((batch) => ({
      id: batch.id,
      foreman: batch.foremanName ?? text.unknownForeman,
      project: batch.projectName ?? '—',
      workedOn: batch.workedOn,
      status: statusLabel(batch.status),
      hours: batch.totalHours,
      workers: batch.workerCount,
      href: `/time/crew?batch=${batch.id}`,
    })),
    drawerOpen: workspace !== null || createForm !== null,
    workspace,
    createForm,
  }
}

export function crewSpec(data: CrewPageData, basePath: string = '/time/crew'): PageSpec {
  return page({
    route: '/time/crew',
    layout: 'list',
    bodyClassName: 'flex h-full min-h-0 flex-col',
    header: [
      pageHeader({
        title: f('title'),
        description: f('description'),
        actions: [
          widget('link-button', { href: f('newHref'), label: f('newLabel'), iconKey: 'plus' }, f('canEnter')),
          widget(
            'link-button',
            { href: f('setupHref'), label: f('setupLabel'), variant: 'outline' },
            f('canSetup'),
          ),
          widget('module-home-tabs', { tabs: data.tabs }),
        ],
      }),
    ],
    body: [
      // An unknown ?batch= or malformed ?project= resolves to refusal
      // state — the same house block the clock page renders for its own
      // refusals — instead of throwing out of render.
      widgetBlock(
        'empty-state',
        {
          title: data.refusal?.title ?? '',
          description: data.refusal?.message,
          ...(data.refusal?.action
            ? { action: 'link-button', actionProps: { href: data.refusal.action.href, label: data.refusal.action.label } }
            : {}),
        },
        f('refusal'),
      ),
      widgetBlock('filter-chips', {
        basePath,
        currentParams: data.currentParams,
        paramKey: 'segment',
        label: data.segmentsLabel,
        allLabel: data.allLabel,
        options: data.segments,
      }),
      panel({
        title: f('listTitle'),
        iconKey: 'users',
        bodyClassName: 'min-h-0 overflow-y-auto p-0',
        className: 'min-h-0 flex-1',
        blocks: [
          table({
            variant: 'app',
            rows: f('rows'),
            rowKey: item('id'),
            columns: [
              column(f('columns.foreman'), text(item('foreman'))),
              column(f('columns.project'), text(item('project'))),
              column(f('columns.workedOn'), text(item('workedOn'))),
              column(f('columns.status'), badge(item('status'), { variant: 'secondary' })),
              column(f('columns.hours'), text(item('hours')), { align: 'right', className: 'tabular-nums' }),
              column(f('columns.workers'), text(item('workers')), { align: 'right', className: 'tabular-nums' }),
              column('', link(item('foreman'), item('href'))),
            ],
            empty: { title: f('emptyTitle'), description: f('emptyDescription') },
          }),
          widgetBlock('hrm-crew-workspace', { ...(data.workspace ?? {}), batchId: data.workspace?.batchId ?? '', create: data.createForm }, f('drawerOpen')),
        ],
      }),
    ],
  })
}

export async function crewTitle(): Promise<string> {
  const t = await getTranslations('timesheets')
  return t('field.crewTitle')
}
