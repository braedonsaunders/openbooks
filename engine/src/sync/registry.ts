import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { MigrationSource } from "./source.ts";
import { NetSuiteSource } from "./netsuite-source.ts";

/**
 * Registry of configured external-source adapters. The PRODUCT knows
 * nothing about specific vendors — pages and buttons render whatever is
 * configured here. Adding a system = adding an adapter + its config
 * detection; zero UI changes.
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

export interface ConfiguredSource {
  name: string; // stable key, e.g. "netsuite"
  displayName: string; // what the UI shows, e.g. "NetSuite"
  make: () => MigrationSource;
}

export function configuredSources(): ConfiguredSource[] {
  const sources: ConfiguredSource[] = [];
  if (existsSync(join(repoRoot, ".env.netsuite"))) {
    sources.push({ name: "netsuite", displayName: "NetSuite", make: () => new NetSuiteSource() });
  }
  // future adapters detect their own config here (QuickBooks, Xero, …)
  return sources;
}

export function sourceByName(name: string): ConfiguredSource | undefined {
  return configuredSources().find((s) => s.name === name);
}
