import assert from 'node:assert/strict';
import test from 'node:test';
import { connectorSettings, NETSUITE_MAPPING_GROUPS, resolveSyncSelection, validateConnectionMappings } from './connection-settings.ts';
import { parseNetSuiteMappings } from './netsuite-source.ts';

test('sync selections preserve legacy defaults and refuse unsupported or malformed populations', () => {
  const supported = connectorSettings('netsuite').syncCapabilities;
  assert.deepEqual(resolveSyncSelection(undefined, supported), { attachments: true, projectFinancials: true, crm: true, fixedAssets: true });
  assert.deepEqual(resolveSyncSelection({ attachments: false, crm: false }, supported), { attachments: false, projectFinancials: true, crm: false, fixedAssets: true });
  for (const source of ['odoo', 'erpnext', 'qbd', 'qbo', 'xero', 'dynamics']) {
    const { syncCapabilities, mappingGroups } = connectorSettings(source);
    assert.deepEqual(resolveSyncSelection(undefined, syncCapabilities), { attachments: source !== 'qbd', projectFinancials: false, crm: false, fixedAssets: false });
    assert.equal(mappingGroups.length, 0);
    if (source === 'qbd') assert.throws(() => resolveSyncSelection({ attachments: true }, syncCapabilities), /does not support attachments/);
    else assert.equal(resolveSyncSelection({ attachments: true }, syncCapabilities).attachments, true);
    assert.throws(() => resolveSyncSelection({ crm: true }, syncCapabilities), /does not support crm/);
  }
  assert.throws(() => resolveSyncSelection('false', supported), /must be an object/);
  assert.throws(() => resolveSyncSelection({ attachments: 'false' }, supported), /enabled or disabled/);
  assert.throws(() => resolveSyncSelection({ transactions: false }, supported), /Unknown sync content/);
});

test('structured and legacy mappings reach the native parser without losing nested values', () => {
  const saved = { timeTypeRecord: 'customrecord_time', timeTypeMultiplierField: 'custrecord_multiplier', projectStatuses: { 'In Progress': 'active' }, projectBillingTypes: { fbi: 'cost_plus' }, taxCodeFallbacks: { sales: '-8', purchase: '13.5' }, crmProbabilityField: 'custbody_probability' };
  assert.deepEqual(validateConnectionMappings(JSON.stringify(saved), NETSUITE_MAPPING_GROUPS), saved);
  for (const value of [saved, JSON.stringify(saved)]) {
    const native = parseNetSuiteMappings(value);
    assert.equal(native.timeTypeMultiplierField, saved.timeTypeMultiplierField);
    assert.deepEqual(native.projectStatuses, { 'in progress': 'active' });
    assert.deepEqual(native.projectBillingTypes, { FBI: 'cost_plus' });
    assert.deepEqual(native.taxCodeFallbacks, saved.taxCodeFallbacks);
    assert.equal(native.crmProbabilityField, saved.crmProbabilityField);
  }
  assert.deepEqual(parseNetSuiteMappings({ projectForemanField: '' }).projectForemanField, undefined);
});

test('mapping boundaries refuse broken parents, query fragments and ambiguous source values', () => {
  for (const value of [
    { timeTypeMultiplierField: 'custrecord_multiplier' },
    { projectForemanField: 'id FROM employee' },
    { crmProbabilityField: 'probability; DROP TABLE' },
    { projectStatuses: [] },
    { projectStatuses: { active: 'active', ACTIVE: 'closed' } },
    { projectBillingTypes: { FBI: 'invented_type' } },
    { taxCodeFallbacks: { sales: '' } },
    { unknownOverride: 'custbody_ignored' },
  ]) assert.throws(() => parseNetSuiteMappings(value));
  assert.throws(() => validateConnectionMappings('{broken', NETSUITE_MAPPING_GROUPS), /cannot be read/);
  assert.throws(() => validateConnectionMappings({ projectStatuses: { '': 'active' } }, NETSUITE_MAPPING_GROUPS), /empty or duplicate/);
});
