import 'server-only';
import { canonicalDecimal, compareDecimal } from './exact-decimal';
import { validateCustomValues, type CustomFieldDef } from './custom-fields';

/** A definition must not install input rules or defaults that its own value
 * validator cannot satisfy. Unrecognized extension metadata is retained. */
export function validateCustomFieldConfig(fieldType: CustomFieldDef['fieldType'], input: unknown): string | null {
  if (input !== undefined && input !== null && (typeof input !== 'object' || Array.isArray(input))) {
    return 'config must be an object';
  }
  const config = (input ?? {}) as Record<string, unknown>;
  for (const key of ['helpText', 'placeholder']) {
    if (config[key] !== undefined && typeof config[key] !== 'string') return `${key} must be a string`;
  }
  if (config.showInList !== undefined && typeof config.showInList !== 'boolean') return 'showInList must be a boolean';
  if (config.displayMode !== undefined && (typeof config.displayMode !== 'string' || !['always', 'normal', 'readonly', 'disabled', 'hidden'].includes(config.displayMode))) {
    return 'invalid display mode';
  }
  if (config.allowedRoles !== undefined && (!Array.isArray(config.allowedRoles) || config.allowedRoles.some(role => typeof role !== 'string' || !role.trim()))) {
    return 'allowedRoles must be a list of role keys';
  }
  const bounds: Record<string, string> = {};
  for (const key of ['min', 'max']) {
    const value = config[key];
    if (value == null) continue;
    const exact = typeof value === 'string' || typeof value === 'number' ? canonicalDecimal(value, 4) : null;
    if (exact === null) return `${key} must be an exact decimal with at most four decimal places`;
    bounds[key] = exact;
  }
  if (bounds.min !== undefined && bounds.max !== undefined && compareDecimal(bounds.min, bounds.max) > 0) {
    return 'min must not exceed max';
  }
  const value = config.defaultValue;
  if (value === undefined || value === null || value === '') return null;
  if ((fieldType === 'number' || fieldType === 'currency') && typeof value !== 'string' && typeof value !== 'number') return 'invalid numeric default';
  if ((fieldType === 'text' || fieldType === 'long_text' || fieldType === 'select') && typeof value !== 'string') return 'defaultValue must be a string';
  if (fieldType === 'boolean' && value !== true && value !== false && value !== 'true' && value !== 'false') return 'invalid boolean default';
  if (fieldType === 'multi_select' && typeof value !== 'string' && (!Array.isArray(value) || value.some(option => typeof option !== 'string'))) return 'invalid selection default';
  const result = validateCustomValues([{
    id: 'definition-default', targetTable: '', targetKind: null, key: 'value', label: 'Default value',
    fieldType, config: { ...config, ...bounds } as CustomFieldDef['config'], isRequired: false, sortOrder: 0,
  }], { value });
  return result.ok ? null : result.errors.value ?? 'invalid defaultValue';
}

/** Called only after validation; canonical bounds must also be the bounds later
 * consumed by the value validator, including legacy numeric configuration. */
export function normalizeCustomFieldConfig(input: unknown): Record<string, unknown> {
  const config = { ...((input ?? {}) as Record<string, unknown>) };
  for (const key of ['min', 'max']) {
    if (config[key] != null) config[key] = canonicalDecimal(config[key], 4)!;
  }
  return config;
}
