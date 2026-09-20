import type { SetupEntity } from './registry'

/**
 * Setup-registry descriptors for the HR leave taxonomy (0194).
 *
 * Lives in its own module only so the entries can be reviewed as one change;
 * both are ordinary registry entities and MUST be spread into SETUP_ENTITIES
 * in registry.ts — that is what wires the generic list view
 * (admin/setup/[entity]), the create/edit drawer, and the generic CRUD API
 * (api/admin/setup/[entity]).
 *
 * What these screens are, and are NOT:
 *
 * They are NOT the payroll banks. Leave types name time off (vacation,
 * sick, unpaid) and policies declare the entitlement in TIME (accrual and
 * carryover in hours); the payroll entitlement bank in VALUE is computed by
 * the pay run and read through the entitlement functions, never configured
 * here. The two are never conflated in code or copy — see the in-app docs
 * article "leave-time-versus-value".
 *
 * Policies never edit raw JSON (a json-kind field on a workforce entity is
 * barred by registry.test.ts). The drawer edits scope, accrual, and
 * carryover through typed slot controls backed by 0194 STORED GENERATED
 * columns (readable for prefill, never written); normalizeHrmLeavePolicyInput
 * folds the slots back into applies_to, accrual_rule, and carryover_rule
 * before buildRow, write.ts persists the folded objects explicitly, and
 * leavePolicyRuleProblem refuses malformed shapes with the engine's own
 * words before the write. The stored jsonb stays the source of truth, and a
 * rule that still arrives malformed fails closed at read time (the balance
 * read throws instead of accruing zero), never as a silent nil.
 */

const VALUE_CROSSINGS = [
  { value: 'none', labelKey: 'options.leaveValueCrossing.none' },
  { value: 'payout', labelKey: 'options.leaveValueCrossing.payout' },
  { value: 'bank_in', labelKey: 'options.leaveValueCrossing.bankIn' },
]

export const LEAVE_TYPES_ENTITY: SetupEntity = {
  key: 'leave-types',
  table: 'hrm_leave_types',
  groupKey: 'workforce',
  featureKey: 'hrm',
  iconKey: 'timer',
  orgScoped: true,
  actorCols: true,
  naturalKey: 'code',
  hasActive: true,
  docSlug: 'leave-time-versus-value',
  columns: [
    { key: 'code', kind: 'code' },
    { key: 'name', kind: 'text' },
    { key: 'paid', kind: 'boolean' },
    { key: 'valueCrossing', kind: 'badge', options: VALUE_CROSSINGS },
    { key: 'requiresAttachment', kind: 'boolean' },
    { key: 'isActive', kind: 'badge-active' },
  ],
  filters: [{ key: 'valueCrossing', options: VALUE_CROSSINGS }],
  fields: [
    // Code is identity: editable on create, read-only on edit — rename by
    // deactivating and creating the new code, never by rewriting history.
    { key: 'code', kind: 'text', required: true, lockedOnEdit: true },
    { key: 'name', kind: 'text', required: true },
    { key: 'paid', kind: 'boolean', defaultValue: true },
    {
      key: 'valueCrossing', kind: 'select', required: true, defaultValue: 'none',
      options: VALUE_CROSSINGS, helpTextKey: 'fieldHelp.leaveValueCrossing',
    },
    { key: 'requiresAttachment', kind: 'boolean' },
    { key: 'isActive', kind: 'boolean', defaultValue: true },
  ],
}

export const LEAVE_POLICIES_ENTITY: SetupEntity = {
  key: 'leave-policies',
  table: 'hrm_leave_policies',
  groupKey: 'workforce',
  featureKey: 'hrm',
  iconKey: 'calendar',
  orgScoped: true,
  actorCols: true,
  orderBy: 'effective_from desc',
  hasActive: true,
  docSlug: 'leave-time-versus-value',
  columns: [
    { key: 'leaveTypeId', kind: 'ref', ref: 'leave-types' },
    { key: 'effectiveFrom', kind: 'date' },
    { key: 'effectiveTo', kind: 'date' },
    { key: 'minimumNoticeDays', kind: 'number' },
    { key: 'isActive', kind: 'badge-active' },
  ],
  fields: [
    { key: 'leaveTypeId', kind: 'ref', ref: 'leave-types', required: true },
    // Structured rules edit as JSON (parsed by the setup coercer; invalid
    // JSON is refused, never stored). Scope pins are null for org-wide; the
    // engine resolves overlaps by specificity. Prefer the engine leave
    // service for validated authoring; the drawer carries the declaration.
    {
      key: 'appliesTo', kind: 'json', required: true,
      helpTextKey: 'fieldHelp.leaveAppliesTo',
    },
    { key: 'accrualRule', kind: 'json', required: true, helpTextKey: 'fieldHelp.leaveAccrualRule' },
    { key: 'carryoverRule', kind: 'json', required: true, helpTextKey: 'fieldHelp.leaveCarryoverRule' },
    { key: 'minimumNoticeDays', kind: 'integer', keepDefault: true, defaultValue: 0 },
    { key: 'effectiveFrom', kind: 'date', required: true },
    { key: 'effectiveTo', kind: 'date' },
    { key: 'isActive', kind: 'boolean', defaultValue: true },
  ],
}
