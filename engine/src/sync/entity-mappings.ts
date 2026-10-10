import { sql } from 'drizzle-orm';
import { db } from '../platform/db.ts';
import { findUnownedCustomReferences, validateCustomValues, type CustomFieldDef } from '../records/custom-fields.ts';
import { CUSTOM_FIELD_REFERENCE_TABLES, CUSTOM_FIELD_TARGETS } from '@openbooks/customization';
import { applyEntityFieldMappings, decodeEntityMappings, mappingFieldValue, setMappingFieldValue, validateEntityMappingCatalog, type EntityMappingField, type EntityMappingMetadata } from './entity-mapping-contract.ts';
import type { EntityStream, MigrationSource, NativeChanges, SourceEntity } from './source.ts';

async function customDefinitions(orgId: string, table: string): Promise<CustomFieldDef[]> {
  return (await db.execute<CustomFieldDef>(sql`select id,target_table as "targetTable",target_kind as "targetKind",key,label,field_type as "fieldType",config,is_required as "isRequired",sort_order as "sortOrder"
    from custom_field_defs where org_id=${orgId} and target_table=${table} and is_active order by sort_order,label`)).rows;
}
function customTarget(def: CustomFieldDef): EntityMappingField | null {
  const kinds: Record<string, EntityMappingField['kind']> = { text: 'text', long_text: 'text', number: 'decimal', currency: 'decimal', date: 'date', boolean: 'boolean', select: 'choice', multi_select: 'multi-choice', reference: 'reference' };
  const kind = kinds[def.fieldType];
  if (!kind || (kind === 'reference' && !(CUSTOM_FIELD_REFERENCE_TABLES as readonly string[]).includes(def.config.referenceTable ?? ''))) return null;
  return { key: `custom.${def.targetKind ? def.targetKind + "." : ""}${def.key}`, customKey: def.key, targetKind: def.targetKind ?? undefined, label: def.targetKind ? `${def.label} (${def.targetKind.replaceAll("_", " ")})` : def.label, kind, referenceTable: def.config.referenceTable,
    options: ['choice', 'multi-choice'].includes(kind) ? (def.config.options ?? []).map(value => ({ value, label: value })) : undefined, help: def.config.helpText };
}

/** Catalog reads and reference choices are explicitly organization-scoped, including under bypass callers. */
export async function connectionEntityMappingMetadata(source: MappingSource, orgId: string, entityKey?: string): Promise<EntityMappingMetadata[]> {
  if (!source.entityMappingMetadata) throw new Error('This connector has not declared its entity mapping contract');
  const definitions = new Map<string, CustomFieldDef[]>();
  const output: EntityMappingMetadata[] = [];
  for (const entity of source.entityMappingMetadata.filter(entity => !entityKey || entity.key === entityKey)) {
    if (!definitions.has(entity.table)) definitions.set(entity.table, await customDefinitions(orgId, entity.table));
    const reserved = new Set([source.refKey, 'source', 'connectionId', 'controlAccountId', 'sourceLineRef', 'connectorMappedValues', 'netsuite', 'netsuiteFam', 'sourceConnectionId', 'sourceManaged', 'accounts']);
    const storage = CUSTOM_FIELD_TARGETS.find(target => target.table === entity.table);
    const custom = (storage ? definitions.get(entity.table)! : []).filter(def => def.targetKind === null || storage!.kinds.some(kind => kind.value === def.targetKind)).filter(def => !reserved.has(def.key) && !['__proto__', 'constructor', 'prototype'].includes(def.key)).map(customTarget).filter((field): field is EntityMappingField => field !== null);
    output.push({ ...entity, sourceFields: [...entity.sourceFields], nativeFields: entity.refusal ? [] : [...entity.nativeFields, ...custom] });
  }
  return output;
}

function referenceTable(field: EntityMappingField): string {
  const table = field.referenceTable;
  if (!table || (!(CUSTOM_FIELD_REFERENCE_TABLES as readonly string[]).includes(table) && !(field.sourceReference && table === 'payment_terms'))) throw new Error('This field has no supported native reference picker');
  return table;
}
async function linkedReference(source: MappingSource, orgId: string, field: EntityMappingField, value: unknown): Promise<string> {
  const table = referenceTable(field);
  const rows = (await db.execute<{ ref: string }>(sql`select custom->>${source.refKey} as ref from ${sql.identifier(table)} where org_id=${orgId}
    and (id::text=${String(value)} or custom->>${source.refKey}=${String(value)})
    ${field.allowedAccountTypes ? sql`and type=any(${field.allowedAccountTypes}::text[]) and is_active` : sql``}`)).rows;
  if (rows.length !== 1 || !rows[0]!.ref) throw new Error(`Choose an eligible ${field.label} linked to this source in this organization`);
  return rows[0]!.ref;
}
export async function mappingReferenceChoices(orgId: string, field: EntityMappingField, source?: MappingSource, sourceValues = false, query = '', selected = ''): Promise<{ value: string; label: string }[]> {
  const table = referenceTable(field);
  // The native reference table whitelist supplies identifiers; configuration never supplies SQL identifiers.
  const columns = (await db.execute<{ column_name: string }>(sql`select column_name from information_schema.columns where table_schema='public' and table_name=${table}`)).rows.map(row => row.column_name);
  const label = ['display_name', 'name', 'document_number', 'code', 'number'].find(column => columns.includes(column));
  if (!label || !columns.includes('org_id')) throw new Error('This native reference table has no supported organization-scoped display field');
  if (sourceValues && (!source || !field.sourceReference)) throw new Error('This field has no source record picker');
  const choices = (await db.execute<{ value: string; label: string }>(sql`select ${sourceValues ? sql`custom->>${source!.refKey}` : sql`id::text`} as value,${sql.identifier(label)}::text as label from ${sql.identifier(table)} where org_id=${orgId}
    ${field.sourceReference && source ? sql`and nullif(custom->>${source.refKey},'') is not null` : sql``}
    ${field.allowedAccountTypes ? sql`and type=any(${field.allowedAccountTypes}::text[]) and is_active` : sql``}
    and (${query === ''} or ${sql.identifier(label)}::text ilike ${'%' + query.replace(/[\\%_]/g, '\\$&') + '%'})
    order by ${sql.identifier(label)},id limit 200`)).rows;
  if (selected && !choices.some(option => option.value === selected)) {
    const current = (await db.execute<{ value: string; label: string }>(sql`select ${sourceValues ? sql`custom->>${source!.refKey}` : sql`id::text`} as value,${sql.identifier(label)}::text as label from ${sql.identifier(table)} where org_id=${orgId}
      and ${sourceValues ? sql`custom->>${source!.refKey}` : sql`id::text`}=${selected}
      ${field.sourceReference && source ? sql`and nullif(custom->>${source.refKey},'') is not null` : sql``}
      ${field.allowedAccountTypes ? sql`and type=any(${field.allowedAccountTypes}::text[]) and is_active` : sql``}`)).rows;
    if (current.length > 1) throw new Error('The selected source record identity is ambiguous');
    choices.push(...current);
  }
  return choices;
}

async function validateCustom(orgId: string, entity: EntityMappingMetadata, custom: Record<string, unknown>, targetKind?: string): Promise<void> {
  if (!Object.keys(custom).length) return;
  const all = await customDefinitions(orgId, entity.table);
  const defs = all.filter(def => Object.hasOwn(custom, def.key) && (def.targetKind === null || def.targetKind === targetKind));
  if (Object.keys(custom).some(key => !defs.some(def => def.key === key))) throw new Error(`A custom field on ${entity.label} is no longer active`);
  const validation = validateCustomValues(defs, custom);
  if (!validation.ok) throw new Error(Object.values(validation.errors).join('; '));
  if ((await findUnownedCustomReferences(orgId, defs, custom)).length) throw new Error('Choose a native reference in this organization');
}

export async function validateConnectionEntityMappings(source: MappingSource, orgId: string, value: unknown): Promise<void> {
  const model = decodeEntityMappings(value);
  if (!Object.values(model.entities).some(rows => rows.length)) return;
  const entities = await connectionEntityMappingMetadata(source, orgId);
  for (const entity of entities) {
    const rows = model.entities[entity.key] ?? [];
    if (rows.some(row => row.source && !entity.sourceFields.some(field => field.key === row.source))) entity.sourceFields.push(...(await source.mappingSourceFields?.(entity.key) ?? []));
  }
  validateEntityMappingCatalog(model, entities);
  for (const [key, rows] of Object.entries(model.entities)) {
    const entity = entities.find(entity => entity.key === key)!;
    for (const row of rows) {
      const target = entity.nativeFields.find(field => field.key === row.target)!;
      for (const value of [...(row.values ?? []).map(pair => pair.target), ...(row.defaultValue !== undefined ? [row.defaultValue] : [])]) {
        if (target.customKey) await validateCustom(orgId, entity, { [target.customKey]: value }, target.targetKind);
        else if (target.sourceReference) await linkedReference(source, orgId, target, value);
      }
    }
  }
}

export type MappingSource = Pick<MigrationSource, 'name' | 'refKey' | 'entityMappingMetadata' | 'mappingSourceFields' | 'mappingSourceValues'>;

export function createEntityMappingProjector(source: MappingSource, value: unknown, orgId: string) {
  const model = decodeEntityMappings(value);
  let catalog: Promise<EntityMappingMetadata[]> | undefined;
  const metadata = () => catalog ??= connectionEntityMappingMetadata(source, orgId).then(async entities => {
    for (const entity of entities) {
      const rows = model.entities[entity.key] ?? [];
      if (rows.some(row => row.source && !entity.sourceFields.some(field => field.key === row.source))) {
        if (!source.mappingSourceFields) throw new Error(`This connector cannot expose additional source fields for ${entity.label}`);
        entity.sourceFields.push(...await source.mappingSourceFields(entity.key));
      }
    }
    validateEntityMappingCatalog(model, entities);
    return entities;
  });
  const project = async (key: string, records: { ref: string; fields: Record<string, unknown> }[]) => {
    const rows = model.entities[key] ?? [];
    if (!rows.length) return records.map(record => ({ fields: record.fields, custom: {}, appliedFields: [] as string[] }));
    const entity = (await metadata()).find(entity => entity.key === key)!;
    const extra = [...new Set(rows.flatMap(row => row.source && !source.entityMappingMetadata?.find(entity => entity.key === key)?.sourceFields.some(field => field.key === row.source) ? [row.source] : []))];
    let values = new Map<string, Record<string, unknown>>();
    if (extra.length) {
      if (!source.mappingSourceValues) throw new Error(`This connector cannot read configured source fields for ${entity.label}`);
      values = await source.mappingSourceValues(key, extra, records.map(record => record.ref));
    }
    const output = [];
    for (const record of records) {
      const mapped = applyEntityFieldMappings({ ...record.fields, ...values.get(record.ref) }, rows, entity);
      for (const field of entity.nativeFields.filter(field => field.sourceReference && mapped.appliedFields.includes(field.key))) setMappingFieldValue(mapped.fields, field.key, await linkedReference(source, orgId, field, mappingFieldValue(mapped.fields, field.key)));
      await validateCustom(orgId, entity, mapped.custom, typeof record.fields.kind === "string" ? record.fields.kind : undefined);
      output.push(mapped);
    }
    return output;
  };
  return project;
}

/** Apply configured overrides through the same adapter seam for imports, mirrors and bounded repairs. */
export function withEntityMappings(source: MigrationSource, value: unknown, orgId: string): MigrationSource {
  const model = decodeEntityMappings(value);
  if (!Object.values(model.entities).some(rows => rows.length)) return source;
  const project = createEntityMappingProjector(source, model, orgId);
  const streams = async (input: EntityStream[]) => {
    for (const stream of input) {
      const mapped = await project(stream.resource, stream.records.map(record => ({ ref: record.sourceRef, fields: record.fields })));
      for (let i = 0; i < stream.records.length; i++) {
        const record = stream.records[i]!, result = mapped[i]!;
        record.mappingApplied = Boolean(model.entities[stream.resource]?.length); record.mappedFields = result.appliedFields; record.fields = result.fields; record.mappedCustom = { ...record.mappedCustom, ...result.custom };
      }
      if (stream.resource === 'parties') {
        const siblingValues = new Map<SourceEntity, Map<string, unknown>>();
        const roleSources = new Map(stream.records.map(record => [record, record.fields]));
        for (const key of ['customers', 'vendors', 'employees']) {
          const subset = stream.records.filter(record => record.mappingEntities?.includes(key) || Boolean(record.fields[{ customers: 'customerRole', vendors: 'vendorRole', employees: 'employeeRole' }[key]!]));
          const overrides = await project(key, subset.map(record => ({ ref: record.sourceRef, fields: roleSources.get(record)! })));
          subset.forEach((record, index) => {
            const result = overrides[index]!;
            const applied = siblingValues.get(record) ?? new Map<string, unknown>();
            for (const [field, value] of [...result.appliedFields.map(field => [field, mappingFieldValue(result.fields, field)] as const), ...Object.entries(result.custom).map(([field, value]) => [`custom.${field}`, value] as const)]) {
              if (applied.has(field) && JSON.stringify(applied.get(field)) !== JSON.stringify(value)) throw new Error(`Role mappings conflict on ${field}; use an agreed mapping for this shared person or company`);
              applied.set(field, value);
            }
            siblingValues.set(record, applied);
            record.mappingApplied ||= Boolean(model.entities[key]?.length); record.mappedFields = [...(record.mappedFields ?? []), ...result.appliedFields]; record.fields = { ...record.fields };
            for (const field of result.appliedFields) setMappingFieldValue(record.fields, field, mappingFieldValue(result.fields, field));
            record.mappedCustom = { ...record.mappedCustom, ...result.custom };
          });
        }
      }
    }
    return input;
  };
  const documents = async (changes: NativeChanges) => {
    const mapped = await project('transactions', changes.documents.map(doc => ({ ref: doc.sourceRef, fields: { ...doc } })));
    for (let i = 0; i < changes.documents.length; i++) {
      const doc = changes.documents[i]!, result = mapped[i]!;
      Object.assign(doc, result.fields); doc.mappedCustom = result.custom; doc.mappingApplied = Boolean(model.entities.transactions?.length || model.entities.transactionLines?.length);
      const lines = await project('transactionLines', doc.lines.map(line => ({ ref: `${doc.sourceRef}:${line.sourceLineRef ?? line.lineNumber}`, fields: { ...line, kind: doc.kind } })));
      doc.lines.forEach((line, index) => { Object.assign(line, lines[index]!.fields); line.mappedCustom = lines[index]!.custom; });
    }
    return changes;
  };
  const mappedSource: MigrationSource = new Proxy(source, { get(target, property) {
    const member = Reflect.get(target, property);
    if (typeof member !== 'function') return member;
    if (['entities', 'employeeEntities', 'transactionReferenceEntities'].includes(String(property))) return async (...args: unknown[]) => streams(await member.apply(target, args));
    if (property === 'accountingPeriods') return async (...args: unknown[]) => (await streams([{ resource: 'accounting_periods', records: await member.apply(target, args) }]))[0]!.records;
    if (property === 'nativeChanges' || property === 'nativeChangesByRefs' || property === 'nativeTransactionsByIds') return async (...args: unknown[]) => documents(await member.apply(target, args));
    if (property === 'syncOperationalRecords') return async (options: Record<string, unknown>) => member.call(target, { ...options, mappingSource: mappedSource });
    return member.bind(target);
  } });
  return mappedSource;
}
