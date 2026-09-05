import assert from 'node:assert/strict';
import test from 'node:test';
import { customFieldEditorConfig, type CustomFieldEditorState } from './custom-field-editor-config';

const base: CustomFieldEditorState = { fieldType: 'text', options: [], helpText: '', placeholder: '', defaultValue: '', minValue: '', maxValue: '', showInList: false, displayMode: 'always', allowedRoles: [], referenceTable: '' };
test('editing a numeric field preserves exact bounds beyond binary precision', () => {
  for (const fieldType of ['number','currency']) {
    const result = customFieldEditorConfig({}, { ...base, fieldType, minValue: '900000000000000.1234', maxValue: '900000000000000.1235' });
    assert.deepEqual(result, { min: '900000000000000.1234', max: '900000000000000.1235' });
  }
});
test('editing a reference field retains its target, filter and unrelated metadata', () => {
  const original = { referenceTable: 'parties', referenceFilter: { kind: 'person' }, extension: { revision: 3 }, placeholder: 'Owner' };
  const result = customFieldEditorConfig(original, { ...base, fieldType: 'reference', referenceTable: 'parties', placeholder: 'Owner' });
  assert.deepEqual(result, original);
  assert.notEqual(result, original, 'the stored definition is never mutated by form construction');
});
test('false, zero and multiple-selection defaults survive unrelated edits', () => {
  for (const [fieldType, defaultValue] of [['boolean',false],['number',0],['multi_select',['One','Two']]] as const) {
    const result = customFieldEditorConfig({}, { ...base, fieldType, defaultValue, options: ['One','Two'] });
    assert.deepEqual(result.defaultValue, defaultValue);
  }
});
test('cleared and type-specific settings are removed without deleting extension metadata', () => {
  const result = customFieldEditorConfig({ min: '1', max: '2', options: ['One'], defaultValue: 'One', showInList: true, displayMode: 'hidden', allowedRoles: ['admin'], referenceTable: 'parties', referenceFilter: { kind: 'person' }, extension: { keep: true } }, base);
  assert.deepEqual(result, { extension: { keep: true } });
});
