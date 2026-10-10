/** Serializable connector configuration shared by forms and native commands. */
export const SYNC_CONTENT_KEYS = ['attachments', 'projectFinancials', 'crm', 'fixedAssets'] as const;
export type SyncContentKey = typeof SYNC_CONTENT_KEYS[number];
export type SyncSelection = Record<SyncContentKey, boolean>;
export type SyncCapabilities = Record<SyncContentKey, boolean>;

export interface MappingField {
  key: string;
  kind: 'identifier' | 'values' | 'tax';
  /** A field belongs to the explicitly configured source record. */
  requires?: string;
  targets?: readonly string[];
}
export interface MappingGroup { key: string; fields: readonly MappingField[] }
export const NETSUITE_MAPPING_GROUPS: readonly MappingGroup[] = [
  { key: 'projects', fields: [
    { key: 'projectForemanField', kind: 'identifier' },
    { key: 'projectPurchaseOrderField', kind: 'identifier' },
    { key: 'projectStatuses', kind: 'values', targets: ['active', 'awarded', 'substantially_complete', 'closed', 'cancelled'] },
    { key: 'projectBillingTypes', kind: 'values', targets: ['time_and_materials', 'fixed_price', 'cost_plus', 'not_to_exceed'] },
  ] },
  { key: 'transactionLines', fields: [{ key: 'lineMarkupField', kind: 'identifier' }, { key: 'lineBillableField', kind: 'identifier' }] },
  { key: 'items', fields: [{ key: 'itemCategoryField', kind: 'identifier' }] },
  { key: 'parties', fields: [{ key: 'customerShortCodeField', kind: 'identifier' }, { key: 'employeeBenefitsField', kind: 'identifier' }] },
  { key: 'timeTypes', fields: [{ key: 'timeTypeRecord', kind: 'identifier' }, { key: 'timeTypeMultiplierField', kind: 'identifier', requires: 'timeTypeRecord' }] },
  { key: 'timeEntries', fields: [{ key: 'timeEntryTypeField', kind: 'identifier' }, { key: 'timeEntryFieldTicketNumberField', kind: 'identifier' }] },
  { key: 'crm', fields: [{ key: 'crmProbabilityField', kind: 'identifier' }] },
  { key: 'taxes', fields: [{ key: 'taxCodeFallbacks', kind: 'tax', targets: ['sales', 'purchase'] }] },
];

export function connectorSettings(source: string): { syncCapabilities: SyncCapabilities; mappingGroups: readonly MappingGroup[] } {
  const supported = source === 'netsuite';
  return { syncCapabilities: { attachments: supported, projectFinancials: supported, crm: supported, fixedAssets: supported }, mappingGroups: supported ? NETSUITE_MAPPING_GROUPS : [] };
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

/** Missing selections retain the existing all-supported-content behavior. */
export function resolveSyncSelection(value: unknown, capabilities: SyncCapabilities): SyncSelection {
  const raw = value == null ? {} : objectValue(value, 'Sync content');
  for (const key of Object.keys(raw)) {
    if (!(SYNC_CONTENT_KEYS as readonly string[]).includes(key)) throw new Error(`Unknown sync content ${key}`);
    if (typeof raw[key] !== 'boolean') throw new Error(`Sync content ${key} must be enabled or disabled`);
    if (raw[key] === true && !capabilities[key as SyncContentKey]) throw new Error(`This connector does not support ${key}`);
  }
  return Object.fromEntries(SYNC_CONTENT_KEYS.map((key) => [key, raw[key] ?? capabilities[key]])) as SyncSelection;
}

/** Decode legacy text and current structured mappings without discarding keys. */
export function decodeConnectionMappings(value: unknown): Record<string, unknown> {
  if (value == null || value === '') return {};
  let parsed = value;
  if (typeof value === 'string') {
    try { parsed = JSON.parse(value); } catch { throw new Error('Saved field mappings cannot be read; correct the connection mappings before saving'); }
  }
  return objectValue(parsed, 'Field mappings');
}

/** Validate source identifiers and value maps before a connector builds queries. */
export function validateConnectionMappings(value: unknown, groups: readonly MappingGroup[]): Record<string, unknown> {
  const raw = decodeConnectionMappings(value);
  const fields = new Map(groups.flatMap((group) => group.fields.map((field) => [field.key, field] as const)));
  for (const [key, value] of Object.entries(raw)) {
    const field = fields.get(key);
    if (!field) throw new Error(`Unsupported field mapping ${key}; this connector cannot apply it`);
    if (value == null || value === '') continue;
    if (field.kind === 'identifier') {
      if (typeof value !== 'string' || !/^[a-z][a-z0-9_]{0,119}$/i.test(value.trim())) throw new Error(`Field mapping ${key} must be a source field or record identifier`);
      if (field.requires && !raw[field.requires]) throw new Error(`Field mapping ${key} requires ${field.requires}`);
    } else {
      const entries = Object.entries(objectValue(value, `Field mapping ${key}`));
      if (!entries.length) throw new Error(`Field mapping ${key} needs at least one value`);
      const normalized = new Set<string>();
      for (const [source, target] of entries) {
        const identity = key === 'projectStatuses' ? source.trim().toLowerCase() : source.trim().toUpperCase();
        if (!identity || normalized.has(identity)) throw new Error(`Field mapping ${key} has an empty or duplicate source value`);
        normalized.add(identity);
        if (field.kind === 'tax') {
          if (!field.targets?.includes(source) || typeof target !== 'string' || !/^-?\d+(\.\d+)?$/.test(target.trim())) throw new Error(`Tax fallback ${source} must use sales or purchase and a source tax-code id or rate`);
        } else if (typeof target !== 'string' || !field.targets?.includes(target)) throw new Error(`Field mapping ${key} has an invalid target for ${source}`);
      }
    }
  }
  return raw;
}
