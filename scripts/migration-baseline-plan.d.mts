export type BaselineManifest = {
  format: 1;
  verified: true;
  filename: string;
  baselineSha256: string;
  catalogSha256: string;
  environmentSha256?: string;
  covered: { filename: string; sha256: string }[];
};
export function validateBaselineManifest(manifest: BaselineManifest, directory: string): number;
export function releaseMigrationPlan(directory: string, generated: readonly string[]): { baseline: BaselineManifest | null; filenames: string[] };
export function historicalMigrationPlan(directory: string, generated: readonly string[]): { baseline: BaselineManifest | null; filenames: string[]; environment: string };
export function assertBaselineHistory(baseline: BaselineManifest | null, recorded: { filename: string; sha256: string }[], applicationTablesPresent: boolean): void;
export function migrationIdentityIsApplied(filename: string, recorded: { filename: string; sha256: string }[], baseline: BaselineManifest | null): boolean;
