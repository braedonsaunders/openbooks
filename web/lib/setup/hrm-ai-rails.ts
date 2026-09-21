import type { SetupEntity } from './registry'

/**
 * HR-21 AI rails settings (ai_rails_settings singleton). The scan
 * thresholds, cohort key, org-declared bias terms and the ledger review
 * cadence are org-declared here; the deterministic services read them
 * with conservative fallbacks. Rehomed onto /admin/ai beside the
 * providers card and the governance ledger (never a standalone setup
 * page). The row is a per-org singleton seeded by migration 0232 and
 * ensured on ledger view: values editable, the row itself never created
 * or deleted here.
 */
export const AI_RAILS_SETTINGS_ENTITY: SetupEntity = {
  key: 'ai-rails-settings',
  table: 'ai_rails_settings',
  groupKey: 'workforce',
  featureKey: 'aiGovernanceLedger',
  rehomed: true, // section on the Admin → AI page
  iconKey: 'settings',
  orgScoped: true,
  actorCols: true,
  hasActive: false,
  allowCreate: false,
  allowDelete: false,
  docSlug: 'ai-governance-ledger',
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
