import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalConnectionMappingConfig, connectionSourceOptions, migrateConnectionEntityMappings, validateStructuredConnectionMappings, connectorSettings, NETSUITE_MAPPING_GROUPS, resolveSyncSelection, validateConnectionMappings } from './connection-settings.ts';
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


test('legacy options migrate losslessly into the entity model and native commands use the sole structured authority', () => {
  const legacy = {
    projectForemanField: 'custentity_foreman', projectPurchaseOrderField: 'custentity_po',
    projectStatuses: { Completed: 'closed' }, projectBillingTypes: { FBI: 'cost_plus' },
    lineMarkupField: 'custcol_markup', lineBillableField: 'custcol_billable', itemCategoryField: 'custitem_category',
    customerShortCodeField: 'custentity_shortcode', employeeBenefitsField: 'custentity_benefits',
    timeTypeRecord: 'customrecord_time', timeTypeMultiplierField: 'custrecord_multiplier',
    timeEntryTypeField: 'custcol_time_type', timeEntryFieldTicketNumberField: 'custcol_ticket',
    crmProbabilityField: 'custbody_probability', taxCodeFallbacks: { sales: '-8', purchase: '13.5' },
  };
  assert.deepEqual(Object.keys(legacy).sort(), NETSUITE_MAPPING_GROUPS.flatMap(group => group.fields.map(field => field.key)).sort());
  const entities = { items: [{ target: 'category', missing: 'default' as const, defaultValue: 'Materials' }] };
  const model = migrateConnectionEntityMappings({ version: 1, entities }, JSON.stringify(legacy), NETSUITE_MAPPING_GROUPS);
  assert.deepEqual(model, { version: 1, entities, sourceOptions: legacy });
  assert.deepEqual(migrateConnectionEntityMappings(model, undefined, NETSUITE_MAPPING_GROUPS), model);
  const config = canonicalConnectionMappingConfig({ mappingJson: JSON.stringify(legacy), entityMappings: { version: 1, entities }, baseCurrency: 'CAD' }, NETSUITE_MAPPING_GROUPS);
  assert.equal(config.mappingJson, undefined);
  assert.deepEqual(config.entityMappings, model);
  assert.deepEqual(connectionSourceOptions(config, NETSUITE_MAPPING_GROUPS), legacy);
  assert.deepEqual(parseNetSuiteMappings(connectionSourceOptions(config, NETSUITE_MAPPING_GROUPS)), parseNetSuiteMappings(legacy));
});

test('unavailable, malformed and conflicting legacy values remain visible and refuse until explicitly removed', () => {
  const unknown = { nested: ['Original', false, null], amount: '100.0100' };
  const model = migrateConnectionEntityMappings(undefined, { projectForemanField: 'custentity_foreman', obsolete: unknown, timeTypeMultiplierField: 'custrecord_multiplier' }, NETSUITE_MAPPING_GROUPS);
  assert.deepEqual(model.sourceOptions, { projectForemanField: 'custentity_foreman' });
  assert.deepEqual(model.unavailableRules?.map(rule => [rule.key, rule.value]), [['obsolete', unknown], ['timeTypeMultiplierField', 'custrecord_multiplier']]);
  assert.throws(() => validateStructuredConnectionMappings(model, NETSUITE_MAPPING_GROUPS), /Remove or resolve/);
  assert.throws(() => canonicalConnectionMappingConfig({ entityMappings: model }, NETSUITE_MAPPING_GROUPS), /Remove or resolve/);
  assert.deepEqual(validateStructuredConnectionMappings({ ...model, unavailableRules: [] }, NETSUITE_MAPPING_GROUPS).sourceOptions, model.sourceOptions);
  for (const legacy of ['{unreadable', [1, 2], true]) {
    const unreadable = migrateConnectionEntityMappings(undefined, legacy, NETSUITE_MAPPING_GROUPS);
    assert.deepEqual(unreadable.unavailableRules?.[0]?.value, legacy);
    assert.throws(() => connectionSourceOptions({ entityMappings: unreadable }, NETSUITE_MAPPING_GROUPS), /Remove or resolve/);
  }
  const conflict = migrateConnectionEntityMappings({ version: 1, entities: {}, sourceOptions: { projectForemanField: 'custentity_new' } }, { projectForemanField: 'custentity_old' }, NETSUITE_MAPPING_GROUPS);
  assert.equal(conflict.sourceOptions?.projectForemanField, 'custentity_new');
  assert.equal(conflict.unavailableRules?.[0]?.value, 'custentity_old');
  assert.throws(() => validateStructuredConnectionMappings(conflict, NETSUITE_MAPPING_GROUPS), /Remove or resolve/);
});
