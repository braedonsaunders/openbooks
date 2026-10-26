export type MigrationIdentity = { filename: string; sha256: string };
export type BaselineManifest = {
  format: 2;
  verified: true;
  filename: string;
  baselineSha256: string;
  catalogSha256: string;
  environmentSha256?: string;
  upgradeFromRelease: string;
  upgradeFrom: MigrationIdentity[];
  covered: MigrationIdentity[];
};
export function orderMigrationPrerequisites(
  directory: string,
  filenames: readonly string[],
): string[];
export function validateBaselineManifest(manifest: BaselineManifest, directory: string): void;
export function releaseMigrationPlan(
  directory: string,
  generated: readonly string[],
): { baseline: BaselineManifest | null; filenames: string[] };
export function missingUpgradeLedger(
  baseline: BaselineManifest,
  recorded: MigrationIdentity[],
): string[];
export function assertBaselineHistory(
  baseline: BaselineManifest | null,
  recorded: MigrationIdentity[],
  applicationTablesPresent: boolean,
): void;
export function migrationIdentityIsApplied(
  filename: string,
  recorded: MigrationIdentity[],
  baseline: BaselineManifest | null,
): boolean;
