import type { SetupEntity } from './registry'

/**
 * Setup-registry descriptor for observed statutory holidays.
 *
 * Lives in its own module only so the entry can be reviewed as one change; it
 * is an ordinary registry entity and MUST be spread into SETUP_ENTITIES in
 * registry.ts — that is what wires the generic CRUD API
 * (api/admin/setup/[entity]) and the ref-option loader. See
 * .local/handoff-holidays.md.
 *
 * What this screen is, and is NOT:
 *
 * It is NOT the holiday calendar. The calendar is a jurisdictional fact
 * declared by the country pack (engine/src/payroll/packs.ts), and no row here
 * can invent, move or delete a mandatory statutory holiday — the engine
 * refuses. This screen is the ELECTIONS an employer makes on top of it: the
 * optional days its jurisdiction names but does not compel (Boxing Day in
 * Ontario, Heritage Day in Alberta, Easter Monday in Quebec as the alternative
 * to Good Friday), and its own closures.
 *
 * The resolved calendar — pack days and elections merged, dated, for any year
 * — is the read-only companion tab, so an operator confirms what a change
 * actually did instead of inferring it.
 */

/** Pack jurisdiction keys. Mirrors `declaredJurisdictions()`; a key the pack
 *  does not declare is refused by the engine rather than silently ignored. */
const HOLIDAY_JURISDICTIONS = [
  { value: 'CA', labelKey: 'options.holidayJurisdiction.ca' },
  { value: 'CA-AB', labelKey: 'options.holidayJurisdiction.caAb' },
  { value: 'CA-BC', labelKey: 'options.holidayJurisdiction.caBc' },
  { value: 'CA-ON', labelKey: 'options.holidayJurisdiction.caOn' },
  { value: 'CA-QC', labelKey: 'options.holidayJurisdiction.caQc' },
  { value: 'CA-SK', labelKey: 'options.holidayJurisdiction.caSk' },
  { value: 'US', labelKey: 'options.holidayJurisdiction.us' },
]

const HOLIDAY_RULE_KINDS = [
  { value: 'date', labelKey: 'options.holidayRuleKind.date' },
  { value: 'fixed', labelKey: 'options.holidayRuleKind.fixed' },
  { value: 'nth_weekday', labelKey: 'options.holidayRuleKind.nthWeekday' },
  { value: 'weekday_before', labelKey: 'options.holidayRuleKind.weekdayBefore' },
  { value: 'easter_offset', labelKey: 'options.holidayRuleKind.easterOffset' },
]

const HOLIDAY_OBSERVANCE = [
  { value: 'none', labelKey: 'options.holidayObservance.none' },
  { value: 'next_monday', labelKey: 'options.holidayObservance.nextMonday' },
  { value: 'nearest_weekday', labelKey: 'options.holidayObservance.nearestWeekday' },
]

export const PAYROLL_HOLIDAYS_ENTITY: SetupEntity = {
  key: 'payroll-holidays',
  table: 'payroll_holidays',
  groupKey: 'workforce',
  featureKey: 'payroll',
  rehomed: true, // subtab of the Payroll setup workspace, beside the calendar
  iconKey: 'calendar',
  orgScoped: true,
  actorCols: true,
  orderBy: 'jurisdiction, effective_from, pack_key nulls last, name',
  // Deliberately NOT `hasActive`: a suppressed election is `isObserved = false`,
  // which is a real, visible statement about the calendar, not an archived
  // record. Hiding it the way archived setup rows are hidden would make "we do
  // not observe Boxing Day" invisible the moment it was saved.
  hasActive: false,
  columns: [
    { key: 'jurisdiction', kind: 'badge', options: HOLIDAY_JURISDICTIONS },
    { key: 'packKey', kind: 'code' },
    { key: 'name', kind: 'text' },
    { key: 'ruleKind', kind: 'badge', options: HOLIDAY_RULE_KINDS },
    { key: 'observedOn', kind: 'date' },
    { key: 'isObserved', kind: 'boolean' },
    { key: 'isPaid', kind: 'boolean' },
    { key: 'effectiveFrom', kind: 'date' },
    { key: 'effectiveTo', kind: 'date' },
  ],
  filters: [{ key: 'jurisdiction', options: HOLIDAY_JURISDICTIONS }],
  fields: [
    {
      key: 'jurisdiction', kind: 'select', required: true, options: HOLIDAY_JURISDICTIONS,
      helpTextKey: 'fieldHelp.holidayJurisdiction',
    },
    // Effective dating is compared against the holiday's OBSERVED DATE, never
    // against today, so re-running a prior period reproduces that period's
    // calendar rather than today's configuration.
    { key: 'effectiveFrom', kind: 'date', required: true },
    { key: 'effectiveTo', kind: 'date', helpTextKey: 'fieldHelp.holidayEffectiveTo' },
    {
      key: 'packKey', kind: 'text',
      helpTextKey: 'fieldHelp.holidayPackKey',
      sectionKey: 'sections.holidayElection',
    },
    { key: 'isObserved', kind: 'boolean', helpTextKey: 'fieldHelp.holidayIsObserved' },
    { key: 'isPaid', kind: 'boolean', helpTextKey: 'fieldHelp.holidayIsPaid' },
    {
      key: 'name', kind: 'text',
      helpTextKey: 'fieldHelp.holidayName',
      sectionKey: 'sections.holidayCompanyDay',
    },
    { key: 'ruleKind', kind: 'select', options: HOLIDAY_RULE_KINDS },
    { key: 'observedOn', kind: 'date', showWhen: { field: 'ruleKind', in: ['date'] } },
    {
      key: 'ruleMonth', kind: 'integer',
      showWhen: { field: 'ruleKind', in: ['fixed', 'nth_weekday', 'weekday_before'] },
    },
    {
      key: 'ruleDay', kind: 'integer',
      showWhen: { field: 'ruleKind', in: ['fixed', 'weekday_before'] },
    },
    {
      key: 'ruleWeekday', kind: 'integer',
      helpTextKey: 'fieldHelp.holidayRuleWeekday',
      showWhen: { field: 'ruleKind', in: ['nth_weekday', 'weekday_before'] },
    },
    {
      key: 'ruleNth', kind: 'integer',
      helpTextKey: 'fieldHelp.holidayRuleNth',
      showWhen: { field: 'ruleKind', in: ['nth_weekday'] },
    },
    {
      key: 'ruleOffset', kind: 'integer',
      helpTextKey: 'fieldHelp.holidayRuleOffset',
      showWhen: { field: 'ruleKind', in: ['easter_offset'] },
    },
    {
      key: 'observance', kind: 'select', keepDefault: true, defaultValue: 'none',
      options: HOLIDAY_OBSERVANCE, helpTextKey: 'fieldHelp.holidayObservance',
      showWhen: { field: 'ruleKind', in: ['fixed', 'nth_weekday', 'weekday_before', 'easter_offset'] },
    },
  ],
}
