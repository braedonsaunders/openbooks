import type { SetupEntity } from './registry'

/**
 * Setup-registry descriptors for HR documents (0230).
 *
 * Each lives in this module only so the entries can be reviewed as one
 * change; all three MUST be spread into SETUP_ENTITIES in registry.ts —
 * that wires the generic list view (admin/setup/[entity]), the
 * create/edit drawer, and the generic CRUD API
 * (api/admin/setup/[entity]). All three are rehomed onto /hrm/documents
 * (rehomed: true hides them from the setup rail): categories, templates,
 * and retention rules are configured where documents are worked.
 *
 * Templates edit signer_roles and merge_fields through typed slot
 * controls (three signer booleans in canonical employee → manager → hr
 * order, plus a merge-key string array) — never raw JSON
 * (registry.test.ts bars json-kind workforce fields).
 * normalizeHrmDocumentTemplateInput (./hrm-document-template.ts) folds
 * the slots back into signerRoles/mergeFields arrays before buildRow,
 * hrm-rule-slots.ts persists the folded arrays, and
 * validateEntityIntegrity refuses unknown merge keys with the engine's
 * own words (DOCUMENT_MERGE_FIELDS) and undeclared categories against
 * hrm_document_categories.
 */

const FROM_EVENTS = ['completion', 'termination', 'creation'].map((value) => ({
  value,
  labelKey: `options.hrmDocFromEvent.${value}`,
}))

const TERMINAL_ACTIONS = ['delete', 'anonymize'].map((value) => ({
  value,
  labelKey: `options.hrmDocAction.${value}`,
}))

export const DOCUMENT_CATEGORIES_ENTITY: SetupEntity = {
  key: 'hrm-document-categories',
  table: 'hrm_document_categories',
  groupKey: 'workforce',
  featureKey: 'hrmDocuments',
  rehomed: true,
  rehomedTo: '/hrm/documents',
  iconKey: 'tag',
  orgScoped: true,
  actorCols: true,
  naturalKey: 'key',
  refValue: 'key',
  hasActive: true,
  docSlug: 'documents-signatures-and-retention',
  columns: [
    { key: 'key', kind: 'code' },
    { key: 'label', kind: 'text' },
    { key: 'isActive', kind: 'badge-active' },
  ],
  fields: [
    { key: 'key', kind: 'text', required: true, lockedOnEdit: true },
    { key: 'label', kind: 'text', required: true },
    { key: 'isActive', kind: 'boolean', defaultValue: true },
  ],
}

export const RETENTION_SCHEDULES_ENTITY: SetupEntity = {
  key: 'hrm-retention-schedules',
  table: 'hrm_retention_schedules',
  groupKey: 'workforce',
  featureKey: 'hrmDocumentRetention',
  rehomed: true,
  rehomedTo: '/hrm/documents',
  iconKey: 'archive',
  orgScoped: true,
  actorCols: true,
  naturalKey: 'categoryKey',
  hasActive: true,
  docSlug: 'documents-signatures-and-retention',
  columns: [
    { key: 'categoryKey', kind: 'ref', ref: 'hrm-document-categories' },
    { key: 'retainYears', kind: 'number' },
    { key: 'fromEvent', kind: 'badge' },
    { key: 'action', kind: 'badge' },
    { key: 'isActive', kind: 'badge-active' },
  ],
  filters: [
    { key: 'fromEvent', options: FROM_EVENTS },
    { key: 'action', options: TERMINAL_ACTIONS },
  ],
  fields: [
    { key: 'categoryKey', kind: 'ref', ref: 'hrm-document-categories', required: true, lockedOnEdit: true },
    { key: 'retainYears', kind: 'integer', required: true, min: 0, max: 100 },
    { key: 'fromEvent', kind: 'select', required: true, options: FROM_EVENTS },
    { key: 'action', kind: 'select', required: true, options: TERMINAL_ACTIONS },
    { key: 'isActive', kind: 'boolean', defaultValue: true },
  ],
}

export const DOCUMENT_TEMPLATES_ENTITY: SetupEntity = {
  key: 'hrm-document-templates',
  table: 'hrm_document_templates',
  groupKey: 'workforce',
  featureKey: 'hrmDocuments',
  rehomed: true,
  rehomedTo: '/hrm/documents',
  iconKey: 'file-text',
  orgScoped: true,
  actorCols: true,
  naturalKey: 'name',
  hasActive: true,
  docSlug: 'documents-signatures-and-retention',
  columns: [
    { key: 'name', kind: 'text' },
    { key: 'categoryKey', kind: 'ref', ref: 'hrm-document-categories' },
    { key: 'requiresSignature', kind: 'boolean' },
    { key: 'isActive', kind: 'badge-active' },
  ],
  fields: [
    { key: 'name', kind: 'text', required: true },
    { key: 'categoryKey', kind: 'ref', ref: 'hrm-document-categories', required: true },
    { key: 'bodyTemplate', kind: 'textarea', required: true },
    // Merge keys declared as a string array, folded into merge_fields
    // before buildRow — the drawer never edits the jsonb directly.
    { key: 'mergeFields', kind: 'stringArray' },
    { key: 'requiresSignature', kind: 'boolean' },
    // Signer membership in canonical order; the fold emits signer_roles
    // as the ordered subset, so the drawer cannot invent a role or an
    // order the signing engine does not enforce.
    { key: 'signEmployee', kind: 'boolean' },
    { key: 'signManager', kind: 'boolean' },
    { key: 'signHr', kind: 'boolean' },
    { key: 'acknowledgmentOnly', kind: 'boolean' },
    { key: 'isActive', kind: 'boolean', defaultValue: true },
  ],
}
