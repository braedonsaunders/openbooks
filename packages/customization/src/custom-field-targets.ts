import { RECORD_TYPES, RECORD_TYPE_BY_KEY, customFieldTargetFor } from './registry';

export const CUSTOM_FIELD_REFERENCE_TABLES = ['parties', 'projects', 'accounts', 'items'] as const;

export type CustomFieldTarget = {
  table: string;
  labelKey: string;
  descriptionKey?: string;
  kinds: { value: string; labelKey: string }[];
};

/** Native tables whose custom JSON values are stored and consumed today.
 * A registry list profile alone does not establish writable custom storage
 * (for example, budget scenarios have no custom column). Keep the API and
 * settings switchboard on this single storage-capability catalog. */
const STORAGE_TARGETS = [
  ['documents', 'documents'],
  ['document_lines', 'documentLines'],
  ['parties', 'parties'],
  ['projects', 'projects'],
  ['managed_properties', 'managedProperties'],
  ['accounts', 'accounts'],
  ['items', 'items'],
  ['crm_account_profiles', 'crmAccounts'],
  ['crm_activities', 'crmActivities'],
  ['crm_opportunities', 'crmOpportunities'],
] as const;

export const CUSTOM_FIELD_TARGETS: CustomFieldTarget[] = [
  ...STORAGE_TARGETS.map(([table, message]) => ({
    table,
    labelKey: `admin.customFields.targets.${message}.label`,
    descriptionKey: `admin.customFields.targets.${message}.description`,
    kinds: RECORD_TYPES.filter(record => {
      if (record.supportsForms === false) return false;
      const target = customFieldTargetFor(record.key);
      return table === 'documents' ? target.table === table
        : table === 'document_lines' && target.lineTable === table && record.lineFields.length > 0;
    }).map(record => ({ value: record.key, labelKey: record.labelKey })),
  })),
  ...([['item_rate_versions', 'labor_rate_card'], ['fixed_assets', 'fixed_asset'], ['time_entries', 'timesheet_week']] as const)
    .map(([table, record]) => ({ table, labelKey: RECORD_TYPE_BY_KEY[record]!.labelKey, kinds: [] })),
];

/** Creation must use the same table/kind as the form's definition reader. */
export function customFieldCreationTargetFor(recordType: string, level: 'header' | 'line'): { table: string; kind: string | null } | null {
  const record = RECORD_TYPES.find(candidate => candidate.key === recordType);
  if (!record || record.supportsForms === false) return null;
  const target = customFieldTargetFor(recordType);
  const table = level === 'header' ? target.table : target.lineTable;
  const kind = (level === 'header' ? target.kind : target.lineKind) ?? null;
  if (!table || (level === 'line' && record.lineFields.length === 0)) return null;
  const storage = CUSTOM_FIELD_TARGETS.find(candidate => candidate.table === table);
  if (!storage || (kind && !storage.kinds.some(candidate => candidate.value === kind))) return null;
  return { table, kind };
}
