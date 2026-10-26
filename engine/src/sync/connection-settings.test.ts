import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalConnectionMappingConfig,
  connectionSourceOptions,
  validateStructuredConnectionMappings,
  connectorSettings,
  NETSUITE_MAPPING_GROUPS,
  resolveSyncSelection,
  validateConnectionMappings,
} from "./connection-settings.ts";
import { parseNetSuiteMappings } from "./netsuite-source.ts";

test("sync selections preserve supported defaults and refuse unsupported or malformed populations", () => {
  const supported = connectorSettings("netsuite").syncCapabilities;
  assert.deepEqual(resolveSyncSelection(undefined, supported), {
    attachments: true,
    projectFinancials: true,
    crm: true,
    fixedAssets: true,
  });
  assert.deepEqual(resolveSyncSelection({ attachments: false, crm: false }, supported), {
    attachments: false,
    projectFinancials: true,
    crm: false,
    fixedAssets: true,
  });
  for (const source of ["odoo", "erpnext", "qbd", "qbo", "xero", "dynamics"]) {
    const { syncCapabilities, mappingGroups } = connectorSettings(source);
    assert.deepEqual(resolveSyncSelection(undefined, syncCapabilities), {
      attachments: source !== "qbd",
      projectFinancials: false,
      crm: false,
      fixedAssets: false,
    });
    assert.equal(mappingGroups.length, 0);
    if (source === "qbd")
      assert.throws(
        () => resolveSyncSelection({ attachments: true }, syncCapabilities),
        /does not support attachments/,
      );
    else
      assert.equal(resolveSyncSelection({ attachments: true }, syncCapabilities).attachments, true);
    assert.throws(
      () => resolveSyncSelection({ crm: true }, syncCapabilities),
      /does not support crm/,
    );
  }
  assert.throws(() => resolveSyncSelection("false", supported), /must be an object/);
  assert.throws(
    () => resolveSyncSelection({ attachments: "false" }, supported),
    /enabled or disabled/,
  );
  assert.throws(
    () => resolveSyncSelection({ transactions: false }, supported),
    /Unknown sync content/,
  );
});

test("structured mappings reach the native parser without losing nested values", () => {
  const saved = {
    timeTypeRecord: "customrecord_time",
    timeTypeMultiplierField: "custrecord_multiplier",
    projectStatuses: { "In Progress": "active" },
    projectBillingTypes: { fbi: "cost_plus" },
    taxCodeFallbacks: { sales: "-8", purchase: "13.5" },
    crmProbabilityField: "custbody_probability",
  };
  assert.deepEqual(validateConnectionMappings(saved, NETSUITE_MAPPING_GROUPS), saved);
  assert.throws(
    () => validateConnectionMappings(JSON.stringify(saved), NETSUITE_MAPPING_GROUPS),
    /must be an object/,
  );
  assert.throws(() => parseNetSuiteMappings(JSON.stringify(saved)), /must be a JSON object/);
  for (const value of [saved]) {
    const native = parseNetSuiteMappings(value);
    assert.equal(native.timeTypeMultiplierField, saved.timeTypeMultiplierField);
    assert.deepEqual(native.projectStatuses, { "in progress": "active" });
    assert.deepEqual(native.projectBillingTypes, { FBI: "cost_plus" });
    assert.deepEqual(native.taxCodeFallbacks, saved.taxCodeFallbacks);
    assert.equal(native.crmProbabilityField, saved.crmProbabilityField);
  }
  assert.deepEqual(
    parseNetSuiteMappings({ projectForemanField: "" }).projectForemanField,
    undefined,
  );
});

test("mapping boundaries refuse broken parents, query fragments and ambiguous source values", () => {
  for (const value of [
    { timeTypeMultiplierField: "custrecord_multiplier" },
    { projectForemanField: "id FROM employee" },
    { crmProbabilityField: "probability; DROP TABLE" },
    { projectStatuses: [] },
    { projectStatuses: { active: "active", ACTIVE: "closed" } },
    { projectBillingTypes: { FBI: "invented_type" } },
    { taxCodeFallbacks: { sales: "" } },
    { unknownOverride: "custbody_ignored" },
  ])
    assert.throws(() => parseNetSuiteMappings(value));
  assert.throws(
    () => validateConnectionMappings("{broken", NETSUITE_MAPPING_GROUPS),
    /must be an object/,
  );
  assert.throws(
    () =>
      validateConnectionMappings({ projectStatuses: { "": "active" } }, NETSUITE_MAPPING_GROUPS),
    /empty or duplicate/,
  );
});

test("native commands read and write one structured mapping authority", () => {
  const options = {
    projectForemanField: "custentity_foreman",
    projectPurchaseOrderField: "custentity_po",
    projectStatuses: { Completed: "closed" },
    projectBillingTypes: { FBI: "cost_plus" },
    lineMarkupField: "custcol_markup",
    lineBillableField: "custcol_billable",
    itemCategoryField: "custitem_category",
    customerShortCodeField: "custentity_shortcode",
    employeeBenefitsField: "custentity_benefits",
    timeTypeRecord: "customrecord_time",
    timeTypeMultiplierField: "custrecord_multiplier",
    timeEntryTypeField: "custcol_time_type",
    timeEntryFieldTicketNumberField: "custcol_ticket",
    crmProbabilityField: "custbody_probability",
    taxCodeFallbacks: { sales: "-8", purchase: "13.5" },
  };
  assert.deepEqual(
    Object.keys(options).sort(),
    NETSUITE_MAPPING_GROUPS.flatMap((group) => group.fields.map((field) => field.key)).sort(),
  );
  const model = {
    version: 1 as const,
    entities: {
      items: [{ target: "category", missing: "default" as const, defaultValue: "Materials" }],
    },
    sourceOptions: options,
  };
  const config = canonicalConnectionMappingConfig(
    { entityMappings: model, baseCurrency: "CAD" },
    NETSUITE_MAPPING_GROUPS,
  );
  assert.deepEqual(config, { entityMappings: model, baseCurrency: "CAD" });
  assert.deepEqual(connectionSourceOptions(config, NETSUITE_MAPPING_GROUPS), options);
  assert.deepEqual(
    parseNetSuiteMappings(connectionSourceOptions(config, NETSUITE_MAPPING_GROUPS)),
    parseNetSuiteMappings(options),
  );
  for (const stored of [options, JSON.stringify(options), null]) {
    for (const config of [
      { mappingJson: stored },
      { mappingJson: stored, entityMappings: model },
    ]) {
      assert.throws(
        () => connectionSourceOptions(config, NETSUITE_MAPPING_GROUPS),
        /native database upgrade/,
      );
      assert.throws(
        () => canonicalConnectionMappingConfig(config, NETSUITE_MAPPING_GROUPS),
        /native database upgrade/,
      );
    }
  }
});

test("unresolved saved values remain available for explicit removal and refuse execution", () => {
  const value = { nested: ["Original", false, null], amount: "100.0100" };
  const model = {
    version: 1 as const,
    entities: {},
    sourceOptions: { projectForemanField: "custentity_foreman" },
    unavailableRules: [{ key: "obsolete", value, reason: "Unsupported source option" }],
  };
  assert.throws(
    () => validateStructuredConnectionMappings(model, NETSUITE_MAPPING_GROUPS),
    /Remove or resolve/,
  );
  assert.throws(
    () => canonicalConnectionMappingConfig({ entityMappings: model }, NETSUITE_MAPPING_GROUPS),
    /Remove or resolve/,
  );
  assert.deepEqual(model.unavailableRules[0]!.value, value);
  assert.deepEqual(
    validateStructuredConnectionMappings(
      { ...model, unavailableRules: [] },
      NETSUITE_MAPPING_GROUPS,
    ).sourceOptions,
    model.sourceOptions,
  );
});
