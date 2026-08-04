#!/usr/bin/env node
import {
  prepareAllSampleCompanyTemplates,
  prepareSampleCompanyTemplate,
  promoteExistingSampleTemplate,
  sampleCompanyStatuses,
} from "./service.ts";
import { SAMPLE_COMPANY_BY_INDUSTRY } from "./catalog.ts";
import { pool } from "../db.ts";

function valueAfter(flag: string): string | null {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
}

function line(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? "inventory";
  if (command === "inventory") {
    // Status does not use the member ID when no user copy exists; the sentinel
    // can never match a UUID owner and keeps this operation read-only.
    const statuses = await sampleCompanyStatuses("00000000-0000-0000-0000-000000000000");
    for (const status of statuses) line(status);
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
    throw new Error("usage: npm -w engine run samples -- inventory | prepare [--industry KEY] | promote --industry KEY --source-org UUID --confirm-sample-data [--unmasked --confirm-synthetic]");
  }

  const industry = valueAfter("--industry");
  if (industry) {
    if (!SAMPLE_COMPANY_BY_INDUSTRY.has(industry)) throw new Error(`unknown industry: ${industry}`);
    line(await prepareSampleCompanyTemplate(industry));
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
  });
