import type { SetupEntity } from './types'

/**
 * Recruiting-depth Setup entities, gated on the Recruiting module. All
 * four top-level lists live in Company Setup (SetupEntitySection
 * via the shared registry list and drawer), exposed on the setup rail — one
 * configurable surface, never two. Kit attributes and questions nest under their kit in
 * the registry (served by the shared CRUD API and the kits/[id] routes);
 * the kit drawer owns their authoring, so the registry carries no second
 * editor.
 *
 * Structured fields share the native Setup drawer. The Setup write path
 * validates their stored shapes through the authoritative engine validators.
 */

const RETENTION_BASES = [
  { value: 'inactivity', labelKey: 'options.hrmRetentionBasis.inactivity' },
  { value: 'consent', labelKey: 'options.hrmRetentionBasis.consent' },
]

const RETENTION_ACTIONS = [
  { value: 'anonymize', labelKey: 'options.hrmRetentionAction.anonymize' },
  { value: 'delete', labelKey: 'options.hrmRetentionAction.delete' },
]

export const RECRUITING_KITS_ENTITY: SetupEntity = {
  key: 'hrm-interview-kits',
  table: 'hrm_interview_kits',
  groupKey: 'workforce',
  featureKey: 'hrmRecruiting',
  iconKey: 'clipboard-check',
  orgScoped: true,
  actorCols: true,
  naturalKey: 'name',
  hasActive: true,
  docSlug: 'structured-interviews-offers-job-boards',
  columns: [
    { key: 'name', kind: 'text' },
    { key: 'pipelineStageId', kind: 'ref', ref: 'hrm-pipeline-stages' },
    { key: 'isActive', kind: 'badge-active' },
  ],
  fields: [
    { key: 'name', kind: 'text', required: true },
    { key: 'pipelineStageId', kind: 'ref', ref: 'hrm-pipeline-stages', helpTextKey: 'fieldHelp.hrmKitStage' },
    { key: 'instructions', kind: 'textarea', helpTextKey: 'fieldHelp.hrmKitInstructions' },
    // Canonical rating keys, subset of the four the engine knows. The
    // write path refuses unknown keys by name (storage CHECKs the same
    // vocabulary, but its error names no field).
    { key: 'ratingScale', kind: 'stringArray', helpTextKey: 'fieldHelp.hrmKitScale' },
    { key: 'isActive', kind: 'boolean' },
  ],
}

export const RECRUITING_KIT_ATTRIBUTES_ENTITY: SetupEntity = {
  key: 'hrm-kit-attributes',
  table: 'hrm_scorecard_attributes',
  groupKey: 'workforce',
  featureKey: 'hrmRecruiting',
  nestedUnder: 'hrm-interview-kits',
  iconKey: 'list-checks',
  orgScoped: true,
  actorCols: true,
  orderBy: 'position',
  hasActive: false,
  docSlug: 'structured-interviews-offers-job-boards',
  columns: [
    { key: 'kitId', kind: 'ref', ref: 'hrm-interview-kits' },
    { key: 'position', kind: 'number' },
    { key: 'category', kind: 'text' },
    { key: 'attribute', kind: 'text' },
    { key: 'isFocusDefault', kind: 'badge-active' },
  ],
  fields: [
    { key: 'kitId', kind: 'ref', ref: 'hrm-interview-kits', required: true },
    { key: 'category', kind: 'text', required: true },
    { key: 'attribute', kind: 'text', required: true },
    { key: 'description', kind: 'textarea' },
    { key: 'position', kind: 'integer', required: true },
    { key: 'isFocusDefault', kind: 'boolean', helpTextKey: 'fieldHelp.hrmAttributeFocus' },
  ],
}

export const RECRUITING_KIT_QUESTIONS_ENTITY: SetupEntity = {
  key: 'hrm-kit-questions',
  table: 'hrm_interview_kit_questions',
  groupKey: 'workforce',
  featureKey: 'hrmRecruiting',
  nestedUnder: 'hrm-interview-kits',
  iconKey: 'list-checks',
  orgScoped: true,
  actorCols: true,
  orderBy: 'position',
  hasActive: false,
  docSlug: 'structured-interviews-offers-job-boards',
  columns: [
    { key: 'kitId', kind: 'ref', ref: 'hrm-interview-kits' },
    { key: 'position', kind: 'number' },
    { key: 'question', kind: 'text' },
  ],
  fields: [
    { key: 'kitId', kind: 'ref', ref: 'hrm-interview-kits', required: true },
    { key: 'question', kind: 'textarea', required: true },
    { key: 'position', kind: 'integer', required: true },
    { key: 'attributeId', kind: 'ref', ref: 'hrm-kit-attributes', helpTextKey: 'fieldHelp.hrmQuestionAttribute' },
  ],
}

export const RECRUITING_INTERVIEWER_POOLS_ENTITY: SetupEntity = {
  key: 'hrm-interviewer-pools',
  table: 'hrm_interviewer_pools',
  groupKey: 'workforce',
  featureKey: 'hrmRecruiting',
  iconKey: 'users',
  orgScoped: true,
  actorCols: true,
  naturalKey: 'name',
  hasActive: true,
  docSlug: 'structured-interviews-offers-job-boards',
  columns: [
    { key: 'name', kind: 'text' },
    { key: 'kitId', kind: 'ref', ref: 'hrm-interview-kits' },
    { key: 'isActive', kind: 'badge-active' },
  ],
  fields: [
    { key: 'name', kind: 'text', required: true },
    { key: 'kitId', kind: 'ref', ref: 'hrm-interview-kits', helpTextKey: 'fieldHelp.hrmPoolKit' },
    { key: 'availability', kind: 'objectArray', helpTextKey: 'fieldHelp.hrmPoolAvailability', fields: [
      { key: 'startsAt', kind: 'zonedDateTime', required: true, helpTextKey: 'fieldHelp.zonedDateTime' },
      { key: 'endsAt', kind: 'zonedDateTime', required: true, helpTextKey: 'fieldHelp.zonedDateTime' },
      { key: 'timezone', kind: 'text', required: true, helpTextKey: 'fieldHelp.ianaTimezone' },
    ] },
    { key: 'isActive', kind: 'boolean' },
  ],
}

export const RECRUITING_OFFER_TEMPLATES_ENTITY: SetupEntity = {
  key: 'hrm-offer-templates',
  table: 'hrm_offer_templates',
  groupKey: 'workforce',
  featureKey: 'hrmRecruiting',
  iconKey: 'file',
  orgScoped: true,
  actorCols: true,
  naturalKey: 'name',
  hasActive: true,
  docSlug: 'structured-interviews-offers-job-boards',
  columns: [
    { key: 'name', kind: 'text' },
    { key: 'approvalRequired', kind: 'badge-active' },
    { key: 'isActive', kind: 'badge-active' },
  ],
  fields: [
    { key: 'name', kind: 'text', required: true },
    { key: 'bodyTemplate', kind: 'textarea', required: true, helpTextKey: 'fieldHelp.hrmTemplateBody' },
    { key: 'clauses', kind: 'objectArray', helpTextKey: 'fieldHelp.hrmTemplateClauses', fields: [
      { key: 'key', kind: 'text', required: true },
      { key: 'label', kind: 'text' },
      { key: 'body', kind: 'textarea', required: true },
      { key: 'default_on', kind: 'boolean', defaultValue: false },
    ] },
    { key: 'approvalRequired', kind: 'boolean' },
    { key: 'isActive', kind: 'boolean' },
  ],
}

export const RECRUITING_RETENTION_RULES_ENTITY: SetupEntity = {
  key: 'hrm-retention-rules',
  table: 'hrm_retention_rules',
  groupKey: 'workforce',
  featureKey: 'hrmRecruiting',
  iconKey: 'timer',
  orgScoped: true,
  actorCols: true,
  naturalKey: 'name',
  hasActive: true,
  docSlug: 'structured-interviews-offers-job-boards',
  columns: [
    { key: 'name', kind: 'text' },
    { key: 'basis', kind: 'badge', options: RETENTION_BASES },
    { key: 'retainMonths', kind: 'number' },
    { key: 'action', kind: 'badge', options: RETENTION_ACTIONS },
    { key: 'isActive', kind: 'badge-active' },
  ],
  filters: [{ key: 'basis', options: RETENTION_BASES }],
  fields: [
    { key: 'name', kind: 'text', required: true },
    { key: 'regionScope', kind: 'object', defaultValue: { applies_to: 'all' }, helpTextKey: 'fieldHelp.hrmRetentionScope', fields: [
      { key: 'applies_to', kind: 'select', required: true, options: [
        { value: 'all', labelKey: 'options.retentionRegions.all' },
        { value: 'countries', labelKey: 'options.retentionRegions.countries' },
      ] },
      { key: 'countries', kind: 'stringArray', required: true, ref: 'countries', showWhen: { field: 'applies_to', in: ['countries'] } },
    ] },
    { key: 'basis', kind: 'select', required: true, options: RETENTION_BASES },
    { key: 'retainMonths', kind: 'integer', required: true },
    { key: 'action', kind: 'select', required: true, options: RETENTION_ACTIONS },
    { key: 'consentExtensionLeadDays', kind: 'integer', helpTextKey: 'fieldHelp.hrmRetentionLeadDays' },
    { key: 'isActive', kind: 'boolean' },
  ],
}
