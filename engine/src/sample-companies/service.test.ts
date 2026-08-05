import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const service = readFileSync(
  new URL("./service.ts", import.meta.url),
  "utf8",
);
const timeAndMaterials = readFileSync(
  new URL("../sim/ops-tm.ts", import.meta.url),
  "utf8",
);

function functionSource(name: string, nextMarker: string): string {
  const start = service.indexOf(`async function ${name}`);
  const end = service.indexOf(nextMarker, start + 1);
  assert.ok(start >= 0, `${name} is missing`);
  assert.ok(end > start, `${name} boundary is missing`);
  return service.slice(start, end);
}

test("sample template discovery never reads accounting content under cross-tenant bypass", () => {
  const discovery = functionSource("templateCandidates", "async function templateFor");
  assert.match(discovery, /withBypassContext/);
  assert.doesNotMatch(
    discovery,
    /(?:from|join)\s+(?:documents|journal_entries|parties|users)\b/i,
  );

  const inspection = functionSource("templateRowForOrg", "function assertTemplateCoverage");
  assert.match(inspection, /withOrgContext\(orgId/);
  assert.match(inspection, /from documents/);
  assert.match(inspection, /from journal_entries/);
  assert.doesNotMatch(inspection, /withBypass/);
});

test("generated sample templates require durable oracle evidence", () => {
  const discovery = functionSource("templateCandidates", "async function templateFor");
  assert.match(discovery, /sampleTemplateOracle/);
  assert.match(discovery, /status' = 'passed'/);
  assert.match(service, /Simulation completed with no oracle defects/);
  assert.ok(
    service.indexOf("await markSimulationOraclePassed") <
      service.indexOf("await templateRowForOrg(provisioned.orgId)"),
  );
});

test("sample generation resumes only recognized transient database failures", () => {
  assert.match(service, /runSimulatorThroughTransientDatabaseFailures\(provisioned\.runDir\)/);
  assert.match(service, /query read timeout/);
  assert.match(service, /attempt >= maximumAttempts/);
  assert.match(service, /if \(!isTransientDatabaseFailure\(error\)/);
});

test("a lost template advisory lock is reacquired before registration", () => {
  const prepare = functionSource("prepareSampleCompanyTemplate", "export async function prepareAllSampleCompanyTemplates");
  assert.match(prepare, /lockClient\.on\("error", handleLockError\)/);
  assert.match(prepare, /await reacquireLockIfNeeded\(\)/);
  assert.ok(
    prepare.lastIndexOf("await reacquireLockIfNeeded()") < prepare.lastIndexOf("await markTemplate"),
  );
  assert.match(prepare, /sample template lock could not be held through registration/);
});

test("a lost member lock converges on the first completed preview", () => {
  const existing = functionSource("existingFor", "export async function sampleCompanyStatuses");
  assert.match(existing, /order by o\.created_at asc/);
  const create = service.slice(service.indexOf("export async function createSampleCompany"));
  assert.match(create, /member lock connection was lost/);
  assert.match(create, /await reacquireLockIfNeeded\(\)/);
  assert.match(create, /winnerBeforeFinalize/);
  assert.match(create, /deleteSandbox\(cloned\.sandboxId\)/);
  assert.match(create, /sample company member lock could not be held through registration/);
});

test("simulated T&M invoices use the canonical approval lifecycle", () => {
  assert.match(timeAndMaterials, /await postDraftDocument\(world, docId\)/);
  assert.doesNotMatch(timeAndMaterials, /await postDocument\(docId/);
});
