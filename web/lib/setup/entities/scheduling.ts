/** Setup-registry scheduling entities (Workforce group): boards and booking codes. */
import { sql } from 'drizzle-orm'
import { lockAndCheckOrgFeature } from '@openbooks/engine/src/organization/org-feature-lock.ts'
import type { SetupEntity, SetupOption, SetupEntityValidationHook } from '../types'

const ROW_KINDS: SetupOption[] = [
  { value: 'people', labelKey: 'options.scheduleRowKind.people' },
  { value: 'tasks', labelKey: 'options.scheduleRowKind.tasks' },
  { value: 'resources', labelKey: 'options.scheduleRowKind.resources' },
]
const GRAINS: SetupOption[] = [
  { value: 'day', labelKey: 'options.scheduleGrain.day' },
  { value: 'timed', labelKey: 'options.scheduleGrain.timed' },
]
const VIEWS: SetupOption[] = [
  { value: 'grid', labelKey: 'options.scheduleView.grid' },
  { value: 'targets', labelKey: 'options.scheduleView.targets' },
  { value: 'timeline', labelKey: 'options.scheduleView.timeline' },
  { value: 'calendar', labelKey: 'options.scheduleView.calendar' },
  { value: 'gantt', labelKey: 'options.scheduleView.gantt' },
  { value: 'progress', labelKey: 'options.scheduleView.progress' },
]
const PUBLISH_POLICIES: SetupOption[] = [
  { value: 'live', labelKey: 'options.schedulePublishPolicy.live' },
  { value: 'staged', labelKey: 'options.schedulePublishPolicy.staged' },
]
const CODE_CATEGORIES: SetupOption[] = [
  { value: 'work', labelKey: 'options.scheduleCodeCategory.work' },
  { value: 'unavailable', labelKey: 'options.scheduleCodeCategory.unavailable' },
]
const PEOPLE_VIEWS = new Set(['grid', 'targets', 'timeline', 'calendar'])
const TASK_VIEWS = new Set(['gantt', 'progress'])
const RANGE_DAYS = new Set([1, 3, 7, 14, 21, 28, 35, 42])

function list(value: unknown): string[] | null {
  if (Array.isArray(value)) return value.map(String)
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value)
      return Array.isArray(parsed) ? parsed.map(String) : null
    } catch {
      return null
    }
  }
  return null
}

export const SCHEDULING_ENTITIES: SetupEntity[] = [
  {
    // A board is a scoped lens: the people (or project tasks) of a legal
    // entity, department, location or project, with its views, publication
    // policy and booking behavior. Bookings belong to the board they were
    // made on, so archiving a board preserves its history.
    key: 'schedule-boards',
    table: 'schedule_boards',
    singularTitleKey: 'entities.schedule-boards.singularTitle',
    actorCols: true,
    groupKey: 'workforce',
    iconKey: 'calendar',
    orgScoped: true,
    naturalKey: 'code',
    orderBy: 'sort_order, name',
    hasActive: true,
    allowDelete: false,
    featureKeysAny: ['hrmShiftPlanning', 'projectScheduling'],
    docSlug: 'scheduling',
    columns: [
      { key: 'code', kind: 'code' },
      { key: 'name', kind: 'text' },
      { key: 'rowKind', kind: 'badge', options: ROW_KINDS },
      { key: 'grain', kind: 'badge', options: GRAINS },
      { key: 'publishPolicy', kind: 'badge', options: PUBLISH_POLICIES },
      { key: 'isActive', kind: 'badge-active' },
    ],
    formSections: [
      { titleKey: 'sections.scheduleBoardIdentity', fields: ['code', 'name', 'description', 'rowKind', 'resourceKind', 'sortOrder', 'isActive'] },
      { titleKey: 'sections.scheduleBoardScope', descriptionKey: 'sections.scheduleBoardScopeHelp', fields: ['subsidiaryId', 'departmentId', 'locationId', 'projectId'] },
      { titleKey: 'sections.scheduleBoardDisplay', fields: ['views', 'defaultView', 'rangeDays', 'weekStartsOn', 'showWeekends', 'weekendDays', 'showTotals', 'cellColorRules'] },
      { titleKey: 'sections.scheduleBoardBooking', descriptionKey: 'sections.scheduleBoardBookingHelp', fields: ['grain', 'timeZone', 'dayStarts', 'dayEnds', 'dayBreakMinutes', 'publishPolicy'] },
      { titleKey: 'sections.scheduleBoardAutomation', descriptionKey: 'sections.scheduleBoardAutomationHelp', fields: ['prefillTimesheets', 'prefillCrewTime', 'prefillFieldTickets', 'notifyAssignees'] },
    ],
    fields: [
      { key: 'code', kind: 'text', required: true, lockedOnEdit: true, helpTextKey: 'fieldHelp.scheduleBoardCode' },
      { key: 'name', kind: 'text', required: true },
      { key: 'description', kind: 'textarea' },
      { key: 'rowKind', kind: 'select', options: ROW_KINDS, required: true, lockedOnEdit: true, defaultValue: 'people', helpTextKey: 'fieldHelp.scheduleBoardRowKind' },
      { key: 'resourceKind', kind: 'select', required: true, lockedOnEdit: true, showWhen: { field: 'rowKind', in: ['resources'] }, omitWhenHidden: true, options: [{ value: 'equipment', labelKey: 'options.scheduleResourceKind.equipment' }, { value: 'location', labelKey: 'options.scheduleResourceKind.location' }] },
      { key: 'subsidiaryId', kind: 'ref', ref: 'subsidiaries' },
      { key: 'departmentId', kind: 'ref', ref: 'departments', showWhen: { field: 'rowKind', in: ['people'] }, clearWhenHidden: true },
      { key: 'locationId', kind: 'ref', ref: 'locations' },
      { key: 'projectId', kind: 'ref', ref: 'projects', helpTextKey: 'fieldHelp.scheduleBoardProject' },
      { key: 'views', kind: 'stringArray', arrayStorage: 'text', options: VIEWS, required: true, defaultValue: ['grid', 'targets', 'timeline', 'calendar'], helpTextKey: 'fieldHelp.scheduleBoardViews' },
      { key: 'defaultView', kind: 'select', options: VIEWS, required: true, defaultValue: 'grid' },
      { key: 'rangeDays', kind: 'integer', required: true, min: 1, max: 42, defaultValue: 14, helpTextKey: 'fieldHelp.scheduleBoardRangeDays' },
      { key: 'weekStartsOn', kind: 'integer', required: true, min: 0, max: 6, defaultValue: 0, helpTextKey: 'fieldHelp.scheduleBoardWeekStartsOn' },
      { key: 'showWeekends', kind: 'boolean', defaultValue: true },
      { key: 'weekendDays', kind: 'stringArray', arrayStorage: 'text', defaultValue: ['6', '7'], options: Array.from({ length: 7 }, (_, index) => ({ value: String(index + 1), labelKey: `options.scheduleWeekday.${index + 1}` })), helpTextKey: 'fieldHelp.scheduleWeekendDays' },
      { key: 'showTotals', kind: 'boolean', booleanStyle: 'switch', defaultValue: false, helpTextKey: 'fieldHelp.scheduleShowTotals' },
      { key: 'cellColorRules', kind: 'objectArray', defaultValue: [], addLabelKey: 'scheduleColors.add', itemTitleKey: 'scheduleColors.rule', helpTextKey: 'fieldHelp.scheduleCellColorRules', fields: [
        { key: 'field', kind: 'select', required: true, defaultValue: 'bookingLabel', options: ['bookingLabel', 'targetName', 'detail'].map((value) => ({ value, labelKey: `options.scheduleColorField.${value}` })) },
        { key: 'match', kind: 'select', required: true, defaultValue: 'equals', options: ['equals', 'startsWith', 'contains'].map((value) => ({ value, labelKey: `options.scheduleColorMatch.${value}` })) },
        { key: 'value', kind: 'text', required: true },
        { key: 'color', kind: 'text', required: true, defaultValue: '#38bdf8' },
      ] },
      { key: 'grain', kind: 'select', options: GRAINS, required: true, defaultValue: 'day', helpTextKey: 'fieldHelp.scheduleBoardGrain' },
      { key: 'timeZone', kind: 'timeZone', required: true },
      { key: 'dayStarts', kind: 'text', required: true, defaultValue: '07:00', helpTextKey: 'fieldHelp.scheduleBoardDayStarts' },
      { key: 'dayEnds', kind: 'text', required: true, defaultValue: '15:30' },
      { key: 'dayBreakMinutes', kind: 'integer', required: true, min: 0, max: 240, defaultValue: 30 },
      { key: 'publishPolicy', kind: 'select', options: PUBLISH_POLICIES, required: true, defaultValue: 'live', helpTextKey: 'fieldHelp.scheduleBoardPublishPolicy' },
      { key: 'prefillTimesheets', kind: 'boolean', booleanStyle: 'switch', defaultValue: false, helpTextKey: 'fieldHelp.scheduleBoardPrefillTimesheets' },
      { key: 'prefillCrewTime', kind: 'boolean', booleanStyle: 'switch', defaultValue: false, helpTextKey: 'fieldHelp.scheduleBoardPrefillCrewTime' },
      { key: 'prefillFieldTickets', kind: 'boolean', booleanStyle: 'switch', defaultValue: false, helpTextKey: 'fieldHelp.scheduleBoardPrefillFieldTickets' },
      { key: 'notifyAssignees', kind: 'boolean', booleanStyle: 'switch', defaultValue: false, helpTextKey: 'fieldHelp.scheduleBoardNotifyAssignees' },
      { key: 'sortOrder', kind: 'integer', defaultValue: 0 },
      { key: 'isActive', kind: 'boolean', defaultValue: true },
    ],
  },
  {
    // Codes book work that is not a customer or project (shop, training)
    // and mark days a person is unavailable without filing leave (a forced
    // day off). Leave itself is never a code: it is filed as leave.
    key: 'schedule-codes',
    table: 'schedule_codes',
    singularTitleKey: 'entities.schedule-codes.singularTitle',
    actorCols: true,
    groupKey: 'workforce',
    iconKey: 'tag',
    orgScoped: true,
    naturalKey: 'code',
    orderBy: 'sort_order, code',
    hasActive: true,
    allowDelete: false,
    featureKey: 'hrmShiftPlanning',
    docSlug: 'scheduling',
    columns: [
      { key: 'code', kind: 'code' },
      { key: 'label', kind: 'text' },
      { key: 'category', kind: 'badge', options: CODE_CATEGORIES },
      { key: 'color', kind: 'text' },
      { key: 'isActive', kind: 'badge-active' },
    ],
    fields: [
      { key: 'code', kind: 'text', required: true, lockedOnEdit: true, helpTextKey: 'fieldHelp.scheduleCode' },
      { key: 'label', kind: 'text', required: true },
      { key: 'description', kind: 'textarea' },
      { key: 'category', kind: 'select', options: CODE_CATEGORIES, required: true, defaultValue: 'work', helpTextKey: 'fieldHelp.scheduleCodeCategory' },
      { key: 'color', kind: 'text', required: true, defaultValue: '#38bdf8', helpTextKey: 'fieldHelp.scheduleCodeColor' },
      { key: 'sortOrder', kind: 'integer', defaultValue: 0 },
      { key: 'isActive', kind: 'boolean', defaultValue: true },
    ],

  },
]

export const validateScheduleBoardWrite: SetupEntityValidationHook = async ({ body, executor, orgId, rowId }) => {
  let current: Record<string, unknown> = {}
  if (rowId) {
    current = (await executor.execute<Record<string, unknown>>(sql`select row_kind as "rowKind", views, default_view as "defaultView",
      resource_kind as "resourceKind", department_id as "departmentId", location_id as "locationId", range_days as "rangeDays", prefill_timesheets as "prefillTimesheets", prefill_crew_time as "prefillCrewTime",
      prefill_field_tickets as "prefillFieldTickets", notify_assignees as "notifyAssignees"
      from schedule_boards where org_id = ${orgId} and id = ${rowId}`)).rows[0] ?? {}
  }
  const merged = { ...current, ...body }
  const rowKind = String(merged.rowKind ?? 'people')
  const enabled = rowKind === 'people'
    ? await lockAndCheckOrgFeature(executor, orgId, 'hrm') && await lockAndCheckOrgFeature(executor, orgId, 'hrmShiftPlanning')
    : await lockAndCheckOrgFeature(executor, orgId, 'projects') && await lockAndCheckOrgFeature(executor, orgId, 'projectScheduling')
  if (!enabled) return `Enable ${rowKind === 'people' ? 'Human Resources and Scheduling' : 'Projects and Project Scheduling'} in Company Settings → Features before configuring this board.`
  if (rowKind === 'resources' && merged.resourceKind === 'equipment' && !await lockAndCheckOrgFeature(executor, orgId, 'equipment')) return 'Enable Equipment in Company Settings → Features before configuring an equipment board.'
  const views = list(merged.views) ?? []
  const allowedViews = rowKind === 'tasks' ? TASK_VIEWS : PEOPLE_VIEWS
  const foreign = views.filter((view) => !allowedViews.has(view))
  if (views.length === 0) return 'Choose at least one view for the board.'
  if (foreign.length) return `${foreign.join(', ')} ${foreign.length === 1 ? 'is' : 'are'} not available on a ${rowKind === 'tasks' ? 'task' : rowKind === 'resources' ? 'resource' : 'people'} board.`
  if (!views.includes(String(merged.defaultView ?? ''))) return 'The default view must be one of the board views.'
  if (!RANGE_DAYS.has(Number(merged.rangeDays))) return 'Show 1, 3, 7, 14, 21, 28, 35 or 42 days.'
  if (rowKind !== 'people' && [merged.prefillTimesheets, merged.prefillCrewTime, merged.prefillFieldTickets, merged.notifyAssignees].some((flag) => flag === true || flag === 'true')) {
    return 'Pre-fill and notification settings apply to people boards; turn them off for a task or resource board.'
  }
  if (rowKind === 'resources' && !['equipment', 'location'].includes(String(merged.resourceKind))) return 'Choose equipment units or locations for this resource board.'
  if (rowKind === 'resources' && (merged.departmentId || (merged.resourceKind === 'equipment' && merged.locationId))) return 'Resource boards use native legal-entity scope; equipment units have no department or location assignment.'
  if (body.cellColorRules !== undefined) {
    const rules = body.cellColorRules
    if (!Array.isArray(rules) || rules.length > 100) return 'Use at most 100 ordered color rules.'
    for (const rule of rules) {
      if (!rule || typeof rule !== 'object' || !['bookingLabel', 'targetName', 'detail'].includes(rule.field) || !['equals', 'startsWith', 'contains'].includes(rule.match) || typeof rule.value !== 'string' || !rule.value.trim() || rule.value.length > 120 || typeof rule.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(rule.color)) return 'Each color rule needs a field, match, value and six-digit hex color.'
    }
  }
  for (const key of ['dayStarts', 'dayEnds'] as const) {
    if (merged[key] !== undefined && !/^(?:[01]\d|2[0-3]):[0-5]\d(?::00)?$/.test(String(merged[key]))) return 'Enter the working day as clock times such as 07:00 and 15:30.'
  }
  return null
}

export const validateScheduleCodeWrite: SetupEntityValidationHook = async ({ body }) => {
  if (body.code !== undefined && !/^[A-Z0-9][A-Z0-9/&+._-]{0,15}$/.test(String(body.code))) {
    return 'Codes are up to 16 capital letters, digits or / & + . _ -, such as TRAIN or SHOP.'
  }
  if (body.color !== undefined && !/^#[0-9a-f]{6}$/i.test(String(body.color))) return 'Enter the colour as a hex value such as #38bdf8.'
  return null
}
