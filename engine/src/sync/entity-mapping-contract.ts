import { canonicalDecimal } from '../money/exact-decimal.ts';

/** The connector's normalized field contract is shared by sync and its editor. */
export type MappingScalar = string | boolean | string[];
export type EntityFieldKind = 'text' | 'boolean' | 'decimal' | 'date' | 'choice' | 'multi-choice' | 'reference';
export interface EntityMappingField {
  key: string;
  label: string;
  kind: EntityFieldKind;
  options?: { value: string; label: string }[];
  referenceTable?: string;
  /** Master-data references are translated through this connector's verified native identity. */
  sourceReference?: boolean;
  allowedAccountTypes?: string[];
  /** Custom targets are backed by an active native custom-field definition. */
  customKey?: string;
  targetKind?: string;
  help?: string;
  maxScale?: number;
}
export interface EntityMappingMetadata {
  key: string;
  resource: string;
  table: string;
  label: string;
  parent?: string;
  sourceFields: EntityMappingField[];
  nativeFields: EntityMappingField[];
  refusal?: string;
  operational?: boolean;
}
export interface EntityFieldMapping {
  source?: string;
  target: string;
  values?: { source: MappingScalar; target: MappingScalar }[];
  defaultValue?: MappingScalar;
  missing: 'refuse' | 'keep' | 'default';
}
export interface ConnectionEntityMappings {
  version: 1;
  entities: Record<string, EntityFieldMapping[]>;
  sourceOptions?: Record<string, unknown>;
  unavailableRules?: { key: string; value: unknown; reason: string }[];
}

const text = (key: string, label: string): EntityMappingField => ({ key, label, kind: 'text' });
const flag = (key: string, label: string): EntityMappingField => ({ key, label, kind: 'boolean', options: [{ value: 'true', label: 'Yes' }, { value: 'false', label: 'No' }] });
const date = (key: string, label: string): EntityMappingField => ({ key, label, kind: 'date' });
const decimal = (key: string, label: string, maxScale = 4): EntityMappingField => ({ key, label, kind: 'decimal', maxScale });
const reference = (key: string, label: string, referenceTable: string, allowedAccountTypes?: string[]): EntityMappingField => ({ key, label, referenceTable, allowedAccountTypes, kind: 'reference', sourceReference: true });
const choice = (key: string, label: string, values: string[]): EntityMappingField => ({ key, label, kind: 'choice', options: values.map((value) => ({ value, label: value.replaceAll('_', ' ') })) });
const active = flag('isActive', 'Active');
const partyFields = [text('displayName', 'Display name'), text('email', 'Email'), text('phone', 'Phone'), text('website', 'Website'), text('legalName', 'Legal name'), active];
/** Only fields actually consumed by the native loader are offered as targets. */
const CONTRACTS: Record<string, { table?: string; label: string; fields: EntityMappingField[]; parent?: string; sources?: EntityMappingField[]; refusal?: string; operational?: boolean }> = {
  accounts: { label: 'Accounts', fields: [text('number', 'Account number'), text('name', 'Name'), active] },
  subsidiaries: { label: 'Legal entities', fields: [text('name', 'Name'), text('legalName', 'Legal name'), active] },
  departments: { label: 'Departments', fields: [text('name', 'Name')] },
  payment_terms: { label: 'Payment terms', fields: [text('name', 'Name'), decimal('netDays', 'Net days', 0), decimal('discountDays', 'Discount days', 0), decimal('discountPercent', 'Discount percent')] },
  time_types: { label: 'Time types', fields: [text('name', 'Name'), decimal('costMultiplier', 'Cost multiplier'), active] },
  tax_codes: { label: 'Tax codes', fields: [text('code', 'Code'), text('name', 'Name'), choice('appliesTo', 'Applies to', ['sales', 'purchase', 'both'])] },
  items: { label: 'Items', fields: [text('code', 'Code'), text('name', 'Name'), text('category', 'Category'), text('unit', 'Unit'), decimal('defaultCost', 'Default cost'), decimal('defaultRate', 'Default rate'), active] },
  parties: { label: 'People and companies', fields: partyFields },
  customers: { table: 'parties', label: 'Customers', fields: [...partyFields, reference('customerRole.arAccountRef', 'Receivables account', 'accounts', ['asset_receivable']), reference('customerRole.termsRef', 'Payment terms', 'payment_terms')], parent: 'parties' },
  vendors: { table: 'parties', label: 'Vendors', fields: [...partyFields, reference('vendorRole.apAccountRef', 'Payables account', 'accounts', ['liability_payable']), reference('vendorRole.defaultExpenseAccountRef', 'Default expense account', 'accounts', ['expense', 'expense_other', 'cogs']), reference('vendorRole.termsRef', 'Payment terms', 'payment_terms')], parent: 'parties' },
  employees: { table: 'parties', label: 'Employees', fields: [...partyFields, text('employeeRole.employeeNumber', 'Employee number'), date('employeeRole.hiredOn', 'Hire date'), date('employeeRole.terminatedOn', 'Termination date'), flag('employeeRole.hasBenefits', 'Benefits eligible')], parent: 'parties' },
  projects: { label: 'Projects', fields: [text('code', 'Code'), text('name', 'Name'), text('customerPoNumber', 'Customer purchase order'), date('startsOn', 'Start date'), date('endsOn', 'End date'), choice('status', 'Status', ['quoted', 'awarded', 'active', 'substantially_complete', 'closed', 'cancelled']), active] },
  addresses: { label: 'Addresses', fields: ['label', 'line1', 'line2', 'city', 'region', 'postalCode', 'country'].map(key => text(key, key.replace(/([A-Z])/g, ' $1'))) },
  contacts: { label: 'Contacts', fields: ['name', 'firstName', 'lastName', 'title', 'role', 'email', 'phone', 'mobilePhone', 'fax'].map(key => text(key, key.replace(/([A-Z])/g, ' $1'))).concat(active) },
  time_entries: { label: 'Time entries', fields: [], sources: [date('workedOn', 'Work date'), decimal('hours', 'Hours'), decimal('costRate', 'Cost rate'), decimal('billRate', 'Bill rate'), flag('isBillable', 'Billable')] },
  transactions: { table: 'documents', label: 'Transactions', fields: [text('memo', 'Memo'), text('referenceNumber', 'Reference number'), date('dueDate', 'Due date')] },
  transactionLines: { table: 'document_lines', label: 'Transaction lines', parent: 'transactions', fields: [text('description', 'Description'), text('unit', 'Unit'), flag('isBillable', 'Billable'), decimal('markupPercent', 'Markup percent')] },
  accounting_periods: { label: 'Accounting periods', fields: [], },
  crmAccountStatuses: { table: 'crm_account_statuses', label: 'CRM account statuses', fields: [text('name', 'Name')], operational: true },
  crmAccounts: { table: 'crm_account_profiles', label: 'CRM accounts', fields: [], sources: [choice('lifecycleStage', 'Lifecycle stage', ['lead', 'prospect', 'customer']), decimal('qualificationScore', 'Qualification score')], operational: true },
  crmActivities: { table: 'crm_activities', label: 'CRM activities', fields: [text('subject', 'Subject'), text('body', 'Body')], operational: true },
  crmOpportunities: { table: 'crm_opportunities', label: 'CRM opportunities', fields: [text('title', 'Title'), text('description', 'Description')], operational: true },
  fixedAssets: { table: 'fixed_assets', label: 'Fixed assets', fields: [text('name', 'Name'), text('description', 'Description'), text('serialNumber', 'Serial number')], operational: true },
  assetCategories: { table: 'asset_categories', label: 'Asset categories', fields: [text('name', 'Name')], parent: 'fixedAssets', operational: true },
  assetHistory: { table: 'asset_events', label: 'Asset history', fields: [], parent: 'fixedAssets', refusal: 'Asset history retains its source event identity and immutable financial values.' },
  files: { label: 'Files', fields: [], parent: 'transactions', refusal: 'Files retain their source identity and original content. Choose document and file synchronization in Sync content.' },
};

export function entityMappingMetadata(resources: readonly string[], roles: readonly string[] = [], sourceFields?: Readonly<Record<string, readonly string[]>>): EntityMappingMetadata[] {
  return [...new Set([...resources, ...roles, 'transactions', 'transactionLines'])].map((key) => {
    const contract = CONTRACTS[key];
    if (!contract) throw new Error(`Connector entity ${key} has no native mapping contract`);
    const extras: Record<string, EntityMappingField[]> = { accounts: [text('type', 'Account type')], items: [text('kind', 'Item kind')], parties: [text('kind', 'Person or company')], projects: [decimal('contractValue', 'Contract value'), choice('billingMethod', 'Billing method', ['time_and_materials', 'fixed_price', 'cost_plus', 'not_to_exceed'])], tax_codes: [decimal('ratePercent', 'Tax rate')] };
    const fields = [...contract.fields, ...(contract.sources ?? []), ...(extras[contract.table ?? key] ?? extras[key] ?? [])];
    const keys = sourceFields?.[key] ?? sourceFields?.[roles.includes(key) ? 'parties' : key];
    return { key, resource: roles.includes(key) ? 'parties' : key, table: contract.table ?? key, label: contract.label, parent: contract.parent,
      sourceFields: fields.filter(field => !keys || keys.includes(field.key)).map(field => ({ ...field })), nativeFields: contract.fields.map(field => ({ ...field })),
      operational: contract.operational,
      refusal: contract.refusal ?? (key === 'accounting_periods' ? 'Fiscal periods and locks retain the source accounting calendar and cannot be remapped.' : undefined) };
  });
}

export function netSuiteEntityMappingMetadata(): EntityMappingMetadata[] {
  return entityMappingMetadata(['accounting_periods', 'subsidiaries', 'accounts', 'tax_codes', 'departments', 'payment_terms', 'time_types', 'items', 'parties', 'projects', 'addresses', 'contacts', 'time_entries', 'crmAccountStatuses', 'crmAccounts', 'crmActivities', 'crmOpportunities', 'fixedAssets', 'assetCategories', 'assetHistory', 'files'], ['customers', 'vendors', 'employees'], {
    customers: ['displayName', 'email', 'phone', 'website', 'isActive', 'kind', 'customerRole.arAccountRef', 'customerRole.termsRef'],
    vendors: ['displayName', 'email', 'phone', 'legalName', 'isActive', 'kind', 'vendorRole.apAccountRef', 'vendorRole.defaultExpenseAccountRef', 'vendorRole.termsRef'],
    employees: ['displayName', 'email', 'phone', 'isActive', 'kind', 'employeeRole.employeeNumber', 'employeeRole.hiredOn', 'employeeRole.terminatedOn', 'employeeRole.hasBenefits'],
  });
}

const object = (value: unknown, label: string): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
};
const scalar = (value: unknown): value is MappingScalar => typeof value === 'string' || typeof value === 'boolean' || (Array.isArray(value) && value.length <= 500 && value.every(entry => typeof entry === 'string' && entry.length > 0) && new Set(value).size === value.length);
const identity = (value: unknown) => Array.isArray(value) ? `array:${JSON.stringify([...value].sort())}` : `${typeof value}:${String(value)}`;

/** Strict structural validation precedes catalog, subject and value validation. */
export function decodeEntityMappings(value: unknown): ConnectionEntityMappings {
  if (value == null) return { version: 1, entities: {} };
  const raw = object(value, 'Entity mappings');
  if (raw.version !== 1 || Object.keys(raw).some(key => !['version', 'entities', 'sourceOptions', 'unavailableRules'].includes(key))) throw new Error('Unsupported entity mapping version');
  if (raw.sourceOptions !== undefined) object(raw.sourceOptions, 'Source options');
  if (raw.unavailableRules !== undefined) {
    if (!Array.isArray(raw.unavailableRules) || raw.unavailableRules.length > 500) throw new Error('Invalid unavailable mapping rules');
    for (const entry of raw.unavailableRules) {
      const rule = object(entry, 'Unavailable mapping rule');
      if (Object.keys(rule).some(key => !['key', 'value', 'reason'].includes(key)) || typeof rule.key !== 'string' || !rule.key || typeof rule.reason !== 'string' || !rule.reason || !Object.hasOwn(rule, 'value')) throw new Error('Invalid unavailable mapping rule');
    }
  }
  const entities = object(raw.entities, 'Mapped entities');
  if (Object.keys(entities).length > 100) throw new Error('Too many mapped entities');
  for (const [entity, rows] of Object.entries(entities)) {
    if (!/^[a-zA-Z][a-zA-Z0-9_]{0,119}$/.test(entity) || !Array.isArray(rows) || rows.length > 200) throw new Error('Invalid entity mapping rows');
    const targets = new Set<string>();
    for (const row of rows) {
      const mapping = object(row, 'Field mapping');
      if (Object.keys(mapping).some(key => !['source', 'target', 'values', 'defaultValue', 'missing'].includes(key))
        || typeof mapping.target !== 'string' || !mapping.target || targets.has(mapping.target)
        || (mapping.source != null && (typeof mapping.source !== 'string' || !mapping.source))
        || !['refuse', 'keep', 'default'].includes(String(mapping.missing))) throw new Error(`Invalid or duplicate field mapping in ${entity}`);
      targets.add(mapping.target);
      if (mapping.defaultValue !== undefined && !scalar(mapping.defaultValue)) throw new Error('A mapping default must be a single value');
      if ((mapping.missing === 'default' || mapping.source == null) && mapping.defaultValue === undefined) throw new Error('Choose a source field or supply a default value');
      if (mapping.values != null) {
        if (!Array.isArray(mapping.values) || mapping.values.length > 1000) throw new Error('Invalid value mappings');
        const seen = new Set<string>();
        for (const entry of mapping.values) {
          const pair = object(entry, 'Value mapping');
          if (Object.keys(pair).some(key => !['source', 'target'].includes(key)) || !scalar(pair.source) || pair.source === '' || !scalar(pair.target) || seen.has(identity(pair.source))) throw new Error('Value mappings need unique, nonempty source values');
          seen.add(identity(pair.source));
        }
      }
    }
  }
  return raw as unknown as ConnectionEntityMappings;
}

export function validateEntityMappingCatalog(value: unknown, metadata: readonly EntityMappingMetadata[]): ConnectionEntityMappings {
  const model = decodeEntityMappings(value);
  for (const [key, rows] of Object.entries(model.entities)) {
    const entity = metadata.find(entity => entity.key === key);
    if (!entity || (rows.length && entity.refusal)) throw new Error(entity?.refusal ?? `This connector does not sync ${key}`);
    const customScopes = new Map<string, Set<string>>();
    for (const row of rows) {
      const target = entity.nativeFields.find(field => field.key === row.target);
      if (!target) throw new Error(`Native field ${key}.${row.target} is unavailable; restore its active definition or remove this mapping`);
      if (target.customKey) {
        const scopes = customScopes.get(target.customKey) ?? new Set<string>();
        const scope = target.targetKind ?? '';
        if (scopes.size && (!scope || scopes.has('') || scopes.has(scope))) throw new Error(`Custom field ${target.label} has overlapping mapping scopes`);
        scopes.add(scope); customScopes.set(target.customKey, scopes);
      }
      if (row.source && !entity.sourceFields.some(field => field.key === row.source)) throw new Error(`Source field ${key}.${row.source} is unavailable; check source access or remove this mapping`);
      for (const entry of row.values ?? []) validateMappingScalar(target, entry.target);
      if (row.defaultValue !== undefined) validateMappingScalar(target, row.defaultValue);
    }
  }
  return model;
}

export function validateMappingScalar(field: EntityMappingField, value: unknown): MappingScalar {
  if (field.kind === 'multi-choice') {
    if (!Array.isArray(value) || !scalar(value) || value.some(entry => !field.options?.some(option => option.value === entry))) throw new Error(`Choose supported values for ${field.label}`);
    return [...value].sort() as string[];
  }
  if (field.kind === 'boolean') {
    if (value === true || value === 'true') return true;
    if (value === false || value === 'false') return false;
    throw new Error(`${field.label} requires Yes or No`);
  }
  if (typeof value !== 'string') throw new Error(`${field.label} requires a text value`);
  if (!value.length) throw new Error(`Supply a value for ${field.label}`);
  if (field.kind === 'choice' && !field.options?.some(option => option.value === value)) throw new Error(`Choose a supported value for ${field.label}`);
  if (field.kind === 'reference' && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) throw new Error(`Choose a native record for ${field.label}`);
  if (field.kind === 'decimal' && canonicalDecimal(value, field.maxScale ?? 8) === null) throw new Error(`${field.label} requires an exact decimal`);
  if (field.kind === 'date' && (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value)) throw new Error(`${field.label} requires a valid date`);
  return value;
}

/** Read every source from the original record, so mapping order never changes the result. */
export function applyEntityFieldMappings(fields: Record<string, unknown>, rows: readonly EntityFieldMapping[], metadata: EntityMappingMetadata): { fields: Record<string, unknown>; custom: Record<string, unknown>; appliedFields: string[] } {
  const output = { ...fields }, custom: Record<string, unknown> = {}, appliedFields: string[] = [];
  for (const row of rows) {
    const target = metadata.nativeFields.find(field => field.key === row.target);
    if (!target) throw new Error(`Native mapping target ${row.target} is unavailable`);
    if (target.targetKind && fields.kind !== target.targetKind) continue;
    let value = row.source ? mappingFieldValue(fields, row.source) : row.defaultValue;
    // Integer-valued source enums and day counts retain exact identities in text controls.
    if (row.source && typeof value === 'number' && Number.isSafeInteger(value)) value = String(value);
    let directReference = Boolean(row.source && metadata.sourceFields.find(field => field.key === row.source)?.sourceReference && target.sourceReference);
    if (value == null || value === '') {
      if (row.missing === 'keep') continue;
      if (row.missing === 'default') value = row.defaultValue;
      else throw new Error(`Source field ${row.source} is missing for ${metadata.label}; supply an explicit default or keep the standard mapping`);
      directReference = false;
    }
    if (row.values?.length) {
      const match = row.values.find(pair => identity(pair.source) === identity(value));
      if (match) value = match.target;
      else if (row.missing === 'default') value = row.defaultValue;
      else if (row.missing === 'keep') continue;
      else throw new Error(`Source value ${String(value)} has no value mapping for ${target.label}`);
      directReference = false;
    }
    const validated = directReference && typeof value === 'string' ? value : validateMappingScalar(target, value);
    if (target.customKey) custom[target.customKey] = validated;
    else { setMappingFieldValue(output, target.key, validated); appliedFields.push(target.key); }
  }
  return { fields: output, custom, appliedFields };
}

export function mappingFieldValue(fields: Record<string, unknown>, path: string): unknown {
  let current: unknown = fields;
  for (const key of path.split('.')) {
    if (!current || typeof current !== 'object' || !Object.hasOwn(current, key)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}
export function setMappingFieldValue(fields: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split('.');
  if (keys.some(key => ['__proto__', 'constructor', 'prototype'].includes(key))) throw new Error('Unsupported mapping field path');
  let current = fields;
  for (const key of keys.slice(0, -1)) {
    current[key] = { ...(current[key] && typeof current[key] === 'object' ? current[key] as Record<string, unknown> : {}) };
    current = current[key] as Record<string, unknown>;
  }
  current[keys.at(-1)!] = value;
}
