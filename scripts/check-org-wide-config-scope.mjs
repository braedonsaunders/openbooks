#!/usr/bin/env node
/**
 * Every API route that mutates an org-wide configuration table must enforce
 * unrestricted subsidiary scope. The governed set is deliberately table
 * based: each table is checked against the generated schema so adding a
 * subsidiary anchor requires an explicit review of this policy.
 */
import assert from "node:assert/strict";
import { globSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const schemaFiles = globSync("schema/migrations/generated/*.sql", { cwd: root });
const schema = schemaFiles.map((file) => readFileSync(join(root, file), "utf8")).join("\n");

// Configuration tables with no subsidiary ownership column. A policy table
// added here is derived into every route that writes it below.
const policyTables = ["flows", "allocation_drivers", "project_types"];
for (const table of policyTables) {
  const declaration = new RegExp(`CREATE TABLE(?: IF NOT EXISTS)? public\\.${table} \\(([\\s\\S]*?)\\n\\);`, "i").exec(schema);
  assert.ok(declaration, `governed org-wide config table ${table} has no generated schema declaration`);
  assert.doesNotMatch(declaration[1], /\bsubsidiary_id\b/i, `${table} gained a subsidiary anchor; review its scope policy`);
}
// Labor rates may be subsidiary-anchored, so only their job-title, trade,
// and default rows are org-wide. Keep a conditional guard in the route that
// writes the table and pin that the schema still carries the anchor field.
const declaration = /CREATE TABLE(?: IF NOT EXISTS)? public\.labor_cost_rates \(([\s\S]*?)\n\);/i.exec(schema);
assert.ok(declaration, "conditionally scoped policy table labor_cost_rates has no generated schema declaration");
assert.match(declaration[1], /\bsubsidiary_id\b/i, "labor_cost_rates scope model changed; review conditional policy enforcement");

function actionArm(source, action) {
  const marker = new RegExp(`if\\s*\\(\\s*body\\.action\\s*===\\s*['\"]${action}['\"]\\s*\\)\\s*\\{`);
  const match = marker.exec(source);
  assert.ok(match, `labor-costing route is missing the ${action} mutation arm`);
  const next = /\n\s*if\s*\(body\.action\s*===/.exec(source.slice(match.index + match[0].length));
  return source.slice(match.index, next ? match.index + match[0].length + next.index : source.length);
}

function assertLaborRateMutationGuard(source, action) {
  const arm = actionArm(source, action);
  assert.match(arm, /isOrgWideWageScope\s*\(/, `labor-costing ${action} does not classify the persisted wage scope`);
  assert.match(arm, /guardUnrestrictedScope\s*\(/, `labor-costing ${action} does not guard org-wide wage scopes`);
}
function handlerArm(source, method) {
  const marker = new RegExp(`export\\s+async\\s+function\\s+${method}\\s*\\(`);
  const match = marker.exec(source);
  if (!match) {
    // A route may expose a factory-created handler so tests can inject the
    // permission and persistence boundaries without replacing app modules.
    const factory = new RegExp(`export\\s+const\\s+${method}\\s*=\\s*(create\\w+Handler)\\s*\\(`).exec(source);
    assert.ok(factory, `org-settings route is missing its ${method} handler`);
    const declaration = new RegExp(`export\\s+function\\s+${factory[1]}\\s*\\(`).exec(source);
    assert.ok(declaration, `org-settings route's ${method} handler factory is missing`);
    return source.slice(declaration.index, factory.index + factory[0].length);
  }
  const next = /\nexport\s+async\s+function\s+/.exec(source.slice(match.index + match[0].length));
  return source.slice(match.index, next ? match.index + match[0].length + next.index : source.length);
}
const routes = globSync("web/app/api/**/route.ts", { cwd: root }).sort();
const writes = [];
for (const file of routes) {
  const source = readFileSync(join(root, file), "utf8");
  const touched = policyTables.filter((table) => {
    const directWrite = new RegExp(`\\b(?:insert\\s+into|update|delete\\s+from)\\s+(?:public\\.)?${table}\\b`, "i").test(source);
    // Allocation driver CRUD delegates its SQL writer to driver-admin.ts.
    const delegatedWrite = table === "allocation_drivers" && /\b(?:createDriver|updateDriver|deleteDriver)\s*\(/.test(source);
    return directWrite || delegatedWrite;
  });
  if (/\b(?:insert\s+into|update|delete\s+from)\s+(?:public\.)?labor_cost_rates\b/i.test(source)) {
    touched.push("labor_cost_rates (conditional org-wide scopes)");
  }
  // Cashflow categories are stored under orgs.settings and have no subsidiary
  // row anchor; detect that JSON policy by the key plus an org mutation.
  if (/cashflowCategories/.test(source) && /\bupdate\s+orgs\b/i.test(source)) touched.push("orgs.settings.analytics.cashflowCategories");
  // The HRM feedback writer is in the engine service, not inline in the
  // route. Detect its API adapter through the setting field and writer call.
  if (/setFeedbackSettings\s*\(/.test(source) && /publicPraiseBy|public_praise_by/.test(source)) {
    touched.push("orgs.settings.hrm_feedback.public_praise_by");
    const post = handlerArm(source, "POST");
    assert.match(post, /guardUnrestrictedScope\s*\(/,
      `${file} writes org-wide orgs.settings policy without a POST unrestricted-scope guard`);
  }
  if (touched.length === 0) continue;
  writes.push({ file, tables: touched });
  if (touched.some((target) => target.startsWith("labor_cost_rates"))) {
    // The three mutation arms have independent authorization decisions. A
    // token in save-rate cannot stand in for end-rate or delete-rate.
    for (const action of ["save-rate", "end-rate", "delete-rate"]) {
      assertLaborRateMutationGuard(source, action);
    }
  }
  if (touched.includes("project_types")) {
    // Project-type rows carry no subsidiary anchor, and each handler is an
    // independent configuration mutation boundary. A guard in POST cannot
    // authorize PATCH or archive.
    for (const method of ["POST", "PATCH", "DELETE"]) {
      const arm = handlerArm(source, method);
      if (/\b(?:insert\s+into|update|delete\s+from)\s+(?:public\.)?project_types\b/i.test(arm)) {
        assert.match(arm, /guardUnrestrictedScope\s*\(/,
          `${file} writes org-wide project_types without a ${method} unrestricted-scope guard`);
      }
    }
  }
  assert.match(source, /guardUnrestrictedScope\s*\(/,
    `${file} writes org-wide configuration (${touched.join(", ")}) without guardUnrestrictedScope`);
}

// Qualification taxonomy and its category vocabulary have no subsidiary
// owner. Derive each write boundary from the service command it dispatches.
const qualificationCommands = new Map([
  ["createQualificationType", "POST"],
  ["updateQualificationType", "PATCH"],
  ["declareCategory", "POST"],
  ["setAlertSchedule", "POST"],
]);
const qualificationWrites = [];
for (const file of routes) {
  const source = readFileSync(join(root, file), "utf8");
  for (const [command, method] of qualificationCommands) {
    if (!new RegExp(`\\b${command}\\s*\\(`).test(source)) continue;
    const arm = handlerArm(source, method);
    assert.match(arm, new RegExp(`\\b${command}\\s*\\(`), `${file} no longer dispatches ${command} from ${method}`);
    assert.match(arm, /guardUnrestrictedScope\s*\(/,
      `${file} dispatches org-wide qualification command ${command} without a ${method} unrestricted-scope guard`);
    qualificationWrites.push({ file, command });
  }
}
assert.deepEqual(qualificationWrites.map(({ command }) => command).sort(), [
  "createQualificationType", "declareCategory", "setAlertSchedule", "updateQualificationType",
].sort(), "qualification policy writer set changed; review every mutation boundary");

// Connector configuration, execution, run metadata, OAuth, and source
// deletion surfaces all act on org-wide integration state. Unlike ordinary
// entity APIs, even their readers expose one shared connector registry and
// run history, so every route in this namespace needs the same scope gate.
const connectorRoutes = globSync("web/app/api/platform/connections/**/route.ts", { cwd: root })
  .concat(["web/app/api/platform/connections/route.ts"])
  .sort();
for (const file of connectorRoutes) {
  const source = readFileSync(join(root, file), "utf8");
  assert.match(source, /guardUnrestrictedScope\s*\(/, `${file} exposes org-wide connector state without guardUnrestrictedScope`);
}

// These org-wide settings commands persist policy/secrets beneath orgs.settings
// rather than a dedicated table, so derive each route from its writer call and
// require the guard in the individual mutating handler. A read handler's guard
// cannot stand in for PUT or DELETE.
const orgSettingsWriters = new Map([
  ["saveSetupAgentPolicy", "orgs.settings.setupAgentPolicies"],
  ["saveOrgAiAgentSettings", "orgs.settings.ai.agentPolicies"],
  ["saveOrgAiSettings", "orgs.settings.ai"],
  ["clearOrgAiKey", "orgs.settings.ai.apiKey"],
  ["clearOrgDocumentCaptureKey", "orgs.settings.ai.documentCapture.apiKey"],
]);
const orgSettingsWrites = [];
for (const file of routes) {
  const source = readFileSync(join(root, file), "utf8");
  for (const [writer, target] of orgSettingsWriters) {
    if (!new RegExp(`\\b${writer}\\s*\\(`).test(source)) continue;
    const methods = writer.startsWith("clearOrg") ? ["DELETE"] : ["PUT"];
    for (const method of methods) {
      const arm = handlerArm(source, method);
      assert.match(arm, new RegExp(`\\b${writer}\\s*\\(`),
        `${file} no longer calls ${writer} from its ${method} handler; update the derived writer map`);
      assert.match(arm, /guardUnrestrictedScope\s*\(/,
        `${file} writes ${target} without a ${method} unrestricted-scope guard`);
    }
    orgSettingsWrites.push({ file, target });
  }
}

// Inventory GET handlers that disclose org-wide policy. Read access is its
// own boundary: a guarded PUT cannot authorize an unrestricted configuration
// read. This map is derived from the same stored settings touched by the
// corresponding org-wide writers.
const orgSettingsReaders = new Map([
  ["cashflowCategories", "orgs.settings.analytics.cashflowCategories"],
  ["getOrgAiSettings", "orgs.settings.ai"],
  ["getFeedbackSettings", "orgs.settings.hrm_feedback.public_praise_by"],
]);
const orgWideConfigReaders = [];
for (const file of routes) {
  const source = readFileSync(join(root, file), "utf8");
  const get = /export\s+async\s+function\s+GET\s*\([\s\S]*?(?=\nexport\s+async\s+function\s+|$)/.exec(source)?.[0];
  if (!get) continue;
  for (const [signal, target] of orgSettingsReaders) {
    if (!new RegExp(`\\b${signal}\\b`).test(get)) continue;
    assert.match(get, /guardUnrestrictedScope\s*\(/,
      `${file} reads ${target} without a GET unrestricted-scope guard`);
    orgWideConfigReaders.push({ file, target });
  }
}
for (const file of globSync("web/app/**/view.ts", { cwd: root }).sort()) {
  const source = readFileSync(join(root, file), "utf8");
  if (!/\bbank_match_rules\b/.test(source)) continue;
  assert.match(source, /guardUnrestrictedScope\s*\(/,
    `${file} reads org-wide banking rules without an unrestricted-scope guard`);
  const guardAt = source.indexOf("if (guardUnrestrictedScope(authz)) forbidden()");
  const firstReadAt = source.search(/\bdb\.execute(?:<[^>]+>)?\s*\(/);
  assert.ok(guardAt >= 0 && firstReadAt >= 0 && guardAt < firstReadAt,
    `${file} must refuse restricted readers before loading banking-rule pickers or seed data`);
  orgWideConfigReaders.push({ file, target: "bank_match_rules and banking-rule pickers" });
}

// Keep an inventory of other config-table readers as they are discovered.
// Some have purpose-built scoped projections (for example flow execution
// history); the inventory makes those surfaces visible for review rather than
// silently treating the writer check as coverage for reads.
const tableReaders = [];
for (const file of routes) {
  const source = readFileSync(join(root, file), "utf8");
  const get = /export\s+async\s+function\s+GET\s*\([\s\S]*?(?=\nexport\s+async\s+function\s+|$)/.exec(source)?.[0];
  if (!get) continue;
  for (const table of policyTables) {
    const directRead = new RegExp(`\\bfrom\\s+(?:public\\.)?${table}\\b`, "i").test(get);
    const delegatedRead = table === "allocation_drivers" && /\b(?:listDrivers|getDriver)\s*\(/.test(get);
    if (directRead || delegatedRead) tableReaders.push({ file, target: table });
  }
}
const cashflowCompositeFile = "web/lib/analytics/cashflow-data.ts";
const cashflowComposite = readFileSync(join(root, cashflowCompositeFile), "utf8");
if (/\bloadCategories\s*\(/.test(cashflowComposite)) {
  assert.match(cashflowComposite, /catConfigs\.filter\([\s\S]*?isCategoryVisibleInScope\s*\(/,
    `${cashflowCompositeFile} reads org-wide cashflow category configuration without its subsidiary visibility projection`);
  tableReaders.push({ file: cashflowCompositeFile, target: "orgs.settings.analytics.cashflowCategories" });
}

console.log(`org-wide config scope: ${writes.length} route(s), ${writes.reduce((n, row) => n + row.tables.length, 0)} write target(s)`);
console.log(`org-wide qualification scope: ${qualificationWrites.length} command writer(s), mutation handlers guarded`);
for (const row of writes) console.log(`  ${row.file}: ${row.tables.join(", ")}`);
console.log(`org-wide connector scope: ${connectorRoutes.length} route(s), reads and writes guarded`);
console.log(`org-wide settings scope: ${orgSettingsWrites.length} route writer(s), mutation handlers guarded`);
for (const row of orgSettingsWrites) console.log(`  ${row.file}: ${row.target}`);
console.log(`org-wide settings readers: ${orgWideConfigReaders.length} read surface(s), unrestricted handlers guarded`);
for (const row of orgWideConfigReaders) console.log(`  ${row.file}: ${row.target}`);
console.log(`org-wide config table readers inventoried: ${tableReaders.length}`);
for (const row of tableReaders) console.log(`  ${row.file}: ${row.target}`);
