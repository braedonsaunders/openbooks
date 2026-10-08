/** Setup-registry scheduling entities (Workforce group): boards and booking codes. */
import { sql } from 'drizzle-orm'
import type { SetupEntity, SetupOption } from '../types'

const ROW_KINDS: SetupOption[] = [
  { value: 'people', labelKey: 'scheduleRowKind.people' },
  { value: 'tasks', labelKey: 'scheduleRowKind.tasks' },
]
const GRAINS: SetupOption[] = [
  { value: 'day', labelKey: 'scheduleGrain.day' },
  { value: 'timed', labelKey: 'scheduleGrain.timed' },
]
const VIEWS: SetupOption[] = [
  { value: 'grid', labelKey: 'scheduleView.grid' },
  { value: 'targets', labelKey: 'scheduleView.targets' },
  { value: 'timeline', labelKey: 'scheduleView.timeline' },
  { value: 'calendar', labelKey: 'scheduleView.calendar' },
  { value: 'gantt', labelKey: 'scheduleView.gantt' },
  { value: 'progress', labelKey: 'scheduleView.progress' },
]
const PUBLISH_POLICIES: SetupOption[] = [
  { value: 'live', labelKey: 'schedulePublishPolicy.live' },
  { value: 'staged', labelKey: 'schedulePublishPolicy.staged' },
]
const CODE_CATEGORIES: SetupOption[] = [
  { value: 'work', labelKey: 'scheduleCodeCategory.work' },
  { value: 'unavailable', labelKey: 'scheduleCodeCategory.unavailable' },
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
      { titleKey: 'sections.scheduleBoardIdentity', fields: ['code', 'name', 'description', 'rowKind', 'sortOrder', 'isActive'] },
      { titleKey: 'sections.scheduleBoardScope', descriptionKey: 'sections.scheduleBoardScopeHelp', fields: ['subsidiaryId', 'departmentId', 'locationId', 'projectId'] },
      { titleKey: 'sections.scheduleBoardDisplay', fields: ['views', 'defaultView', 'rangeDays', 'weekStartsOn', 'showWeekends'] },
      { titleKey: 'sections.scheduleBoardBooking', descriptionKey: 'sections.scheduleBoardBookingHelp', fields: ['grain', 'timeZone', 'dayStarts', 'dayEnds', 'dayBreakMinutes', 'publishPolicy'] },
      { titleKey: 'sections.scheduleBoardAutomation', descriptionKey: 'sections.scheduleBoardAutomationHelp', fields: ['prefillTimesheets', 'prefillCrewTime', 'prefillFieldTickets', 'notifyAssignees'] },
    ],
    fields: [
      { key: 'code', kind: 'text', required: true, lockedOnEdit: true, helpTextKey: 'fieldHelp.scheduleBoardCode' },
      { key: 'name', kind: 'text', required: true },
      { key: 'description', kind: 'textarea' },
      { key: 'rowKind', kind: 'select', options: ROW_KINDS, required: true, lockedOnEdit: true, defaultValue: 'people', helpTextKey: 'fieldHelp.scheduleBoardRowKind' },
      { key: 'subsidiaryId', kind: 'ref', ref: 'subsidiaries' },
      { key: 'departmentId', kind: 'ref', ref: 'departments' },
      { key: 'locationId', kind: 'ref', ref: 'locations' },
      { key: 'projectId', kind: 'ref', ref: 'projects', helpTextKey: 'fieldHelp.scheduleBoardProject' },
      { key: 'views', kind: 'stringArray', arrayStorage: 'text', options: VIEWS, required: true, defaultValue: ['grid', 'targets', 'timeline', 'calendar'], helpTextKey: 'fieldHelp.scheduleBoardViews' },
      { key: 'defaultView', kind: 'select', options: VIEWS, required: true, defaultValue: 'grid' },
      { key: 'rangeDays', kind: 'integer', required: true, min: 1, max: 42, defaultValue: 14, helpTextKey: 'fieldHelp.scheduleBoardRangeDays' },
      { key: 'weekStartsOn', kind: 'integer', required: true, min: 0, max: 6, defaultValue: 0, helpTextKey: 'fieldHelp.scheduleBoardWeekStartsOn' },
      { key: 'showWeekends', kind: 'boolean', defaultValue: true },
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
    // The table's checks and guard are authoritative; this names the
    // common mistakes in operator terms before the write is attempted.
    validateWrite: async ({ body, executor, orgId, rowId }) => {
      let current: Record<string, unknown> = {}
      if (rowId) {
        current = (await executor.execute<Record<string, unknown>>(sql`select row_kind as "rowKind", views, default_view as "defaultView",
          range_days as "rangeDays", prefill_timesheets as "prefillTimesheets", prefill_crew_time as "prefillCrewTime",
          prefill_field_tickets as "prefillFieldTickets", notify_assignees as "notifyAssignees"
          from schedule_boards where org_id = ${orgId} and id = ${rowId}`)).rows[0] ?? {}
      }
      const merged = { ...current, ...body }
      const rowKind = String(merged.rowKind ?? 'people')
      const views = list(merged.views) ?? []
      const allowedViews = rowKind === 'tasks' ? TASK_VIEWS : PEOPLE_VIEWS
      const foreign = views.filter((view) => !allowedViews.has(view))
      if (views.length === 0) return 'Choose at least one view for the board.'
      if (foreign.length) return `${foreign.join(', ')} ${foreign.length === 1 ? 'is' : 'are'} not available on a ${rowKind === 'tasks' ? 'task' : 'people'} board.`
      if (!views.includes(String(merged.defaultView ?? ''))) return 'The default view must be one of the board views.'
      if (!RANGE_DAYS.has(Number(merged.rangeDays))) return 'Show 1, 3, 7, 14, 21, 28, 35 or 42 days.'
      if (rowKind === 'tasks' && [merged.prefillTimesheets, merged.prefillCrewTime, merged.prefillFieldTickets, merged.notifyAssignees].some((flag) => flag === true || flag === 'true')) {
        return 'Pre-fill and notification settings apply to people boards; turn them off for a task board.'
      }
      for (const key of ['dayStarts', 'dayEnds'] as const) {
        if (merged[key] !== undefined && !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(String(merged[key]))) return 'Enter the working day as clock times such as 07:00 and 15:30.'
      }
      return null
    },
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
    validateWrite: async ({ body }) => {
      if (body.code !== undefined && !/^[A-Z0-9][A-Z0-9/&+._-]{0,15}$/.test(String(body.code))) {
        return 'Codes are up to 16 capital letters, digits or / & + . _ -, such as TRAIN or SHOP.'
      }
      if (body.color !== undefined && !/^#[0-9a-f]{6}$/.test(String(body.color))) return 'Enter the colour as a hex value such as #38bdf8.'
      return null
    },
  },
]
