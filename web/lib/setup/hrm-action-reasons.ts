import type { SetupEntity } from './registry'

/**
 * Setup-registry descriptor for HR action/reason codes (0227).
 *
 * Lives in its own module only so the entry can be reviewed as one change;
 * it MUST be spread into SETUP_ENTITIES in registry.ts — that wires the
 * generic list view, the create/edit drawer, and the generic CRUD API.
 * Rehomed onto /hrm/change-requests (rehomed: true hides it from the setup
 * rail): reasons are configured where changes are proposed. The generic
 * write path maps camelCase field keys to the snake_case columns.
 */

const HRM_ACTIONS = [
  'hire', 'rehire', 'transfer', 'promotion', 'demotion', 'pay_change',
  'manager_change', 'location_change', 'schedule_change',
  'leave_of_absence', 'return', 'termination', 'profile_change', 'other',
].map((value) => ({ value, labelKey: `options.hrmAction.${value}` }))

export const ACTION_REASONS_ENTITY: SetupEntity = {
  key: 'hrm-action-reasons',
  table: 'hrm_action_reasons',
  groupKey: 'workforce',
  featureKey: 'hrmActionReasons',
  rehomed: true,
  rehomedTo: '/hrm/change-requests?reasons=1',
  iconKey: 'tag',
  orgScoped: true,
  actorCols: true,
  hasActive: true,
  docSlug: 'correcting-and-rescinding-changes',
  columns: [
    { key: 'action', kind: 'badge' },
    { key: 'reasonCode', kind: 'code' },
    { key: 'label', kind: 'text' },
    { key: 'requiresComment', kind: 'boolean' },
    { key: 'isActive', kind: 'badge-active' },
  ],
  filters: [{ key: 'action', options: HRM_ACTIONS }],
  fields: [
    {
      key: 'action',
      kind: 'select',
      required: true,
      lockedOnEdit: true,
      options: HRM_ACTIONS,
    },
    { key: 'reasonCode', kind: 'text', required: true, lockedOnEdit: true },
    { key: 'label', kind: 'text', required: true },
    { key: 'requiresComment', kind: 'boolean' },
    { key: 'isActive', kind: 'boolean', defaultValue: true },
  ],
}
