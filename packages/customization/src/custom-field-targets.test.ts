import assert from 'node:assert/strict';
import test from 'node:test';
import { CUSTOM_FIELD_TARGETS, customFieldCreationTargetFor } from './custom-field-targets';

for (const [record, table] of [['customer','parties'],['vendor','parties'],['employee','parties'],['project','projects'],['fixed_asset','fixed_assets'],['property','managed_properties'],['labor_rate_card','item_rate_versions']] as const) {
  test(`native form creation targets ${record} storage`, () => {
    assert.deepEqual(customFieldCreationTargetFor(record, 'header'), { table, kind: null });
    assert.equal(customFieldCreationTargetFor(record, 'line'), null, 'entity forms cannot create fields on a nonexistent custom line table');
  });
}
test('transaction creation separates the header from real line grids', () => {
  for (const record of ['vendor_bill','customer_invoice','deposit','quote','sales_order','purchase_order','field_ticket']) {
    assert.deepEqual(customFieldCreationTargetFor(record, 'header'), { table: 'documents', kind: record });
    assert.deepEqual(customFieldCreationTargetFor(record, 'line'), { table: 'document_lines', kind: record });
  }
  for (const record of ['vendor_payment','customer_payment','transfer']) {
    assert.deepEqual(customFieldCreationTargetFor(record, 'header'), { table: 'documents', kind: record });
    assert.equal(customFieldCreationTargetFor(record, 'line'), null);
  }
});
test('unknown and non-form profiles cannot create orphan form fields', () => {
  for (const record of ['not_a_record','timesheet_week','bank_rule','budget_scenario','equipment_unit','revenue_contract']) {
    assert.equal(customFieldCreationTargetFor(record, 'header'), null);
    assert.equal(customFieldCreationTargetFor(record, 'line'), null);
  }
  assert.ok(CUSTOM_FIELD_TARGETS.some(target => target.table === 'time_entries'), 'time-entry fields remain available through the settings editor');
  const tables = CUSTOM_FIELD_TARGETS.map(target => target.table);
  assert.equal(new Set(tables).size, tables.length);
});
