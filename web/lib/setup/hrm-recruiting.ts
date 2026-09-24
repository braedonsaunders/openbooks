import type { SetupEntity } from './registry'

/**
 * HR-18 recruiting-depth Setup entities (0229). All four top-level lists
 * live rehomed on /hrm/recruiting (SetupEntitySection via the shared
 * `setup-section` widget), never on the setup rail — one configurable
 * surface, never two. Kit attributes and questions nest under their kit in
 * the registry (served by the shared CRUD API and the kits/[id] routes);
 * the kit drawer owns their authoring, so the registry carries no second
 * editor.
 *
 * Scalar fields only. Availability windows, template clauses, the kit
 * rating scale and the retention region scope are validated structures:
 * the drawer edits them as JSON and the Setup write path (web/lib/setup/
 * write.ts, HR-18 block) validates each one through the engine service
 * that owns the shape — validateAvailabilityWindows, parseClauses,
 * CANONICAL_RATING_KEYS, retentionScopeMatches — so Setup can never store
 * a row the services refuse to read. Pool membership (member_party_ids)
 * is deliberately NOT a registry field: the generic section cannot load
 * member checkboxes (members={[]}), so a multiref here would silently
 * wipe membership on every edit. Membership rides the interview panel.
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
  featureKey: 'hrmStructuredInterviews',
  rehomed: true, // section on the HRM Recruiting page (Interviews tab)
  rehomedTo: '/hrm/recruiting?tab=interviews',
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
  featureKey: 'hrmStructuredInterviews',
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
  featureKey: 'hrmStructuredInterviews',
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
  featureKey: 'hrmInterviewScheduling',
  rehomed: true, // section on the HRM Recruiting page (Interviews tab)
  rehomedTo: '/hrm/recruiting?tab=interviews',
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
    // Declared availability windows [{startsAt, endsAt, timezone}] — the
    // windows propose-slots books from. Edited as JSON, validated by the
    // engine validator on write; the service refuses an empty or
    // unordered list by name before a slot is ever stored.
    { key: 'availability', kind: 'json', helpTextKey: 'fieldHelp.hrmPoolAvailability' },
    { key: 'isActive', kind: 'boolean' },
  ],
}

export const RECRUITING_OFFER_TEMPLATES_ENTITY: SetupEntity = {
  key: 'hrm-offer-templates',
  table: 'hrm_offer_templates',
  groupKey: 'workforce',
  featureKey: 'hrmOfferSigning',
  rehomed: true, // section on the HRM Recruiting page (Offers tab)
  rehomedTo: '/hrm/recruiting?tab=offers',
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
    // Clause list [{key, label, body, default_on}] — edited as JSON and
    // parsed by the same parseClauses the renderer uses, so a template
    // that cannot render cannot be saved.
    { key: 'clauses', kind: 'json', helpTextKey: 'fieldHelp.hrmTemplateClauses' },
    { key: 'approvalRequired', kind: 'boolean' },
    { key: 'isActive', kind: 'boolean' },
  ],
}

export const RECRUITING_RETENTION_RULES_ENTITY: SetupEntity = {
  key: 'hrm-retention-rules',
  table: 'hrm_retention_rules',
  groupKey: 'workforce',
  featureKey: 'hrmCandidateRetention',
  rehomed: true, // section on the HRM Recruiting page (Pools tab: pools keep
  // candidates, retention rules bound how long — one stewardship surface)
  rehomedTo: '/hrm/recruiting?tab=pools',
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
    // Region scope {applies_to: all | countries, countries?[]} — edited
    // as JSON; an unreadable scope matches nothing at runtime (fail
    // closed), so the write path refuses malformed shapes by name.
    { key: 'regionScope', kind: 'json', helpTextKey: 'fieldHelp.hrmRetentionScope' },
    { key: 'basis', kind: 'select', required: true, options: RETENTION_BASES },
    { key: 'retainMonths', kind: 'integer', required: true },
    { key: 'action', kind: 'select', required: true, options: RETENTION_ACTIONS },
    { key: 'consentExtensionLeadDays', kind: 'integer', helpTextKey: 'fieldHelp.hrmRetentionLeadDays' },
    { key: 'isActive', kind: 'boolean' },
  ],
}
