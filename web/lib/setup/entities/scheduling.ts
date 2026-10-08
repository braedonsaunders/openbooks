/** Setup-registry scheduling entities (Workforce group): boards and booking codes. */
import type { SetupEntity, SetupOption } from '../types'

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
export const SCHEDULING_ENTITIES: SetupEntity[] = [
  {
    // A board is a scoped lens: the people (or project tasks) of a legal
    // entity, department, location or project, with its views, publication
    // policy and booking behavior. Bookings belong to the board they were
    // made on, so archiving a board preserves its history.
    key: 'schedule-boards',
    rehomed: true,
    table: 'schedule_boards',
    singularTitleKey: 'entities.schedule-boards.singularTitle',
    actorCols: true,
    groupKey: 'workforce',
    iconKey: 'calendar',
    orgScoped: true,
    naturalKey: 'code',
    orderBy: 'sort_order, name',
    hasActive: true,
    allowDelete: true,
    archiveOnDelete: true,
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
      { titleKey: 'sections.scheduleBoardBooking', descriptionKey: 'sections.scheduleBoardBookingHelp', fields: ['grain', 'timeZone', 'dayPolicyKnown', 'dayStarts', 'dayEnds', 'dayBreakMinutes', 'publishPolicy'] },
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
      { key: 'views', kind: 'stringArray', arrayStorage: 'text', options: VIEWS, scopedOptions: { scopeField: 'rowKind', byValue: { people: VIEWS.slice(0, 4), resources: VIEWS.slice(0, 4), tasks: VIEWS.slice(4) } }, required: true, defaultValue: ['grid', 'targets', 'timeline', 'calendar'], helpTextKey: 'fieldHelp.scheduleBoardViews' },
      { key: 'defaultView', kind: 'select', options: VIEWS, scopedOptions: { scopeField: 'rowKind', byValue: { people: VIEWS.slice(0, 4), resources: VIEWS.slice(0, 4), tasks: VIEWS.slice(4) } }, required: true, defaultValue: 'grid' },
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
      { key: 'dayPolicyKnown', kind: 'boolean', required: true, defaultValue: true, helpTextKey: 'fieldHelp.scheduleBoardDayPolicyKnown' },
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
    featureKeysAny: ['hrmShiftPlanning', 'projectScheduling'],
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
