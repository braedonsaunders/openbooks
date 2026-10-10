#!/usr/bin/env node
import { readFileSync, statSync } from "node:fs";
import { admitSampleRetirement, executeSampleRetirement } from "./retirement.ts";
import { tenantRetirementStatus, releaseTenantRetirement } from "../organization/tenant-retirement.ts";
import { sampleRetirementPlan } from "./retirement-plan.ts";
import { sampleTenantInventory } from "./tenant-inventory.ts";
import { installDemoScenarios, verifyDemoScenarios } from "./install-scenarios.ts";
import { sampleSourceManifest } from "./manifest.ts";
import {
  createSampleCompany,
  prepareAllSampleCompanyTemplates,
  prepareIndustryDemo,
  resumeSampleTemplate,
  promoteExistingSampleTemplate,
  sampleCompanyStatuses,
} from "./service.ts";
import { sampleRefreshPlan, refreshAllSampleCompanies } from "./refresh.ts";
import { sampleCompanyFeatures } from "./features.ts";
import { SAMPLE_COMPANY_BY_INDUSTRY, SAMPLE_COMPANY_PROFILES } from "./catalog.ts";
import { pool, longPool } from "../platform/db.ts";
import { installEngineSeams } from "../composition/install.ts";

// Company builds post: install the engine seams first.
installEngineSeams();

function valueAfter(flag: string): string | null {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
}

function line(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function privateJson(flag: string, maxBytes: number): unknown {
  const path = valueAfter(flag);
  if (!path) throw new Error(`Missing ${flag} PATH`);
  const file = statSync(path);
  if (!file.isFile() || file.size > maxBytes) throw new Error(`${flag} must name a bounded regular JSON file`);
  try { return JSON.parse(readFileSync(path, "utf8")); }
  catch { throw new Error(`${flag} contains invalid JSON`); }
}
function required(flag: string): string {
  const value = valueAfter(flag);
  if (!value) throw new Error(`Missing ${flag}`);
  return value;
}

function operatorOptions(): { actorId?: string } {
  return process.argv.includes("--actor") ? { actorId: required("--actor") } : {};
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? "inventory";
  if (command === "retirement-admit") {
    line(await admitSampleRetirement({ plan: privateJson("--plan-file", 16 * 1024 * 1024), recovery: privateJson("--recovery-file", 65536), runId: required("--run-id"), actorId: required("--actor") }));
    return;
  }
  if (command === "retirement-execute") {
    line(await executeSampleRetirement({ runId: required("--run-id"), orgId: required("--org"), planDigest: required("--plan-digest") }));
    return;
  }
  if (command === "retirement-release") {
    line(await releaseTenantRetirement({ runId: required("--run-id"), orgId: required("--org"), planDigest: required("--plan-digest"), actorId: required("--actor"), reason: required("--reason") }));
    return;
  }
  if (command === "retirement-status") { line(await tenantRetirementStatus(required("--run-id"))); return; }
  if (command === "retirement-plan") {
    const path = valueAfter("--selection-file");
    if (!path) throw new Error("retirement-plan requires --selection-file PATH containing exact database identity and retain/retire UUID lists");
    const file = statSync(path);
    if (!file.isFile() || file.size > 65536) throw new Error("Retirement selection must be a regular JSON file no larger than 64 KiB");
    let selection: unknown;
    try { selection = JSON.parse(readFileSync(path, "utf8")); }
    catch { throw new Error("Retirement selection is not valid JSON; review its schema without placing credentials in the file"); }
    line(await sampleRetirementPlan(selection));
    return;
  }
  if (command === "tenant-inventory") { for (const tenant of await sampleTenantInventory()) line(tenant); return; }
  if (command === "manifest") { line(sampleSourceManifest()); return; }
  if (command === "inventory") {
    // Status does not use the member ID when no user copy exists; the sentinel
    // can never match a UUID owner and keeps this operation read-only.
    const statuses = await sampleCompanyStatuses("00000000-0000-0000-0000-000000000000");
    for (const status of statuses) line(status);
    return;
  }

  if (command === "inspect") {
    const orgId = valueAfter("--org");
    const industryKey = valueAfter("--industry");
    if (!orgId || !industryKey) throw new Error("inspect requires --org UUID --industry KEY");
    line(await verifyDemoScenarios(orgId, industryKey));
    return;
  }

  if (command === "refresh-plan") {
    line(await sampleRefreshPlan(valueAfter("--industry") ?? undefined, operatorOptions()));
    return;
  }
  if (command === "refresh") {
    const digest = valueAfter("--plan-digest");
    if (!digest) throw new Error("refresh requires --plan-digest SHA256 from a reviewed refresh-plan");
    await refreshAllSampleCompanies({ digest, ...operatorOptions(), industryKey: valueAfter("--industry") ?? undefined, onResult: line });
    return;
  }

  if (command === "install-scenarios") {
    line(await installDemoScenarios(required("--org"), required("--industry"), operatorOptions()));
    return;
  }

  if (command === "install") {
    const memberUserId = valueAfter("--member-user");
    const sourceOrgId = valueAfter("--source-org");
    const memberName = valueAfter("--member-name");
    if (!memberUserId || !sourceOrgId || !memberName) throw new Error("install requires --member-user UUID --source-org UUID --member-name NAME");
    const industry = valueAfter("--industry");
    if (industry && !SAMPLE_COMPANY_BY_INDUSTRY.has(industry)) throw new Error(`unknown industry: ${industry}`);
    const profiles = industry ? [SAMPLE_COMPANY_BY_INDUSTRY.get(industry)!] : SAMPLE_COMPANY_PROFILES;
    for (const profile of profiles) line(await createSampleCompany({ industryKey: profile.industryKey, memberUserId, sourceOrgId, memberName, features: sampleCompanyFeatures(profile.industryKey) }));
    return;
  }

  if (command === "resume") {
    const runDir = valueAfter("--run-dir");
    if (!runDir) throw new Error("resume requires --run-dir PATH");
    line(await resumeSampleTemplate(runDir));
    return;
  }

  if (command === "promote") {
    const industry = valueAfter("--industry");
    const sourceOrgId = valueAfter("--source-org");
    if (!industry || !sourceOrgId) {
      throw new Error("promote requires --industry INDUSTRY_KEY and --source-org UUID");
    }
    if (!SAMPLE_COMPANY_BY_INDUSTRY.has(industry)) throw new Error(`unknown industry: ${industry}`);
    const unmasked = process.argv.includes("--unmasked");
    line(await promoteExistingSampleTemplate({
      industryKey: industry,
      sourceOrgId,
      confirmedSampleData: process.argv.includes("--confirm-sample-data"),
      masked: !unmasked,
      confirmedSynthetic: process.argv.includes("--confirm-synthetic"),
    }));
    return;
  }

  if (command !== "prepare") {
    throw new Error("usage: npm -w engine run samples -- manifest | tenant-inventory | retirement-plan --selection-file PATH | retirement-admit --plan-file PATH --recovery-file PATH --run-id UUID --actor UUID | retirement-execute --run-id UUID --org UUID --plan-digest SHA256 | retirement-status --run-id UUID | retirement-release --run-id UUID --org UUID --plan-digest SHA256 --actor UUID --reason TEXT | inventory | inspect --org UUID --industry KEY | refresh-plan [--industry KEY] [--actor UUID] | refresh --plan-digest SHA256 [--industry KEY] [--actor UUID] | install-scenarios --org UUID --industry KEY [--actor UUID] | prepare [--industry KEY] | install --member-user UUID --source-org UUID --member-name NAME [--industry KEY] | resume --run-dir PATH | promote --industry KEY --source-org UUID --confirm-sample-data [--unmasked --confirm-synthetic]");
  }

  const industry = valueAfter("--industry");
  if (industry) {
    if (!SAMPLE_COMPANY_BY_INDUSTRY.has(industry)) throw new Error(`unknown industry: ${industry}`);
    line(await prepareIndustryDemo(industry));
    return;
  }

  for (const result of await prepareAllSampleCompanyTemplates()) line(result);
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
    await longPool.end();
  });
