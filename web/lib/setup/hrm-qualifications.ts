import type { SetupEntity } from './registry'

/**
 * HR-14 qualification Setup entities. Both live rehomed on the
 * Qualifications page (SetupEntitySection), never on the setup rail —
 * one configurable surface, never two. The taxonomy (codes the org
 * declares) and the extended category vocabulary ride the registry;
 * the alert lead-day schedule rides the settings API beside them.
 */

const BASE_CATEGORIES = [
  { value: 'certification', labelKey: 'options.hrmQualificationCategory.certification' },
  { value: 'license', labelKey: 'options.hrmQualificationCategory.license' },
  { value: 'training', labelKey: 'options.hrmQualificationCategory.training' },
  { value: 'medical', labelKey: 'options.hrmQualificationCategory.medical' },
  { value: 'clearance', labelKey: 'options.hrmQualificationCategory.clearance' },
  { value: 'other', labelKey: 'options.hrmQualificationCategory.other' },
]

export const QUALIFICATION_TYPES_ENTITY: SetupEntity = {
  key: 'qualification-types',
  table: 'hrm_qualification_types',
  groupKey: 'workforce',
  featureKey: 'hrmCertifications',
  rehomed: true, // section on the HRM Qualifications page
  iconKey: 'badge-check',
  orgScoped: true,
  actorCols: true,
  naturalKey: 'code',
  hasActive: true,
  docSlug: 'qualifications-and-dispatch',
  columns: [
    { key: 'code', kind: 'code' },
    { key: 'name', kind: 'text' },
    { key: 'category', kind: 'badge' },
    { key: 'validityMonths', kind: 'number' },
    { key: 'isActive', kind: 'badge-active' },
  ],
  fields: [
    { key: 'code', kind: 'text', required: true, lockedOnEdit: true },
    { key: 'name', kind: 'text', required: true },
    { key: 'category', kind: 'select', required: true, options: BASE_CATEGORIES },
    { key: 'issuingBody', kind: 'text' },
    { key: 'validityMonths', kind: 'integer', helpTextKey: 'fieldHelp.hrmQualificationValidity' },
    { key: 'renewalLeadDays', kind: 'integer' },
    { key: 'requiresEvidence', kind: 'boolean' },
  ],
}

export const QUALIFICATION_SETTINGS_ENTITY: SetupEntity = {
  key: 'qualification-settings',
  table: 'hrm_qualification_settings',
  groupKey: 'workforce',
  featureKey: 'hrmCertifications',
  rehomed: true, // section on the HRM Qualifications page
  iconKey: 'settings',
  orgScoped: true,
  actorCols: true,
  // The settings row is a per-org singleton seeded by the service: values
  // editable, but the row itself is never created or deleted here.
  hasActive: false,
  allowCreate: false,
  allowDelete: false,
  docSlug: 'qualifications-and-dispatch',
  columns: [{ key: 'extraCategories', kind: 'text' }],
  fields: [
    {
      key: 'extraCategories',
      kind: 'stringArray',
      helpTextKey: 'fieldHelp.hrmQualificationExtraCategories',
    },
  ],
}
