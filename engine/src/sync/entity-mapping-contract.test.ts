import assert from 'node:assert/strict';
import test from 'node:test';
import { applyEntityFieldMappings, decodeEntityMappings, entityMappingMetadata, validateEntityMappingCatalog } from './entity-mapping-contract.ts';

test('field mappings read the original source and preserve unconfigured values independent of row order', () => {
  const entity = entityMappingMetadata(['items'])[0]!;
  const rules = [{ source: 'name', target: 'category', missing: 'refuse' as const }, { source: 'category', target: 'name', missing: 'refuse' as const }];
  const fields = { name: 'Material', category: 'Copper', code: 'C-1', isActive: false };
  const first = applyEntityFieldMappings(fields, rules, entity);
  assert.deepEqual(first.fields, { ...fields, category: 'Material', name: 'Copper' });
  assert.deepEqual(applyEntityFieldMappings(fields, [...rules].reverse(), entity).fields, first.fields);
  assert.deepEqual(fields, { name: 'Material', category: 'Copper', code: 'C-1', isActive: false });
});

test('defaults, typed value translations and missing-value policies are explicit and fail closed', () => {
  const entity = entityMappingMetadata(['items'])[0]!;
  const rules = [{ source: 'kind', target: 'category', missing: 'default' as const, defaultValue: 'Services', values: [{ source: 'inventory', target: 'Materials' }] }];
  validateEntityMappingCatalog({ version: 1, entities: { items: rules } }, [entity]);
  assert.equal(applyEntityFieldMappings({ kind: 'inventory' }, rules, entity).fields.category, 'Materials');
  assert.equal(applyEntityFieldMappings({ kind: 'other' }, rules, entity).fields.category, 'Services');
  assert.equal(applyEntityFieldMappings({}, rules, entity).fields.category, 'Services');
  assert.equal(applyEntityFieldMappings({ category: 'Existing' }, [{ ...rules[0]!, missing: 'keep' }], entity).fields.category, 'Existing');
  assert.throws(() => applyEntityFieldMappings({}, [{ ...rules[0]!, missing: 'refuse' }], entity), /missing/);
  assert.throws(() => applyEntityFieldMappings({ kind: 'other' }, [{ ...rules[0]!, missing: 'refuse' }], entity), /no value mapping/);
  const flag = [{ source: 'isActive', target: 'isActive', missing: 'refuse' as const, values: [{ source: false, target: true }] }];
  assert.equal(applyEntityFieldMappings({ isActive: false }, flag, entity).fields.isActive, true);
});

test('mapping contracts refuse unknown entities, duplicate targets, values, unavailable fields and silent version changes', () => {
  const metadata = entityMappingMetadata(['items']);
  const row = { source: 'name', target: 'category', missing: 'refuse' };
  for (const value of [
    { version: 2, entities: {} }, { version: 1, entities: { items: [row, row] } },
    { version: 1, entities: { items: [{ ...row, values: [{ source: 'A', target: 'One' }, { source: 'A', target: 'Two' }] }] } },
    { version: 1, entities: { items: [{ target: 'category', missing: 'default' }] } },
  ]) assert.throws(() => decodeEntityMappings(value));
  assert.throws(() => validateEntityMappingCatalog({ version: 1, entities: { projects: [row] } }, metadata), /does not sync/);
  assert.throws(() => validateEntityMappingCatalog({ version: 1, entities: { items: [{ ...row, source: 'custitem_unavailable' }] } }, metadata), /Source field.*unavailable/);
  assert.throws(() => validateEntityMappingCatalog({ version: 1, entities: { items: [{ ...row, target: 'orgId' }] } }, metadata), /Native field.*unavailable/);
  assert.throws(() => validateEntityMappingCatalog({ version: 1, entities: { items: [{ source: 'name', target: 'isActive', missing: 'default', defaultValue: 'perhaps' }] } }, metadata), /Yes or No/);
});

test('custom field scopes refuse overlapping writers and apply only to the actual native record kind', () => {
  const entity = entityMappingMetadata([]).find(entity => entity.key === 'transactions')!;
  entity.nativeFields.push({ key: 'custom.evidence', customKey: 'evidence', kind: 'text', label: 'Evidence' }, { key: 'custom.vendor_bill.evidence', customKey: 'evidence', targetKind: 'vendor_bill', kind: 'text', label: 'Bill evidence' });
  const rules = [{ target: 'custom.vendor_bill.evidence', missing: 'default' as const, defaultValue: 'Bill' }];
  validateEntityMappingCatalog({ version: 1, entities: { transactions: rules } }, [entity]);
  assert.deepEqual(applyEntityFieldMappings({ kind: 'vendor_bill' }, rules, entity).custom, { evidence: 'Bill' });
  assert.deepEqual(applyEntityFieldMappings({ kind: 'customer_invoice' }, rules, entity).custom, {});
  assert.throws(() => validateEntityMappingCatalog({ version: 1, entities: { transactions: [...rules, { ...rules[0]!, target: 'custom.evidence' }] } }, [entity]), /overlapping/);
});

test('connector metadata exposes only declared source fields while retaining native default targets', () => {
  const entity = entityMappingMetadata(['items'], [], { items: ['name', 'kind', 'code', 'isActive'] })[0]!;
  assert.equal(entity.sourceFields.some(field => field.key === 'defaultCost'), false);
  assert.equal(entity.nativeFields.some(field => field.key === 'defaultCost'), true);
  assert.deepEqual(decodeEntityMappings(undefined), { version: 1, entities: {} });
});

test('native multi-select targets use option arrays and exact decimals reject unsupported precision', () => {
  const entity = entityMappingMetadata(['items'])[0]!;
  entity.nativeFields.push({ key: 'custom.tags', customKey: 'tags', label: 'Tags', kind: 'multi-choice', options: [{ value: 'A', label: 'A' }, { value: 'B', label: 'B' }] });
  const rules = [{ target: 'custom.tags', missing: 'default' as const, defaultValue: ['B', 'A'] }];
  validateEntityMappingCatalog({ version: 1, entities: { items: rules } }, [entity]);
  assert.deepEqual(applyEntityFieldMappings({}, rules, entity).custom, { tags: ['A', 'B'] });
  assert.throws(() => applyEntityFieldMappings({}, [{ ...rules[0]!, defaultValue: ['Unknown'] }], entity), /supported values/);
  assert.throws(() => validateEntityMappingCatalog({ version: 1, entities: { items: [{ target: 'defaultCost', missing: 'default', defaultValue: '1.12345' }] } }, [entity]), /exact decimal/);
  const terms = entityMappingMetadata(['payment_terms'])[0]!;
  assert.throws(() => validateEntityMappingCatalog({ version: 1, entities: { payment_terms: [{ target: 'netDays', missing: 'default', defaultValue: '30.5' }] } }, [terms]), /exact decimal/);
});


test('integer source fields use exact picker identities and refuse fractional numeric financial values', () => {
  const terms = entityMappingMetadata(['payment_terms'])[0]!;
  const rules = [{ source: 'netDays', target: 'netDays', missing: 'refuse' as const, values: [{ source: '30', target: '45' }] }];
  assert.equal(applyEntityFieldMappings({ netDays: 30 }, rules, terms).fields.netDays, '45');
  const item = entityMappingMetadata(['items'])[0]!;
  assert.throws(() => applyEntityFieldMappings({ defaultRate: 12.34 }, [{ source: 'defaultRate', target: 'defaultRate', missing: 'refuse' }], item), /requires a text value/);
});
