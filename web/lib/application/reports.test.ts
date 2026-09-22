import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const SOURCE = readFileSync(new URL("./reports.ts", import.meta.url), "utf8");

test("report run reuses the hub resolver and refuses a restricted subsidiary scope", () => {
  assert.match(SOURCE, /resolveDefinitionToExportData/);
  assert.match(SOURCE, /withReportAuthz/);
  assert.match(SOURCE, /canAccessReportDefinition/);
  assert.match(SOURCE, /allowedSubsidiaryIds !== null/);
  assert.match(SOURCE, /forbidden\("reports\.unrestricted_scope"\)/);
  const runStart = SOURCE.indexOf("export async function runApplicationReport");
  assert.ok(runStart >= 0);
  const run = SOURCE.slice(runStart);
  const scopeCheck = run.indexOf("allowedSubsidiaryIds !== null");
  const resolver = run.indexOf("resolveDefinitionToExportData");
  assert.ok(scopeCheck >= 0 && resolver > scopeCheck, "the subsidiary refuse must run before the report resolver");
});
