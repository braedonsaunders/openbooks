import type { SetupEntity } from './types'

/** The existing organization policy record for deterministic workforce checks, drafting terms and review cadence. */
export const AI_RAILS_SETTINGS_ENTITY: SetupEntity = {
  key: 'ai-rails-settings',
  table: 'ai_rails_settings',
  // The organization ID is the existing singleton's primary key.
  idColumn: 'org_id',
  groupKey: 'workforce',
  featureKey: 'aiGovernanceLedger',
  iconKey: 'settings',
  orgScoped: true,
  actorCols: true,
  hasActive: false,
  allowCreate: false,
  allowDelete: false,
  docSlug: 'ai-governance-ledger',
  recordSections: [
    { key: 'checks', titleKey: 'aiPolicy.checksTitle', descriptionKey: 'aiPolicy.checksDescription', fields: ['zThreshold', 'retroThreshold', 'cohortKey'] },
    { key: 'drafting', titleKey: 'aiPolicy.draftingTitle', descriptionKey: 'aiPolicy.draftingDescription', fields: ['biasTerms'] },
    { key: 'reviews', titleKey: 'aiPolicy.reviewsTitle', descriptionKey: 'aiPolicy.reviewsDescription', fields: ['reviewMonths'] },
  ],
  columns: [
    { key: 'zThreshold', kind: 'number' },
    { key: 'retroThreshold', kind: 'number' },
    { key: 'cohortKey', kind: 'badge' },
    { key: 'reviewMonths', kind: 'number' },
  ],
  fields: [
    {
      key: 'zThreshold',
      kind: 'decimal',
      required: true,
      helpTextKey: 'fieldHelp.aiRailsZThreshold',
    },
    {
      key: 'retroThreshold',
      kind: 'decimal',
      required: true,
      helpTextKey: 'fieldHelp.aiRailsRetroThreshold',
    },
    {
      key: 'cohortKey',
      kind: 'select',
      required: true,
      options: [
        { value: 'subsidiary', labelKey: 'options.aiRailsCohort.subsidiary' },
        { value: 'department', labelKey: 'options.aiRailsCohort.department' },
        { value: 'pay_schedule', labelKey: 'options.aiRailsCohort.paySchedule' },
        { value: 'job_level', labelKey: 'options.aiRailsCohort.jobLevel' },
      ],
      helpTextKey: 'fieldHelp.aiRailsCohort',
    },
    {
      key: 'biasTerms',
      kind: 'stringArray',
      helpTextKey: 'fieldHelp.aiRailsBiasTerms',
    },
    {
      key: 'reviewMonths',
      kind: 'integer',
      required: true,
      helpTextKey: 'fieldHelp.aiRailsReviewMonths',
    },
  ],
}

/** Configuration writes remain owned by the native capability command, never generic CRUD. */
export const AI_CAPABILITIES_ENTITY: SetupEntity = {
  key: 'ai-capabilities', table: 'ai_capabilities', groupKey: 'company', iconKey: 'settings',
  orgScoped: true, hasActive: false, featureKey: 'aiGovernanceLedger',
  readOnly: true, allowCreate: false, allowDelete: false, importVia: 'none',
  naturalKey: 'key', docSlug: 'ai-governance-ledger',
  columns: [{ key: 'name', kind: 'text' }, { key: 'purpose', kind: 'text' }, { key: 'autonomy', kind: 'text' }],
  fields: [],
}
